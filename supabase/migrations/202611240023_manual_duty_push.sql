begin;

create table if not exists g19_private.manual_duty_push (
  request_id uuid primary key,
  room smallint not null check (room between 1 and 4),
  starts_on date not null,
  missed boolean not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table g19_private.manual_duty_push enable row level security;
revoke all on g19_private.manual_duty_push from public, anon, authenticated, service_role;
create index if not exists manual_duty_push_period on g19_private.manual_duty_push(room, starts_on, created_at desc);

create table if not exists g19_private.manual_duty_recipients (
  request_id uuid not null references g19_private.manual_duty_push,
  notification_id bigint primary key references g19_private.notification_inbox on delete cascade,
  outcome text check (outcome in ('sent', 'failed', 'gone'))
);
alter table g19_private.manual_duty_recipients enable row level security;
revoke all on g19_private.manual_duty_recipients from public, anon, authenticated, service_role;
create index if not exists manual_duty_recipients_request on g19_private.manual_duty_recipients(request_id);

create or replace function public.g19_manual_duty_delivery_active(p_notification bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(
    select 1 from g19_private.manual_duty_recipients m
    join g19_private.manual_duty_push job using (request_id)
    join g19_private.notification_inbox n on n.id = m.notification_id
    join g19_private.devices d on d.id = n.device_id and d.room = job.room and d.revoked_at is null
    join g19_private.rooms r on r.room = d.room and r.generation = d.generation
    join g19_private.push_subscriptions s on s.device_id = d.id
    join g19_private.push_delivery q on q.notification_id = n.id and q.endpoint = s.endpoint
    where m.notification_id = p_notification and m.outcome is null
      and not q.finished and q.lease is not null and n.received_at >= s.enabled_at
      and 'duties' = any(s.categories) and job.created_at >= now() - interval '3 minutes'
  );
$$;

create or replace function g19_private.manual_duty_result(p_request_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  with result as (
    select (select created_at from g19_private.manual_duty_push where request_id = p_request_id) as created_at,
      count(*) as total, count(*) filter (where outcome = 'sent') as sent,
      count(*) filter (where outcome is not null) as finished
    from g19_private.manual_duty_recipients where request_id = p_request_id
  )
  select jsonb_build_object('requestId', p_request_id, 'total', total, 'sent', sent,
    'status', case when total = 0 then 'none' when total = sent then 'sent'
      when finished < total and created_at >= now() - interval '4 minutes' then 'pending'
      when sent > 0 then 'partial' else 'failed' end)
  from result where created_at is not null;
$$;

create or replace function public.g19_web_admin_duty_push_result(p_room integer, p_starts_on date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform g19_private.require_web_admin();
  return g19_private.manual_duty_result((select request_id from g19_private.manual_duty_push
    where room = p_room and starts_on = p_starts_on order by created_at desc limit 1));
end;
$$;

create or replace function public.g19_web_admin_send_duty(p_room integer, p_starts_on date, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  previous g19_private.manual_duty_push;
  is_missed boolean;
  notification_title text;
  notification_body text;
  period text;
begin
  perform g19_private.require_web_admin();
  if not g19_private.valid_duty(p_room, p_starts_on) or p_request_id is null then
    raise sqlstate 'PT400' using message = 'duty_push_invalid';
  end if;
  -- Serialize confirmation for the same room and period across all admin tabs.
  perform pg_advisory_xact_lock(p_room, p_starts_on - date '2026-10-31');
  select * into previous from g19_private.manual_duty_push where request_id = p_request_id;
  if found then
    if (previous.room, previous.starts_on) is distinct from (p_room, p_starts_on) then
      raise sqlstate 'PT409' using message = 'duty_push_request_conflict';
    end if;
    return g19_private.manual_duty_result(p_request_id);
  end if;
  select * into previous from g19_private.manual_duty_push
    where room = p_room and starts_on = p_starts_on order by created_at desc limit 1;
  if found and g19_private.manual_duty_result(previous.request_id)->>'status' = 'pending' then
    return g19_private.manual_duty_result(previous.request_id);
  end if;

  select exists(select 1 from g19_private.missed_duties where room = p_room and starts_on = p_starts_on) into is_missed;
  period := to_char(p_starts_on, 'YYYY-MM-DD') || ' – ' || to_char(p_starts_on + 1, 'YYYY-MM-DD');
  notification_title := case when is_missed then 'Przypomnienie o niewykonanym dyżurze' else 'Przypomnienie o dyżurze' end;
  notification_body := 'Pokój nr ' || p_room || case when is_missed
    then ' — dyżur nadal wymaga wykonania (' || period || ').'
    else ' — przypomnienie o sprzątaniu (' || period || ').' end;
  insert into g19_private.manual_duty_push(request_id, room, starts_on, missed)
    values (p_request_id, p_room, p_starts_on, is_missed);
  with recipients as (
    insert into g19_private.notification_inbox(device_id, category, event_key, title, description, target, created_at)
    select d.id, 'duties', 'manual:' || p_request_id, notification_title, notification_body, '#calendar-title', clock_timestamp()
    from g19_private.devices d join g19_private.rooms r on r.room = d.room and r.generation = d.generation
    join g19_private.push_subscriptions s on s.device_id = d.id
    where d.room = p_room and d.revoked_at is null and 'duties' = any(s.categories)
    returning id
  )
  insert into g19_private.manual_duty_recipients(request_id, notification_id)
    select p_request_id, id from recipients;
  return g19_private.manual_duty_result(p_request_id);
end;
$$;

revoke all on function public.g19_manual_duty_delivery_active(bigint), g19_private.manual_duty_result(uuid),
  public.g19_web_admin_send_duty(integer, date, uuid), public.g19_web_admin_duty_push_result(integer, date)
  from public, anon, authenticated, service_role;
grant execute on function public.g19_manual_duty_delivery_active(bigint) to service_role;
grant execute on function public.g19_web_admin_send_duty(integer, date, uuid),
  public.g19_web_admin_duty_push_result(integer, date) to authenticated;

create or replace function public.g19_push_take() returns jsonb language sql security definer set search_path='' as $$
 with available as (
  select n.id,n.event_key,s.endpoint,s.p256dh,s.auth,n.title,n.category,n.target,n.description,n.announcement_push_summary,n.private_conversation_id,n.private_message_id,job.request_id as manual_request,job.room as manual_room,job.starts_on as manual_date,job.missed as manual_missed
  from g19_private.notification_inbox n join g19_private.push_subscriptions s using(device_id)
  join g19_private.devices d on d.id=n.device_id and d.revoked_at is null
  join g19_private.rooms r on r.room=d.room and r.generation=d.generation
  left join g19_private.push_delivery q on q.notification_id=n.id
  left join g19_private.manual_duty_recipients manual on manual.notification_id=n.id
  left join g19_private.manual_duty_push job on job.request_id=manual.request_id
  where n.category=any(s.categories) and(n.category<>'announcements' or g19_private.announcement_is_active(n.event_key,true))
  and(n.private_message_id is null or public.g19_private_delivery_active(n.id))
  and n.received_at>=s.enabled_at
  and ((job.request_id is not null and d.room=job.room and manual.outcome is null
     and q.notification_id is null and job.created_at>=now()-interval '3 minutes')
   or (job.request_id is null and n.read_at is null and n.presented_at is null
  and(case when n.private_message_id is null then not exists(select 1 from g19_private.notification_presence presence where presence.device_id=n.device_id and presence.active_until>statement_timestamp() and presence.active_since<=n.received_at)
   else not exists(select 1 from g19_private.private_presence presence where presence.device_id=n.device_id and presence.conversation_id=n.private_conversation_id and presence.active_until>statement_timestamp() and presence.active_since<=n.received_at) end)
  and n.received_at>=now()-interval '12 hours' and(q.notification_id is null or(not q.finished and q.attempts<5 and q.next_attempt_at<=now()))))
  order by n.created_at limit 12 for update of n skip locked
 ), claimed as (
  insert into g19_private.push_delivery(notification_id,attempts,next_attempt_at,lease,endpoint)
  select id,1,now()+interval '3 minutes',gen_random_uuid(),endpoint from available
  on conflict(notification_id) do update set attempts=push_delivery.attempts+1,next_attempt_at=now()+interval '3 minutes',lease=gen_random_uuid(),endpoint=excluded.endpoint
   where not push_delivery.finished and push_delivery.attempts<5 and push_delivery.next_attempt_at<=now()
  returning notification_id,lease
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',a.id::text,'lease',c.lease,'endpoint',a.endpoint,'p256dh',a.p256dh,'auth',a.auth,
 'title',a.title,'category',a.category,'target',a.target,'room',coalesce(private_author.sender_room,author.room),'message',m.body,
  'kind',case when a.manual_request is not null then 'manual_duty' when a.private_message_id is not null then 'private' else 'general' end,
 'manual_duty_room',a.manual_room,'manual_duty_date',a.manual_date,'manual_duty_missed',a.manual_missed,
 'duty_saturday',case when a.category='duties' then a.event_key end,
 'announcement_title',case when a.category='announcements' then a.description end,'announcement_summary',a.announcement_push_summary)),'[]'::jsonb)
 from claimed c join available a on a.id=c.notification_id
 left join g19_private.messages m on m.id=case when a.category='messages' and a.private_message_id is null then a.event_key::bigint end
 left join g19_private.devices author on author.id=m.device_id
 left join g19_private.private_messages private_author on private_author.id=a.private_message_id;
$$;

create or replace function public.g19_push_finish(p_id bigint, p_lease uuid, p_outcome text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  sent_endpoint text;
  manual boolean;
  recipient uuid;
begin
  if p_outcome is null or p_outcome not in ('sent','gone','retry','failed') then
    raise sqlstate 'PT400' using message = 'delivery_outcome_invalid';
  end if;
  select exists(select 1 from g19_private.manual_duty_recipients where notification_id = p_id) into manual;
  if manual and p_outcome = 'retry' then p_outcome := 'failed'; end if;
  update g19_private.push_delivery set finished = p_outcome <> 'retry' or attempts >= 5,
    next_attempt_at = now() + make_interval(mins => attempts * 3), lease = null
    where notification_id = p_id and lease = p_lease returning endpoint into sent_endpoint;
  if not found then return; end if;
  if manual then
    update g19_private.manual_duty_recipients set outcome = p_outcome
    where notification_id = p_id;
  end if;
  if p_outcome = 'gone' then
    select device_id into recipient from g19_private.notification_inbox where id = p_id;
    delete from g19_private.push_subscriptions where device_id = recipient and endpoint = sent_endpoint;
  end if;
end;
$$;

commit;
