-- GC-3.2 (gc3c): canonical group-class funding candidate resolver.
--
-- Canonical plan: C:\Users\mcurt\.claude\plans\we-are-continuing-the-streamed-moth.md
-- (Final Design v4), Part A6 ("Canonical funding-resolution architecture --
-- unchanged"), Part D item 3 (gc3c), Part E ("GC-3.2 -- Backend Funding
-- Foundation").
--
-- get_eligible_group_class_funding_candidates(...) becomes the single
-- source of truth for "which of this client's existing packages/
-- memberships can fund a group-class enrollment" -- replacing the
-- duplicated eligibility logic that previously lived independently in
-- three places:
--   1. enroll_class_attendee's own_instructor branch (GC-2d) -- three
--      inline queries (package / unlimited membership / finite membership).
--   2. src/lib/schedule/groupClassMembershipFunding.ts +
--      src/lib/memberships/groupClassBenefit.ts, as consumed by the staff
--      Add Student page (src/app/app/schedule/enroll-student/page.tsx) to
--      build eligibleFundingSourcesByClientId in TypeScript.
--   3. (there was no third independent copy -- cancel_class_attendee and
--      cancel_group_class_appointment do not resolve funding at all.)
--
-- (1) is refactored below via CREATE OR REPLACE of enroll_class_attendee.
-- (2) is refactored in the same application-side change that accompanies
-- this migration (enroll-student/page.tsx now calls this RPC instead of
-- querying client_packages/client_memberships/membership_plan_benefits
-- directly). groupClassMembershipFunding.ts itself is NOT touched -- its
-- other consumer (the roster/attendance display page) is a display-only,
-- non-enrollment surface explicitly out of this slice's scope.
--
-- Candidate math (package / unlimited membership / finite membership) is
-- reproduced from the live GC-2d body verbatim, not redesigned -- the only
-- new behavior is the policy-driven allow-list filter described below.
-- Package eligibility: active client_packages + a client_package_items row
-- for usage_type='group_class' that is either is_unlimited or has
-- quantity_remaining > 0. Unlimited membership eligibility: a status=
-- 'active' client_memberships row whose plan has a benefit_type=
-- 'unlimited_group_classes' row with quantity IS NULL and an applicable
-- applies_to. Finite membership eligibility: same active/applies_to shape
-- for benefit_type='included_group_classes', EXCLUDING any membership whose
-- plan is also (mis-)configured with an unlimited_group_classes benefit
-- (already counted in the unlimited bucket -- never double-counted), with
-- available balance confirmed > 0 via the existing, unmodified
-- _group_class_finite_balance (GC-2b).
--
-- Policy-driven filtering (the one genuinely new piece):
--   - p_appointment_id IS NULL: no policy context at all -- returns every
--     entitlement-eligible candidate unfiltered. Used by the Add Student
--     page's pre-selection-of-a-class eligibility preview, which has never
--     been scoped to one specific class (it precomputes eligibility for
--     every visible client before a class is chosen in the form) -- this
--     mode preserves that page's own pre-existing, appointment-independent
--     behavior exactly, rather than forcing an unrelated UX change onto a
--     slice that ships no policy-authoring UI at all.
--   - p_appointment_id IS NOT NULL: looks up this appointment's
--     group_class_enrollment_policies row (if any). No row, or a row with
--     accepted_funding_types IS NULL, behaves identically to today (every
--     found candidate is returned) -- this is how GC-3.2 guarantees no
--     existing class's enrollment behavior changes merely because this
--     migration lands, since no row exists for any pre-existing class. A
--     non-null accepted_funding_types filters candidates whose funding_type
--     ('package' or 'membership') is not in the allow-list. This applies
--     uniformly to instructor auto-resolution (via this function directly)
--     AND to broad staff's explicit billing-type choice (enforced by a
--     small, separate gate added to enroll_class_attendee's 'broad' branch
--     below, since broad staff never call this function to choose a
--     candidate -- they supply one directly, and always have).
--
-- Authorization: embeds its own auth.uid()-based check, matching every
-- other callable RPC in this codebase (SEC-P0 lesson, reiterated verbatim
-- in GC-1.4A's own header). p_appointment_id IS NOT NULL: caller must have
-- 'broad' or 'own_instructor' authority over THAT class (reuses
-- _gc1_4_class_enrollment_authority unchanged). p_appointment_id IS NULL:
-- caller must have broad authority over p_studio_id (reuses
-- _gc1_4_has_broad_studio_authority unchanged) -- matching the Add Student
-- page's own existing isBroadStaff-only gate for this precompute.

begin;

-- ============================================================================
-- 1. get_eligible_group_class_funding_candidates -- canonical resolver.
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
-- Minimum-necessary posture, matching enroll_class_attendee's own: invoked
-- either internally (below) or from the cookie/session-scoped client on the
-- Add Student page -- no real code path needs service_role execute.
revoke all on function public.get_eligible_group_class_funding_candidates(uuid, uuid, uuid, uuid) from service_role;

-- ============================================================================
-- 2. enroll_class_attendee -- CREATE OR REPLACE, cut over onto the canonical
--    resolver.
--
-- Same signature, same authorization model as GC-2d. Two changes only:
--   - own_instructor branch: the three inline eligibility queries are gone,
--     replaced by one call to get_eligible_group_class_funding_candidates.
--     Still refuses to guess -- exactly one candidate required, or the same
--     'needs a billing decision' exception as before (this exact substring
--     is relied on by classifyEnrollClassAttendeeError in
--     src/app/app/schedule/actions.ts -- preserved verbatim).
--   - broad branch: NEW -- if this appointment has a policy row with a
--     non-null accepted_funding_types, the caller's (possibly
--     caller-overridden) billing_type must map to an accepted funding_type,
--     or the enrollment is rejected. This is the "no silent broad-role
--     bypass" requirement -- broad staff retain full override capability
--     among the ACCEPTED types, but can no longer bill an enrollment to a
--     type the policy has explicitly excluded. No policy row, or a policy
--     row with accepted_funding_types IS NULL, is a no-op here -- identical
--     to every class that existed before this migration.
-- ============================================================================
create or replace function public.enroll_class_attendee(
  p_appointment_id uuid,
  p_client_id uuid,
  p_billing_type text default null,
  p_client_package_id uuid default null,
  p_client_membership_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_authority text;
  v_studio_id uuid;
  v_source text;
  v_billing_type text;
  v_client_package_id uuid;
  v_client_membership_id uuid;
  v_policy_funding_types text[];
  v_funding_type text;
  v_eligible_count int;
  v_candidate_funding_type text;
  v_candidate_source_id uuid;
  v_attendee_id uuid;
begin
  select studio_id into v_studio_id
    from public.appointments
    where id = p_appointment_id
      and appointment_type = 'group_class'::public.appointment_type;

  if v_studio_id is null then
    raise exception 'Group class not found.';
  end if;

  v_authority := public._gc1_4_class_enrollment_authority(v_studio_id, p_appointment_id);

  if v_authority is null then
    raise exception 'Not authorized to enroll a student into this class.';
  end if;

  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.studio_id = v_studio_id
  ) then
    raise exception 'Client not found for this studio.';
  end if;

  if v_authority = 'broad' then
    v_source := 'staff';
    v_billing_type := coalesce(p_billing_type, 'package_credit');
    v_client_package_id := p_client_package_id;
    v_client_membership_id := p_client_membership_id;

    select accepted_funding_types into v_policy_funding_types
      from public.group_class_enrollment_policies
      where appointment_id = p_appointment_id;

    if v_policy_funding_types is not null then
      v_funding_type := case v_billing_type
        when 'package_credit' then 'package'
        when 'membership' then 'membership'
        when 'pay_as_you_go' then 'direct_payment'
        when 'free_comped' then 'manual_other'
        else null
      end;

      if v_funding_type is null or not (v_funding_type = any (v_policy_funding_types)) then
        raise exception 'This class does not accept the selected funding type for enrollment.';
      end if;
    end if;
  else
    -- own_instructor: ignore every caller-supplied billing parameter. The
    -- canonical resolver is the sole source of eligible candidates,
    -- already policy-filtered for this specific appointment.
    v_source := 'instructor';

    select count(*), (array_agg(funding_type))[1], (array_agg(source_id))[1]
      into v_eligible_count, v_candidate_funding_type, v_candidate_source_id
      from public.get_eligible_group_class_funding_candidates(v_studio_id, p_client_id, p_appointment_id, null);

    if v_eligible_count <> 1 then
      raise exception 'This enrollment needs a billing decision -- ask an owner, admin, or front desk to complete it.';
    end if;

    if v_candidate_funding_type = 'package' then
      v_billing_type := 'package_credit';
      v_client_package_id := v_candidate_source_id;
      v_client_membership_id := null;
    else
      v_billing_type := 'membership';
      v_client_membership_id := v_candidate_source_id;
      v_client_package_id := null;
    end if;
  end if;

  begin
    insert into public.appointment_attendees (
      studio_id, appointment_id, client_id, status, source,
      billing_type, client_package_id, client_membership_id, created_by
    )
    values (
      v_studio_id, p_appointment_id, p_client_id, 'booked', v_source,
      v_billing_type, v_client_package_id, v_client_membership_id, auth.uid()
    )
    returning id into v_attendee_id;
  exception when unique_violation then
    raise exception 'This client is already enrolled in this class.';
  end;

  return v_attendee_id;
end;
$$;

revoke all on function public.enroll_class_attendee(uuid, uuid, text, uuid, uuid) from public;
revoke all on function public.enroll_class_attendee(uuid, uuid, text, uuid, uuid) from anon;
grant execute on function public.enroll_class_attendee(uuid, uuid, text, uuid, uuid) to authenticated;
revoke all on function public.enroll_class_attendee(uuid, uuid, text, uuid, uuid) from service_role;

commit;
