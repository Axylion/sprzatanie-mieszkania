begin;

create table g19_private.room_reset_audit (
  id bigint generated always as identity primary key,
  room smallint not null references g19_private.rooms,
  generation integer not null,
  performed_at timestamptz not null default clock_timestamp(),
  administrator name not null default session_user,
  result text not null check (result in ('revoked')),
  devices_revoked integer not null
);
alter table g19_private.room_reset_audit enable row level security;
revoke all on g19_private.room_reset_audit from public, anon, authenticated, service_role;

-- The room remains assigned after self-revocation. Only the administrator can release it.
create or replace function public.g19_revoke_device(p_token text, p_device uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  device g19_private.devices := g19_private.lock_device_room(p_token);
begin
  update g19_private.devices set revoked_at = clock_timestamp()
    where id = p_device and room = device.room and generation = device.generation and revoked_at is null;
  if not found then raise sqlstate 'PT404' using message = 'device_not_found'; end if;
  if p_device = device.id then
    update g19_private.pairings set state = 'cancelled'
      where room = device.room and generation = device.generation and state in ('pending','approved');
  end if;
  delete from g19_private.notification_presence where device_id = p_device;
  update g19_private.chat_revision set version = version + 1 where singleton = true;
end;
$$;

create or replace function public.g19_admin_rooms()
returns table (room smallint, generation integer, active_devices bigint, occupied boolean)
language sql stable security definer set search_path = '' as $$
  select r.room, r.generation, count(d.id), r.occupied
  from g19_private.rooms r left join g19_private.devices d
    on d.room = r.room and d.generation = r.generation and d.revoked_at is null
  group by r.room, r.generation, r.occupied order by r.room;
$$;

create or replace function public.g19_admin_change_resident(p_room integer, p_generation integer, p_active_devices integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  current_generation integer;
  active integer;
begin
  select generation into current_generation from g19_private.rooms where room = p_room for update;
  if not found then
    raise log 'G19 room reset rejected (room_invalid) by % for room %', session_user, p_room;
    raise sqlstate 'PT400' using message = 'room_invalid';
  end if;
  select count(*) into active from g19_private.devices
    where room = p_room and generation = current_generation and revoked_at is null;
  if current_generation is distinct from p_generation or active is distinct from p_active_devices then
    raise log 'G19 room reset rejected (room_changed) by % for room %', session_user, p_room;
    raise sqlstate 'PT409' using message = 'room_changed';
  end if;

  update g19_private.devices set revoked_at = clock_timestamp()
    where room = p_room and generation = current_generation and revoked_at is null;
  delete from g19_private.notification_presence p using g19_private.devices d
    where p.device_id = d.id and d.room = p_room and d.generation = current_generation;
  update g19_private.pairings set state = 'cancelled'
    where room = p_room and generation = current_generation and state in ('pending','approved');
  update g19_private.rooms set generation = generation + 1, occupied = false where room = p_room;
  update g19_private.chat_revision set version = version + 1 where singleton = true;
  insert into g19_private.room_reset_audit (room, generation, result, devices_revoked)
    values (p_room, current_generation, 'revoked', active);
  return active;
end;
$$;

revoke all on function public.g19_admin_rooms(), public.g19_admin_change_resident(integer, integer, integer)
  from public, anon, authenticated, service_role;

-- Grant membership only to individually named administrative database logins.
create role g19_room_admin nologin;
grant usage on schema public to g19_room_admin;
grant execute on function public.g19_admin_rooms(), public.g19_admin_change_resident(integer, integer, integer)
  to g19_room_admin;

notify pgrst, 'reload schema';
commit;
