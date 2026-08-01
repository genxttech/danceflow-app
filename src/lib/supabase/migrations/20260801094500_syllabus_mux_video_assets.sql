-- DanceFlow Studio Curriculum & Syllabus Platform V2 - Slice 4
-- Private Mux-backed curriculum video assets.
-- Run after 20260801093000_syllabus_step_dance_charts.sql.

create table if not exists public.studio_video_assets (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  title text not null,
  description text,
  content_type text not null default 'figure'
    check (content_type in (
      'figure',
      'technique',
      'practice_drill',
      'general_instruction',
      'course_lesson'
    )),
  presentation_type text not null default 'demonstration'
    check (presentation_type in (
      'demonstration',
      'explanation',
      'leader',
      'follower',
      'slow_motion',
      'full_speed'
    )),
  style_id uuid references public.syllabus_styles(id) on delete set null,
  dance_id uuid references public.syllabus_dances(id) on delete set null,
  level_id uuid references public.syllabus_levels(id) on delete set null,
  step_id uuid references public.syllabus_steps(id) on delete set null,
  visibility text not null default 'private'
    check (visibility in ('private', 'assigned_students', 'studio_students')),
  mux_upload_id text,
  mux_upload_status text,
  mux_asset_id text,
  mux_asset_status text,
  mux_playback_id text,
  mux_error_message text,
  duration_seconds integer,
  mux_aspect_ratio text,
  status text not null default 'draft'
    check (status in ('draft', 'ready', 'archived')),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint studio_video_assets_duration_check
    check (duration_seconds is null or duration_seconds >= 0),
  constraint studio_video_assets_mux_upload_status_check
    check (
      mux_upload_status is null or
      mux_upload_status in (
        'waiting', 'uploading', 'asset_created', 'processing',
        'ready', 'errored', 'cancelled', 'timed_out', 'deleted'
      )
    )
);

create unique index if not exists studio_video_assets_mux_upload_unique
  on public.studio_video_assets(mux_upload_id)
  where mux_upload_id is not null;

create unique index if not exists studio_video_assets_mux_asset_unique
  on public.studio_video_assets(mux_asset_id)
  where mux_asset_id is not null;

create index if not exists studio_video_assets_taxonomy_idx
  on public.studio_video_assets(studio_id, style_id, dance_id, level_id, step_id);

create index if not exists studio_video_assets_status_idx
  on public.studio_video_assets(studio_id, status, mux_upload_status);

create table if not exists public.syllabus_step_videos (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  syllabus_step_id uuid not null references public.syllabus_steps(id) on delete cascade,
  video_asset_id uuid not null references public.studio_video_assets(id) on delete cascade,
  display_order integer not null default 0,
  student_visible boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (syllabus_step_id, video_asset_id)
);

create index if not exists syllabus_step_videos_step_order_idx
  on public.syllabus_step_videos(syllabus_step_id, display_order, created_at);

alter table public.commerce_mux_webhook_events
  add column if not exists syllabus_video_asset_id uuid
    references public.studio_video_assets(id) on delete set null;

create index if not exists commerce_mux_webhook_events_syllabus_asset_idx
  on public.commerce_mux_webhook_events(syllabus_video_asset_id, received_at desc);

alter table public.studio_video_assets enable row level security;
alter table public.syllabus_step_videos enable row level security;

drop policy if exists "Studio members can view curriculum videos" on public.studio_video_assets;
create policy "Studio members can view curriculum videos"
on public.studio_video_assets for select
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = studio_video_assets.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

drop policy if exists "Studio members can manage curriculum videos" on public.studio_video_assets;
create policy "Studio members can manage curriculum videos"
on public.studio_video_assets for all
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = studio_video_assets.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner', 'studio_admin', 'front_desk',
        'instructor', 'independent_instructor'
      )
  )
)
with check (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = studio_video_assets.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner', 'studio_admin', 'front_desk',
        'instructor', 'independent_instructor'
      )
  )
);

drop policy if exists "Studio members can view syllabus video links" on public.syllabus_step_videos;
create policy "Studio members can view syllabus video links"
on public.syllabus_step_videos for select
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = syllabus_step_videos.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

drop policy if exists "Studio members can manage syllabus video links" on public.syllabus_step_videos;
create policy "Studio members can manage syllabus video links"
on public.syllabus_step_videos for all
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = syllabus_step_videos.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner', 'studio_admin', 'front_desk',
        'instructor', 'independent_instructor'
      )
  )
)
with check (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = syllabus_step_videos.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner', 'studio_admin', 'front_desk',
        'instructor', 'independent_instructor'
      )
  )
);
