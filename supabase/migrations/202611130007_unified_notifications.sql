begin;

create table g19_private.notification_preferences (
  room smallint not null references g19_private.rooms,
  generation integer not null,
  categories text[] not null,
  primary key (room, generation)
);

create table g19_private.notification_presence (
  device_id uuid not null references g19_private.devices,
  tab uuid not null,
  active_since timestamptz not null,
  active_until timestamptz not null,
  primary key (device_id, tab)
);

alter table g19_private.notification_inbox
  add column received_at timestamptz not null default statement_timestamp(),
  add column presented_at timestamptz;
alter table g19_private.notification_preferences enable row level security;
alter table g19_private.notification_presence enable row level security;
revoke all on g19_private.notification_preferences, g19_private.notification_presence
  from public, anon, authenticated, service_role;

create function g19_private.notification_enabled(p_room smallint, p_generation integer, p_category text)
returns boolean language sql stable set search_path = '' as $$
  select coalesce((select p_category = any(categories) from g19_private.notification_preferences
    where room = p_room and generation = p_generation), true);
$$;
revoke all on function g19_private.notification_enabled(smallint, integer, text)
  from public, anon, authenticated, service_role;

-- NULL reads shared settings; the first active v11 client can import its previous choices.
create function public.g19_notification_preferences(p_token text, p_categories text[], p_initialize boolean)
returns text[] language plpgsql security definer set search_path = '' as $$
declare
  device g19_private.devices := g19_private.lock_device(p_token);
begin
  if p_categories is not null then
    if cardinality(p_categories) > 3 or not (p_categories <@ array['messages','announcements','duties']) then
      raise sqlstate 'PT400' using message = 'categories_invalid';
    end if;

    insert into g19_private.notification_preferences (room, generation, categories)
    values (device.room, device.generation, p_categories)
    on conflict (room, generation) do update set categories = excluded.categories
      where not coalesce(p_initialize, false);
  end if;

  return (select categories from g19_private.notification_preferences
    where room = device.room and generation = device.generation);
end;
$$;

-- A tab reports presence only while visible and recently active. A message is
-- marked as viewed only after the chat actually loaded through that message.
create function public.g19_notification_activity(p_token text, p_tab uuid, p_active boolean, p_seen bigint, p_presented bigint[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  device g19_private.devices := g19_private.lock_device(p_token);
begin
  delete from g19_private.notification_presence
    where device_id = device.id and (active_until <= statement_timestamp() or (tab = p_tab and not p_active));

  if p_active then
    insert into g19_private.notification_presence (device_id, tab, active_since, active_until)
    values (device.id, p_tab, statement_timestamp(), statement_timestamp() + interval '40 seconds')
    on conflict (device_id, tab) do update set active_until = excluded.active_until;
  end if;

  if p_active and cardinality(p_presented) between 1 and 50 then
    update g19_private.notification_inbox n set presented_at = statement_timestamp()
    where n.device_id = device.id and n.id = any(p_presented) and n.presented_at is null;
  end if;

  if p_active and p_seen > 0 then
    update g19_private.notification_inbox n set read_at = statement_timestamp()
    where n.device_id = device.id and n.category = 'messages' and n.read_at is null
      and n.event_key::bigint <= p_seen;
  end if;
end;
$$;

revoke all on function public.g19_notification_preferences(text, text[], boolean),
  public.g19_notification_activity(text, uuid, boolean, bigint, bigint[])
  from public, anon, authenticated, service_role;
grant execute on function public.g19_notification_preferences(text, text[], boolean),
  public.g19_notification_activity(text, uuid, boolean, bigint, bigint[]) to anon;

create or replace function g19_private.notify_message()
returns trigger language plpgsql set search_path = '' as $$
begin
  insert into g19_private.notification_inbox (device_id, category, event_key, title, description, target, created_at)
  select d.id, 'messages', new.id::text, 'Nowa wiadomość',
    'Pokój nr ' || author.room || ' · Dyskusje', '#dyskusje', new.created_at
  from g19_private.devices author
  join g19_private.devices d on (d.room, d.generation) <> (author.room, author.generation)
  join g19_private.rooms r on r.room = d.room and r.generation = d.generation
  where author.id = new.device_id and d.revoked_at is null
    and g19_private.notification_enabled(d.room, d.generation, 'messages')
  on conflict (device_id, category, event_key) do nothing;
  return new;
end;
$$;
create or replace function public.g19_notification_tick(p_announcements jsonb, p_duty_enabled boolean)
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
    and g19_private.notification_enabled(d.room, d.generation, 'announcements')
  on conflict (device_id, category, event_key) do nothing;

  if p_duty_enabled then
    insert into g19_private.notification_inbox (device_id, category, event_key, title, description, target, created_at)
    select d.id, 'duties', saturday::text, 'Twój dyżur sprzątania',
      'Pokój nr ' || duty_room || ' · najbliższy weekend', '#calendar-title',
      due_at
    from g19_private.devices d join g19_private.rooms r on r.room = d.room and r.generation = d.generation
    cross join g19_private.duty_reminder(statement_timestamp())
    where d.revoked_at is null and d.room = duty_room
      and g19_private.notification_enabled(d.room, d.generation, 'duties')
    on conflict (device_id, category, event_key) do nothing;
  end if;
end;
$$;

create or replace function public.g19_push_take()
returns jsonb language sql security definer set search_path = '' as $$
  with available as (
    select n.id, s.endpoint, s.p256dh, s.auth, n.title, n.category, n.target
    from g19_private.notification_inbox n
    join g19_private.push_subscriptions s using (device_id)
    join g19_private.devices d on d.id = n.device_id and d.revoked_at is null
    join g19_private.rooms r on r.room = d.room and r.generation = d.generation
    left join g19_private.push_delivery q on q.notification_id = n.id
    left join g19_private.notification_preferences p on p.room = d.room and p.generation = d.generation
    where n.category = any(coalesce(p.categories, s.categories))
      and n.read_at is null and n.presented_at is null and n.received_at >= s.enabled_at
      and not exists (select 1 from g19_private.notification_presence presence
        where presence.device_id = n.device_id and presence.active_until > statement_timestamp()
          and presence.active_since <= n.received_at)
      and n.received_at >= now() - interval '12 hours'
      and (q.notification_id is null or (not q.finished and q.attempts < 5 and q.next_attempt_at <= now()))
    order by n.created_at limit 12
    for update of n skip locked
  ), claimed as (
    insert into g19_private.push_delivery (notification_id, attempts, next_attempt_at, lease, endpoint)
    select id, 1, now() + interval '3 minutes', gen_random_uuid(), endpoint from available
    on conflict (notification_id) do update
      set attempts = push_delivery.attempts + 1, next_attempt_at = now() + interval '3 minutes',
          lease = gen_random_uuid(), endpoint = excluded.endpoint
      where not push_delivery.finished and push_delivery.attempts < 5 and push_delivery.next_attempt_at <= now()
    returning notification_id, lease
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id::text, 'lease', c.lease, 'endpoint', a.endpoint, 'p256dh', a.p256dh, 'auth', a.auth,
    'title', a.title, 'category', a.category, 'target', a.target
  )), '[]'::jsonb)
  from claimed c join available a on a.id = c.notification_id;
$$;

create or replace function public.g19_notifications(p_token text, p_categories text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  device g19_private.devices := g19_private.lock_device(p_token);
  result jsonb;
  unread bigint;
begin
  select count(*) into unread from g19_private.notification_inbox
    where device_id = device.id and category = any(p_categories)
      and g19_private.notification_enabled(device.room, device.generation, category) and read_at is null;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id::text, 'title', n.title, 'description', n.description, 'target', n.target,
    'category', n.category, 'createdAt', n.created_at, 'receivedAt', n.received_at, 'read', n.read_at is not null
  ) order by n.created_at desc, n.id desc), '[]'::jsonb) into result
  from (
    select * from g19_private.notification_inbox
    where device_id = device.id and category = any(p_categories)
      and g19_private.notification_enabled(device.room, device.generation, category)
    order by created_at desc, id desc limit 50
  ) n;
  return jsonb_build_object('items', result, 'unread', unread);
end;
$$;

notify pgrst, 'reload schema';
commit;
