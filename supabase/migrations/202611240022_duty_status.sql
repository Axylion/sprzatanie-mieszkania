begin;

create table if not exists g19_private.missed_duties (
  room smallint not null check (room between 1 and 4),
  starts_on date not null,
  primary key (room, starts_on)
);
alter table g19_private.missed_duties enable row level security;
revoke all on g19_private.missed_duties from public, anon, authenticated, service_role;

create or replace function g19_private.valid_duty(p_room integer, p_starts_on date)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(case when isfinite(p_starts_on) then
    extract(isodow from p_starts_on) = 6
    and mod(mod((p_starts_on - date '2026-10-31') / 7 + 2, 4) + 4, 4) + 1 = p_room
    else false end, false);
$$;
revoke all on function g19_private.valid_duty(integer, date) from public, anon, authenticated, service_role;

create or replace function public.g19_missed_duties()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('room', room, 'startsOn', starts_on)
    order by starts_on, room), '[]'::jsonb)
  from g19_private.missed_duties;
$$;

create or replace function public.g19_web_admin_save_duty(p_room integer, p_starts_on date, p_missed boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform g19_private.require_web_admin();
  if not g19_private.valid_duty(p_room, p_starts_on) or p_missed is null
      or (p_missed and p_starts_on > (statement_timestamp() at time zone 'Europe/Warsaw')::date) then
    raise sqlstate 'PT400' using message = 'duty_status_invalid';
  end if;
  if p_missed then
    insert into g19_private.missed_duties (room, starts_on)
    values (p_room, p_starts_on) on conflict (room, starts_on) do nothing;
  else
    delete from g19_private.missed_duties where room = p_room and starts_on = p_starts_on;
  end if;
  return p_missed;
end;
$$;
revoke all on function public.g19_missed_duties(),
  public.g19_web_admin_save_duty(integer, date, boolean) from public, anon, authenticated, service_role;
grant execute on function public.g19_missed_duties() to anon, authenticated;
grant execute on function public.g19_web_admin_save_duty(integer, date, boolean) to authenticated;

commit;
