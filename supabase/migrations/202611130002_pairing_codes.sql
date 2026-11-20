begin;

alter table g19_private.pairings
  add column numeric_code text unique check (numeric_code ~ '^[0-9]{6}$');

create table g19_private.pair_attempts (
  room smallint primary key references g19_private.rooms,
  generation integer not null,
  window_start timestamptz not null,
  attempts integer not null
);
alter table g19_private.pair_attempts enable row level security;
revoke all on g19_private.pair_attempts from public, anon, authenticated, service_role;

-- In-flight requests from the old preview cannot be confirmed by the new UI.
update g19_private.pairings set state = 'cancelled'
where state in ('pending', 'approved');
drop function public.g19_pair_decide(text, uuid, boolean);

create or replace function public.g19_pair_start(p_room integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  target g19_private.rooms;
  request g19_private.pairings;
  secret text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  random_bytes bytea;
  sample integer;
  code text;
begin
  select * into target from g19_private.rooms where room = p_room for update;
  if not found or not target.occupied then raise sqlstate 'PT409' using message = 'room_free'; end if;
  if (select count(*) from g19_private.pairings where room = p_room
      and created_at > clock_timestamp() - interval '1 minute') >= 12 then
    raise sqlstate 'PT429' using message = 'pair_rate_limit';
  end if;
  delete from g19_private.pairings where room = p_room and expires_at < clock_timestamp() - interval '1 day';

  for attempt in 1..32 loop
    -- Draw 24 random bits and reject the incomplete range to avoid modulo bias.
    random_bytes := uuid_send(gen_random_uuid());
    sample := get_byte(random_bytes, 0) * 65536 + get_byte(random_bytes, 1) * 256 + get_byte(random_bytes, 2);
    continue when sample >= 16000000;
    code := lpad((sample % 1000000)::text, 6, '0');
    insert into g19_private.pairings (room, generation, claim_hash, numeric_code)
      values (p_room, target.generation, g19_private.token_hash(secret), code)
      on conflict (numeric_code) do nothing returning * into request;
    if found then
      return jsonb_build_object('code', code, 'secret', secret, 'room', p_room,
        'expiresAt', request.expires_at, 'serverNow', clock_timestamp());
    end if;
  end loop;
  raise sqlstate 'PT503' using message = 'pair_code_unavailable';
end;
$$;

create function public.g19_pair_decide(p_token text, p_code text, p_approve boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  device g19_private.devices := g19_private.lock_device(p_token);
  request g19_private.pairings;
  checked_at timestamptz := clock_timestamp();
  bucket g19_private.pair_attempts;
begin
  insert into g19_private.pair_attempts (room, generation, window_start, attempts)
    values (device.room, device.generation, checked_at, 0)
    on conflict (room) do nothing;
  select * into bucket from g19_private.pair_attempts where room = device.room for update;
  checked_at := clock_timestamp();
  if bucket.generation <> device.generation or bucket.window_start <= checked_at - interval '1 minute' then
    bucket.generation := device.generation;
    bucket.window_start := checked_at;
    bucket.attempts := 0;
  end if;
  if bucket.attempts >= 6 then
    return jsonb_build_object('state', 'rate_limited');
  end if;
  update g19_private.pair_attempts set generation = bucket.generation,
    window_start = bucket.window_start, attempts = bucket.attempts + 1 where room = device.room;

  -- Return failed attempts as results so the counter is committed.
  if p_code is null or p_code !~ '^[0-9]{6}$' or p_approve is null then
    return jsonb_build_object('state', 'unavailable');
  end if;
  select * into request from g19_private.pairings
    where numeric_code = p_code and room = device.room and generation = device.generation for update;
  if not found or request.state <> 'pending' or request.expires_at <= clock_timestamp() then
    return jsonb_build_object('state', 'unavailable');
  end if;
  update g19_private.pairings set state = case when p_approve then 'approved' else 'rejected' end
    where id = request.id returning * into request;
  return jsonb_build_object('state', request.state);
end;
$$;

create function public.g19_pair_cancel(p_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  request g19_private.pairings;
  current_generation integer;
begin
  select * into request from g19_private.pairings where claim_hash = g19_private.token_hash(p_secret);
  if not found then return jsonb_build_object('state', 'expired'); end if;
  select generation into current_generation from g19_private.rooms where room = request.room for share;
  select * into request from g19_private.pairings where id = request.id for update;
  if not found or request.expires_at <= clock_timestamp() then
    return jsonb_build_object('state', 'expired');
  end if;
  if current_generation <> request.generation then
    return jsonb_build_object('state', 'cancelled');
  end if;
  if request.state in ('pending', 'approved') then
    update g19_private.pairings set state = 'cancelled' where id = request.id returning * into request;
  end if;
  return jsonb_build_object('state', request.state);
end;
$$;

revoke all on function public.g19_pair_start(integer), public.g19_pair_decide(text, text, boolean),
  public.g19_pair_cancel(text) from public, anon, authenticated, service_role;
grant execute on function public.g19_pair_start(integer), public.g19_pair_decide(text, text, boolean),
  public.g19_pair_cancel(text) to anon;

notify pgrst, 'reload schema';
commit;
