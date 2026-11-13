begin;

create table g19_private.push_subscriptions (
  device_id uuid primary key references g19_private.devices,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  categories text[] not null,
  enabled_at timestamptz not null default clock_timestamp()
);
create table g19_private.push_delivery (
  notification_id bigint primary key references g19_private.notification_inbox,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease uuid,
  endpoint text not null,
  finished boolean not null default false
);
alter table g19_private.push_subscriptions enable row level security;
alter table g19_private.push_delivery enable row level security;
revoke all on g19_private.push_subscriptions, g19_private.push_delivery from public, anon, authenticated, service_role;

create function g19_private.drop_revoked_subscription()
returns trigger language plpgsql set search_path = '' as $$
begin
  delete from g19_private.push_subscriptions where device_id = new.id;
  return new;
end;
$$;
revoke all on function g19_private.drop_revoked_subscription() from public, anon, authenticated, service_role;
create trigger g19_drop_revoked_subscription after update of revoked_at on g19_private.devices
  for each row when (old.revoked_at is null and new.revoked_at is not null)
  execute function g19_private.drop_revoked_subscription();

create function public.g19_push_subscription(p_token text, p_endpoint text, p_p256dh text, p_auth text, p_categories text[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  device g19_private.devices := g19_private.lock_device(p_token);
begin
  if p_endpoint is null then
    delete from g19_private.push_subscriptions where device_id = device.id;
    return;
  end if;
  -- Only known browser push services. Never send to a caller-selected host.
  if length(p_endpoint) > 2048
     or p_endpoint !~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|([a-z0-9-]+\.)?push\.apple\.com|([a-z0-9-]+\.)?notify\.windows\.com)/[^[:space:]#]+$'
     or p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_-]{87}$'
     or p_auth is null or p_auth !~ '^[A-Za-z0-9_-]{22}$'
     or p_categories is null or cardinality(p_categories) not between 1 and 3
     or not (p_categories <@ array['messages','announcements','duties']) then
    raise sqlstate 'PT400' using message = 'subscription_invalid';
  end if;

  insert into g19_private.push_subscriptions (device_id, endpoint, p256dh, auth, categories)
    values (device.id, p_endpoint, p_p256dh, p_auth, p_categories)
  on conflict (device_id) do update set endpoint = excluded.endpoint, p256dh = excluded.p256dh,
    auth = excluded.auth, categories = excluded.categories,
    enabled_at = case when push_subscriptions.endpoint = excluded.endpoint then push_subscriptions.enabled_at
                      else excluded.enabled_at end;
end;
$$;

-- Exclusive leases prevent concurrent workers from sending the same event.
create function public.g19_push_take()
returns jsonb language sql security definer set search_path = '' as $$
  with available as (
    select n.id, s.endpoint, s.p256dh, s.auth, n.title, n.category, n.target
    from g19_private.notification_inbox n
    join g19_private.push_subscriptions s using (device_id)
    join g19_private.devices d on d.id = n.device_id and d.revoked_at is null
    join g19_private.rooms r on r.room = d.room and r.generation = d.generation
    left join g19_private.push_delivery q on q.notification_id = n.id
    where n.category = any(s.categories) and n.read_at is null and n.created_at >= s.enabled_at
      and n.created_at >= now() - interval '12 hours'
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

create function public.g19_push_finish(p_id bigint, p_lease uuid, p_outcome text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  sent_endpoint text;
  recipient uuid;
begin
  if p_outcome is null or p_outcome not in ('sent','gone','retry','failed') then
    raise sqlstate 'PT400' using message = 'delivery_outcome_invalid';
  end if;
  update g19_private.push_delivery set finished = p_outcome <> 'retry' or attempts >= 5,
    next_attempt_at = now() + make_interval(mins => attempts * 3), lease = null
    where notification_id = p_id and lease = p_lease returning endpoint into sent_endpoint;
  if found and p_outcome = 'gone' then
    select device_id into recipient from g19_private.notification_inbox where id = p_id;
    delete from g19_private.push_subscriptions where device_id = recipient and endpoint = sent_endpoint;
  end if;
end;
$$;

revoke all on function public.g19_push_subscription(text, text, text, text, text[]),
  public.g19_push_take(), public.g19_push_finish(bigint, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.g19_push_subscription(text, text, text, text, text[]) to anon;
grant execute on function public.g19_push_take(), public.g19_push_finish(bigint, uuid, text) to service_role;
notify pgrst, 'reload schema';
commit;
