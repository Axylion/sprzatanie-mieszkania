begin;

alter table g19_private.devices add column browser_hash bytea,
  add column revoke_reason text check (revoke_reason in ('resident', 'admin'));
alter table g19_private.pairings add column browser_hash bytea;

create table g19_private.blocked_browsers (
  room smallint not null references g19_private.rooms,
  browser_hash bytea not null,
  primary key (room, browser_hash)
);
alter table g19_private.blocked_browsers enable row level security;
revoke all on g19_private.blocked_browsers from public, anon, authenticated, service_role;

-- The caller holds the exclusive room lock.
create function g19_private.release_empty_room(p_room smallint, p_generation integer)
returns void language plpgsql set search_path = '' as $$
begin
  if g19_private.active_devices(p_room, p_generation) = 0 then
    update g19_private.pairings set state = 'cancelled'
      where room = p_room and generation = p_generation and state in ('pending', 'approved');
    update g19_private.rooms set occupied = false where room = p_room;
  end if;
end;
$$;
revoke all on function g19_private.release_empty_room(smallint, integer) from public, anon, authenticated, service_role;

drop function public.g19_bind(integer, text);
drop function public.g19_pair_start(integer);
drop function public.g19_my_devices(text, text);

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
    raise sqlstate 'PT403' using message = 'browser_blocked';
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
    raise sqlstate 'PT403' using message = 'browser_blocked';
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
  if target.generation <> request.generation or not target.occupied
     or exists (select 1 from g19_private.blocked_browsers
                where room = request.room and browser_hash = request.browser_hash) then
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
create or replace function public.g19_my_devices(p_token text, p_kind text default null, p_browser text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  device g19_private.devices := g19_private.lock_device(p_token);
begin
  if p_browser is not null and device.browser_hash is null
     and g19_private.token_hash(p_browser) is not null then
    if exists (select 1 from g19_private.blocked_browsers
      where room = device.room and browser_hash = g19_private.token_hash(p_browser)) then
      raise sqlstate 'PT403' using message = 'browser_blocked';
    end if;
    update g19_private.devices set browser_hash = g19_private.token_hash(p_browser) where id = device.id;
  end if;
  if p_kind in ('phone', 'computer', 'other') and device.device_kind is distinct from p_kind then
    update g19_private.devices set device_kind = p_kind where id = device.id;
  end if;
  return (
    select jsonb_agg(jsonb_build_object('id', id, 'current', id = device.id,
      'kind', coalesce(device_kind, 'other'), 'createdAt', created_at) order by created_at, id)
    from g19_private.devices where room = device.room and generation = device.generation
      and revoked_at is null
  );
end;
$$;
create or replace function public.g19_revoke_device(p_token text, p_device uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  device g19_private.devices := g19_private.lock_device_room(p_token);
begin
  update g19_private.devices set revoked_at = clock_timestamp(), revoke_reason = 'resident'
    where id = p_device and room = device.room and generation = device.generation and revoked_at is null;
  if not found then raise sqlstate 'PT404' using message = 'device_not_found'; end if;
  if p_device = device.id then
    update g19_private.pairings set state = 'cancelled'
      where room = device.room and generation = device.generation and state in ('pending','approved');
  end if;
  perform g19_private.release_empty_room(device.room, device.generation);
  delete from g19_private.notification_presence where device_id = p_device;
  update g19_private.chat_revision set version = version + 1 where singleton = true;
end;
$$;
create or replace function public.g19_admin_change_resident(p_room integer, p_generation integer, p_active_devices integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  current_generation integer;
  active integer;
begin
  select generation into current_generation from g19_private.rooms where room = p_room for update;
  if not found then
    raise log 'G19 room reset rejected (room_invalid) by % for room %', session_user, p_room;
    raise sqlstate 'PT400' using message = 'room_invalid';
  end if;
  select count(*) into active from g19_private.devices
    where room = p_room and generation = current_generation and revoked_at is null;
  if current_generation is distinct from p_generation or active is distinct from p_active_devices then
    raise log 'G19 room reset rejected (room_changed) by % for room %', session_user, p_room;
    raise sqlstate 'PT409' using message = 'room_changed';
  end if;

  insert into g19_private.blocked_browsers (room, browser_hash)
    select room, browser_hash from g19_private.devices
    where room = p_room and generation = current_generation and browser_hash is not null
    on conflict do nothing;
  update g19_private.devices set revoked_at = clock_timestamp(), revoke_reason = 'admin'
    where room = p_room and generation = current_generation and revoked_at is null;
  delete from g19_private.notification_presence p using g19_private.devices d
    where p.device_id = d.id and d.room = p_room and d.generation = current_generation;
  update g19_private.pairings set state = 'cancelled'
    where room = p_room and generation = current_generation and state in ('pending','approved');
  update g19_private.rooms set generation = generation + 1, occupied = false where room = p_room;
  update g19_private.chat_revision set version = version + 1 where singleton = true;
  insert into g19_private.room_reset_audit (room, generation, result, devices_revoked)
    values (p_room, current_generation, 'revoked', active);
  return active;
end;
$$;

revoke all on function public.g19_bind(integer,text,text), public.g19_pair_start(integer,text),
  public.g19_my_devices(text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.g19_bind(integer,text,text), public.g19_pair_start(integer,text),
  public.g19_my_devices(text,text,text) to anon;

-- Repair legacy self-revocation orphans without changing any room generation.
-- Lock before checking the current device count to serialize with enrollment.
do $$
declare
  target record;
begin
  for target in select room, generation from g19_private.rooms where occupied order by room for update loop
    perform g19_private.release_empty_room(target.room, target.generation);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
commit;
