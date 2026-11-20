begin;

create table g19_private.notification_inbox (
  id bigint generated always as identity primary key,
  device_id uuid not null references g19_private.devices,
  category text not null check (category in ('messages','announcements','duties')),
  event_key text not null,
  title text not null,
  description text not null,
  target text not null,
  created_at timestamptz not null,
  read_at timestamptz,
  unique (device_id, category, event_key)
);
create index notification_recent on g19_private.notification_inbox (device_id, created_at desc, id desc);
alter table g19_private.notification_inbox enable row level security;
revoke all on g19_private.notification_inbox from public, anon, authenticated, service_role;

create function g19_private.notify_message()
returns trigger language plpgsql set search_path = '' as $$
begin
  insert into g19_private.notification_inbox (device_id, category, event_key, title, description, target, created_at)
  select d.id, 'messages', new.id::text, 'Nowa wiadomość',
    'Pokój nr ' || author.room || ' · Dyskusje', '#dyskusje', new.created_at
  from g19_private.devices author
  join g19_private.devices d on (d.room, d.generation) <> (author.room, author.generation)
  join g19_private.rooms r on r.room = d.room and r.generation = d.generation
  where author.id = new.device_id and d.revoked_at is null
  on conflict (device_id, category, event_key) do nothing;
  return new;
end;
$$;
revoke all on function g19_private.notify_message() from public, anon, authenticated, service_role;
create trigger g19_notify_message after insert on g19_private.messages
  for each row execute function g19_private.notify_message();

create function public.g19_notifications(p_token text, p_categories text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  device g19_private.devices := g19_private.lock_device(p_token);
  result jsonb;
  unread bigint;
begin
  select count(*) into unread from g19_private.notification_inbox
    where device_id = device.id and category = any(p_categories) and read_at is null;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id::text, 'title', n.title, 'description', n.description, 'target', n.target,
    'category', n.category, 'createdAt', n.created_at, 'read', n.read_at is not null
  ) order by n.created_at desc, n.id desc), '[]'::jsonb) into result
  from (
    select * from g19_private.notification_inbox
    where device_id = device.id and category = any(p_categories)
    order by created_at desc, id desc limit 50
  ) n;
  return jsonb_build_object('items', result, 'unread', unread);
end;
$$;

create function public.g19_notification_read(p_token text, p_id bigint, p_categories text[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  device g19_private.devices := g19_private.lock_device(p_token);
begin
  update g19_private.notification_inbox set read_at = clock_timestamp()
    where device_id = device.id and category = any(p_categories) and read_at is null
      and (p_id is null or id = p_id);
end;
$$;

create function g19_private.duty_reminder(p_now timestamptz)
returns table (duty_room integer, saturday date, due_at timestamptz)
language sql stable set search_path = '' as $$
  with local_clock as (select p_now at time zone 'Europe/Warsaw' as local_time)
  select ((((local_time::date + 1 - date '2026-10-31') / 7 + 2) % 4 + 4) % 4 + 1),
    local_time::date + 1, (local_time::date + time '14:00') at time zone 'Europe/Warsaw'
  from local_clock where extract(isodow from local_time) = 5 and local_time::time >= time '14:00';
$$;
revoke all on function g19_private.duty_reminder(timestamptz) from public, anon, authenticated, service_role;

-- Called by the scheduled worker. A Friday run may catch up after 14:00 Warsaw time.
create function public.g19_notification_tick(p_announcements jsonb, p_duty_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into g19_private.notification_inbox (device_id, category, event_key, title, description, target, created_at)
  select d.id, 'announcements', a.id, 'Ważne ogłoszenie', a.title,
    '#ogloszenie-' || a.id, a.published
  from jsonb_to_recordset(p_announcements) as a(id text, title text, published timestamptz, expires timestamptz)
  cross join g19_private.devices d join g19_private.rooms r on r.room = d.room and r.generation = d.generation
  where d.revoked_at is null and a.published <= statement_timestamp()
    and (a.expires is null or a.expires > statement_timestamp())
    and a.published >= d.created_at
  on conflict (device_id, category, event_key) do nothing;

  if p_duty_enabled then
    insert into g19_private.notification_inbox (device_id, category, event_key, title, description, target, created_at)
    select d.id, 'duties', saturday::text, 'Twój dyżur sprzątania',
      'Pokój nr ' || duty_room || ' · najbliższy weekend', '#calendar-title',
      due_at
    from g19_private.devices d join g19_private.rooms r on r.room = d.room and r.generation = d.generation
    cross join g19_private.duty_reminder(statement_timestamp())
    where d.revoked_at is null and d.room = duty_room
    on conflict (device_id, category, event_key) do nothing;
  end if;
end;
$$;

revoke all on function public.g19_notifications(text, text[]),
  public.g19_notification_read(text, bigint, text[]), public.g19_notification_tick(jsonb, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.g19_notifications(text, text[]),
  public.g19_notification_read(text, bigint, text[]) to anon;
grant execute on function public.g19_notification_tick(jsonb, boolean) to service_role;
notify pgrst, 'reload schema';
commit;
