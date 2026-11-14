begin;

-- The owner enrolls one existing Supabase Auth user through SQL Editor.
create table g19_private.web_admin (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null references auth.users(id)
);
alter table g19_private.web_admin enable row level security;
revoke all on g19_private.web_admin from public, anon, authenticated, service_role;

alter table g19_private.room_reset_audit
  add column action text not null default 'release_room' check (action in ('release_room','detach_device')),
  add column auth_user_id uuid;

create function g19_private.require_web_admin()
returns uuid language plpgsql stable set search_path = '' as $$
declare
  actor uuid := auth.uid();
begin
  if not exists (
    select 1 from g19_private.web_admin admin join auth.sessions s on s.user_id = admin.user_id
    where admin.user_id = actor and s.id::text = auth.jwt()->>'session_id'
      and s.created_at > statement_timestamp() - interval '1 hour'
  ) then
    raise sqlstate 'PT403' using message = 'admin_required';
  end if;
  return actor;
end;
$$;
revoke all on function g19_private.require_web_admin() from public, anon, authenticated, service_role;

create function public.g19_web_admin_rooms()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform g19_private.require_web_admin();
  return (
    select jsonb_agg(jsonb_build_object(
      'room', r.room, 'generation', r.generation, 'occupied', r.occupied,
      'devices', coalesce((
        select jsonb_agg(jsonb_build_object('id', d.id, 'kind', coalesce(d.device_kind, 'other'))
          order by d.created_at, d.id)
        from g19_private.devices d
        where d.room = r.room and d.generation = r.generation and d.revoked_at is null
      ), '[]'::jsonb)
    ) order by r.room)
    from g19_private.rooms r
  );
end;
$$;

create function public.g19_web_admin_release(p_room integer, p_generation integer, p_devices uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := g19_private.require_web_admin();
  room_generation integer;
  current_devices uuid[];
  revoked integer;
begin
  select generation into room_generation from g19_private.rooms where room = p_room and occupied for update;
  if not found or room_generation is distinct from p_generation then
    raise sqlstate 'PT409' using message = 'room_changed';
  end if;
  select array(select id from g19_private.devices
      where room = p_room and generation = room_generation and revoked_at is null order by id)
    into current_devices;
  if current_devices is distinct from array(select unnest(p_devices) order by 1) then
    raise sqlstate 'PT409' using message = 'room_changed';
  end if;
  revoked := public.g19_admin_change_resident(p_room, p_generation, cardinality(current_devices));
  update g19_private.room_reset_audit set auth_user_id = actor
    where id = currval(pg_get_serial_sequence('g19_private.room_reset_audit','id'));
  return revoked;
end;
$$;

create function public.g19_web_admin_detach(p_room integer, p_generation integer, p_device uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := g19_private.require_web_admin();
  room_generation integer;
  identity_hash bytea;
begin
  select generation into room_generation from g19_private.rooms where room = p_room for update;
  if not found or room_generation is distinct from p_generation then
    raise sqlstate 'PT409' using message = 'room_changed';
  end if;
  update g19_private.devices set revoked_at = clock_timestamp(), revoke_reason = 'admin'
    where id = p_device and room = p_room and generation = room_generation and revoked_at is null
    returning browser_hash into identity_hash;
  if not found then raise sqlstate 'PT409' using message = 'room_changed'; end if;
  if identity_hash is not null then
    insert into g19_private.blocked_browsers (room, browser_hash) values (p_room, identity_hash)
      on conflict do nothing;
  end if;
  delete from g19_private.notification_presence where device_id = p_device;
  perform g19_private.release_empty_room(p_room::smallint, room_generation);
  update g19_private.chat_revision set version = version + 1 where singleton = true;
  insert into g19_private.room_reset_audit
    (room, generation, result, devices_revoked, action, auth_user_id)
    values (p_room, room_generation, 'revoked', 1, 'detach_device', actor);
end;
$$;

revoke all on function public.g19_web_admin_rooms(), public.g19_web_admin_release(integer, integer, uuid[]),
  public.g19_web_admin_detach(integer, integer, uuid) from public, anon, authenticated, service_role;
grant execute on function public.g19_web_admin_rooms(), public.g19_web_admin_release(integer, integer, uuid[]),
  public.g19_web_admin_detach(integer, integer, uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
