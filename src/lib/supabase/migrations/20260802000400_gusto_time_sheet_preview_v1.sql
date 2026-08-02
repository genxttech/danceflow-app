begin;

create table if not exists public.studio_gusto_time_sheet_previews (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  connection_id uuid not null references public.studio_gusto_connections(id) on delete cascade,
  pay_period_id uuid not null references public.payroll_pay_periods(id) on delete cascade,
  readiness_review_id uuid not null references public.studio_gusto_readiness_reviews(id) on delete cascade,
  status text not null check (status in ('ready','blocked')),
  shift_count integer not null default 0,
  ready_count integer not null default 0,
  blocker_count integer not null default 0,
  total_hours numeric(10,2) not null default 0,
  time_zone text not null,
  summary jsonb not null default '{}'::jsonb,
  prepared_by uuid references auth.users(id),
  prepared_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.studio_gusto_time_sheet_preview_items (
  id uuid primary key default gen_random_uuid(),
  preview_id uuid not null references public.studio_gusto_time_sheet_previews(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  earning_id uuid not null references public.instructor_earnings(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete cascade,
  instructor_id uuid not null references public.instructors(id) on delete cascade,
  gusto_worker_uuid uuid not null,
  gusto_job_uuid uuid not null,
  entity_type text not null default 'Employee',
  time_zone text not null,
  shift_started_at timestamptz,
  shift_ended_at timestamptz,
  hours_worked numeric(10,2),
  pay_classification text not null default 'Regular',
  preview_status text not null check (preview_status in ('ready','blocked')),
  blocker_codes text[] not null default '{}'::text[],
  payload_preview jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (preview_id, earning_id)
);

create index if not exists studio_gusto_time_sheet_previews_period_idx
  on public.studio_gusto_time_sheet_previews(studio_id, pay_period_id, prepared_at desc);

create index if not exists studio_gusto_time_sheet_preview_items_preview_idx
  on public.studio_gusto_time_sheet_preview_items(preview_id, preview_status);

alter table public.studio_gusto_time_sheet_previews enable row level security;
alter table public.studio_gusto_time_sheet_preview_items enable row level security;

create policy "Studio payroll managers read Gusto time sheet previews"
on public.studio_gusto_time_sheet_previews for select to authenticated
using (public.can_manage_studio_gusto(studio_id));

create policy "Studio payroll managers read Gusto time sheet preview items"
on public.studio_gusto_time_sheet_preview_items for select to authenticated
using (public.can_manage_studio_gusto(studio_id));

commit;
