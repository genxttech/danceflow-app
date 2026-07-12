begin;

create table if not exists public.student_lesson_checkins (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  instructor_id uuid references public.instructors(id) on delete set null,
  checked_in_by_user_id uuid not null,
  checked_in_at timestamptz not null default now(),
  source text not null default 'student_mobile',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (appointment_id, client_id)
);

create index if not exists student_lesson_checkins_studio_time_idx
  on public.student_lesson_checkins (studio_id, checked_in_at desc);

create index if not exists student_lesson_checkins_instructor_time_idx
  on public.student_lesson_checkins (instructor_id, checked_in_at desc)
  where instructor_id is not null;

alter table public.student_lesson_checkins enable row level security;

drop policy if exists "student_lesson_checkins_service_role_only"
  on public.student_lesson_checkins;

create policy "student_lesson_checkins_service_role_only"
  on public.student_lesson_checkins
  for all
  using (false)
  with check (false);

commit;
