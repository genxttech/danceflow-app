-- Commerce Slice 10: durable student video progress and completion tracking.
-- Apply after 20260721013000_create_commerce_playback_access_events.sql.
-- Apply before deploying the Slice 10 progress API and mobile Learn changes.

create table if not exists public.commerce_playback_progress (
  id uuid primary key default gen_random_uuid(),
  entitlement_id uuid not null
    references public.commerce_entitlements(id) on delete cascade,
  catalog_item_id uuid not null
    references public.commerce_catalog_items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  position_seconds integer not null default 0,
  duration_seconds integer not null default 0,
  percent_complete numeric(5,2) not null default 0,
  completed boolean not null default false,
  completed_at timestamptz,
  first_watched_at timestamptz not null default now(),
  last_watched_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_playback_progress_position_check
    check (position_seconds >= 0),
  constraint commerce_playback_progress_duration_check
    check (duration_seconds >= 0),
  constraint commerce_playback_progress_percent_check
    check (percent_complete >= 0 and percent_complete <= 100),
  constraint commerce_playback_progress_completion_check
    check (
      (completed = false and completed_at is null)
      or completed = true
    )
);

create unique index if not exists commerce_playback_progress_unique
  on public.commerce_playback_progress(entitlement_id, catalog_item_id);

create index if not exists commerce_playback_progress_user_recent_idx
  on public.commerce_playback_progress(user_id, last_watched_at desc);

create index if not exists commerce_playback_progress_completed_idx
  on public.commerce_playback_progress(studio_id, completed_at desc)
  where completed = true;

drop trigger if exists commerce_playback_progress_set_updated_at
  on public.commerce_playback_progress;

create trigger commerce_playback_progress_set_updated_at
before update on public.commerce_playback_progress
for each row execute function public.commerce_set_updated_at();

alter table public.commerce_playback_progress enable row level security;

revoke all
  on public.commerce_playback_progress
  from public, anon, authenticated;

grant select, insert, update
  on public.commerce_playback_progress
  to service_role;
