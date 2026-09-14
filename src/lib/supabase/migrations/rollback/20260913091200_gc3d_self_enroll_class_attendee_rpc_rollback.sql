-- Rollback for 20260913091200_gc3d_self_enroll_class_attendee_rpc.sql
--
-- Unconditional drop -- no guard needed. Enrollments this function created
-- remain valid public.appointment_attendees rows regardless of whether the
-- RPC that created them still exists (identical reasoning to GC-3.2's own
-- enroll_class_attendee rollback -- the row, not the function, is the
-- durable artifact). No other object depends on this function, and this
-- rollback never touches appointment_attendees in any way -- every row
-- self_enroll_class_attendee created while GC-3.3 was active remains
-- exactly as it was.
--
-- CORRECTED (second code review, B1): this rollback previously dropped the
-- internal helper _group_class_funding_candidates_for while leaving
-- get_eligible_group_class_funding_candidates CREATE OR REPLACE'd to
-- delegate to it -- a live PROD-shipped GC-3.2 function that
-- enroll_class_attendee's own-instructor branch and the staff Add Student
-- page both call directly. Running that version of this rollback would have
-- broken staff/instructor group-class enrollment for every studio the
-- moment it executed. Fixed by restoring
-- get_eligible_group_class_funding_candidates to its exact pre-GC-3.3 body
-- BEFORE dropping the helper it would otherwise be left referencing.
--
-- Source of truth: the restored body below is copied verbatim from
-- 20260913091000_gc3c_group_class_funding_candidate_set_function.sql
-- (GC-3.2's own authoritative, already-PROD-verified definition of this
-- function) -- not a reconstructed approximation. Same signature, same
-- authorization (_gc1_4_class_enrollment_authority /
-- _gc1_4_has_broad_studio_authority, unchanged), same SECURITY DEFINER +
-- search_path='public', same grants (authenticated-only, no
-- public/anon/service_role), same candidate-selection semantics (package /
-- unlimited-membership / finite-membership union, identical policy-driven
-- allow-list filtering). This is the GC-3.2 state exactly as it existed
-- immediately before gc3d's own CREATE OR REPLACE, not a fresh redesign.
--
-- Dependency-safe order: the resolver is restored to its non-delegating
-- form FIRST, then a static assertion proves no surviving function body
-- still references _group_class_funding_candidates_for, and only then is
-- that helper (and every other GC-3.3-only function) dropped -- guaranteeing
-- no live function is ever left referencing a soon-to-be-dropped object at
-- any point in this script.

begin;

-- ============================================================================
-- 1. Restore get_eligible_group_class_funding_candidates to its exact
--    pre-GC-3.3 (GC-3.2/gc3c) body, verbatim.
-- ============================================================================
create or replace function public.get_eligible_group_class_funding_candidates(
  p_studio_id uuid,
  p_client_id uuid,
  p_appointment_id uuid default null,
  p_exclude_attendee_id uuid default null
)
returns table (
  funding_type text,
  source_id uuid,
  label text,
  is_unlimited boolean,
  quantity_total numeric,
  used numeric,
  remaining numeric
)
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_appointment_studio_id uuid;
  v_appointment_type public.appointment_type;
  v_as_of timestamptz;
  v_accepted_funding_types text[];
  v_authorized boolean;
begin
  if p_appointment_id is not null then
    select studio_id, appointment_type, starts_at
      into v_appointment_studio_id, v_appointment_type, v_as_of
      from public.appointments
      where id = p_appointment_id;

    if v_appointment_studio_id is null
       or v_appointment_type is distinct from 'group_class'::public.appointment_type
       or v_appointment_studio_id is distinct from p_studio_id
    then
      raise exception 'Group class not found.';
    end if;

    v_authorized := public._gc1_4_class_enrollment_authority(p_studio_id, p_appointment_id) is not null;

    select accepted_funding_types into v_accepted_funding_types
      from public.group_class_enrollment_policies
      where appointment_id = p_appointment_id;
  else
    v_authorized := public._gc1_4_has_broad_studio_authority(p_studio_id);
    v_as_of := now();
    v_accepted_funding_types := null;
  end if;

  if not v_authorized then
    raise exception 'Not authorized to resolve funding eligibility for this studio.';
  end if;

  if not exists (
    select 1 from public.clients c where c.id = p_client_id and c.studio_id = p_studio_id
  ) then
    raise exception 'Client not found for this studio.';
  end if;

  return query
  -- Packages.
  select
    'package'::text as funding_type,
    cp.id as source_id,
    cp.name_snapshot as label,
    cpi.is_unlimited as is_unlimited,
    cpi.quantity_total::numeric as quantity_total,
    cpi.quantity_used::numeric as used,
    cpi.quantity_remaining::numeric as remaining
  from public.client_package_items cpi
  join public.client_packages cp on cp.id = cpi.client_package_id
  where cp.studio_id = p_studio_id
    and cp.client_id = p_client_id
    and cp.active = true
    and cpi.usage_type = 'group_class'::package_usage_type
    and (cpi.is_unlimited = true or coalesce(cpi.quantity_remaining, 0) > 0)
    and (v_accepted_funding_types is null or 'package' = any (v_accepted_funding_types))

  union all

  -- Unlimited memberships.
  select
    'membership'::text,
    cm.id,
    cm.name_snapshot,
    true,
    null::numeric,
    null::numeric,
    null::numeric
  from public.client_memberships cm
  join public.membership_plan_benefits mpb on mpb.membership_plan_id = cm.membership_plan_id
  where cm.studio_id = p_studio_id
    and cm.client_id = p_client_id
    and cm.status = 'active'
    and mpb.benefit_type = 'unlimited_group_classes'
    and mpb.quantity is null
    and (
      mpb.applies_to is null
      or mpb.applies_to = ''
      or mpb.applies_to = 'all'
      or mpb.applies_to = 'group_class'
    )
    and (v_accepted_funding_types is null or 'membership' = any (v_accepted_funding_types))

  union all

  -- Finite memberships: same eligibility shape as GC-2d's own inline query,
  -- excluding any membership whose plan is also (mis-)configured with an
  -- unlimited_group_classes benefit (already counted above), confirmed via
  -- the unmodified _group_class_finite_balance (GC-2b).
  select
    'membership'::text,
    candidates.membership_id,
    candidates.name_snapshot,
    false,
    bal.quantity::numeric,
    bal.consumed::numeric,
    bal.available::numeric
  from (
    select distinct cm.id as membership_id, cm.name_snapshot, mpb.id as benefit_id
    from public.client_memberships cm
    join public.membership_plan_benefits mpb on mpb.membership_plan_id = cm.membership_plan_id
    where cm.studio_id = p_studio_id
      and cm.client_id = p_client_id
      and cm.status = 'active'
      and mpb.benefit_type = 'included_group_classes'
      and (
        mpb.applies_to is null
        or mpb.applies_to = ''
        or mpb.applies_to = 'all'
        or mpb.applies_to = 'group_class'
      )
      and not exists (
        select 1 from public.membership_plan_benefits mpb2
        where mpb2.membership_plan_id = cm.membership_plan_id
          and mpb2.benefit_type = 'unlimited_group_classes'
      )
  ) candidates
  cross join lateral public._group_class_finite_balance(
    candidates.membership_id, candidates.benefit_id, v_as_of, p_exclude_attendee_id
  ) bal
  where bal.available > 0
    and (v_accepted_funding_types is null or 'membership' = any (v_accepted_funding_types));
end;
$$;

revoke all on function public.get_eligible_group_class_funding_candidates(uuid, uuid, uuid, uuid) from public;
revoke all on function public.get_eligible_group_class_funding_candidates(uuid, uuid, uuid, uuid) from anon;
grant execute on function public.get_eligible_group_class_funding_candidates(uuid, uuid, uuid, uuid) to authenticated;
revoke all on function public.get_eligible_group_class_funding_candidates(uuid, uuid, uuid, uuid) from service_role;

-- ============================================================================
-- 2. Static verification: prove the restored resolver's live body no longer
--    references _group_class_funding_candidates_for, BEFORE that helper is
--    dropped below. Aborts the entire rollback (raise inside a transaction)
--    if this ever fails, rather than silently proceeding to drop a function
--    something still depends on.
-- ============================================================================
do $$
declare
  v_body text;
begin
  select pg_get_functiondef(p.oid) into v_body
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_eligible_group_class_funding_candidates';

  if v_body is null then
    raise exception 'Rollback verification failed: get_eligible_group_class_funding_candidates not found after restore.';
  end if;

  if v_body ilike '%_group_class_funding_candidates_for%' then
    raise exception 'Rollback verification failed: get_eligible_group_class_funding_candidates still references _group_class_funding_candidates_for after restore -- refusing to drop the helper.';
  end if;

  raise notice 'Rollback verification passed: get_eligible_group_class_funding_candidates no longer references _group_class_funding_candidates_for.';
end $$;

-- ============================================================================
-- 3. Drop every GC-3.3-only object, in dependency-safe order -- the internal
--    helper last, now that step 1-2 have proven nothing live still calls it.
-- ============================================================================
drop function if exists public.preview_self_enrollment_funding_candidates(uuid, uuid);
drop function if exists public.get_group_class_self_enrollment_flag(uuid);
drop function if exists public.self_enroll_class_attendee(uuid, uuid, uuid, uuid);
drop function if exists public._group_class_funding_candidates_for(uuid, uuid, uuid, uuid);

commit;
