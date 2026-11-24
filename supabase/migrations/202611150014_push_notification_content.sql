begin;

-- Keep notification inbox descriptions and existing queued rows compatible.
alter table g19_private.notification_inbox add column announcement_push_summary text;

create or replace function public.g19_notification_tick(p_announcements jsonb, p_duty_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into g19_private.notification_inbox (device_id, category, event_key, title, description, target, created_at, announcement_push_summary)
  select d.id, 'announcements', a.id, 'Ważne ogłoszenie', a.title,
    '#ogloszenie-' || a.id, a.published, a.summary
  from jsonb_to_recordset(p_announcements) as a(id text, title text, published timestamptz, expires timestamptz, summary text)
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
    select n.id, n.event_key, s.endpoint, s.p256dh, s.auth, n.title, n.category, n.target, n.description, n.announcement_push_summary
    from g19_private.notification_inbox n
    join g19_private.push_subscriptions s using (device_id)
    join g19_private.devices d on d.id = n.device_id and d.revoked_at is null
    join g19_private.rooms r on r.room = d.room and r.generation = d.generation
    left join g19_private.push_delivery q on q.notification_id = n.id
    where n.category = any(s.categories)
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

notify pgrst, 'reload schema';
commit;
