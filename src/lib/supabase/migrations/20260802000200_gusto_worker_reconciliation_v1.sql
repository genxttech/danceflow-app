begin;

create table if not exists public.studio_gusto_workers (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  connection_id uuid not null references public.studio_gusto_connections(id) on delete cascade,
  gusto_worker_uuid uuid not null,
  gusto_worker_type text not null check (gusto_worker_type in ('employee','contractor')),
  first_name text,
  last_name text,
  email text,
  active boolean not null default true,
  onboarding_status text,
  synced_at timestamptz not null default now(),
  raw_summary jsonb not null default '{}'::jsonb,
  unique (connection_id, gusto_worker_uuid)
);

create table if not exists public.studio_gusto_worker_matches (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  connection_id uuid not null references public.studio_gusto_connections(id) on delete cascade,
  instructor_id uuid not null references public.instructors(id) on delete cascade,
  gusto_worker_uuid uuid not null,
  gusto_worker_type text not null check (gusto_worker_type in ('employee','contractor')),
  match_status text not null default 'confirmed' check (match_status in ('confirmed','ignored')),
  match_method text not null check (match_method in ('exact_name_email','manual')),
  matched_points text[] not null default '{}'::text[],
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, instructor_id),
  unique (connection_id, gusto_worker_uuid)
);

create index if not exists studio_gusto_workers_studio_idx
  on public.studio_gusto_workers(studio_id, active);
create index if not exists studio_gusto_worker_matches_studio_idx
  on public.studio_gusto_worker_matches(studio_id, match_status);

alter table public.studio_gusto_workers enable row level security;
alter table public.studio_gusto_worker_matches enable row level security;

create policy "Studio payroll managers read Gusto workers"
on public.studio_gusto_workers for select to authenticated
using (public.can_manage_studio_gusto(studio_id));

create policy "Studio payroll managers read Gusto worker matches"
on public.studio_gusto_worker_matches for select to authenticated
using (public.can_manage_studio_gusto(studio_id));

commit;
