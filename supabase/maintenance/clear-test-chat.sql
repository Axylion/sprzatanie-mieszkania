-- Run only in SQL Editor of goleszan-19-test, project pbsubdmuupwmtgzncxmh.
-- This is a one-time operation. Do not add it to the migration sequence.
begin;
set local lock_timeout = '4s';

-- Pause chat writes and push leasing until the cleanup commits.
lock table g19_private.chat_revision, g19_private.messages, g19_private.reactions,
  g19_private.notification_inbox, g19_private.push_delivery in access exclusive mode;

-- Inbox rows use the message ID as event_key. Include all message events so
-- older test notifications also disappear; other categories are preserved.
delete from g19_private.push_delivery d using g19_private.notification_inbox n
  where d.notification_id = n.id and n.category = 'messages';
delete from g19_private.notification_inbox where category = 'messages';
delete from g19_private.reactions r using g19_private.messages m where r.message_id = m.id;
delete from g19_private.messages where id > 0;
update g19_private.chat_revision set version = version + 1 where singleton = true;

commit;
