-- READ ONLY. Run only against the explicitly selected project before a future
-- approved deployment. No secrets, token hashes, message bodies or endpoints.
begin read only;
select version();
select to_regclass('supabase_migrations.schema_migrations') as optional_migration_ledger,
  to_regprocedure('public.g19_chat_navigation_count(text,bigint)') as migration_019_marker;
select room, generation, occupied,
  (select count(*) from g19_private.devices d where d.room=r.room
    and d.generation=r.generation and d.revoked_at is null) as active_devices
from g19_private.rooms r order by room;
select 'messages' as relation, count(*) from g19_private.messages
union all select 'reactions', count(*) from g19_private.reactions
union all select 'devices', count(*) from g19_private.devices
union all select 'inbox', count(*) from g19_private.notification_inbox
union all select 'delivery', count(*) from g19_private.push_delivery
union all select 'subscriptions', count(*) from g19_private.push_subscriptions;
select pubname, puballtables from pg_catalog.pg_publication;
select pubname, schemaname, tablename from pg_catalog.pg_publication_tables
where schemaname in ('g19_private','public');
select n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
where n.nspname='g19_private' and c.relkind='r';
select n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) as arguments,
  p.prosecdef, p.proacl, p.proconfig
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
where (n.nspname='public' and p.proname like 'g19_%') or n.nspname='g19_private';
rollback;
