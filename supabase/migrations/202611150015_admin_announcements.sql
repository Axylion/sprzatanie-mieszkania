begin;

create table g19_private.announcements (
  id text primary key default gen_random_uuid()::text,
  title text not null,
  content jsonb not null,
  state text not null default 'draft' check (state in ('draft', 'published', 'withdrawn')),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  published_at timestamptz,
  expires_at timestamptz,
  ends_on date,
  withdrawn_at timestamptz,
  changed_by uuid,
  content_version integer not null default 1,
  revision integer not null default 1,
  legacy_hide_key text,
  push_title text,
  push_body text
);
alter table g19_private.announcements enable row level security;
revoke all on g19_private.announcements from public, anon, authenticated, service_role;

-- Store a validated document tree instead of accepting HTML from the browser.
create function g19_private.validate_announcement_nodes(p_nodes jsonb, p_depth integer default 0)
returns void language plpgsql immutable set search_path = '' as $$
declare
  item jsonb;
  tag text;
begin
  if jsonb_typeof(p_nodes) is distinct from 'array' or p_depth > 12 then
    raise sqlstate 'PT400' using message = 'invalid_announcement_content';
  end if;
  for item in select value from jsonb_array_elements(p_nodes) loop
    if jsonb_typeof(item) = 'string' then continue; end if;
    if jsonb_typeof(item) is distinct from 'object' then
      raise sqlstate 'PT400' using message = 'invalid_announcement_content';
    end if;
    tag := item->>'tag';
    if tag is null or tag not in ('p','h2','h3','strong','em','u','ul','ol','li','br','a')
      or exists (select 1 from jsonb_object_keys(item) as k(key)
                 where k.key not in ('tag','children') and (tag <> 'a' or k.key <> 'href'))
      or (tag = 'a' and (jsonb_typeof(item->'href') is distinct from 'string'
        or length(item->>'href') > 2048
        or item->>'href' !~* '^https?://[^/?#[:space:][:cntrl:]]+([/?#][^[:space:][:cntrl:]]*)?$'
        or position(chr(92) in item->>'href') > 0))
      or (tag = 'br' and item->'children' is distinct from '[]'::jsonb) then
      raise sqlstate 'PT400' using message = 'invalid_announcement_content';
    end if;
    perform g19_private.validate_announcement_nodes(item->'children', p_depth + 1);
  end loop;
end;
$$;

create function g19_private.announcement_plain_text(p_nodes jsonb)
returns text language sql immutable set search_path = '' as $$
  select coalesce(string_agg(
    case when jsonb_typeof(item) = 'string' then item #>> '{}'
      when item->>'tag' = 'br' then E'\n'
      when item->>'tag' in ('p','h2','h3','li','ul','ol')
        then g19_private.announcement_plain_text(item->'children') || E'\n'
      else g19_private.announcement_plain_text(item->'children')
    end, '' order by ordinal), '')
  from jsonb_array_elements(p_nodes) with ordinality as nodes(item, ordinal);
$$;
create function g19_private.announcement_default_expiry(p_published_at timestamptz)
returns timestamptz language sql immutable set search_path = '' as $$
  select ((p_published_at at time zone 'Europe/Warsaw') + interval '30 days') at time zone 'Europe/Warsaw';
$$;
revoke all on function g19_private.announcement_default_expiry(timestamptz) from public, anon, authenticated, service_role;

revoke all on function g19_private.validate_announcement_nodes(jsonb,integer),
  g19_private.announcement_plain_text(jsonb) from public, anon, authenticated, service_role;

create function public.g19_public_announcements()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'title', a.title, 'body', g19_private.announcement_plain_text(a.content),
    'content', a.content, 'publishedAt', a.published_at, 'expiresAt', a.expires_at,
    'version', a.content_version, 'legacyHideKey', a.legacy_hide_key
  ) order by a.published_at desc, a.id), '[]'::jsonb)
  from g19_private.announcements a
  where a.state = 'published' and a.published_at <= statement_timestamp()
    and (a.expires_at is null or a.expires_at > statement_timestamp());
$$;

create function public.g19_web_admin_announcements()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform g19_private.require_web_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'title', a.title, 'content', a.content,
    'summary', left(regexp_replace(g19_private.announcement_plain_text(a.content), '[[:space:]]+', ' ', 'g'), 160),
    'status', case when a.state = 'published' and a.expires_at <= statement_timestamp()
                  then 'expired' else a.state end,
    'publishedAt', a.published_at, 'expiresAt', a.expires_at, 'endsOn', a.ends_on,
    'updatedAt', a.updated_at, 'withdrawnAt', a.withdrawn_at, 'revision', a.revision
  ) order by a.updated_at desc, a.id), '[]'::jsonb) from g19_private.announcements a);
end;
$$;

create function public.g19_web_admin_save_announcement(
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
    if not found or existing.revision is distinct from p_revision
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

create function public.g19_web_admin_withdraw_announcement(p_id text, p_revision integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := g19_private.require_web_admin();
begin
  update g19_private.announcements a
  set state = 'withdrawn', changed_by = actor, updated_at = statement_timestamp(),
    withdrawn_at = statement_timestamp(),
    revision = a.revision + 1
  where a.id = p_id and a.revision = p_revision and a.state = 'published'
    and (a.expires_at is null or a.expires_at > statement_timestamp());
  if not found then raise sqlstate 'PT409' using message = 'announcement_changed'; end if;
end;
$$;

revoke all on function public.g19_public_announcements(), public.g19_web_admin_announcements(),
  public.g19_web_admin_save_announcement(text,integer,text,jsonb,date,boolean),
  public.g19_web_admin_withdraw_announcement(text,integer) from public, anon, authenticated, service_role;
grant execute on function public.g19_public_announcements() to anon, authenticated;
grant execute on function public.g19_web_admin_announcements(),
  public.g19_web_admin_save_announcement(text,integer,text,jsonb,date,boolean),
  public.g19_web_admin_withdraw_announcement(text,integer) to authenticated;
notify pgrst, 'reload schema';
commit;
