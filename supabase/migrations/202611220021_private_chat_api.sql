begin;

-- Device IDs and token identities are immutable through the API. A no-key
-- update lock still serializes revocation/rate state, while allowing the FK
-- KEY SHARE locks acquired when notifying a peer device. FOR UPDATE here can
-- deadlock two peer sends while one waits for the shared conversation lock.
create or replace function g19_private.lock_device(p_token text)
returns g19_private.devices language plpgsql set search_path='' as $$
declare device g19_private.devices; current_generation integer;
begin
 select * into device from g19_private.devices where token_hash=g19_private.token_hash(p_token);
 if not found then raise sqlstate 'PT401' using message='device_invalid'; end if;
 select generation into current_generation from g19_private.rooms where room=device.room for share;
 select * into device from g19_private.devices where id=device.id for no key update;
 if device.revoked_at is not null or device.generation<>current_generation then
  raise sqlstate 'PT401' using message='device_invalid';
 end if;
 return device;
end $$;

create function g19_private.require_private_enabled() returns void language plpgsql set search_path='' as $$
begin
  if not exists(select 1 from g19_private.private_chat_settings where singleton and enabled) then
    raise sqlstate 'PT503' using message='private_chat_unavailable';
  end if;
end $$;
create function public.g19_chat_capabilities() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('version',1,'replies',true,'privateChat',coalesce((select enabled from g19_private.private_chat_settings where singleton),false));
$$;
create function g19_private.clean_message(p_body text) returns text language plpgsql immutable set search_path='' as $$
declare clean text;
begin
 if p_body is null or char_length(p_body)>1500 then raise sqlstate 'PT400' using message='message_invalid'; end if;
 clean:=btrim(p_body,U&'\0009\000a\000b\000c\000d\0020\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff');
 if clean='' then raise sqlstate 'PT400' using message='message_invalid'; end if;
 return clean;
end $$;

-- Keep old signatures unambiguous for PostgREST and existing clients.
alter function public.g19_send(text,uuid,text) rename to g19_legacy_send;
alter function public.g19_read(text,bigint,bigint) rename to g19_legacy_read;
revoke all on function public.g19_legacy_send(text,uuid,text),public.g19_legacy_read(text,bigint,bigint) from public,anon,authenticated,service_role;
create function public.g19_send_reply(p_token text,p_request uuid,p_body text,p_reply bigint)
returns text language plpgsql security definer set search_path='' as $$
declare actor g19_private.devices:=g19_private.lock_device(p_token); clean text:=g19_private.clean_message(p_body); existing g19_private.messages; result text;
begin
 if p_request is null then raise sqlstate 'PT400' using message='message_invalid'; end if;
 select * into existing from g19_private.messages where device_id=actor.id and request_id=p_request;
 if found then
  if existing.body is distinct from clean or existing.reply_to is distinct from p_reply then raise sqlstate 'PT409' using message='request_conflict'; end if;
  return existing.id::text;
 end if;
 if p_reply is not null and not exists(select 1 from g19_private.messages where id=p_reply) then raise sqlstate 'PT404' using message='reply_unavailable'; end if;
 result:=public.g19_legacy_send(p_token,p_request,clean);
 update g19_private.messages set reply_to=p_reply, sender_period=(select period_id from g19_private.private_current_period where room=actor.room) where id=result::bigint and device_id=actor.id;
 return result;
end $$;
create function public.g19_send(p_token text,p_request uuid,p_body text) returns text language sql security definer set search_path='' as $$
 select public.g19_send_reply(p_token,p_request,p_body,null);
$$;
create function public.g19_read(p_token text,p_before bigint default null,p_version bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb:=public.g19_legacy_read(p_token,p_before,p_version);
begin
 if coalesce((result->>'unchanged')::boolean,false) then return result; end if;
 return jsonb_set(result,'{messages}',coalesce((
  select jsonb_agg(entry.value || jsonb_build_object('authorPeriod',current_period.period_id,'canPrivate',coalesce(m.sender_period=current_period.period_id, sender.revoked_at is null and sender.generation=sender_room.generation),'reply',case when original.id is null then null else
   jsonb_build_object('id',original.id::text,'room',author.room,'body',left(original.body,160)) end) order by entry.ordinality)
  from jsonb_array_elements(result->'messages') with ordinality entry(value,ordinality)
  join g19_private.messages m on m.id=(entry.value->>'id')::bigint
  join g19_private.devices sender on sender.id=m.device_id
  join g19_private.rooms sender_room on sender_room.room=sender.room
  join g19_private.private_current_period current_period on current_period.room=sender.room
  left join g19_private.messages original on original.id=m.reply_to
  left join g19_private.devices author on author.id=original.device_id
 ),'[]'::jsonb));
end $$;
create function public.g19_general_message(p_token text,p_message bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor g19_private.devices:=g19_private.lock_device(p_token); endpoint bigint;
begin
 if not exists(select 1 from g19_private.messages where id=p_message) then raise sqlstate 'PT404' using message='reply_unavailable'; end if;
 select coalesce(max(id),p_message) into endpoint from (select id from g19_private.messages where id>=p_message order by id limit 20) entries;
 return public.g19_read(p_token,endpoint+1,null) || jsonb_build_object('focusId',p_message::text,'before',(endpoint+1)::text);
end $$;

create function g19_private.private_readable(p_device uuid,p_conversation uuid) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from g19_private.devices d join g19_private.rooms r on r.room=d.room and r.generation=d.generation and r.occupied
 join g19_private.private_current_period cp on cp.room=d.room
 join g19_private.private_members member on member.room=d.room and member.period_id=cp.period_id
 join g19_private.private_periods period on period.id=cp.period_id and period.ended_at is null
 where d.id=p_device and d.revoked_at is null and member.conversation_id=p_conversation);
$$;
create function g19_private.private_writable(p_conversation uuid) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from g19_private.private_conversations c
 join g19_private.private_current_period l on (l.room,l.period_id)=(c.room_low,c.period_low)
 join g19_private.private_current_period h on (h.room,h.period_id)=(c.room_high,c.period_high)
 join g19_private.rooms lr on lr.room=l.room and lr.occupied
 join g19_private.rooms hr on hr.room=h.room and hr.occupied
 where c.id=p_conversation);
$$;
create function g19_private.private_unread(p_room smallint,p_period uuid,p_conversation uuid) returns bigint language sql stable set search_path='' as $$
 select count(*) from g19_private.private_messages m where m.conversation_id=p_conversation and m.sender_room<>p_room
 and m.seq>coalesce((select last_read_seq from g19_private.private_read_cursors where conversation_id=p_conversation and room=p_room and period_id=p_period),0);
$$;
create function public.g19_private_list(p_token text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor g19_private.devices; own_period uuid; items jsonb; archived bigint; archive_unread bigint;
begin
 perform g19_private.require_private_enabled();actor:=g19_private.lock_device(p_token);
 select period_id into own_period from g19_private.private_current_period where room=actor.room;
 select jsonb_agg(jsonb_build_object('room',peer.room,'peerPeriod',peer_period.period_id,'canSend',peer.occupied,
  'conversation',c.id,'lastMessage',left(last_message.body,120),'lastAt',last_message.created_at,
  'unread',case when c.id is null then 0 else g19_private.private_unread(actor.room,own_period,c.id) end)
  order by last_message.created_at desc nulls last,peer.room) into items
 from g19_private.rooms peer join g19_private.private_current_period peer_period using(room)
 left join g19_private.private_conversations c on
  (c.room_low,c.period_low,c.room_high,c.period_high)=(least(actor.room,peer.room),case when actor.room<peer.room then own_period else peer_period.period_id end,
    greatest(actor.room,peer.room),case when actor.room<peer.room then peer_period.period_id else own_period end)
 left join lateral(select body,created_at from g19_private.private_messages where conversation_id=c.id order by seq desc limit 1) last_message on true
 where peer.room<>actor.room;
 select count(*),coalesce(sum(g19_private.private_unread(actor.room,own_period,m.conversation_id)),0) into archived,archive_unread
 from g19_private.private_members m where m.room=actor.room and m.period_id=own_period and not g19_private.private_writable(m.conversation_id);
 return jsonb_build_object('room',actor.room,'period',own_period,'items',coalesce(items,'[]'::jsonb),'archiveCount',archived,'archiveUnread',archive_unread,
  'unread',archive_unread+coalesce((select sum((i->>'unread')::bigint) from jsonb_array_elements(items)i),0));
end $$;
create function public.g19_private_archive(p_token text,p_before uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor g19_private.devices; own_period uuid; result jsonb;
begin
 perform g19_private.require_private_enabled();actor:=g19_private.lock_device(p_token);
 select period_id into own_period from g19_private.private_current_period where room=actor.room;
 with eligible as materialized (
 select c.id,peer.room as peer_room,peer_period.ended_at as closed_at,last_message.body,last_message.created_at
 from g19_private.private_members mine join g19_private.private_conversations c on c.id=mine.conversation_id
 join g19_private.private_members peer on peer.conversation_id=c.id and peer.room<>actor.room
 join g19_private.private_periods peer_period on peer_period.id=peer.period_id
 left join lateral(select body,created_at from g19_private.private_messages where conversation_id=c.id order by seq desc limit 1) last_message on true
 where mine.room=actor.room and mine.period_id=own_period and peer_period.ended_at is not null
 ), page as materialized(select * from eligible where p_before is null or (closed_at,id)<(select closed_at,id from eligible where id=p_before) order by closed_at desc,id desc limit 41),
 shown as(select * from page order by closed_at desc,id desc limit 40)
 select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('id',id,'room',peer_room,'closedAt',closed_at,'readOnly',true,
 'lastMessage',left(body,120),'lastAt',created_at,'unread',g19_private.private_unread(actor.room,own_period,id)) order by closed_at desc,id desc),'[]'::jsonb),
 'hasOlder',(select count(*)>40 from page)) into result from shown;
 return result;
end $$;

-- Final insertion guard also enforces closed-dialog and author checks at the DB layer.
create function g19_private.validate_private_message() returns trigger language plpgsql set search_path='' as $$
begin
 if not g19_private.private_writable(new.conversation_id) then raise sqlstate 'PT409' using message='private_conversation_archived'; end if;
 if not exists(select 1 from g19_private.devices d join g19_private.rooms r on r.room=d.room and r.generation=d.generation
 join g19_private.private_current_period cp on cp.room=d.room and cp.period_id=new.sender_period
 where d.id=new.device_id and d.room=new.sender_room and d.revoked_at is null) then raise sqlstate 'PT401' using message='device_invalid'; end if;
 if new.reply_to is not null and not exists(select 1 from g19_private.private_messages where conversation_id=new.conversation_id and id=new.reply_to and seq<new.seq) then
 raise sqlstate 'PT404' using message='reply_unavailable'; end if;
 return new;
end $$;
create trigger g19_validate_private_message before insert on g19_private.private_messages for each row execute function g19_private.validate_private_message();
create function public.g19_private_send(p_token text,p_peer integer,p_expected_peer_period uuid,p_request uuid,p_body text,p_reply uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor g19_private.devices; own_room smallint; own_period uuid; peer_period uuid; conversation g19_private.private_conversations;
 existing g19_private.private_messages; clean text:=g19_private.clean_message(p_body); message_id uuid; sequence bigint;
begin
 perform g19_private.require_private_enabled();
 select room into own_room from g19_private.devices where token_hash=g19_private.token_hash(p_token);
 if own_room is null then raise sqlstate 'PT401' using message='device_invalid'; end if;
 if p_peer is null or p_peer not between 1 and 4 or p_peer=own_room or p_expected_peer_period is null or p_request is null then raise sqlstate 'PT400' using message='private_peer_invalid'; end if;
 perform 1 from g19_private.rooms where room in(own_room,p_peer) order by room for share;
 actor:=g19_private.lock_device(p_token);
 select cp.period_id into peer_period from g19_private.private_current_period cp join g19_private.rooms r using(room) where cp.room=p_peer and r.occupied;
 select period_id into own_period from g19_private.private_current_period where room=own_room;
 if peer_period is distinct from p_expected_peer_period then raise sqlstate 'PT409' using message='private_context_changed'; end if;
 select * into existing from g19_private.private_messages where device_id=actor.id and request_id=p_request;
 if found then
  select * into conversation from g19_private.private_conversations where id=existing.conversation_id;
  perform g19_private.require_writable_private_conversation(p_token,conversation.id);
  if existing.body<>clean or existing.reply_to is distinct from p_reply or not exists(select 1 from g19_private.private_members where conversation_id=conversation.id and room=p_peer and period_id=peer_period) then raise sqlstate 'PT409' using message='request_conflict'; end if;
  return jsonb_build_object('id',existing.id,'conversation',conversation.id,'seq',existing.seq::text);
 end if;
 if actor.next_message_at>clock_timestamp() then raise sqlstate 'PT429' using message='message_rate_limit'; end if;
 insert into g19_private.private_conversations(room_low,period_low,room_high,period_high)
 values(least(own_room,p_peer),case when own_room<p_peer then own_period else peer_period end,greatest(own_room,p_peer),case when own_room<p_peer then peer_period else own_period end)
 on conflict(room_low,period_low,room_high,period_high) do nothing;
 select * into conversation from g19_private.private_conversations
 where (room_low,period_low,room_high,period_high)=(least(own_room,p_peer),case when own_room<p_peer then own_period else peer_period end,greatest(own_room,p_peer),case when own_room<p_peer then peer_period else own_period end) for update;
 perform g19_private.require_writable_private_conversation(p_token,conversation.id);
 if p_reply is not null and not exists(select 1 from g19_private.private_messages where id=p_reply and conversation_id=conversation.id) then raise sqlstate 'PT404' using message='reply_unavailable'; end if;
 update g19_private.private_conversations set revision=revision+1 where id=conversation.id returning revision into sequence;
 insert into g19_private.private_messages(conversation_id,seq,device_id,sender_room,sender_period,request_id,body,reply_to)
 values(conversation.id,sequence,actor.id,own_room,own_period,p_request,clean,p_reply) returning id into message_id;
 update g19_private.devices set next_message_at=clock_timestamp()+interval '2 seconds' where id=actor.id;
 return jsonb_build_object('id',message_id,'conversation',conversation.id,'seq',sequence::text);
end $$;
create function public.g19_private_read(p_token text,p_conversation uuid,p_before_seq bigint default null,p_revision bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor g19_private.devices; conversation g19_private.private_conversations; result jsonb; own_period uuid;
begin
 perform g19_private.require_private_enabled();conversation:=g19_private.require_private_conversation(p_token,p_conversation);
 actor:=g19_private.lock_device(p_token);select period_id into own_period from g19_private.private_current_period where room=actor.room;
 if p_before_seq is not null and p_before_seq<=0 then raise sqlstate 'PT400' using message='invalid_message_cursor'; end if;
 with page as materialized(select * from g19_private.private_messages where conversation_id=p_conversation and(p_before_seq is null or seq<p_before_seq) order by seq desc limit 41),
 entries as(select * from page order by seq desc limit 40)
 select jsonb_build_object('messages',coalesce(jsonb_agg(jsonb_build_object('id',m.id,'seq',m.seq::text,'room',m.sender_room,'mine',m.sender_room=actor.room,'body',m.body,'createdAt',m.created_at,
 'reply',case when original.id is null then null else jsonb_build_object('id',original.id,'room',original.sender_room,'body',left(original.body,160)) end) order by m.seq),'[]'::jsonb),
 'hasOlder',(select count(*)>40 from page)) into result from entries m left join g19_private.private_messages original on original.conversation_id=m.conversation_id and original.id=m.reply_to;
 return result||jsonb_build_object('conversation',p_conversation,'room',actor.room,'peerRoom',case when actor.room=conversation.room_low then conversation.room_high else conversation.room_low end,
 'revision',conversation.revision::text,'readOnly',not g19_private.private_writable(p_conversation),'unread',g19_private.private_unread(actor.room,own_period,p_conversation));
end $$;
create function public.g19_private_message(p_token text,p_conversation uuid,p_message uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare sequence bigint;
begin
 perform g19_private.require_private_enabled();perform g19_private.require_private_conversation(p_token,p_conversation);
 select seq into sequence from g19_private.private_messages where conversation_id=p_conversation and id=p_message;
 if not found then raise sqlstate 'PT404' using message='reply_unavailable'; end if;
 return public.g19_private_read(p_token,p_conversation,sequence+20,null)||jsonb_build_object('focusId',p_message,'before',(sequence+20)::text);
end $$;

create function g19_private.mark_private_read(p_actor g19_private.devices,p_conversation uuid,p_seen bigint)
returns void language plpgsql set search_path='' as $$
declare own_period uuid;
begin
 if p_seen is null then return; end if;
 if not exists(select 1 from g19_private.private_messages where conversation_id=p_conversation and seq=p_seen) then raise sqlstate 'PT400' using message='invalid_message_cursor'; end if;
 select period_id into own_period from g19_private.private_current_period where room=p_actor.room;
 insert into g19_private.private_read_cursors(conversation_id,room,period_id,last_read_seq,read_at)
 values(p_conversation,p_actor.room,own_period,p_seen,statement_timestamp())
 on conflict(conversation_id,room,period_id) do update set last_read_seq=greatest(private_read_cursors.last_read_seq,excluded.last_read_seq),read_at=excluded.read_at;
 update g19_private.notification_inbox n set read_at=statement_timestamp()
 from g19_private.devices d,g19_private.private_messages m
 where n.device_id=d.id and d.room=p_actor.room and d.generation=p_actor.generation
 and n.private_conversation_id=p_conversation and n.private_message_id=m.id and m.seq<=p_seen and n.read_at is null;
end $$;
create function g19_private.drop_private_presence_revoked() returns trigger language plpgsql set search_path='' as $$
begin delete from g19_private.private_presence where device_id=new.id;return new;end $$;
create trigger g19_drop_private_presence after update of revoked_at on g19_private.devices
 for each row when(old.revoked_at is null and new.revoked_at is not null) execute function g19_private.drop_private_presence_revoked();
create function public.g19_private_activity(p_token text,p_tab uuid,p_conversation uuid,p_seen_seq bigint,p_active boolean)
returns void language plpgsql security definer set search_path='' as $$
declare actor g19_private.devices;
begin
 perform g19_private.require_private_enabled();perform g19_private.require_private_conversation(p_token,p_conversation);
 actor:=g19_private.lock_device(p_token);
 if p_tab is null or p_active is null then raise sqlstate 'PT400' using message='activity_invalid'; end if;
 delete from g19_private.private_presence where device_id=actor.id and(tab=p_tab or active_until<=statement_timestamp());
 if p_active then
  perform g19_private.mark_private_read(actor,p_conversation,p_seen_seq);
  if g19_private.private_writable(p_conversation) then
   insert into g19_private.private_presence(device_id,tab,conversation_id,active_since,active_until)
   values(actor.id,p_tab,p_conversation,statement_timestamp(),statement_timestamp()+interval '40 seconds');
  end if;
 end if;
end $$;

create function g19_private.notify_private_message() returns trigger language plpgsql set search_path='' as $$
begin
 insert into g19_private.notification_inbox(device_id,category,event_key,title,description,target,created_at,private_conversation_id,private_message_id)
 select d.id,'messages','private:'||new.id::text,'Nowa wiadomość prywatna','Pokój nr '||new.sender_room,
 '#dyskusje/prywatne/'||new.conversation_id::text,new.created_at,new.conversation_id,new.id
 from g19_private.private_members member
 join g19_private.private_current_period cp on(cp.room,cp.period_id)=(member.room,member.period_id)
 join g19_private.rooms r on r.room=member.room and r.occupied
 join g19_private.devices d on d.room=r.room and d.generation=r.generation and d.revoked_at is null
 where member.conversation_id=new.conversation_id and member.room<>new.sender_room
 on conflict(device_id,category,event_key) do nothing;
 return new;
end $$;
create trigger g19_notify_private_message after insert on g19_private.private_messages for each row execute function g19_private.notify_private_message();

-- Legacy clients can only mark general-chat/announcement/duty events.
create or replace function public.g19_notification_read(p_token text,p_id bigint,p_categories text[])
returns void language plpgsql security definer set search_path='' as $$
declare actor g19_private.devices:=g19_private.lock_device(p_token);
begin
 update g19_private.notification_inbox set read_at=statement_timestamp()
 where device_id=actor.id and private_conversation_id is null and category=any(p_categories) and(p_id is null or id=p_id) and read_at is null;
end $$;
create or replace function public.g19_notification_activity(p_token text,p_tab uuid,p_active boolean,p_seen bigint,p_presented bigint[])
returns void language plpgsql security definer set search_path='' as $$
declare actor g19_private.devices:=g19_private.lock_device(p_token);
begin
 delete from g19_private.notification_presence where device_id=actor.id and(active_until<=statement_timestamp() or(tab=p_tab and not p_active));
 if p_active then
  insert into g19_private.notification_presence(device_id,tab,active_since,active_until)
  values(actor.id,p_tab,statement_timestamp(),statement_timestamp()+interval '40 seconds')
  on conflict(device_id,tab) do update set active_until=excluded.active_until;
 end if;
 if p_active and cardinality(p_presented) between 1 and 50 then
  update g19_private.notification_inbox set presented_at=statement_timestamp()
  where device_id=actor.id and private_conversation_id is null and id=any(p_presented) and presented_at is null;
 end if;
 if p_active and p_seen>0 then
  update g19_private.notification_inbox set read_at=statement_timestamp()
  where device_id=actor.id and read_at is null and
    case when category='messages' and private_message_id is null then event_key::bigint end<=p_seen;
 end if;
end $$;
create function public.g19_notification_activity_v2(p_token text,p_tab uuid,p_active boolean,p_seen bigint,p_presented bigint[])
returns void language plpgsql security definer set search_path='' as $$
declare actor g19_private.devices;
begin
 perform public.g19_notification_activity(p_token,p_tab,p_active,p_seen,p_presented);
 actor:=g19_private.lock_device(p_token);
 if p_active and cardinality(p_presented) between 1 and 50 then
  update g19_private.notification_inbox n set presented_at=statement_timestamp()
  where n.device_id=actor.id and n.id=any(p_presented) and n.presented_at is null
  and n.private_conversation_id is not null and g19_private.private_readable(actor.id,n.private_conversation_id);
 end if;
end $$;
create function g19_private.inbox_snapshot(p_token text,p_categories text[],p_private boolean)
returns jsonb language plpgsql set search_path='' as $$
declare actor g19_private.devices:=g19_private.lock_device(p_token); result jsonb; unread bigint;
begin
 with eligible as materialized(select n.* from g19_private.notification_inbox n where n.device_id=actor.id and n.category=any(p_categories)
  and(n.category<>'announcements' or g19_private.announcement_is_active(n.event_key,false))
  and(n.private_conversation_id is null or(p_private and g19_private.private_readable(actor.id,n.private_conversation_id))))
 select (select count(*) from eligible where read_at is null),
  (select coalesce(jsonb_agg(jsonb_build_object('id',n.id::text,'title',n.title,'description',n.description,'target',n.target,'category',n.category,
   'kind',case when n.private_conversation_id is not null then 'private' else 'general' end,'conversation',n.private_conversation_id,
   'createdAt',n.created_at,'receivedAt',n.received_at,'read',n.read_at is not null) order by n.created_at desc,n.id desc),'[]'::jsonb)
   from(select * from eligible order by created_at desc,id desc limit 50)n)
 into unread,result;
 return jsonb_build_object('items',result,'unread',unread);
end $$;
create or replace function public.g19_notifications(p_token text,p_categories text[]) returns jsonb language sql security definer set search_path='' as $$
 select g19_private.inbox_snapshot(p_token,p_categories,false);
$$;
create function public.g19_notifications_v2(p_token text,p_categories text[]) returns jsonb language sql security definer set search_path='' as $$
 select g19_private.inbox_snapshot(p_token,p_categories,coalesce((select enabled from g19_private.private_chat_settings where singleton),false));
$$;
create function public.g19_notification_read_v2(p_token text,p_id bigint,p_categories text[])
returns void language plpgsql security definer set search_path='' as $$
declare actor g19_private.devices; selected record;
begin
 perform public.g19_notification_read(p_token,p_id,p_categories);actor:=g19_private.lock_device(p_token);
 if not coalesce('messages'=any(p_categories),false) then return; end if;
 if not exists(select 1 from g19_private.private_chat_settings where singleton and enabled) then return; end if;
 if p_id is not null then
  for selected in select n.private_conversation_id as conversation,m.seq as seen from g19_private.notification_inbox n
   join g19_private.private_messages m on m.id=n.private_message_id
   where n.id=p_id and n.device_id=actor.id and g19_private.private_readable(actor.id,n.private_conversation_id)
  loop perform g19_private.mark_private_read(actor,selected.conversation,selected.seen);end loop;
 else
  for selected in select member.conversation_id as conversation,max(m.seq) as seen
   from g19_private.private_members member join g19_private.private_current_period cp on(cp.room,cp.period_id)=(member.room,member.period_id)
   join g19_private.private_messages m on m.conversation_id=member.conversation_id
   where member.room=actor.room group by member.conversation_id order by member.conversation_id
  loop perform g19_private.mark_private_read(actor,selected.conversation,selected.seen);end loop;
 end if;
end $$;

create function public.g19_private_delivery_active(p_notification bigint) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from g19_private.notification_inbox n
 join g19_private.devices d on d.id=n.device_id
 join g19_private.private_messages m on m.id=n.private_message_id and m.conversation_id=n.private_conversation_id
 where n.id=p_notification and d.room<>m.sender_room and n.read_at is null and n.presented_at is null
 and g19_private.private_readable(d.id,n.private_conversation_id) and g19_private.private_writable(n.private_conversation_id)
 and(select enabled from g19_private.private_chat_settings where singleton));
$$;
create or replace function public.g19_push_take() returns jsonb language sql security definer set search_path='' as $$
 with available as (
  select n.id,n.event_key,s.endpoint,s.p256dh,s.auth,n.title,n.category,n.target,n.description,n.announcement_push_summary,n.private_conversation_id,n.private_message_id
  from g19_private.notification_inbox n join g19_private.push_subscriptions s using(device_id)
  join g19_private.devices d on d.id=n.device_id and d.revoked_at is null
  join g19_private.rooms r on r.room=d.room and r.generation=d.generation
  left join g19_private.push_delivery q on q.notification_id=n.id
  where n.category=any(s.categories) and(n.category<>'announcements' or g19_private.announcement_is_active(n.event_key,true))
  and(n.private_message_id is null or public.g19_private_delivery_active(n.id))
  and n.read_at is null and n.presented_at is null and n.received_at>=s.enabled_at
  and(case when n.private_message_id is null then not exists(select 1 from g19_private.notification_presence presence where presence.device_id=n.device_id and presence.active_until>statement_timestamp() and presence.active_since<=n.received_at)
   else not exists(select 1 from g19_private.private_presence presence where presence.device_id=n.device_id and presence.conversation_id=n.private_conversation_id and presence.active_until>statement_timestamp() and presence.active_since<=n.received_at) end)
  and n.received_at>=now()-interval '12 hours' and(q.notification_id is null or(not q.finished and q.attempts<5 and q.next_attempt_at<=now()))
  order by n.created_at limit 12 for update of n skip locked
 ), claimed as (
  insert into g19_private.push_delivery(notification_id,attempts,next_attempt_at,lease,endpoint)
  select id,1,now()+interval '3 minutes',gen_random_uuid(),endpoint from available
  on conflict(notification_id) do update set attempts=push_delivery.attempts+1,next_attempt_at=now()+interval '3 minutes',lease=gen_random_uuid(),endpoint=excluded.endpoint
   where not push_delivery.finished and push_delivery.attempts<5 and push_delivery.next_attempt_at<=now()
  returning notification_id,lease
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',a.id::text,'lease',c.lease,'endpoint',a.endpoint,'p256dh',a.p256dh,'auth',a.auth,
 'title',a.title,'category',a.category,'target',a.target,'room',coalesce(private_author.sender_room,author.room),'message',m.body,
 'kind',case when a.private_message_id is not null then 'private' else 'general' end,
 'duty_saturday',case when a.category='duties' then a.event_key end,
 'announcement_title',case when a.category='announcements' then a.description end,'announcement_summary',a.announcement_push_summary)),'[]'::jsonb)
 from claimed c join available a on a.id=c.notification_id
 left join g19_private.messages m on m.id=case when a.category='messages' and a.private_message_id is null then a.event_key::bigint end
 left join g19_private.devices author on author.id=m.device_id
 left join g19_private.private_messages private_author on private_author.id=a.private_message_id;
$$;

-- Revoke default function execution before committing. Internal helpers never
-- become a public API; server-only delivery gets neutral metadata, not bodies.
revoke all on function g19_private.require_private_enabled(),g19_private.clean_message(text),g19_private.private_readable(uuid,uuid),
 g19_private.private_writable(uuid),g19_private.private_unread(smallint,uuid,uuid),g19_private.validate_private_message(),
 g19_private.mark_private_read(g19_private.devices,uuid,bigint),g19_private.drop_private_presence_revoked(),g19_private.notify_private_message(),g19_private.inbox_snapshot(text,text[],boolean)
 from public,anon,authenticated,service_role;
revoke all on function public.g19_chat_capabilities(),public.g19_send(text,uuid,text),public.g19_read(text,bigint,bigint),
 public.g19_send_reply(text,uuid,text,bigint),public.g19_general_message(text,bigint),public.g19_private_list(text),public.g19_private_archive(text,uuid),
 public.g19_private_send(text,integer,uuid,uuid,text,uuid),public.g19_private_read(text,uuid,bigint,bigint),public.g19_private_message(text,uuid,uuid),
 public.g19_private_activity(text,uuid,uuid,bigint,boolean),public.g19_notification_activity_v2(text,uuid,boolean,bigint,bigint[]),
 public.g19_notifications_v2(text,text[]),public.g19_notification_read_v2(text,bigint,text[]),public.g19_private_delivery_active(bigint)
 from public,anon,authenticated,service_role;
grant execute on function public.g19_chat_capabilities(),public.g19_send(text,uuid,text),public.g19_read(text,bigint,bigint),
 public.g19_send_reply(text,uuid,text,bigint),public.g19_general_message(text,bigint),public.g19_private_list(text),public.g19_private_archive(text,uuid),
 public.g19_private_send(text,integer,uuid,uuid,text,uuid),public.g19_private_read(text,uuid,bigint,bigint),public.g19_private_message(text,uuid,uuid),
 public.g19_private_activity(text,uuid,uuid,bigint,boolean),public.g19_notification_activity_v2(text,uuid,boolean,bigint,bigint[]),
 public.g19_notifications_v2(text,text[]),public.g19_notification_read_v2(text,bigint,text[])
 to anon;
grant execute on function public.g19_private_delivery_active(bigint) to service_role;
notify pgrst,'reload schema';
commit;
