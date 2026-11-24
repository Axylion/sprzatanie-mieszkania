begin;

-- Keep the legacy tick callable until the worker is switched. The new entry point
-- prepares announcements from the database and reuses duties and inbox deduplication.
create function public.g19_db_notification_tick(p_duty_enabled boolean)
returns void language sql security definer set search_path = '' as $$
  select public.g19_notification_tick(coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'title', a.push_title, 'summary', a.push_body,
      'published', a.published_at, 'expires', a.expires_at
    ))
    from g19_private.announcements a
    where a.state = 'published' and a.push_title is not null
      and a.published_at <= statement_timestamp()
      and (a.expires_at is null or a.expires_at > statement_timestamp())
  ), '[]'::jsonb), p_duty_enabled);
$$;

create function g19_private.announcement_is_active(p_id text, p_for_push boolean)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from g19_private.announcements a
    where a.id = p_id and a.state = 'published'
      and (not p_for_push or a.push_title is not null) and a.published_at <= statement_timestamp()
      and (a.expires_at is null or a.expires_at > statement_timestamp())
  );
$$;
revoke all on function g19_private.announcement_is_active(text,boolean) from public, anon, authenticated, service_role;

create function public.g19_announcement_delivery_active(p_id bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from g19_private.notification_inbox n
    where n.id = p_id and n.category = 'announcements'
      and g19_private.announcement_is_active(n.event_key, true)
  );
$$;

revoke all on function public.g19_db_notification_tick(boolean), public.g19_announcement_delivery_active(bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.g19_db_notification_tick(boolean), public.g19_announcement_delivery_active(bigint)
  to service_role;
create or replace function public.g19_push_take()
returns jsonb language sql security definer set search_path = '' as $$
  with available as (
    select n.id, n.event_key, s.endpoint, s.p256dh, s.auth, n.title, n.category, n.target, n.description, n.announcement_push_summary
    from g19_private.notification_inbox n
    join g19_private.push_subscriptions s using (device_id)
    join g19_private.devices d on d.id = n.device_id and d.revoked_at is null
    join g19_private.rooms r on r.room = d.room and r.generation = d.generation
    left join g19_private.push_delivery q on q.notification_id = n.id
    where n.category = any(s.categories)
      and (n.category <> 'announcements' or g19_private.announcement_is_active(n.event_key, true))
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
    'title', a.title, 'category', a.category, 'target', a.target,
    'room', author.room, 'message', m.body,
    'duty_saturday', case when a.category = 'duties' then a.event_key end,
    'announcement_title', case when a.category = 'announcements' then a.description end,
    'announcement_summary', a.announcement_push_summary
  )), '[]'::jsonb)
  from claimed c join available a on a.id = c.notification_id
  left join g19_private.messages m on m.id = case when a.category = 'messages' then a.event_key::bigint end
  left join g19_private.devices author on author.id = m.device_id;
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
      and (category <> 'announcements' or g19_private.announcement_is_active(event_key, false))
      and g19_private.notification_enabled(device.room, device.generation, category) and read_at is null;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id::text, 'title', n.title, 'description', n.description, 'target', n.target,
    'category', n.category, 'createdAt', n.created_at, 'receivedAt', n.received_at, 'read', n.read_at is not null
  ) order by n.created_at desc, n.id desc), '[]'::jsonb) into result
  from (
    select * from g19_private.notification_inbox
    where device_id = device.id and category = any(p_categories)
      and (category <> 'announcements' or g19_private.announcement_is_active(event_key, false))
      and g19_private.notification_enabled(device.room, device.generation, category)
    order by created_at desc, id desc limit 50
  ) n;
  return jsonb_build_object('items', result, 'unread', unread);
end;
$$;

notify pgrst, 'reload schema';
commit;
