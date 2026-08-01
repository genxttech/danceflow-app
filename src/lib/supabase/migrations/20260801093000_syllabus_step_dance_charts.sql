-- DanceFlow Studio Curriculum & Syllabus Platform V2 - Slice 3
-- Structured dance-chart builder for canonical syllabus steps.
-- Run after:
--   20260801090000_syllabus_curriculum_v2_slice_1.sql
--   20260801091500_syllabus_style_dance_classification_correction.sql

create table if not exists public.syllabus_step_charts (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  syllabus_step_id uuid not null references public.syllabus_steps(id) on delete cascade,
  title text not null default 'Dance chart',
  chart_format text not null default 'partner'
    check (chart_format in ('partner', 'solo', 'custom')),
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (syllabus_step_id)
);

create table if not exists public.syllabus_step_chart_rows (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  chart_id uuid not null references public.syllabus_step_charts(id) on delete cascade,
  sort_order integer not null default 0,
  count_label text,
  leader_foot text,
  leader_action text,
  follower_foot text,
  follower_action text,
  direction text,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_syllabus_step_charts_studio
  on public.syllabus_step_charts(studio_id, syllabus_step_id);

create index if not exists idx_syllabus_step_chart_rows_chart_order
  on public.syllabus_step_chart_rows(chart_id, sort_order, created_at);

alter table public.syllabus_step_charts enable row level security;
alter table public.syllabus_step_chart_rows enable row level security;

drop policy if exists "Studio members can view syllabus charts" on public.syllabus_step_charts;
create policy "Studio members can view syllabus charts"
on public.syllabus_step_charts for select
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = syllabus_step_charts.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

drop policy if exists "Studio members can manage syllabus charts" on public.syllabus_step_charts;
create policy "Studio members can manage syllabus charts"
on public.syllabus_step_charts for all
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = syllabus_step_charts.studio_id
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
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = syllabus_step_charts.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner', 'studio_admin', 'front_desk',
        'instructor', 'independent_instructor'
      )
  )
);

drop policy if exists "Studio members can view syllabus chart rows" on public.syllabus_step_chart_rows;
create policy "Studio members can view syllabus chart rows"
on public.syllabus_step_chart_rows for select
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = syllabus_step_chart_rows.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

drop policy if exists "Studio members can manage syllabus chart rows" on public.syllabus_step_chart_rows;
create policy "Studio members can manage syllabus chart rows"
on public.syllabus_step_chart_rows for all
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = syllabus_step_chart_rows.studio_id
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
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = syllabus_step_chart_rows.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner', 'studio_admin', 'front_desk',
        'instructor', 'independent_instructor'
      )
  )
);
