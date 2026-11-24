begin;

-- Existing registrations retain their real timestamps. Their classification is
-- unknown unless the server observed the browser ID at enrollment.
alter table g19_private.devices add column browser_known boolean;
create index g19_device_browser_history on g19_private.devices (browser_hash)
  where browser_hash is not null;

create function g19_private.classify_browser()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.browser_hash is not null then
    -- Serialize registrations of the same identifier, including across rooms.
    perform pg_advisory_xact_lock(hashtextextended(encode(new.browser_hash, 'hex'), 19));
    select exists(select 1 from g19_private.devices where browser_hash = new.browser_hash)
      into new.browser_known;
  end if;
  return new;
end;
$$;
revoke all on function g19_private.classify_browser() from public, anon, authenticated, service_role;
create trigger g19_classify_browser before insert on g19_private.devices
  for each row execute function g19_private.classify_browser();

create table g19_private.blocked_attempts (
  id bigint generated always as identity primary key,
  room smallint not null references g19_private.rooms,
  generation integer not null,
  device_id uuid references g19_private.devices,
  occurred_at timestamptz not null default clock_timestamp()
);
create index g19_blocked_attempt_history on g19_private.blocked_attempts (room, occurred_at desc);
alter table g19_private.blocked_attempts enable row level security;
revoke all on g19_private.blocked_attempts from public, anon, authenticated, service_role;

create function g19_private.record_blocked_attempt(p_room smallint, p_generation integer, p_hash bytea)
returns void language sql set search_path = '' as $$
  insert into g19_private.blocked_attempts(room, generation, device_id)
  select p_room, p_generation, device.id
  from (select 1) event
  left join lateral (select id from g19_private.devices where room = p_room and browser_hash = p_hash
    order by created_at desc, id desc limit 1) device on true;
$$;
revoke all on function g19_private.record_blocked_attempt(smallint,integer,bytea) from public, anon, authenticated, service_role;

-- Return a structured denial so the transaction can persist the event.
create or replace function public.g19_bind(p_room integer, p_proof text, p_browser text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  target g19_private.rooms;
  device g19_private.devices;
  proof_hash bytea := g19_private.token_hash(p_proof);
  nonce uuid;
  token text;
begin
  if proof_hash is null then raise sqlstate 'PT400' using message = 'proof_invalid'; end if;
  select * into target from g19_private.rooms where room = p_room for update;
  if not found then raise sqlstate 'PT400' using message = 'room_invalid'; end if;

  if p_browser is not null and g19_private.token_hash(p_browser) is null then
    raise sqlstate 'PT400' using message = 'browser_invalid';
  end if;
  if exists (select 1 from g19_private.blocked_browsers
      where room = p_room and browser_hash = g19_private.token_hash(p_browser)) then
    perform g19_private.record_blocked_attempt(target.room, target.generation, g19_private.token_hash(p_browser));
    perform set_config('response.status', '403', true);
    return jsonb_build_object('message', 'browser_blocked');
  end if;

  select * into device from g19_private.devices where enrollment_hash = proof_hash;
  if found then
    if device.room <> p_room or device.revoked_at is not null or device.generation <> target.generation
       or (device.browser_hash is not null and p_browser is not null
         and device.browser_hash <> g19_private.token_hash(p_browser)) then
      raise sqlstate 'PT401' using message = 'device_invalid';
    end if;
    if device.browser_hash is null and p_browser is not null then
      update g19_private.devices set browser_hash = g19_private.token_hash(p_browser) where id = device.id;
    end if;
    token := encode(sha256(convert_to(p_proof || device.enrollment_nonce::text, 'UTF8')), 'hex');
    return jsonb_build_object('token', token, 'room', p_room);
  end if;
  if target.occupied then raise sqlstate 'PT409' using message = 'room_occupied'; end if;

  nonce := gen_random_uuid();
  token := encode(sha256(convert_to(p_proof || nonce::text, 'UTF8')), 'hex');
  insert into g19_private.devices (room, generation, token_hash, enrollment_hash, enrollment_nonce, browser_hash)
    values (p_room, target.generation, g19_private.token_hash(token), proof_hash, nonce, g19_private.token_hash(p_browser));
  update g19_private.rooms set occupied = true where room = p_room;
  return jsonb_build_object('token', token, 'room', p_room);
end;
$$;

create or replace function public.g19_pair_start(p_room integer, p_browser text default null)
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
  if p_browser is not null and g19_private.token_hash(p_browser) is null then
    raise sqlstate 'PT400' using message = 'browser_invalid';
  end if;
  if exists (select 1 from g19_private.blocked_browsers
      where room = p_room and browser_hash = g19_private.token_hash(p_browser)) then
    perform g19_private.record_blocked_attempt(target.room, target.generation, g19_private.token_hash(p_browser));
    perform set_config('response.status', '403', true);
    return jsonb_build_object('message', 'browser_blocked');
  end if;
  if g19_private.active_devices(target.room, target.generation) >= 2 then
    raise sqlstate 'PT409' using message = 'device_limit';
  end if;
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
    insert into g19_private.pairings (room, generation, claim_hash, numeric_code, browser_hash)
      values (p_room, target.generation, g19_private.token_hash(secret), code, g19_private.token_hash(p_browser))
      on conflict (numeric_code) do nothing returning * into request;
    if found then
      return jsonb_build_object('code', code, 'secret', secret, 'room', p_room,
        'expiresAt', request.expires_at, 'serverNow', clock_timestamp());
    end if;
  end loop;
  raise sqlstate 'PT503' using message = 'pair_code_unavailable';
end;
$$;

create or replace function public.g19_pair_claim(p_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  request g19_private.pairings;
  target g19_private.rooms;
  new_device uuid;
  token text;
begin
  select * into request from g19_private.pairings where claim_hash = g19_private.token_hash(p_secret);
  if not found then return jsonb_build_object('state', 'expired'); end if;
  select * into target from g19_private.rooms where room = request.room for update;
  select * into request from g19_private.pairings where id = request.id for update;
  if not found or request.expires_at <= clock_timestamp() then return jsonb_build_object('state', 'expired'); end if;
  if exists (select 1 from g19_private.blocked_browsers
             where room = request.room and browser_hash = request.browser_hash) then
    perform g19_private.record_blocked_attempt(request.room, target.generation, request.browser_hash);
    return jsonb_build_object('state', 'cancelled');
  end if;
  if target.generation <> request.generation or not target.occupied then
    return jsonb_build_object('state', 'cancelled');
  end if;
  if request.state in ('approved', 'claimed') then
    token := encode(sha256(convert_to(p_secret || request.claim_nonce::text, 'UTF8')), 'hex');
  end if;
  if request.state = 'claimed' and not exists (
    select 1 from g19_private.devices where id = request.device_id and revoked_at is null
  ) then
    return jsonb_build_object('state', 'cancelled');
  end if;
  if request.state = 'approved' then
    if g19_private.active_devices(request.room, request.generation) >= 2 then
      return jsonb_build_object('state', 'device_limit');
    end if;
    insert into g19_private.devices (room, generation, token_hash, browser_hash)
      values (request.room, request.generation, g19_private.token_hash(token), request.browser_hash) returning id into new_device;
    update g19_private.pairings set state = 'claimed', device_id = new_device where id = request.id;
    request.state := 'claimed';
  end if;
  return jsonb_build_object('state', request.state, 'token', token, 'room', request.room);
end;
$$;
create or replace function public.g19_web_admin_rooms()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform g19_private.require_web_admin();
  return (
    select jsonb_agg(jsonb_build_object(
      'room', r.room, 'generation', r.generation, 'occupied', r.occupied,
      'devices', coalesce((
        select jsonb_agg(jsonb_build_object('id', d.id, 'kind', coalesce(d.device_kind, 'other'),
          'connectedAt', d.created_at, 'known', d.browser_known)
          order by d.created_at, d.id)
        from g19_private.devices d
        where d.room = r.room and d.generation = r.generation and d.revoked_at is null
      ), '[]'::jsonb)
    ) order by r.room)
    from g19_private.rooms r
  );
end;
$$;

create function public.g19_web_admin_history(p_room integer, p_before_time timestamptz default null,
  p_before_key text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform g19_private.require_web_admin();
  return (
    with events as (
      select 'connected:' || id key, created_at at_time,
        case when browser_known then 'reconnected' when browser_known = false then 'connected' else 'connected_legacy' end kind, id device_id
      from g19_private.devices where room = p_room
      union all
      select 'revoked:' || id, revoked_at,
        case revoke_reason when 'admin' then 'admin_detached' when 'resident' then 'self_detached' else 'detached_legacy' end, id
      from g19_private.devices where room = p_room and revoked_at is not null
      union all
      select 'release:' || id, performed_at, 'room_released', null::uuid
      from g19_private.room_reset_audit where room = p_room and action = 'release_room'
      union all
      select 'blocked:' || id, occurred_at, 'blocked', device_id
      from g19_private.blocked_attempts where room = p_room
    ), page as (
      select * from events
      where p_before_time is null or (at_time, key) < (p_before_time, p_before_key)
      order by at_time desc, key desc limit 26
    )
    select jsonb_build_object('more', count(*) > 25, 'events', coalesce((
      select jsonb_agg(jsonb_build_object('key', key, 'at', at_time, 'kind', kind, 'deviceId', device_id)
        order by at_time desc, key desc) from (select * from page limit 25) items
    ), '[]'::jsonb)) from page
  );
end;
$$;
revoke all on function public.g19_web_admin_history(integer,timestamptz,text) from public, anon, authenticated, service_role;
grant execute on function public.g19_web_admin_history(integer,timestamptz,text) to authenticated;

notify pgrst, 'reload schema';
commit;
