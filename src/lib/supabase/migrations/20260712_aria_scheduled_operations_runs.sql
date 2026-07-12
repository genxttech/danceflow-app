create table if not exists public.aria_operations_runs (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  run_bucket timestamptz not null,
  status text not null default 'running'
    check (
      status in (
        'running',
        'completed',
        'completed_with_errors',
        'failed'
      )
    ),
  summary jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (studio_id, run_bucket)
);

create index if not exists aria_operations_runs_studio_started_idx
  on public.aria_operations_runs (studio_id, started_at desc);

alter table public.aria_operations_runs enable row level security;

drop policy if exists "aria operations runs studio managers read"
  on public.aria_operations_runs;

create policy "aria operations runs studio managers read"
  on public.aria_operations_runs
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = aria_operations_runs.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin'
        )
    )
    or exists (
      select 1
      from public.organizers o
      join public.organizer_users ou
        on ou.organizer_id = o.id
      where o.studio_id = aria_operations_runs.studio_id
        and ou.user_id = auth.uid()
        and ou.active = true
        and ou.role::text in (
          'organizer_owner',
          'organizer_admin'
        )
    )
  );
