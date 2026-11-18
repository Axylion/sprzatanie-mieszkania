begin;

-- Independent of notification preferences and the inbox's 50-row display limit.
-- The device token grants the same discussion access as g19_read.
create or replace function public.g19_chat_navigation_count(p_token text, p_seen bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  device g19_private.devices := g19_private.lock_device(p_token);
  newest bigint;
  unread bigint;
begin
  select coalesce(max(id), 0) into newest from g19_private.messages;
  if p_seen is not null and p_seen < 0 then
    raise sqlstate 'PT400' using message = 'invalid_message_cursor';
  end if;
  select count(*) into unread from g19_private.messages m
    join g19_private.devices author on author.id = m.device_id
    where m.id > coalesce(p_seen, newest) and m.id <= newest
      and (author.room, author.generation) <> (device.room, device.generation);
  return jsonb_build_object('latest', newest::text, 'unread', unread);
end;
$$;
revoke all on function public.g19_chat_navigation_count(text,bigint) from public, anon, authenticated, service_role;
grant execute on function public.g19_chat_navigation_count(text,bigint) to anon;
notify pgrst, 'reload schema';

commit;
