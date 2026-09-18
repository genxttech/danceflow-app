-- Landmark 1A -- Slice 5A: Capability Activation Bridge
--
-- One-time, owner-approved, named-row remediation granting
-- instructors.can_instruct = true to exactly 5 currently owner-linked
-- PROD instructor rows, serving as the explicit capability grant Decision
-- 8 requires -- ahead of Slice 6's formal capability-grant workflow,
-- which does not yet exist. This is not an automatic rule: it names 5
-- exact (instructor_id, studio_id, user_id) triples, reviewed and
-- individually approved by the owner; it never infers capability from
-- studio_owner role, never matches by predicate, and never applies to
-- any row not explicitly listed here, including any future owner row.
--
-- Every named target is guarded against its exact expected state
-- (studio_id, user_id, active=true, can_instruct=false) immediately
-- before mutation. Any mismatch -- including a target no longer
-- existing at all -- aborts the entire transaction: either exactly the
-- reviewed set applies as reviewed, or nothing happens.
--
-- On an environment where none of these 5 instructor_ids exist (e.g.
-- DEV), this migration is expected to abort via the guard below -- a
-- deliberate, correct, fail-closed outcome for a PROD-specific named-row
-- bridge, not a defect. See the companion sql-tests file for synthetic
-- proof of the successful-path/guard/rollback logic.

begin;

create temp table slice5a_targets (
  instructor_id uuid primary key,
  studio_id uuid not null,
  user_id uuid not null
) on commit drop;

insert into slice5a_targets (instructor_id, studio_id, user_id) values
  ('13f7cebc-cc09-4e51-9177-c138d77b38a5', '5d752848-60f9-40ff-80d2-c44bd14d635e', '6aa322b1-6d88-4f8b-918e-8e8f2a797b26'),
  ('1bd3d5d2-5926-4fdb-9d7a-53f4726bfb42', 'dd6c35ce-0765-4247-afc2-9738817e991c', 'bcad3c1a-265e-4c72-94ed-50345d3a2930'),
  ('6a0d901f-a5c5-45b8-a016-2c5405eb7d50', 'c27d52b9-c5aa-4e60-ae65-09181e07a754', '64684746-ca0c-42ac-8546-e317ea106695'),
  ('a46e6f9f-ee94-4f0d-987e-338011d3bfa7', '4bd4bee4-8102-449d-a3fd-96a2aea4a385', '41374356-347e-402a-9494-66780a071da4'),
  ('e9a019e5-1874-47c5-a2dd-ee7206eb602b', 'e9365dbd-9f8d-44ee-b7ec-053a7c0651ee', '610b387c-2f63-413a-a585-eed4bd2136e2');

-- Guard: every named target must still exist with exactly its expected
-- studio_id/user_id, active=true, can_instruct=false. Any mismatch
-- aborts the entire transaction -- no partial application of a
-- reviewed, named-row remediation.
do $$
declare
  v_mismatch_count int;
begin
  select count(*) into v_mismatch_count
  from slice5a_targets t
  left join public.instructors i
    on i.id = t.instructor_id
    and i.studio_id = t.studio_id
    and i.user_id = t.user_id
    and i.active = true
    and i.can_instruct = false
  where i.id is null;

  if v_mismatch_count > 0 then
    raise exception
      'Slice 5A guard failed: % of 5 named target rows no longer match expected state (studio_id/user_id/active=true/can_instruct=false); aborting, zero rows changed.',
      v_mismatch_count;
  end if;
end $$;

create schema if not exists migration_support;
revoke all on schema migration_support from public, anon, authenticated;

create table if not exists migration_support.instructor_capability_bridge_snapshot_20260918 (
  instructor_id uuid primary key,
  can_instruct boolean not null,
  captured_at timestamptz not null default now()
);
alter table migration_support.instructor_capability_bridge_snapshot_20260918 enable row level security;
revoke all on migration_support.instructor_capability_bridge_snapshot_20260918 from public, anon, authenticated;

insert into migration_support.instructor_capability_bridge_snapshot_20260918 (instructor_id, can_instruct)
select t.instructor_id, i.can_instruct
from slice5a_targets t
join public.instructors i on i.id = t.instructor_id
on conflict (instructor_id) do nothing;

update public.instructors i
set can_instruct = true
from slice5a_targets t
where i.id = t.instructor_id;

insert into public.instructor_audit_events (
  studio_id, instructor_id, actor_user_id, event_type,
  before_value, after_value, metadata
)
select
  t.studio_id, t.instructor_id, null, 'capability_granted',
  jsonb_build_object('can_instruct', false),
  jsonb_build_object('can_instruct', true),
  jsonb_build_object(
    'source', 'slice5a_capability_bridge',
    'matched_via', 'owner_explicit_approval',
    'migration', '20260918030000_landmark1a_slice5a_capability_activation_bridge'
  )
from slice5a_targets t;

commit;
