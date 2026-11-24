begin;

create schema g19_private;
revoke all on schema g19_private from public, anon, authenticated, service_role;

create table g19_private.rooms (
  room smallint primary key check (room between 1 and 4),
  generation integer not null default 1,
  occupied boolean not null default false
);
insert into g19_private.rooms (room) values (1), (2), (3), (4);

create table g19_private.devices (
  id uuid primary key default gen_random_uuid(),
  room smallint not null references g19_private.rooms,
  generation integer not null,
  token_hash bytea not null unique,
  created_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  next_message_at timestamptz,
  next_reaction_at timestamptz,
  enrollment_hash bytea unique,
  enrollment_nonce uuid
);
create index devices_by_room on g19_private.devices (room, created_at desc);

create table g19_private.messages (
  id bigint generated always as identity primary key,
  device_id uuid not null references g19_private.devices,
  request_id uuid not null,
  body text not null check (char_length(body) between 1 and 1500),
  created_at timestamptz not null default clock_timestamp(),
  unique (device_id, request_id)
);

create table g19_private.reactions (
  message_id bigint not null references g19_private.messages,
  room smallint not null references g19_private.rooms,
  generation integer not null,
  vote smallint not null check (vote in (-1, 1)),
  primary key (message_id, room, generation)
);

create table g19_private.pairings (
  id uuid primary key default gen_random_uuid(),
  room smallint not null references g19_private.rooms,
  generation integer not null,
  claim_hash bytea not null unique,
  claim_nonce uuid not null default gen_random_uuid(),
  device_id uuid references g19_private.devices,
  state text not null default 'pending' check (state in ('pending','approved','rejected','claimed','cancelled')),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp() + interval '2 minutes'
);
create index pairings_by_room on g19_private.pairings (room, created_at desc);

create table g19_private.chat_revision (
  singleton boolean primary key default true check (singleton),
  version bigint not null default 0
);
insert into g19_private.chat_revision default values;

-- Nothing in this schema is directly readable or writable from the public API.
alter table g19_private.rooms enable row level security;
alter table g19_private.devices enable row level security;
alter table g19_private.messages enable row level security;
alter table g19_private.reactions enable row level security;
alter table g19_private.pairings enable row level security;
alter table g19_private.chat_revision enable row level security;
revoke all on all tables in schema g19_private from public, anon, authenticated, service_role;

create function g19_private.token_hash(p_token text)
returns bytea language sql immutable strict set search_path = '' as $$
  select case when p_token ~ '^[0-9a-f]{64}$'
    then pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')) end;
$$;

-- Lock the room before the device, so a reset and a write cannot race past one another.
create function g19_private.lock_device(p_token text)
returns g19_private.devices language plpgsql set search_path = '' as $$
declare
  device g19_private.devices;
  current_generation integer;
begin
  select * into device from g19_private.devices where token_hash = g19_private.token_hash(p_token);
  if not found then raise sqlstate 'PT401' using message = 'device_invalid'; end if;

  select generation into current_generation from g19_private.rooms
    where room = device.room for share;
  select * into device from g19_private.devices where id = device.id for update;
  if device.revoked_at is not null or device.generation <> current_generation then
    raise sqlstate 'PT401' using message = 'device_invalid';
  end if;
  return device;
end;
$$;

create function public.g19_rooms()
returns table (room smallint, occupied boolean)
language sql stable security definer set search_path = '' as $$
  select room, occupied from g19_private.rooms order by room;
$$;

create function public.g19_bind(p_room integer, p_proof text)
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

  select * into device from g19_private.devices where enrollment_hash = proof_hash;
  if found then
    if device.room <> p_room or device.revoked_at is not null or device.generation <> target.generation then
      raise sqlstate 'PT401' using message = 'device_invalid';
    end if;
    token := encode(sha256(convert_to(p_proof || device.enrollment_nonce::text, 'UTF8')), 'hex');
    return jsonb_build_object('token', token, 'room', p_room);
  end if;
  if target.occupied then raise sqlstate 'PT409' using message = 'room_occupied'; end if;

  nonce := gen_random_uuid();
  token := encode(sha256(convert_to(p_proof || nonce::text, 'UTF8')), 'hex');
  insert into g19_private.devices (room, generation, token_hash, enrollment_hash, enrollment_nonce)
    values (p_room, target.generation, g19_private.token_hash(token), proof_hash, nonce);
  update g19_private.rooms set occupied = true where room = p_room;
  return jsonb_build_object('token', token, 'room', p_room);
end;
$$;

create function public.g19_pair_start(p_room integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  target g19_private.rooms;
  request g19_private.pairings;
  secret text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  select * into target from g19_private.rooms where room = p_room for update;
  if not found or not target.occupied then raise sqlstate 'PT409' using message = 'room_free'; end if;
  if (select count(*) from g19_private.pairings where room = p_room
      and created_at > clock_timestamp() - interval '1 minute') >= 12 then
    raise sqlstate 'PT429' using message = 'pair_rate_limit';
  end if;
  delete from g19_private.pairings where room = p_room and expires_at < clock_timestamp() - interval '1 day';
  insert into g19_private.pairings (room, generation, claim_hash)
    values (p_room, target.generation, g19_private.token_hash(secret)) returning * into request;
  return jsonb_build_object('code', request.id, 'secret', secret, 'expiresAt', request.expires_at);
end;
$$;

create function public.g19_pair_decide(p_token text, p_code uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  device g19_private.devices := g19_private.lock_device(p_token);
  request g19_private.pairings;
begin
  select * into request from g19_private.pairings
    where id = p_code and room = device.room and generation = device.generation for update;
  if not found or request.state <> 'pending' or request.expires_at <= clock_timestamp() or p_approve is null then
    raise sqlstate 'PT409' using message = 'pair_unavailable';
  end if;
  update g19_private.pairings set state = case when p_approve then 'approved' else 'rejected' end
    where id = request.id;
end;
$$;

create function public.g19_pair_claim(p_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  request g19_private.pairings;
  target g19_private.rooms;
  new_device uuid;
  token text;
begin
  select * into request from g19_private.pairings where claim_hash = g19_private.token_hash(p_secret);
  if not found then return jsonb_build_object('state', 'expired'); end if;
  select * into target from g19_private.rooms where room = request.room for share;
  select * into request from g19_private.pairings where id = request.id for update;
  if not found or request.expires_at <= clock_timestamp() then return jsonb_build_object('state', 'expired'); end if;
  if target.generation <> request.generation then return jsonb_build_object('state', 'cancelled'); end if;
  if request.state in ('approved', 'claimed') then
    token := encode(sha256(convert_to(p_secret || request.claim_nonce::text, 'UTF8')), 'hex');
  end if;
  if request.state = 'approved' then
    insert into g19_private.devices (room, generation, token_hash)
      values (request.room, request.generation, g19_private.token_hash(token)) returning id into new_device;
    update g19_private.pairings set state = 'claimed', device_id = new_device where id = request.id;
    request.state := 'claimed';
  end if;
  return jsonb_build_object('state', request.state, 'token', token, 'room', request.room);
end;
$$;

create function public.g19_read(p_token text, p_before bigint default null, p_version bigint default null)
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
    return jsonb_build_object('version', revision, 'unchanged', true);
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
    'hasOlder', (select count(*) > 40 from page),
    'messages', coalesce(jsonb_agg(entry order by id), '[]'::jsonb)
  ) into result from entries;
  return result;
end;
$$;

create function public.g19_send(p_token text, p_request uuid, p_body text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  device g19_private.devices;
  existing g19_private.messages;
  clean_body text;
  message_id bigint;
begin
  device := g19_private.lock_device(p_token);
  if p_request is null or p_body is null or char_length(p_body) > 1500 then
    raise sqlstate 'PT400' using message = 'message_invalid';
  end if;
  clean_body := btrim(p_body, U&'\0009\000a\000b\000c\000d\0020\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff');
  if clean_body = '' then
    raise sqlstate 'PT400' using message = 'message_invalid';
  end if;
  select * into existing from g19_private.messages where device_id = device.id and request_id = p_request;
  if found then
    if existing.body <> clean_body then raise sqlstate 'PT409' using message = 'request_conflict'; end if;
    return existing.id::text;
  end if;
  if device.next_message_at > clock_timestamp() then
    raise sqlstate 'PT429' using message = 'message_rate_limit';
  end if;

  update g19_private.chat_revision set version = version + 1;
  insert into g19_private.messages (device_id, request_id, body)
    values (device.id, p_request, clean_body) returning id into message_id;
  update g19_private.devices set next_message_at = clock_timestamp() + interval '2 seconds'
    where id = device.id;
  return message_id::text;
end;
$$;

create function public.g19_react(p_token text, p_message bigint, p_vote integer)
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
  -- Serialize cross-device changes before reading this resident's current reaction.
  perform 1 from g19_private.chat_revision for update;
  select vote into existing_vote from g19_private.reactions
    where message_id = p_message and room = device.room and generation = device.generation;
  if coalesce(existing_vote, 0) = p_vote then return; end if;
  if device.next_reaction_at > clock_timestamp() then
    raise sqlstate 'PT429' using message = 'reaction_rate_limit';
  end if;

  update g19_private.chat_revision set version = version + 1;
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

-- Run these commands from the project owner's authenticated Supabase SQL Editor.
create function public.g19_admin_rooms()
returns table (room smallint, generation integer, active_devices bigint, occupied boolean)
language sql stable set search_path = '' as $$
  select r.room, r.generation, count(d.id), r.occupied
  from g19_private.rooms r left join g19_private.devices d
    on d.room = r.room and d.generation = r.generation and d.revoked_at is null
  group by r.room, r.generation, r.occupied order by r.room;
$$;

create function public.g19_admin_change_resident(p_room integer, p_generation integer, p_active_devices integer)
returns integer language plpgsql set search_path = '' as $$
declare
  current_generation integer;
  active integer;
begin
  select generation into current_generation from g19_private.rooms where room = p_room for update;
  if not found then raise sqlstate 'PT400' using message = 'room_invalid'; end if;
  select count(*) into active from g19_private.devices
    where room = p_room and generation = current_generation and revoked_at is null;
  if current_generation is distinct from p_generation or active is distinct from p_active_devices then
    raise sqlstate 'PT409' using message = 'room_changed';
  end if;

  update g19_private.devices set revoked_at = clock_timestamp()
    where room = p_room and generation = current_generation and revoked_at is null;
  update g19_private.pairings set state = 'cancelled'
    where room = p_room and generation = current_generation and state in ('pending','approved');
  update g19_private.rooms set generation = generation + 1, occupied = false where room = p_room;
  update g19_private.chat_revision set version = version + 1;
  return active;
end;
$$;

revoke all on all functions in schema g19_private from public, anon, authenticated, service_role;
revoke all on function public.g19_bind(integer, text), public.g19_rooms(),
  public.g19_pair_start(integer), public.g19_pair_decide(text, uuid, boolean), public.g19_pair_claim(text), public.g19_read(text, bigint, bigint),
  public.g19_send(text, uuid, text), public.g19_react(text, bigint, integer),
  public.g19_admin_rooms(), public.g19_admin_change_resident(integer, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.g19_bind(integer, text), public.g19_rooms(),
  public.g19_pair_start(integer), public.g19_pair_decide(text, uuid, boolean), public.g19_pair_claim(text), public.g19_read(text, bigint, bigint),
  public.g19_send(text, uuid, text), public.g19_react(text, bigint, integer) to anon;

commit;
