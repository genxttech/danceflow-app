-- DanceFlow onboarding pilot readiness and activation analytics v1

create table if not exists public.onboarding_activation_events (
  id uuid primary key default gen_random_uuid(),
  onboarding_project_id uuid not null references public.onboarding_projects(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  event_key text not null,
  source_table text,
  source_id uuid,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint onboarding_activation_events_key_check check (
    event_key in (
      'first_import_completed',
      'first_booking_created',
      'first_payment_recorded',
      'first_portal_login',
      'first_aria_action_completed',
      'pilot_started',
      'pilot_completed',
      'go_live_confirmed'
    )
  )
);

create unique index if not exists onboarding_activation_events_once_unique
  on public.onboarding_activation_events(onboarding_project_id, event_key)
  where event_key in (
    'first_import_completed',
    'first_booking_created',
    'first_payment_recorded',
    'first_portal_login',
    'first_aria_action_completed',
    'pilot_started',
    'pilot_completed',
    'go_live_confirmed'
  );

create index if not exists onboarding_activation_events_project_occurred_idx
  on public.onboarding_activation_events(onboarding_project_id, occurred_at desc);

alter table public.onboarding_projects
  add column if not exists pilot_started_at timestamptz,
  add column if not exists pilot_completed_at timestamptz,
  add column if not exists activation_score integer not null default 0,
  add column if not exists reconciliation_score integer not null default 0,
  add column if not exists pilot_readiness_score integer not null default 0;

alter table public.onboarding_projects
  drop constraint if exists onboarding_projects_activation_score_check,
  add constraint onboarding_projects_activation_score_check check (activation_score between 0 and 100),
  drop constraint if exists onboarding_projects_reconciliation_score_check,
  add constraint onboarding_projects_reconciliation_score_check check (reconciliation_score between 0 and 100),
  drop constraint if exists onboarding_projects_pilot_readiness_score_check,
  add constraint onboarding_projects_pilot_readiness_score_check check (pilot_readiness_score between 0 and 100);

alter table public.onboarding_activation_events enable row level security;

drop policy if exists onboarding_activation_events_workspace_access
  on public.onboarding_activation_events;

create policy onboarding_activation_events_workspace_access
  on public.onboarding_activation_events
  for all
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = onboarding_activation_events.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
    )
    or exists (
      select 1
      from public.organizers o
      join public.organizer_users ou on ou.organizer_id = o.id
      where o.studio_id = onboarding_activation_events.studio_id
        and ou.user_id = auth.uid()
        and ou.active = true
    )
  )
  with check (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = onboarding_activation_events.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
    )
    or exists (
      select 1
      from public.organizers o
      join public.organizer_users ou on ou.organizer_id = o.id
      where o.studio_id = onboarding_activation_events.studio_id
        and ou.user_id = auth.uid()
        and ou.active = true
    )
  );

comment on table public.onboarding_activation_events is
  'First-success and pilot lifecycle events used to measure 30-day onboarding activation.';
