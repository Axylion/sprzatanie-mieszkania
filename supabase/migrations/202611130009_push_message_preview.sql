begin;

-- Extend the service-role delivery lease only. The resident inbox stays unchanged.
create or replace function public.g19_push_take()
returns jsonb language sql security definer set search_path = '' as $$
  with available as (
    select n.id, n.event_key, s.endpoint, s.p256dh, s.auth, n.title, n.category, n.target
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
    'title', a.title, 'category', a.category, 'target', a.target,
    'room', author.room, 'message', m.body
  )), '[]'::jsonb)
  from claimed c join available a on a.id = c.notification_id
  left join g19_private.messages m on m.id = case when a.category = 'messages' then a.event_key::bigint end
  left join g19_private.devices author on author.id = m.device_id;
$$;

revoke all on function public.g19_push_take() from public, anon, authenticated;
grant execute on function public.g19_push_take() to service_role;

notify pgrst, 'reload schema';
commit;
