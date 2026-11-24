begin;

-- Keep the client's idempotency key when concurrent admin requests share a job.
create table if not exists g19_private.manual_duty_push_aliases (
  request_id uuid primary key,
  job_id uuid not null references g19_private.manual_duty_push
);
alter table g19_private.manual_duty_push_aliases enable row level security;
revoke all on g19_private.manual_duty_push_aliases from public, anon, authenticated, service_role;

create or replace function g19_private.manual_duty_result(p_request_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  with result as (
    select (select created_at from g19_private.manual_duty_push where request_id = p_request_id) as created_at,
      count(*) as total, count(*) filter (where outcome = 'sent') as sent,
      count(*) filter (where outcome is not null) as finished
    from g19_private.manual_duty_recipients where request_id = p_request_id
  )
  select jsonb_build_object('requestId', p_request_id, 'total', total, 'sent', sent,
    'expiresAt', created_at + interval '4 minutes',
    'status', case when total = 0 then 'none' when total = sent then 'sent'
      when finished < total and created_at >= now() - interval '4 minutes' then 'pending'
      when sent > 0 then 'partial' else 'failed' end)
  from result where created_at is not null;
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
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
  -- Serialize confirmation for the same room and period across all admin tabs.
  perform pg_advisory_xact_lock(p_room, p_starts_on - date '2026-10-31');
  select job.* into previous
  from g19_private.manual_duty_push job
  where job.request_id = coalesce(
    (select a.job_id from g19_private.manual_duty_push_aliases a where a.request_id = p_request_id),
    p_request_id
  );
  if found then
    if (previous.room, previous.starts_on) is distinct from (p_room, p_starts_on) then
      raise sqlstate 'PT409' using message = 'duty_push_request_conflict';
    end if;
    return g19_private.manual_duty_result(previous.request_id);
  end if;
  select * into previous from g19_private.manual_duty_push
    where room = p_room and starts_on = p_starts_on order by created_at desc limit 1;
  if found and g19_private.manual_duty_result(previous.request_id)->>'status' = 'pending' then
    insert into g19_private.manual_duty_push_aliases(request_id, job_id)
      values (p_request_id, previous.request_id);
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

create or replace function public.g19_web_admin_duty_push_request(p_request_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform g19_private.require_web_admin();
  return g19_private.manual_duty_result(coalesce(
    (select a.job_id from g19_private.manual_duty_push_aliases a where a.request_id = p_request_id),
    p_request_id
  ));
end;
$$;
revoke all on function public.g19_web_admin_duty_push_request(uuid) from public, anon, authenticated, service_role;
grant execute on function public.g19_web_admin_duty_push_request(uuid) to authenticated;

commit;
