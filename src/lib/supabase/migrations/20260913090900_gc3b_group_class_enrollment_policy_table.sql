-- GC-3.2 (gc3b): group-class enrollment policy table.
--
-- Canonical plan: C:\Users\mcurt\.claude\plans\we-are-continuing-the-streamed-moth.md
-- (Final Design v4), Part A1 ("group_class_enrollment_policies -- unchanged
-- from the prior pass"), Part D item 2 (gc3b), Part E ("GC-3.2 -- Backend
-- Funding Foundation").
--
-- One row per individual group_class appointment (never recurring --
-- recurring group classes are not currently shipped, so no recurrence
-- field is added here). Purely additive, purely backend: no self-enrollment
-- RPC, no public discovery surface, no UI to create a row exists yet. A
-- class with no row here behaves EXACTLY as it did before this migration --
-- every read of this table (gc3c's resolver, a future gc3d/gc3f) must treat
-- "no row" identically to "a row with accepted_funding_types IS NULL and
-- both booleans false", which is also this table's own DEFAULT shape.
--
-- Semantics (locked by the finalized design):
--   - accepted_funding_types IS NULL  = unrestricted legacy/staff behavior
--     (every existing package/membership candidate the resolver would
--     otherwise find remains eligible, with no allow-list filtering).
--   - a non-null array                = explicit allow-list. Once set, this
--     applies universally -- broad staff and instructor auto-resolution
--     alike (gc3c) -- there is no silent broad-role bypass of an explicit
--     policy.
--   - discovery/self-enrollment (both out of scope to actually exercise
--     until GC-3.3/3.4) can never be turned on against an undefined or
--     empty funding policy -- enforced below by a CHECK constraint, not
--     merely a convention, since a future self-enrollment RPC must be able
--     to trust this invariant already holds at the schema level.
--   - no hard-delete workflow: a class is "disabled" for discovery/self-
--     enrollment by flipping the two booleans back to false (and,
--     optionally, accepted_funding_types back to null), never by deleting
--     the row -- matching this table's DELETE-less RLS posture below.
--
-- Authority model audited from the live GC-1.4A/GC-1.1 precedent before
-- writing this file: _gc1_4_has_broad_studio_authority and
-- is_own_instructor_appointment are the existing helpers for "broad staff"
-- and "this class's assigned instructor" respectively. The former is
-- revoked from every role (including authenticated) and is only callable
-- from inside another SECURITY DEFINER function body via owner-implicit
-- privilege -- it CANNOT be called from inside an RLS USING/WITH CHECK
-- expression (those execute as the querying role, which lacks EXECUTE on
-- it). RLS below therefore inlines the identical three-branch broad-role
-- check appointment_attendees' own policies already use, rather than
-- inventing a new role predicate or granting execute to a function whose
-- whole point was never being reachable that way.

begin;

-- ============================================================================
-- 1. Table.
-- ============================================================================
create table public.group_class_enrollment_policies (
  id                       uuid primary key default gen_random_uuid(),
  studio_id                uuid not null references public.studios(id),
  appointment_id           uuid not null references public.appointments(id),
  publicly_discoverable    boolean not null default false,
  self_enrollment_allowed  boolean not null default false,
  accepted_funding_types   text[],
  direct_payment_amount    numeric,
  created_by               uuid,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint group_class_enrollment_policies_one_per_appointment
    unique (appointment_id),

  -- Finalized funding vocabulary -- exactly these four values, nothing
  -- speculative (no "cash", "check", etc. -- 'manual_other' covers every
  -- staff-recorded non-package/membership/direct-payment case, matching
  -- appointment_attendees.billing_type='free_comped''s existing role).
  constraint group_class_enrollment_policies_funding_types_valid
    check (
      accepted_funding_types is null
      or accepted_funding_types <@ array['membership', 'package', 'direct_payment', 'manual_other']::text[]
    ),

  constraint group_class_enrollment_policies_direct_payment_amount_positive
    check (direct_payment_amount is null or direct_payment_amount > 0),

  -- direct_payment accepted => a valid amount is required. The reverse is
  -- not constrained: an amount set while direct_payment isn't (currently)
  -- accepted is harmless, and re-adding direct_payment later should not
  -- require re-entering the amount.
  constraint group_class_enrollment_policies_direct_payment_requires_amount
    check (
      not ('direct_payment' = any (coalesce(accepted_funding_types, array[]::text[])))
      or direct_payment_amount is not null
    ),

  -- Discovery/self-enrollment can never be enabled against an undefined or
  -- EMPTY funding allow-list -- an empty array is schema-valid on its own
  -- (a fully staff-manual class with no auto-eligible funding type at all),
  -- just never combined with either of these two booleans being true.
  -- cardinality(), not array_length(...,1), deliberately -- array_length of
  -- an empty (but non-null) array is NULL, not 0, which would make this
  -- whole CHECK evaluate to NULL (Postgres treats a NULL CHECK result as
  -- satisfied) and silently let an empty allow-list through. cardinality()
  -- correctly returns 0 for an empty array.
  constraint group_class_enrollment_policies_discovery_requires_funding
    check (
      (not publicly_discoverable and not self_enrollment_allowed)
      or (accepted_funding_types is not null and cardinality(accepted_funding_types) > 0)
    )
);

comment on table public.group_class_enrollment_policies is
  'GC-3.2: per-group_class-appointment enrollment policy. No row = not '
  'publicly discoverable, not self-enrollable, and unrestricted (legacy) '
  'funding-type behavior for staff/instructor enrollment -- identical to a '
  'row with accepted_funding_types IS NULL and both booleans false, which '
  'is also this table''s DEFAULT shape.';

create index idx_group_class_enrollment_policies_studio_id
  on public.group_class_enrollment_policies (studio_id);
-- appointment_id is already indexed via the unique constraint above.

-- ============================================================================
-- 2. Shape trigger -- a policy may only target a real group_class
--    appointment in the SAME studio it claims. Mirrors
--    enforce_appointment_attendee_integrity's (GC-1.1) cross-table
--    validation shape for the identical class of problem.
-- ============================================================================
create or replace function public.enforce_group_class_enrollment_policy_shape()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_appointment_studio_id uuid;
  v_appointment_type public.appointment_type;
begin
  if tg_op = 'UPDATE' and new.appointment_id is distinct from old.appointment_id then
    raise exception 'An enrollment policy''s appointment_id cannot be changed after creation.';
  end if;

  select studio_id, appointment_type
    into v_appointment_studio_id, v_appointment_type
    from public.appointments
    where id = new.appointment_id;

  if v_appointment_studio_id is null then
    raise exception 'Enrollment policy target appointment not found.';
  end if;

  if v_appointment_type is distinct from 'group_class'::public.appointment_type then
    raise exception 'An enrollment policy may only target a group class.';
  end if;

  if v_appointment_studio_id is distinct from new.studio_id then
    raise exception 'Enrollment policy studio_id must match its target appointment''s studio.';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_group_class_enrollment_policy_shape() from public;
revoke all on function public.enforce_group_class_enrollment_policy_shape() from anon;
revoke all on function public.enforce_group_class_enrollment_policy_shape() from authenticated;
revoke all on function public.enforce_group_class_enrollment_policy_shape() from service_role;
-- No grant execute statement follows: reachable only as a trigger body,
-- matching enforce_group_class_canonical_shape's (GC-1.4A) established
-- posture for this exact kind of function.

create trigger group_class_enrollment_policies_enforce_shape
  before insert or update on public.group_class_enrollment_policies
  for each row
  execute function public.enforce_group_class_enrollment_policy_shape();

-- ============================================================================
-- 3. RLS.
--
--    SELECT: platform_admin, broad studio staff, OR the class's assigned
--    instructor (read-only -- an instructor needs to see their own class's
--    policy to know what funding types are acceptable, but never to change
--    it). INSERT/UPDATE: platform_admin or broad studio staff only -- no
--    instructor write, no anonymous write, no direct student/public
--    mutation (matches this slice's explicit scope). No DELETE policy --
--    disabling a policy's discovery/self-enrollment happens by updating its
--    state (see the table comment), never by removing the row; with RLS
--    enabled and no matching DELETE policy for any role, hard deletion is
--    structurally unreachable through the API, identical to
--    appointment_attendees' own established posture.
-- ============================================================================
alter table public.group_class_enrollment_policies enable row level security;

create policy "group_class_enrollment_policies_select" on public.group_class_enrollment_policies
for select
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_class_enrollment_policies.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
  or exists (
    select 1 from public.appointments a
    where a.id = group_class_enrollment_policies.appointment_id
      and a.studio_id = group_class_enrollment_policies.studio_id
      and a.instructor_id is not null
      and public.is_own_instructor_appointment(a.studio_id, a.instructor_id)
  )
);

create policy "group_class_enrollment_policies_insert" on public.group_class_enrollment_policies
for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_class_enrollment_policies.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
);

create policy "group_class_enrollment_policies_update" on public.group_class_enrollment_policies
for update
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_class_enrollment_policies.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_class_enrollment_policies.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
);

commit;
