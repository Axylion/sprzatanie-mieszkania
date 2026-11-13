-- Run via psql in an empty disposable database with Supabase roles created.
-- G19_SAFEUPDATE_LIBRARY must point to a pg-safeupdate library for this server.
\set ON_ERROR_STOP on
\getenv safeupdate_library G19_SAFEUPDATE_LIBRARY
\ir ../supabase/migrations/202611130001_dyskusje.sql
\ir ../supabase/migrations/202611130002_pairing_codes.sql

select public.g19_bind(1, repeat('a', 64))->>'token' as first_token \gset
select public.g19_pair_start(1) as pair \gset
select public.g19_pair_decide(:'first_token', :'pair'::jsonb->>'code', true);
select public.g19_pair_claim(:'pair'::jsonb->>'secret')->>'token' as second_token \gset
select public.g19_send(:'first_token', gen_random_uuid(), 'Wiadomość przed migracją') as old_message \gset
select public.g19_react(:'second_token', :'old_message'::bigint, 1);

-- Age the fixture's reaction cooldown without sleeping.
update g19_private.devices set next_reaction_at = null
where token_hash = g19_private.token_hash(:'second_token');

select set_config('g19_test.first_token', :'first_token', false) as saved_first,
  set_config('g19_test.second_token', :'second_token', false) as saved_second \gset
load :'safeupdate_library';
set safeupdate.enabled = on;
-- Reparse plans prepared while seeding the pre-migration data.
discard plans;

set role anon;
do $$
declare
  error_context text;
begin
  begin
    perform public.g19_send(current_setting('g19_test.second_token'), gen_random_uuid(), 'Próba przed poprawką');
    raise exception 'Expected safeupdate to reject the old function';
  exception when sqlstate '21000' then
    get stacked diagnostics error_context = pg_exception_context;
    if sqlerrm <> 'UPDATE requires a WHERE clause'
       or position('update g19_private.chat_revision' in error_context) = 0 then
      raise;
    end if;
    raise notice 'Reproduced SQLSTATE 21000 in g19_send while updating chat_revision';
  end;
end;
$$;
reset role;

\ir ../supabase/migrations/202611130003_scope_chat_revision_updates.sql

set role anon;
do $$
declare
  first_token text := current_setting('g19_test.first_token');
  second_token text := current_setting('g19_test.second_token');
  request_id uuid := gen_random_uuid();
  message_id text;
  previous jsonb;
  history jsonb;
begin
  previous := public.g19_read(first_token);
  if jsonb_array_length(previous->'messages') <> 1
     or previous#>>'{messages,0,body}' <> 'Wiadomość przed migracją'
     or previous#>>'{messages,0,vote}' <> '1' then
    raise exception 'Expected original message and reaction, with failed write rolled back';
  end if;

  message_id := public.g19_send(second_token, request_id, 'Wysłane po poprawce');
  if public.g19_send(second_token, request_id, 'Wysłane po poprawce') is distinct from message_id then
    raise exception 'Retry must return the same message';
  end if;
  history := public.g19_read(first_token, null, (previous->>'version')::bigint);
  if jsonb_array_length(history->'messages') is distinct from 2
     or history#>>'{messages,1,id}' is distinct from message_id
     or history#>>'{messages,1,mine}' is distinct from 'true' then
    raise exception 'The other device must read the new message in its room';
  end if;
  perform public.g19_react(first_token, message_id::bigint, 1);
  perform public.g19_react(second_token, message_id::bigint, 1);
  history := public.g19_read(second_token, null, (history->>'version')::bigint);
  if history#>>'{messages,1,up}' is distinct from '1'
     or history#>>'{messages,1,vote}' is distinct from '1' then
    raise exception 'Same-room devices must share a single reaction';
  end if;
  perform public.g19_react(second_token, message_id::bigint, -1);
  history := public.g19_read(first_token, null, (history->>'version')::bigint);
  if history#>>'{messages,1,up}' is distinct from '0'
     or history#>>'{messages,1,down}' is distinct from '1'
     or history#>>'{messages,1,vote}' is distinct from '-1' then
    raise exception 'The reaction change must reach both devices';
  end if;

  begin
    perform public.g19_send('invalid', gen_random_uuid(), 'Odrzucona wiadomość');
    raise exception 'Invalid token accepted';
  exception when sqlstate 'PT401' then null;
  end;
  begin
    perform public.g19_admin_change_resident(1, 1, 2);
    raise exception 'anon must not reset the room';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from g19_private.messages;
    raise exception 'anon must not read the private table';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

do $$
begin
  if public.g19_admin_change_resident(1, 1, 2) is distinct from 2 then
    raise exception 'The admin reset must revoke both devices';
  end if;
  if (select count(*) from g19_private.messages) <> 2 then
    raise exception 'The reset must retain both messages';
  end if;
  begin
    perform public.g19_read(current_setting('g19_test.second_token'));
    raise exception 'Revoked token accepted';
  exception when sqlstate 'PT401' then null;
  end;
end;
$$;
