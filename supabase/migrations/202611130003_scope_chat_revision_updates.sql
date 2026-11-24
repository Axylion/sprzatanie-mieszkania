begin;

-- Keep revision changes scoped to the singleton row for pg-safeupdate.

create or replace function public.g19_send(p_token text, p_request uuid, p_body text)
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

  update g19_private.chat_revision set version = version + 1 where singleton = true;
  insert into g19_private.messages (device_id, request_id, body)
    values (device.id, p_request, clean_body) returning id into message_id;
  update g19_private.devices set next_message_at = clock_timestamp() + interval '2 seconds'
    where id = device.id;
  return message_id::text;
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

create or replace function public.g19_admin_change_resident(p_room integer, p_generation integer, p_active_devices integer)
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
  update g19_private.chat_revision set version = version + 1 where singleton = true;
  return active;
end;
$$;

commit;
