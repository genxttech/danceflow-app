-- Reconciliation migration: aria_digest_runs
--
-- public.aria_digest_runs already exists in production (confirmed via a
-- read-only production schema inspection performed for ARIA
-- release-readiness criterion 1.2) but was never captured by a CREATE TABLE
-- migration in this repository. Application code
-- (src/app/api/cron/aria-digest/route.ts, src/lib/notifications/dispatch.ts,
-- src/app/app/aria/operations/page.tsx) has read from and written to this
-- table since before migration tracking began here.
--
-- This migration documents the table's exact, literally-verified production
-- schema (columns, defaults, constraint names/expressions, indexes, and RLS
-- policy names/predicates) so that (a) fresh/dev/staging environments that
-- lack the table get it created correctly, and (b) production, which
-- already has it, is left untouched. No statement below is intended to
-- alter, drop, or otherwise change any existing production column,
-- constraint, index, policy, or data.
--
-- Every statement is independently idempotent and safe to run whether the
-- table is being created for the first time or already exists with this
-- schema:
--   - CREATE TABLE IF NOT EXISTS no-ops entirely against production, where
--     the table (and its inline PK/UNIQUE/CHECK/FK) already exist.
--   - Each CREATE INDEX IF NOT EXISTS is its own idempotent guard, not
--     dependent on whether the CREATE TABLE above actually ran.
--   - ENABLE ROW LEVEL SECURITY is a no-op if RLS is already enabled.
--   - DROP POLICY IF EXISTS + CREATE POLICY is this repository's existing
--     pattern (see aria_digest_preferences) for safely reconciling policy
--     definitions.

create table if not exists public.aria_digest_runs (
  id uuid not null default gen_random_uuid(),
  studio_id uuid not null,
  digest_type text not null,
  digest_date date not null,
  delivery_channel text not null default 'in_app',
  recipient_user_id uuid null,
  recipient_email text null,
  status text not null default 'processing',
  summary jsonb not null default '{}'::jsonb,
  delivery_id uuid null,
  error_message text null,
  processed_at timestamptz null,
  created_at timestamptz not null default now(),
  retry_count integer not null default 0,
  last_attempt_at timestamptz null,
  next_attempt_at timestamptz null,
  sent_at timestamptz null,
  constraint aria_digest_runs_pkey primary key (id),
  constraint aria_digest_runs_studio_id_fkey
    foreign key (studio_id) references public.studios(id)
    on update no action on delete cascade,
  constraint aria_digest_runs_digest_type_check
    check (digest_type = any (array['morning'::text, 'end_of_day'::text])),
  constraint aria_digest_runs_delivery_channel_check
    check (delivery_channel = any (array['in_app'::text, 'email'::text])),
  constraint aria_digest_runs_status_check
    check (
      status = any (array[
        'processing'::text,
        'prepared'::text,
        'queued'::text,
        'sent'::text,
        'skipped'::text,
        'failed'::text
      ])
    ),
  constraint aria_digest_runs_studio_id_digest_type_digest_date_key
    unique (studio_id, digest_type, digest_date)
);

-- Indexes verified against production metadata; each guard is independent
-- of whether CREATE TABLE above just ran or no-opped. (The PK and UNIQUE
-- constraint above generate their own backing indexes automatically:
-- aria_digest_runs_pkey and aria_digest_runs_studio_id_digest_type_digest_date_key.)

create index if not exists aria_digest_runs_delivery_id_idx
  on public.aria_digest_runs (delivery_id)
  where delivery_id is not null;

create index if not exists aria_digest_runs_retry_due_idx
  on public.aria_digest_runs (next_attempt_at)
  where status = 'failed' and retry_count < 3;

create index if not exists aria_digest_runs_status_idx
  on public.aria_digest_runs (status, created_at desc);

create index if not exists aria_digest_runs_studio_created_idx
  on public.aria_digest_runs (studio_id, created_at desc);

-- Row level security. Policy names and predicates below are the literal,
-- verified production definitions (not an approximation from a sibling
-- table): both the view (SELECT) and manage (ALL) policies apply to the
-- `authenticated` role and share the identical manager-role-gated
-- predicate; the ALL policy's USING and WITH CHECK clauses are identical.

alter table public.aria_digest_runs enable row level security;

drop policy if exists "Managers can view ARIA digest runs for their studios"
  on public.aria_digest_runs;

drop policy if exists "Managers can manage ARIA digest runs for their studios"
  on public.aria_digest_runs;

create policy "Managers can view ARIA digest runs for their studios"
  on public.aria_digest_runs
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = aria_digest_runs.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'owner',
          'admin',
          'manager',
          'studio_owner',
          'studio_admin',
          'studio_manager'
        )
    )
    or exists (
      select 1
      from public.organizer_users ou
      join public.organizers o on o.id = ou.organizer_id
      where o.studio_id = aria_digest_runs.studio_id
        and ou.user_id = auth.uid()
        and ou.active = true
        and ou.role::text in (
          'organizer_owner',
          'organizer_admin',
          'organizer_staff'
        )
    )
  );

create policy "Managers can manage ARIA digest runs for their studios"
  on public.aria_digest_runs
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = aria_digest_runs.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'owner',
          'admin',
          'manager',
          'studio_owner',
          'studio_admin',
          'studio_manager'
        )
    )
    or exists (
      select 1
      from public.organizer_users ou
      join public.organizers o on o.id = ou.organizer_id
      where o.studio_id = aria_digest_runs.studio_id
        and ou.user_id = auth.uid()
        and ou.active = true
        and ou.role::text in (
          'organizer_owner',
          'organizer_admin',
          'organizer_staff'
        )
    )
  )
  with check (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = aria_digest_runs.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'owner',
          'admin',
          'manager',
          'studio_owner',
          'studio_admin',
          'studio_manager'
        )
    )
    or exists (
      select 1
      from public.organizer_users ou
      join public.organizers o on o.id = ou.organizer_id
      where o.studio_id = aria_digest_runs.studio_id
        and ou.user_id = auth.uid()
        and ou.active = true
        and ou.role::text in (
          'organizer_owner',
          'organizer_admin',
          'organizer_staff'
        )
    )
  );
