-- STAGE A PROPOSAL ONLY. Not an installable release migration.
-- Do not move into supabase/migrations or apply to a connected database before
-- approval of server-side privacy and the room-period lifecycle.
-- Public/private RPCs and the inbox bridge belong to the subsequent Stage B.
begin;

-- Fail closed: an ALL TABLES publication would automatically include new tables.
do $$ begin
  if exists (select 1 from pg_catalog.pg_publication where puballtables) then
    raise exception 'Review ALL TABLES publications before introducing private chat';
  end if;
end $$;

create table g19_private.private_periods (
  id uuid primary key default gen_random_uuid(),
  room smallint not null references g19_private.rooms(room),
  started_at timestamptz not null default clock_timestamp(),
  ended_at timestamptz,
  unique (room, id),
  check (ended_at is null or ended_at >= started_at)
);
create table g19_private.private_current_period (
  room smallint primary key references g19_private.rooms(room),
  period_id uuid not null unique,
  foreign key (room, period_id) references g19_private.private_periods(room, id)
);
insert into g19_private.private_periods (room) select room from g19_private.rooms;
insert into g19_private.private_current_period (room, period_id)
  select room, id from g19_private.private_periods;

-- A privacy period is deliberately separate from device-auth generation.
-- Existing bind/pair/revoke/reset functions and token semantics stay intact.
create function g19_private.rotate_private_period()
returns trigger language plpgsql set search_path = '' as $$
declare old_period uuid; new_period uuid;
begin
  if (old.occupied and not new.occupied) or old.generation is distinct from new.generation then
    select period_id into strict old_period from g19_private.private_current_period
      where room = new.room for update;
    update g19_private.private_periods set ended_at = clock_timestamp()
      where id = old_period and ended_at is null;
    insert into g19_private.private_periods (room) values (new.room) returning id into new_period;
    update g19_private.private_current_period set period_id = new_period where room = new.room;
  end if;
  return new;
end;
$$;
revoke all on function g19_private.rotate_private_period() from public, anon, authenticated, service_role;
create trigger g19_rotate_private_period before update of occupied, generation on g19_private.rooms
  for each row execute function g19_private.rotate_private_period();

create table g19_private.private_conversations (
  id uuid primary key default gen_random_uuid(),
  room_low smallint not null,
  period_low uuid not null,
  room_high smallint not null,
  period_high uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  revision bigint not null default 0 check (revision >= 0),
  check (room_low < room_high),
  foreign key (room_low, period_low) references g19_private.private_periods(room, id),
  foreign key (room_high, period_high) references g19_private.private_periods(room, id),
  unique (room_low, period_low, room_high, period_high)
);
-- Draft authorization primitive for the later RPC layer. It grants no API
-- entry point. The tests call it through an isolated, test-only wrapper.
create function g19_private.require_private_conversation(p_token text, p_conversation uuid)
returns g19_private.private_conversations language plpgsql set search_path = '' as $$
declare
  viewer_room smallint;
  viewer g19_private.devices;
  conversation g19_private.private_conversations;
begin
  select room into viewer_room from g19_private.devices
    where token_hash = g19_private.token_hash(p_token);
  if not found then raise sqlstate 'PT401' using message = 'device_invalid'; end if;
  select * into conversation from g19_private.private_conversations where id = p_conversation;
  if not found or viewer_room not in (conversation.room_low, conversation.room_high) then
    raise sqlstate 'PT404' using message = 'private_conversation_unavailable';
  end if;
  -- Always acquire both room locks in numeric order before the device lock.
  perform 1 from g19_private.rooms where room in (conversation.room_low, conversation.room_high)
    order by room for share;
  viewer := g19_private.lock_device(p_token);
  if not exists (
    select 1 from g19_private.private_current_period l
      join g19_private.private_periods lp on lp.id = l.period_id and lp.ended_at is null
      join g19_private.rooms lr on lr.room = l.room and lr.occupied
      join g19_private.private_current_period h on h.room = conversation.room_high
      join g19_private.private_periods hp on hp.id = h.period_id and hp.ended_at is null
      join g19_private.rooms hr on hr.room = h.room and hr.occupied
    where l.room = conversation.room_low and l.period_id = conversation.period_low
      and h.period_id = conversation.period_high
  ) then raise sqlstate 'PT404' using message = 'private_conversation_unavailable'; end if;
  return conversation;
end;
$$;
revoke all on function g19_private.require_private_conversation(text,uuid)
  from public, anon, authenticated, service_role;

create table g19_private.private_members (
  conversation_id uuid not null references g19_private.private_conversations(id),
  room smallint not null,
  period_id uuid not null,
  primary key (conversation_id, room),
  unique (conversation_id, room, period_id),
  foreign key (room, period_id) references g19_private.private_periods(room, id)
);
create function g19_private.seed_private_members()
returns trigger language plpgsql set search_path = '' as $$
begin
  insert into g19_private.private_members (conversation_id, room, period_id)
    values (new.id, new.room_low, new.period_low), (new.id, new.room_high, new.period_high);
  return new;
end;
$$;
revoke all on function g19_private.seed_private_members() from public, anon, authenticated, service_role;
create trigger g19_seed_private_members after insert on g19_private.private_conversations
  for each row execute function g19_private.seed_private_members();

-- IDs are opaque UUIDs; ordering/cursors are local to a conversation, not a
-- global private-message sequence that exposes other pairs' activity through gaps.
create table g19_private.private_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references g19_private.private_conversations(id),
  seq bigint not null check (seq > 0),
  device_id uuid not null references g19_private.devices(id),
  sender_room smallint not null,
  sender_period uuid not null,
  request_id uuid not null,
  body text not null check (char_length(body) between 1 and 1500),
  reply_to uuid,
  created_at timestamptz not null default clock_timestamp(),
  unique (conversation_id, id),
  unique (conversation_id, seq),
  unique (device_id, request_id),
  foreign key (conversation_id, sender_room, sender_period)
    references g19_private.private_members(conversation_id, room, period_id),
  foreign key (conversation_id, reply_to)
    references g19_private.private_messages(conversation_id, id),
  check (reply_to is null or reply_to <> id)
);
create index private_messages_recent on g19_private.private_messages(conversation_id, seq desc);

create table g19_private.private_read_cursors (
  conversation_id uuid not null,
  room smallint not null,
  period_id uuid not null,
  last_read_seq bigint,
  read_at timestamptz,
  primary key (conversation_id, room, period_id),
  foreign key (conversation_id, room, period_id)
    references g19_private.private_members(conversation_id, room, period_id),
  foreign key (conversation_id, last_read_seq)
    references g19_private.private_messages(conversation_id, seq)
);
create table g19_private.private_presence (
  device_id uuid not null references g19_private.devices(id),
  tab uuid not null,
  conversation_id uuid not null references g19_private.private_conversations(id),
  active_since timestamptz not null,
  active_until timestamptz not null,
  primary key (device_id, tab),
  check (active_until >= active_since)
);

-- New tables remain inaccessible even if the schema is accidentally exposed.
-- No SELECT/INSERT/UPDATE/DELETE policies, grants, public views or Realtime feed.
alter table g19_private.private_periods enable row level security;
alter table g19_private.private_current_period enable row level security;
alter table g19_private.private_conversations enable row level security;
alter table g19_private.private_members enable row level security;
alter table g19_private.private_messages enable row level security;
alter table g19_private.private_read_cursors enable row level security;
alter table g19_private.private_presence enable row level security;
revoke all on g19_private.private_periods, g19_private.private_current_period,
  g19_private.private_conversations, g19_private.private_members,
  g19_private.private_messages, g19_private.private_read_cursors,
  g19_private.private_presence from public, anon, authenticated, service_role;

-- Additive, backwards-compatible general-chat reply pointer. No duplicated body.
alter table g19_private.messages add column reply_to bigint
  references g19_private.messages(id);
create index messages_reply_to on g19_private.messages(reply_to) where reply_to is not null;

-- Metadata only. DO NOT create private inbox events until the Stage B bridge
-- guards legacy bigint casts, read-all calls, delivery, and route validation.
alter table g19_private.notification_inbox
  add column private_conversation_id uuid,
  add column private_message_id uuid,
  add constraint private_notification_message foreign key (private_conversation_id, private_message_id)
    references g19_private.private_messages(conversation_id, id),
  add constraint private_notification_shape check (
    (private_conversation_id is null and private_message_id is null) or
    (private_conversation_id is not null and private_message_id is not null
      and category = 'messages' and event_key = 'private:' || private_message_id::text
      and target = '#dyskusje/prywatne/' || private_conversation_id::text
      and title = 'Nowa wiadomość prywatna'
      and description ~ '^Pokój nr [1-4]$')
  );
create index private_notification_lookup on g19_private.notification_inbox
  (private_conversation_id, device_id) where private_conversation_id is not null;

commit;
