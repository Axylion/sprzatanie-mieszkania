begin;

create function g19_private.active_devices(p_room smallint, p_generation integer)
returns bigint language sql stable set search_path = '' as $$
  select count(*) from g19_private.devices
  where room = p_room and generation = p_generation and revoked_at is null;
$$;

-- Acquire the exclusive room lock before any device lock for changes to membership.
create function g19_private.lock_device_room(p_token text)
returns g19_private.devices language plpgsql set search_path = '' as $$
declare
  device_room smallint;
begin
  select room into device_room from g19_private.devices
    where token_hash = g19_private.token_hash(p_token);
  if not found then raise sqlstate 'PT401' using message = 'device_invalid'; end if;
  perform 1 from g19_private.rooms where room = device_room for update;
  return g19_private.lock_device(p_token);
end;
$$;

revoke all on function g19_private.active_devices(smallint, integer),
  g19_private.lock_device_room(text) from public, anon, authenticated, service_role;

alter table g19_private.devices
  add column device_kind text check (device_kind in ('phone', 'computer', 'other'));

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

create or replace function public.g19_pair_decide(p_token text, p_code text, p_approve boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  device g19_private.devices;
  request g19_private.pairings;
  checked_at timestamptz := clock_timestamp();
  bucket g19_private.pair_attempts;
begin
  device := g19_private.lock_device_room(p_token);
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
  if p_approve and g19_private.active_devices(device.room, device.generation) + (
    select count(*) from g19_private.pairings
    where room = device.room and generation = device.generation
      and state = 'approved' and expires_at > clock_timestamp()
  ) >= 2 then
    return jsonb_build_object('state', 'device_limit');
  end if;
  update g19_private.pairings set state = case when p_approve then 'approved' else 'rejected' end
    where id = request.id returning * into request;
  return jsonb_build_object('state', request.state);
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
  if target.generation <> request.generation then return jsonb_build_object('state', 'cancelled'); end if;
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
    insert into g19_private.devices (room, generation, token_hash)
      values (request.room, request.generation, g19_private.token_hash(token)) returning id into new_device;
    update g19_private.pairings set state = 'claimed', device_id = new_device where id = request.id;
    request.state := 'claimed';
  end if;
  return jsonb_build_object('state', request.state, 'token', token, 'room', request.room);
end;
$$;

create or replace function public.g19_read(p_token text, p_before bigint default null, p_version bigint default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  viewer g19_private.devices;
  revision bigint;
  result jsonb;
begin
  select d.* into viewer from g19_private.devices d join g19_private.rooms r using (room)
    where d.token_hash = g19_private.token_hash(p_token)
      and d.revoked_at is null and d.generation = r.generation;
  if not found then raise sqlstate 'PT401' using message = 'device_invalid'; end if;

  select version into revision from g19_private.chat_revision;
  if p_version = revision then
    return jsonb_build_object('version', revision, 'unchanged', true, 'deviceCount', g19_private.active_devices(viewer.room, viewer.generation));
  end if;

  with page as materialized (
    select m.* from g19_private.messages m
    where p_before is null or m.id < p_before
    order by m.id desc limit 41
  ), entries as (
    select p.id, jsonb_build_object(
      'id', p.id::text, 'body', p.body, 'createdAt', p.created_at,
      'room', d.room, 'former', d.generation <> r.generation, 'mine', d.room = viewer.room and d.generation = viewer.generation,
      'up', votes.up, 'down', votes.down, 'vote', votes.mine
    ) as entry
    from (select * from page order by id desc limit 40) p
    join g19_private.devices d on d.id = p.device_id
    join g19_private.rooms r on r.room = d.room
    cross join lateral (
      select count(*) filter (where vote = 1) as up, count(*) filter (where vote = -1) as down,
        coalesce(max(vote) filter (where room = viewer.room and generation = viewer.generation), 0) as mine
      from g19_private.reactions where message_id = p.id
    ) votes
  )
  select jsonb_build_object(
    'version', revision,
    'room', viewer.room,
    'deviceCount', g19_private.active_devices(viewer.room, viewer.generation),
    'hasOlder', (select count(*) > 40 from page),
    'messages', coalesce(jsonb_agg(entry order by id), '[]'::jsonb)
  ) into result from entries;
  return result;
end;
$$;

create or replace function public.g19_react(p_token text, p_message bigint, p_vote integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  device g19_private.devices;
  existing_vote smallint;
begin
  device := g19_private.lock_device(p_token);
  if p_vote is null or p_vote not in (-1, 0, 1)
    or not exists (select 1 from g19_private.messages where id = p_message) then
    raise sqlstate 'PT400' using message = 'reaction_invalid';
  end if;
  if exists (
    select 1 from g19_private.messages m join g19_private.devices author on author.id = m.device_id
    where m.id = p_message and author.room = device.room and author.generation = device.generation
  ) then
    raise sqlstate 'PT403' using message = 'own_message';
  end if;
  -- Serialize cross-device changes before reading this resident's current reaction.
  perform 1 from g19_private.chat_revision where singleton = true for update;
  select vote into existing_vote from g19_private.reactions
    where message_id = p_message and room = device.room and generation = device.generation;
  if coalesce(existing_vote, 0) = p_vote then return; end if;
  if device.next_reaction_at > clock_timestamp() then
    raise sqlstate 'PT429' using message = 'reaction_rate_limit';
  end if;

  update g19_private.chat_revision set version = version + 1 where singleton = true;
  if p_vote = 0 then
    delete from g19_private.reactions where message_id = p_message and room = device.room and generation = device.generation;
  else
    insert into g19_private.reactions (message_id, room, generation, vote)
      values (p_message, device.room, device.generation, p_vote)
      on conflict (message_id, room, generation) do update set vote = excluded.vote;
  end if;
  update g19_private.devices set next_reaction_at = clock_timestamp() + interval '400 milliseconds'
    where id = device.id;
end;
$$;

create function public.g19_my_devices(p_token text, p_kind text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  device g19_private.devices := g19_private.lock_device(p_token);
begin
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

create function public.g19_revoke_device(p_token text, p_device uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  device g19_private.devices := g19_private.lock_device_room(p_token);
begin
  if p_device = device.id then raise sqlstate 'PT403' using message = 'current_device'; end if;
  update g19_private.devices set revoked_at = clock_timestamp()
    where id = p_device and room = device.room and generation = device.generation and revoked_at is null;
  if not found then raise sqlstate 'PT404' using message = 'device_not_found'; end if;
  update g19_private.chat_revision set version = version + 1 where singleton = true;
end;
$$;

revoke all on function public.g19_my_devices(text, text), public.g19_revoke_device(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.g19_my_devices(text, text), public.g19_revoke_device(text, uuid) to anon;

-- Remove only votes by the resident who authored the message.
with removed as (
  delete from g19_private.reactions r
    using g19_private.messages m, g19_private.devices author
    where r.message_id = m.id and m.device_id = author.id
      and r.room = author.room and r.generation = author.generation
    returning 1
)
update g19_private.chat_revision set version = version + 1
where singleton = true and exists (select 1 from removed);

notify pgrst, 'reload schema';
commit;
