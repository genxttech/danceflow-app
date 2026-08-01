-- DanceFlow Studio Curriculum & Syllabus Platform V2 - Slice 5A
-- Canonical step assignments and private-lesson recap attachments.
-- Run after 20260801094500_syllabus_mux_video_assets.sql.

create table if not exists public.client_syllabus_step_assignments (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  syllabus_step_id uuid not null references public.syllabus_steps(id) on delete cascade,
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  target_date date,
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high')),
  status text not null default 'assigned'
    check (status in (
      'assigned',
      'introduced',
      'practicing',
      'comfortable',
      'mastered',
      'archived'
    )),
  practice_note text,
  student_visible boolean not null default true,
  completed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, syllabus_step_id)
);

create index if not exists client_syllabus_step_assignments_client_idx
  on public.client_syllabus_step_assignments(
    studio_id,
    client_id,
    archived_at,
    assigned_at desc
  );

create index if not exists client_syllabus_step_assignments_step_idx
  on public.client_syllabus_step_assignments(
    syllabus_step_id,
    status
  );

create table if not exists public.lesson_recap_syllabus_steps (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  lesson_recap_id uuid not null references public.lesson_recaps(id) on delete cascade,
  syllabus_step_id uuid not null references public.syllabus_steps(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  progress_status text not null default 'practiced'
    check (progress_status in (
      'introduced',
      'practiced',
      'needs_review',
      'assigned',
      'mastered'
    )),
  recap_note text,
  practice_guidance text,
  student_visible boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lesson_recap_id, syllabus_step_id)
);

create index if not exists lesson_recap_syllabus_steps_recap_idx
  on public.lesson_recap_syllabus_steps(lesson_recap_id, created_at);

create index if not exists lesson_recap_syllabus_steps_client_idx
  on public.lesson_recap_syllabus_steps(studio_id, client_id, syllabus_step_id);

alter table public.client_syllabus_step_assignments enable row level security;
alter table public.lesson_recap_syllabus_steps enable row level security;

drop policy if exists "Studio members can view direct syllabus assignments"
  on public.client_syllabus_step_assignments;
create policy "Studio members can view direct syllabus assignments"
on public.client_syllabus_step_assignments for select
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = client_syllabus_step_assignments.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

drop policy if exists "Studio members can manage direct syllabus assignments"
  on public.client_syllabus_step_assignments;
create policy "Studio members can manage direct syllabus assignments"
on public.client_syllabus_step_assignments for all
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = client_syllabus_step_assignments.studio_id
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
    where usr.studio_id = client_syllabus_step_assignments.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner', 'studio_admin', 'front_desk',
        'instructor', 'independent_instructor'
      )
  )
);

drop policy if exists "Studio members can view recap syllabus steps"
  on public.lesson_recap_syllabus_steps;
create policy "Studio members can view recap syllabus steps"
on public.lesson_recap_syllabus_steps for select
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = lesson_recap_syllabus_steps.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

drop policy if exists "Studio members can manage recap syllabus steps"
  on public.lesson_recap_syllabus_steps;
create policy "Studio members can manage recap syllabus steps"
on public.lesson_recap_syllabus_steps for all
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = lesson_recap_syllabus_steps.studio_id
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
    where usr.studio_id = lesson_recap_syllabus_steps.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner', 'studio_admin', 'front_desk',
        'instructor', 'independent_instructor'
      )
  )
);
