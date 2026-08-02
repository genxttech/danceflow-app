begin;

create table if not exists public.studio_gusto_pay_schedules (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  connection_id uuid not null references public.studio_gusto_connections(id) on delete cascade,
  gusto_pay_schedule_uuid uuid not null,
  name text,
  frequency text,
  active boolean not null default true,
  synced_at timestamptz not null default now(),
  raw_summary jsonb not null default '{}'::jsonb,
  unique (connection_id, gusto_pay_schedule_uuid)
);

create table if not exists public.studio_gusto_worker_jobs (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  connection_id uuid not null references public.studio_gusto_connections(id) on delete cascade,
  gusto_worker_uuid uuid not null,
  gusto_job_uuid uuid not null,
  title text,
  active boolean not null default true,
  hire_date date,
  termination_date date,
  synced_at timestamptz not null default now(),
  raw_summary jsonb not null default '{}'::jsonb,
  unique (connection_id, gusto_job_uuid)
);

create table if not exists public.studio_gusto_pay_periods (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  connection_id uuid not null references public.studio_gusto_connections(id) on delete cascade,
  gusto_pay_period_uuid uuid,
  gusto_pay_schedule_uuid uuid,
  period_start date not null,
  period_end date not null,
  pay_date date,
  synced_at timestamptz not null default now(),
  raw_summary jsonb not null default '{}'::jsonb,
  unique (connection_id, gusto_pay_schedule_uuid, period_start, period_end)
);

create table if not exists public.studio_gusto_readiness_reviews (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  connection_id uuid not null references public.studio_gusto_connections(id) on delete cascade,
  pay_period_id uuid not null references public.payroll_pay_periods(id) on delete cascade,
  status text not null check (status in ('ready','blocked')),
  earning_count integer not null default 0,
  ready_count integer not null default 0,
  blocker_count integer not null default 0,
  summary jsonb not null default '{}'::jsonb,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.studio_gusto_readiness_items (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.studio_gusto_readiness_reviews(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  earning_id uuid not null references public.instructor_earnings(id) on delete cascade,
  instructor_id uuid not null references public.instructors(id) on delete cascade,
  gusto_worker_uuid uuid,
  gusto_job_uuid uuid,
  readiness_status text not null check (readiness_status in ('ready','blocked')),
  blocker_codes text[] not null default '{}'::text[],
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (review_id, earning_id)
);

create index if not exists studio_gusto_readiness_reviews_period_idx
  on public.studio_gusto_readiness_reviews(studio_id, pay_period_id, reviewed_at desc);
create index if not exists studio_gusto_readiness_items_review_idx
  on public.studio_gusto_readiness_items(review_id, readiness_status);

alter table public.studio_gusto_pay_schedules enable row level security;
alter table public.studio_gusto_worker_jobs enable row level security;
alter table public.studio_gusto_pay_periods enable row level security;
alter table public.studio_gusto_readiness_reviews enable row level security;
alter table public.studio_gusto_readiness_items enable row level security;

create policy "Studio payroll managers read Gusto pay schedules"
on public.studio_gusto_pay_schedules for select to authenticated
using (public.can_manage_studio_gusto(studio_id));

create policy "Studio payroll managers read Gusto worker jobs"
on public.studio_gusto_worker_jobs for select to authenticated
using (public.can_manage_studio_gusto(studio_id));

create policy "Studio payroll managers read Gusto pay periods"
on public.studio_gusto_pay_periods for select to authenticated
using (public.can_manage_studio_gusto(studio_id));

create policy "Studio payroll managers read Gusto readiness reviews"
on public.studio_gusto_readiness_reviews for select to authenticated
using (public.can_manage_studio_gusto(studio_id));

create policy "Studio payroll managers read Gusto readiness items"
on public.studio_gusto_readiness_items for select to authenticated
using (public.can_manage_studio_gusto(studio_id));

commit;
