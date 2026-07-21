-- Commerce Slice 5: digital content library foundation.
-- Apply after 20260720223000_sync_retail_accounting.sql.
-- Apply before deploying Slice 5.

create table if not exists public.commerce_digital_content (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  catalog_item_id uuid not null references public.commerce_catalog_items(id) on delete cascade,
  content_kind text not null,
  title text not null,
  summary text,
  skill_level text,
  dance_style text,
  instructor_name text,
  duration_seconds integer,
  thumbnail_bucket text,
  thumbnail_path text,
  media_bucket text,
  media_path text,
  download_bucket text,
  download_path text,
  external_provider text,
  external_asset_id text,
  external_playback_id text,
  status text not null default 'draft',
  release_at timestamptz,
  published_at timestamptz,
  archived_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_digital_content_catalog_unique unique (catalog_item_id),
  constraint commerce_digital_content_kind_check
    check (content_kind in ('video', 'series', 'download')),
  constraint commerce_digital_content_status_check
    check (status in ('draft', 'published', 'archived')),
  constraint commerce_digital_content_skill_check
    check (
      skill_level is null or
      skill_level in (
        'all_levels',
        'beginner',
        'intermediate',
        'advanced',
        'professional'
      )
    ),
  constraint commerce_digital_content_duration_check
    check (
      duration_seconds is null or
      (duration_seconds >= 0 and duration_seconds <= 86400)
    ),
  constraint commerce_digital_content_provider_check
    check (
      external_provider is null or
      external_provider in ('mux', 'vimeo', 'youtube', 'wistia', 'other')
    ),
  constraint commerce_digital_content_thumbnail_reference_check
    check (
      (thumbnail_bucket is null and thumbnail_path is null) or
      (thumbnail_bucket is not null and thumbnail_path is not null)
    ),
  constraint commerce_digital_content_media_reference_check
    check (
      (media_bucket is null and media_path is null) or
      (media_bucket is not null and media_path is not null)
    ),
  constraint commerce_digital_content_download_reference_check
    check (
      (download_bucket is null and download_path is null) or
      (download_bucket is not null and download_path is not null)
    )
);

create index if not exists commerce_digital_content_studio_status_idx
  on public.commerce_digital_content(studio_id, status, content_kind);

create index if not exists commerce_digital_content_release_idx
  on public.commerce_digital_content(studio_id, release_at)
  where release_at is not null;

create table if not exists public.commerce_series_items (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  series_catalog_item_id uuid not null references public.commerce_catalog_items(id) on delete cascade,
  child_catalog_item_id uuid not null references public.commerce_catalog_items(id) on delete cascade,
  position integer not null default 0,
  title_override text,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_series_items_distinct_check
    check (series_catalog_item_id <> child_catalog_item_id),
  constraint commerce_series_items_position_check
    check (position >= 0),
  constraint commerce_series_items_unique
    unique (series_catalog_item_id, child_catalog_item_id)
);

create index if not exists commerce_series_items_order_idx
  on public.commerce_series_items(
    series_catalog_item_id,
    active,
    position,
    created_at
  );

create or replace function public.validate_commerce_digital_content()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item_type text;
begin
  select item_type
  into v_item_type
  from public.commerce_catalog_items
  where id = new.catalog_item_id
    and studio_id = new.studio_id;

  if v_item_type is null then
    raise exception 'Catalog item was not found for this studio.';
  end if;

  if (
    (v_item_type = 'digital_video' and new.content_kind <> 'video') or
    (v_item_type = 'video_series' and new.content_kind <> 'series') or
    (v_item_type = 'digital_download' and new.content_kind <> 'download') or
    v_item_type not in ('digital_video', 'video_series', 'digital_download')
  ) then
    raise exception 'Digital content kind does not match the catalog item type.';
  end if;

  return new;
end;
$$;

drop trigger if exists commerce_digital_content_validate
  on public.commerce_digital_content;

create trigger commerce_digital_content_validate
before insert or update
on public.commerce_digital_content
for each row
execute function public.validate_commerce_digital_content();

create or replace function public.validate_commerce_series_item()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_series_type text;
  v_child_type text;
begin
  select item_type
  into v_series_type
  from public.commerce_catalog_items
  where id = new.series_catalog_item_id
    and studio_id = new.studio_id;

  select item_type
  into v_child_type
  from public.commerce_catalog_items
  where id = new.child_catalog_item_id
    and studio_id = new.studio_id;

  if v_series_type <> 'video_series' then
    raise exception 'Series item must belong to a video-series catalog item.';
  end if;

  if v_child_type <> 'digital_video' then
    raise exception 'Only digital-video catalog items may be added to a series.';
  end if;

  return new;
end;
$$;

drop trigger if exists commerce_series_items_validate
  on public.commerce_series_items;

create trigger commerce_series_items_validate
before insert or update
on public.commerce_series_items
for each row
execute function public.validate_commerce_series_item();

drop trigger if exists commerce_digital_content_set_updated_at
  on public.commerce_digital_content;

create trigger commerce_digital_content_set_updated_at
before update on public.commerce_digital_content
for each row execute function public.commerce_set_updated_at();

drop trigger if exists commerce_series_items_set_updated_at
  on public.commerce_series_items;

create trigger commerce_series_items_set_updated_at
before update on public.commerce_series_items
for each row execute function public.commerce_set_updated_at();

alter table public.commerce_digital_content enable row level security;
alter table public.commerce_series_items enable row level security;

drop policy if exists "commerce digital content managers read"
  on public.commerce_digital_content;
create policy "commerce digital content managers read"
  on public.commerce_digital_content
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_digital_content.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin',
          'front_desk'
        )
    )
  );

drop policy if exists "commerce digital content managers write"
  on public.commerce_digital_content;
create policy "commerce digital content managers write"
  on public.commerce_digital_content
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_digital_content.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin'
        )
    )
  )
  with check (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_digital_content.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin'
        )
    )
  );

drop policy if exists "commerce series items managers read"
  on public.commerce_series_items;
create policy "commerce series items managers read"
  on public.commerce_series_items
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_series_items.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin',
          'front_desk'
        )
    )
  );

drop policy if exists "commerce series items managers write"
  on public.commerce_series_items;
create policy "commerce series items managers write"
  on public.commerce_series_items
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_series_items.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin'
        )
    )
  )
  with check (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_series_items.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin'
        )
    )
  );

grant select, insert, update, delete
  on public.commerce_digital_content
  to authenticated;

grant select, insert, update, delete
  on public.commerce_series_items
  to authenticated;

revoke execute
  on function public.validate_commerce_digital_content()
  from public, anon, authenticated;

revoke execute
  on function public.validate_commerce_series_item()
  from public, anon, authenticated;
