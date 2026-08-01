-- DanceFlow Studio Curriculum & Syllabus Platform V2 - Slice 5B
-- Group lesson recap curriculum attachments and attendee assignments.
-- Run after 20260801170000_syllabus_assignments_private_recap_steps.sql.

create table if not exists public.group_lesson_recap_syllabus_steps (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  group_lesson_recap_id uuid not null references public.group_lesson_recaps(id) on delete cascade,
  syllabus_step_id uuid not null references public.syllabus_steps(id) on delete cascade,
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
  unique (group_lesson_recap_id, syllabus_step_id)
);

create index if not exists group_lesson_recap_syllabus_steps_recap_idx
  on public.group_lesson_recap_syllabus_steps(
    group_lesson_recap_id,
    created_at
  );

create index if not exists group_lesson_recap_syllabus_steps_step_idx
  on public.group_lesson_recap_syllabus_steps(
    studio_id,
    syllabus_step_id,
    progress_status
  );

alter table public.group_lesson_recap_syllabus_steps enable row level security;

drop policy if exists "Studio members can view group recap syllabus steps"
  on public.group_lesson_recap_syllabus_steps;
create policy "Studio members can view group recap syllabus steps"
on public.group_lesson_recap_syllabus_steps for select
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = group_lesson_recap_syllabus_steps.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

drop policy if exists "Studio members can manage group recap syllabus steps"
  on public.group_lesson_recap_syllabus_steps;
create policy "Studio members can manage group recap syllabus steps"
on public.group_lesson_recap_syllabus_steps for all
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = group_lesson_recap_syllabus_steps.studio_id
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
    where usr.studio_id = group_lesson_recap_syllabus_steps.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner', 'studio_admin', 'front_desk',
        'instructor', 'independent_instructor'
      )
  )
);
