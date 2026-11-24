-- Read only. Run in SQL Editor for goleszan-19-test (pbsubdmuupwmtgzncxmh).
-- Limit this to the relevant room and time window in the Warsaw time zone.
with settings as (
  select 1 as room, now() - interval '1 day' as since
),
recent as (
  select j.request_id, j.room, j.starts_on, j.created_at
  from g19_private.manual_duty_push j
  join settings s on s.room = j.room and j.created_at >= s.since
  order by j.created_at desc
  limit 20
)
select j.room, j.starts_on,
  j.created_at at time zone 'Europe/Warsaw' as created_warsaw,
  now() >= j.created_at + interval '4 minutes' as expired,
  g19_private.manual_duty_result(j.request_id)->>'status' as rpc_status,
  count(m.notification_id) as queued,
  count(q.notification_id) as claimed,
  count(*) filter (where m.outcome = 'sent') as provider_accepted,
  count(*) filter (where m.outcome = 'gone') as subscription_gone,
  count(*) filter (where m.outcome = 'failed') as failed,
  count(*) filter (where q.notification_id is not null and m.outcome is null) as claimed_without_outcome,
  count(*) filter (where m.notification_id is not null and d.revoked_at is null and r.room is not null
    and 'duties' = any(s.categories) and n.received_at >= s.enabled_at) as still_eligible
from recent j
left join g19_private.manual_duty_recipients m on m.request_id = j.request_id
left join g19_private.notification_inbox n on n.id = m.notification_id
left join g19_private.push_delivery q on q.notification_id = m.notification_id
left join g19_private.devices d on d.id = n.device_id and d.room = j.room
left join g19_private.rooms r on r.room = d.room and r.generation = d.generation
left join g19_private.push_subscriptions s on s.device_id = d.id
group by j.request_id, j.room, j.starts_on, j.created_at
order by j.created_at desc;
