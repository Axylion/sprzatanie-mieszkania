begin;

-- Retain the announcement ID and delivery history. An archive deletion only
-- removes the announcement from the administrative list.
alter table g19_private.announcements add column if not exists deleted_at timestamptz;

create or replace function g19_private.announcement_default_expiry(p_published_at timestamptz)
returns timestamptz language sql immutable set search_path = '' as $$
  select (((p_published_at at time zone 'Europe/Warsaw')::date + 31)::timestamp) at time zone 'Europe/Warsaw';
$$;
revoke all on function g19_private.announcement_default_expiry(timestamptz) from public, anon, authenticated, service_role;

revoke all on function g19_private.validate_announcement_nodes(jsonb,integer),
  g19_private.announcement_plain_text(jsonb) from public, anon, authenticated, service_role;

create or replace function public.g19_web_admin_announcements()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform g19_private.require_web_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'title', a.title, 'content', a.content,
    'summary', left(regexp_replace(g19_private.announcement_plain_text(a.content), '[[:space:]]+', ' ', 'g'), 160),
    'status', case when a.state = 'published' and a.expires_at <= statement_timestamp()
                  then 'expired' else a.state end,
    'publishedAt', a.published_at, 'expiresAt', a.expires_at, 'endsOn', a.ends_on,
    'displayEndsOn', case when a.expires_at is not null then
      ((a.expires_at - interval '1 microsecond') at time zone 'Europe/Warsaw')::date end,
    'updatedAt', a.updated_at, 'withdrawnAt', a.withdrawn_at, 'revision', a.revision
  ) order by a.updated_at desc, a.id), '[]'::jsonb) from g19_private.announcements a where a.deleted_at is null);
end;
$$;

create or replace function public.g19_web_admin_save_announcement(
  p_id text, p_revision integer, p_title text, p_content jsonb, p_ends_on date, p_publish boolean
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := g19_private.require_web_admin();
  existing g19_private.announcements;
  stamp timestamptz := statement_timestamp();
  local_now timestamp := stamp at time zone 'Europe/Warsaw';
  new_expiry timestamptz;
  plain text;
  clean_title text := btrim(p_title);
  new_id text;
begin
  if clean_title is null or length(clean_title) not between 1 and 160 or p_content is null
    or octet_length(p_content::text) > 65536 or p_publish is null then
    raise sqlstate 'PT400' using message = 'invalid_announcement';
  end if;
  perform g19_private.validate_announcement_nodes(p_content);
  plain := btrim(regexp_replace(g19_private.announcement_plain_text(p_content), '[[:space:]]+', ' ', 'g'));
  if length(plain) > 12000 or (p_publish and length(plain) = 0) then
    raise sqlstate 'PT400' using message = 'invalid_announcement_content';
  end if;
  if p_revision is not null then
    select a.* into existing from g19_private.announcements a where a.id = p_id for update;
    if not found or existing.deleted_at is not null or existing.revision is distinct from p_revision
      or (p_publish and existing.state <> 'draft') then
      raise sqlstate 'PT409' using message = 'announcement_changed';
    end if;
  end if;
  if p_revision is null and p_id is not null
    and p_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise sqlstate 'PT400' using message = 'invalid_announcement_id';
  end if;
  new_expiry := existing.expires_at;
  if existing.state = 'withdrawn' or (existing.state = 'published' and existing.expires_at <= stamp) then
    p_ends_on := existing.ends_on;
  elsif existing.state = 'published' and p_ends_on is not distinct from existing.ends_on then
    -- Preserve the exact existing expiry on unrelated edits, including legacy records.
    null;
  elsif p_ends_on is not null then
    if not isfinite(p_ends_on) or p_ends_on > local_now::date + 3650
      or p_ends_on < local_now::date then
      raise sqlstate 'PT400' using message = 'invalid_announcement_expiry';
    end if;
    if p_publish or existing.state = 'published' then
      new_expiry := ((p_ends_on + 1)::timestamp at time zone 'Europe/Warsaw');
    end if;
  elsif p_publish then
    new_expiry := g19_private.announcement_default_expiry(stamp);
  elsif existing.state = 'published' then
    p_ends_on := existing.ends_on;
  end if;
  if p_revision is null then
    insert into g19_private.announcements (id, title, content, state, published_at, expires_at, ends_on,
      changed_by, push_title, push_body)
    values (coalesce(p_id, gen_random_uuid()::text), clean_title, p_content,
      case when p_publish then 'published' else 'draft' end,
      case when p_publish then stamp end, new_expiry, p_ends_on, actor,
      case when p_publish then clean_title end, case when p_publish then plain end)
    on conflict (id) do nothing returning id into new_id;
    if new_id is not null then return new_id; end if;
    select a.* into existing from g19_private.announcements a where a.id = p_id;
    if existing.revision = 1 and existing.changed_by = actor and existing.title = clean_title
      and existing.content = p_content and existing.ends_on is not distinct from p_ends_on
      and existing.state = (case when p_publish then 'published' else 'draft' end) then
      return p_id;
    end if;
    raise sqlstate 'PT409' using message = 'announcement_changed';
  end if;
  update g19_private.announcements a
  set title = clean_title, content = p_content,
    state = case when p_publish then 'published' else a.state end,
    published_at = case when p_publish then stamp else a.published_at end,
    expires_at = new_expiry, ends_on = p_ends_on, changed_by = actor, updated_at = stamp,
    revision = a.revision + 1,
    content_version = a.content_version + case when a.title is distinct from clean_title
      or a.content is distinct from p_content then 1 else 0 end,
    legacy_hide_key = case when a.title is not distinct from clean_title
      and a.content is not distinct from p_content and a.expires_at is not distinct from new_expiry
      then a.legacy_hide_key end,
    push_title = case when p_publish then clean_title else a.push_title end,
    push_body = case when p_publish then plain else a.push_body end
  where a.id = p_id;
  return p_id;
end;
$$;

create or replace function public.g19_web_admin_delete_announcement(p_id text, p_revision integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := g19_private.require_web_admin();
  stamp timestamptz := statement_timestamp();
begin
  update g19_private.announcements a
     set deleted_at = stamp, changed_by = actor, updated_at = stamp, revision = a.revision + 1
   where a.id = p_id and a.revision = p_revision and a.deleted_at is null
     and (a.state = 'withdrawn' or (a.state = 'published' and a.expires_at <= stamp));
  if not found then raise sqlstate 'PT409' using message = 'announcement_changed'; end if;
end;
$$;

revoke all on function public.g19_web_admin_delete_announcement(text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.g19_web_admin_delete_announcement(text,integer) to authenticated;
notify pgrst, 'reload schema';

commit;
