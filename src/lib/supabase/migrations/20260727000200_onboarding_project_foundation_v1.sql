-- DanceFlow onboarding project foundation v1
-- Persistent 30-day onboarding, milestone, decision, exception, activity,
-- readiness, and import linkage foundation.

create extension if not exists pgcrypto;

create table if not exists public.onboarding_projects (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  checklist_type text not null default 'studio',
  source_system text,
  onboarding_mode text not null default 'guided',
  status text not null default 'active',
  current_phase text not null default 'essentials',
  started_at timestamptz not null default now(),
  target_go_live_date date not null default (current_date + 30),
  actual_go_live_date date,
  assigned_owner_user_id uuid references auth.users(id) on delete set null,
  readiness_score integer not null default 0,
  next_milestone_key text,
  last_activity_at timestamptz not null default now(),
  completed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint onboarding_projects_checklist_type_check
    check (checklist_type in ('studio', 'organizer')),
  constraint onboarding_projects_mode_check
    check (onboarding_mode in ('guided', 'self_service', 'assisted_migration')),
  constraint onboarding_projects_status_check
    check (status in ('not_started', 'active', 'blocked', 'ready_for_launch', 'live', 'completed', 'paused')),
  constraint onboarding_projects_readiness_score_check
    check (readiness_score between 0 and 100),
  constraint onboarding_projects_workspace_type_unique
    unique (studio_id, checklist_type)
);

create index if not exists onboarding_projects_status_target_idx
  on public.onboarding_projects(status, target_go_live_date);

create table if not exists public.onboarding_milestones (
  id uuid primary key default gen_random_uuid(),
  onboarding_project_id uuid not null references public.onboarding_projects(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  milestone_key text not null,
  domain_key text not null default 'essentials',
  title text not null,
  status text not null default 'not_started',
  required_for_launch boolean not null default true,
  sequence_number integer not null default 0,
  evidence jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint onboarding_milestones_status_check
    check (status in ('not_started', 'in_progress', 'blocked', 'ready', 'completed', 'waived')),
  constraint onboarding_milestones_project_key_unique
    unique (onboarding_project_id, milestone_key)
);

create index if not exists onboarding_milestones_project_status_idx
  on public.onboarding_milestones(onboarding_project_id, status, sequence_number);

create table if not exists public.onboarding_exceptions (
  id uuid primary key default gen_random_uuid(),
  onboarding_project_id uuid not null references public.onboarding_projects(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  exception_key text not null,
  category text not null,
  severity text not null default 'warning',
  title text not null,
  description text,
  source_table text,
  source_id uuid,
  status text not null default 'open',
  assigned_to uuid references auth.users(id) on delete set null,
  resolution_note text,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint onboarding_exceptions_severity_check
    check (severity in ('info', 'warning', 'high', 'critical')),
  constraint onboarding_exceptions_status_check
    check (status in ('open', 'in_review', 'resolved', 'waived', 'superseded'))
);

create index if not exists onboarding_exceptions_project_status_idx
  on public.onboarding_exceptions(onboarding_project_id, status, severity);

create table if not exists public.onboarding_decisions (
  id uuid primary key default gen_random_uuid(),
  onboarding_project_id uuid not null references public.onboarding_projects(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  decision_key text not null,
  title text not null,
  description text,
  decision_type text not null default 'owner_choice',
  status text not null default 'pending',
  options jsonb not null default '[]'::jsonb,
  selected_value jsonb,
  due_at timestamptz,
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint onboarding_decisions_status_check
    check (status in ('pending', 'decided', 'deferred', 'not_required', 'superseded'))
);

create index if not exists onboarding_decisions_project_status_idx
  on public.onboarding_decisions(onboarding_project_id, status, due_at);

create table if not exists public.onboarding_activity (
  id uuid primary key default gen_random_uuid(),
  onboarding_project_id uuid not null references public.onboarding_projects(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  event_type text not null,
  title text not null,
  description text,
  related_table text,
  related_id uuid,
  actor_user_id uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists onboarding_activity_project_created_idx
  on public.onboarding_activity(onboarding_project_id, created_at desc);

create table if not exists public.onboarding_readiness_snapshots (
  id uuid primary key default gen_random_uuid(),
  onboarding_project_id uuid not null references public.onboarding_projects(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  readiness_score integer not null,
  completed_milestones integer not null default 0,
  total_milestones integer not null default 0,
  open_exceptions integer not null default 0,
  pending_decisions integer not null default 0,
  domain_scores jsonb not null default '{}'::jsonb,
  snapshot_reason text not null default 'workspace_sync',
  created_at timestamptz not null default now(),
  constraint onboarding_readiness_score_check
    check (readiness_score between 0 and 100)
);

create index if not exists onboarding_readiness_project_created_idx
  on public.onboarding_readiness_snapshots(onboarding_project_id, created_at desc);

-- Link the existing import engine to the onboarding project without replacing it.
alter table public.import_batches
  add column if not exists onboarding_project_id uuid references public.onboarding_projects(id) on delete set null,
  add column if not exists stage_key text,
  add column if not exists sequence_number integer,
  add column if not exists reconciliation_status text not null default 'not_started',
  add column if not exists supersedes_batch_id uuid references public.import_batches(id) on delete set null,
  add column if not exists idempotency_key text;

create index if not exists import_batches_onboarding_project_idx
  on public.import_batches(onboarding_project_id, sequence_number, created_at);

create unique index if not exists import_batches_idempotency_unique
  on public.import_batches(studio_id, idempotency_key)
  where idempotency_key is not null;

-- RLS
alter table public.onboarding_projects enable row level security;
alter table public.onboarding_milestones enable row level security;
alter table public.onboarding_exceptions enable row level security;
alter table public.onboarding_decisions enable row level security;
alter table public.onboarding_activity enable row level security;
alter table public.onboarding_readiness_snapshots enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'onboarding_projects',
    'onboarding_milestones',
    'onboarding_exceptions',
    'onboarding_decisions',
    'onboarding_activity',
    'onboarding_readiness_snapshots'
  ]
  loop
    execute format('drop policy if exists %I_workspace_access on public.%I', table_name, table_name);
    execute format($policy$
      create policy %I_workspace_access
      on public.%I
      for all
      using (
        exists (
          select 1
          from public.user_studio_roles usr
          where usr.studio_id = %I.studio_id
            and usr.user_id = auth.uid()
            and usr.active = true
        )
        or exists (
          select 1
          from public.organizers o
          join public.organizer_users ou on ou.organizer_id = o.id
          where o.studio_id = %I.studio_id
            and ou.user_id = auth.uid()
            and ou.active = true
        )
      )
      with check (
        exists (
          select 1
          from public.user_studio_roles usr
          where usr.studio_id = %I.studio_id
            and usr.user_id = auth.uid()
            and usr.active = true
        )
        or exists (
          select 1
          from public.organizers o
          join public.organizer_users ou on ou.organizer_id = o.id
          where o.studio_id = %I.studio_id
            and ou.user_id = auth.uid()
            and ou.active = true
        )
      )
    $policy$, table_name, table_name, table_name, table_name, table_name, table_name);
  end loop;
end $$;

comment on table public.onboarding_projects is
  'Persistent studio or organizer implementation project targeting operational readiness within 30 days.';
comment on table public.onboarding_milestones is
  'Operational, migration, retail, integration, and launch milestones for an onboarding project.';
comment on column public.import_batches.stage_key is
  'Ordered migration stage such as clients, instructors, products, inventory, appointments, payments, retail_orders, or digital_entitlements.';
