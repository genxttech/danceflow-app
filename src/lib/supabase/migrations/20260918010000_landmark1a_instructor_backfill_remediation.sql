-- Landmark 1A -- Slice 3: Existing Instructor Linkage & Capability
-- Backfill Remediation.
--
-- One-time, migration-only remediation of *existing* instructors rows,
-- using the exact ongoing linkage precedence already locked and shipped
-- in Slice 2, plus Decision 8's exact 4-condition can_instruct
-- predicate. Never creates an account, never creates a new instructors
-- row, never guesses on ambiguity, never overwrites a non-null
-- conflicting user_id. Conflict checks are studio-scoped only -- the
-- same person legitimately holds instructor relationships at multiple
-- studios; the only invariant enforced is at most one instructors row
-- per (studio_id, user_id), matching exactly what Slice 4's future
-- partial unique index will enforce.
--
-- The complete deterministic mutation set (identity AND capability) is
-- precomputed in a transaction-scoped temp table BEFORE any persistent
-- mutation, so the capability predicate is evaluated against the
-- post-linkage target identity, not the pre-migration value -- a row
-- that becomes capability-eligible only as a consequence of linkage
-- earlier in this same pass is never missed by the snapshot or the
-- audit trail.

begin;

-- 1. Precompute the complete target state -------------------------------

create temp table slice3_target_state (
  instructor_id uuid primary key,
  studio_id uuid not null,
  original_user_id uuid,
  target_user_id uuid,
  identity_matched_via text,
  original_can_instruct boolean not null,
  target_can_instruct boolean not null,
  needs_account_link_audit boolean not null default false,
  needs_capability_audit boolean not null default false
) on commit drop;

insert into slice3_target_state (
  instructor_id, studio_id, original_user_id, target_user_id,
  original_can_instruct, target_can_instruct
)
select id, studio_id, user_id, user_id, can_instruct, can_instruct
from public.instructors;

-- Tier 2: authoritative same-studio client_account_links.user_id,
-- reachable via clients.linked_instructor_id. Only applied when exactly
-- one distinct candidate user_id exists for the instructor row (never
-- guessing among multiple), and only when that candidate is not already
-- linked to a *different* instructors row at the same studio (checked
-- against both already-persisted data and other rows targeted within
-- this same pass). Never rejected merely because the candidate already
-- teaches at a different studio.
with tier2_pairs as (
  select distinct
    c.linked_instructor_id as instructor_id,
    c.studio_id,
    cal.user_id as candidate_user_id
  from public.clients c
  join public.client_account_links cal
    on cal.client_id = c.id
    and cal.studio_id = c.studio_id
    and cal.status = 'linked'
  where c.linked_instructor_id is not null
),
tier2_counts as (
  select instructor_id, count(*) as candidate_count
  from tier2_pairs
  group by instructor_id
),
tier2_unambiguous as (
  select p.instructor_id, p.studio_id, p.candidate_user_id
  from tier2_pairs p
  join tier2_counts c on c.instructor_id = p.instructor_id and c.candidate_count = 1
)
update slice3_target_state t
set target_user_id = m.candidate_user_id,
    identity_matched_via = 'client_account_links'
from tier2_unambiguous m
where t.instructor_id = m.instructor_id
  and t.studio_id = m.studio_id
  and t.target_user_id is null
  and not exists (
    select 1 from public.instructors i2
    where i2.studio_id = t.studio_id
      and i2.user_id = m.candidate_user_id
      and i2.id <> t.instructor_id
  )
  and not exists (
    select 1 from slice3_target_state t2
    where t2.studio_id = t.studio_id
      and t2.target_user_id = m.candidate_user_id
      and t2.instructor_id <> t.instructor_id
  );

-- Tier 3: valid profile_user_id compatibility mapping, only when
-- user_id is still unresolved after Tier 2. Same studio-scoped-only
-- conflict checks.
update slice3_target_state t
set target_user_id = i.profile_user_id,
    identity_matched_via = 'profile_user_id'
from public.instructors i
where t.instructor_id = i.id
  and t.target_user_id is null
  and i.profile_user_id is not null
  and not exists (
    select 1 from public.instructors i2
    where i2.studio_id = t.studio_id
      and i2.user_id = i.profile_user_id
      and i2.id <> t.instructor_id
  )
  and not exists (
    select 1 from slice3_target_state t2
    where t2.studio_id = t.studio_id
      and t2.target_user_id = i.profile_user_id
      and t2.instructor_id <> t.instructor_id
  );

-- Tier 4: exact, case-insensitive, same-studio email match, only when
-- exactly one currently-unlinked instructor row at that studio shares
-- the normalized email (never guessing among multiple), matched against
-- the one DanceFlow account with that email. Same studio-scoped-only
-- conflict checks.
with tier4_email_groups as (
  select studio_id, lower(trim(email)) as norm_email, count(*) as unlinked_group_size
  from public.instructors
  where email is not null and trim(email) <> '' and user_id is null
  group by studio_id, lower(trim(email))
)
update slice3_target_state t
set target_user_id = p.id,
    identity_matched_via = 'email'
from public.instructors i
join tier4_email_groups g
  on g.studio_id = i.studio_id
  and g.norm_email = lower(trim(i.email))
join public.profiles p
  on lower(trim(p.email)) = lower(trim(i.email))
where t.instructor_id = i.id
  and t.target_user_id is null
  and i.email is not null and trim(i.email) <> ''
  and g.unlinked_group_size = 1
  and not exists (
    select 1 from public.instructors i2
    where i2.studio_id = t.studio_id
      and i2.user_id = p.id
      and i2.id <> t.instructor_id
  )
  and not exists (
    select 1 from slice3_target_state t2
    where t2.studio_id = t.studio_id
      and t2.target_user_id = p.id
      and t2.instructor_id <> t.instructor_id
  );

-- Capability: Decision 8's exact 4-condition deterministic predicate,
-- evaluated against the just-computed TARGET user_id (post-linkage),
-- never the pre-migration value. Implemented as exactly the 4 locked
-- conditions -- no additional gate (e.g. instructors.active) is added,
-- since none is present in the locked predicate text.
update slice3_target_state t
set target_can_instruct = true
from public.user_studio_roles usr
where usr.user_id = t.target_user_id
  and usr.studio_id = t.studio_id
  and usr.active = true
  and usr.role = 'instructor'
  and t.target_user_id is not null
  and t.target_can_instruct = false;

-- Mark which rows actually change, and along which axis.
update slice3_target_state
set needs_account_link_audit = (target_user_id is distinct from original_user_id),
    needs_capability_audit = (target_can_instruct is distinct from original_can_instruct);

-- 2. Snapshot exactly the rows that will change --------------------------

create schema if not exists migration_support;
revoke all on schema migration_support from public, anon, authenticated;

create table if not exists migration_support.instructor_backfill_snapshot_20260918010000 (
  instructor_id uuid primary key,
  user_id uuid,
  can_instruct boolean,
  captured_at timestamptz not null default now()
);
alter table migration_support.instructor_backfill_snapshot_20260918010000 enable row level security;
revoke all on migration_support.instructor_backfill_snapshot_20260918010000 from public, anon, authenticated;

-- ON CONFLICT DO NOTHING: if this migration is ever accidentally
-- re-applied without an intervening rollback, a second run's own
-- target-state computation naturally finds nothing left to change for
-- already-migrated rows (Tier 1 preserves the now-populated user_id,
-- capability re-evaluates to the same result) -- so no second snapshot
-- attempt would even be made for those rows. This clause is deliberate
-- defense-in-depth on top of that natural idempotency, guaranteeing the
-- original pre-migration values can never be overwritten by
-- already-migrated state under any circumstance.
insert into migration_support.instructor_backfill_snapshot_20260918010000 (instructor_id, user_id, can_instruct)
select instructor_id, original_user_id, original_can_instruct
from slice3_target_state
where needs_account_link_audit or needs_capability_audit
on conflict (instructor_id) do nothing;

-- 3. Apply mutations, from the precomputed target table only -------------

update public.instructors i
set user_id = t.target_user_id,
    can_instruct = t.target_can_instruct
from slice3_target_state t
where i.id = t.instructor_id
  and (t.needs_account_link_audit or t.needs_capability_audit);

-- 4. Audit -----------------------------------------------------------------
-- Migration-driven remediation has no human actor: actor_user_id is
-- explicitly NULL, never fabricated. Metadata carries provenance only --
-- no email, no name.

insert into public.instructor_audit_events (
  studio_id, instructor_id, actor_user_id, event_type,
  before_value, after_value, metadata
)
select
  t.studio_id, t.instructor_id, null, 'account_linked',
  jsonb_build_object('user_id', t.original_user_id),
  jsonb_build_object('user_id', t.target_user_id),
  jsonb_build_object(
    'source', 'slice3_backfill_migration',
    'matched_via', t.identity_matched_via,
    'migration', '20260918010000_landmark1a_instructor_backfill_remediation'
  )
from slice3_target_state t
where t.needs_account_link_audit;

insert into public.instructor_audit_events (
  studio_id, instructor_id, actor_user_id, event_type,
  before_value, after_value, metadata
)
select
  t.studio_id, t.instructor_id, null, 'capability_granted',
  jsonb_build_object('can_instruct', t.original_can_instruct),
  jsonb_build_object('can_instruct', t.target_can_instruct),
  jsonb_build_object(
    'source', 'slice3_backfill_migration',
    'matched_via', 'instructor_role_membership',
    'migration', '20260918010000_landmark1a_instructor_backfill_remediation'
  )
from slice3_target_state t
where t.needs_capability_audit;

commit;
