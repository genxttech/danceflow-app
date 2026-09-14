-- GC-3.3 (gc3d): student/guardian self-enrollment RPC.
--
-- Canonical plan: C:\Users\mcurt\.claude\plans\pause-gc-3-2-packaging-perform-virtual-orbit.md,
-- section 51 (GC-3.3 implementation plan, as revised) -- the authoritative
-- design for this migration, since the original GC-3 roadmap
-- (we-are-continuing-the-streamed-moth.md) names this file but supplies no
-- body content for it (confirmed absent by a dedicated recovery audit, same
-- plan file section 48). Owner-approved decisions (same plan file, section
-- 50) are cited inline below by number.
--
-- New, standalone RPC -- NOT a third branch on enroll_class_attendee.
-- enroll_class_attendee is already shipped and PROD-verified (GC-3.2); its
-- only two branches ('broad' staff, 'own_instructor') are untouched by this
-- migration. The two functions instead converge on the same canonical
-- funding-resolution engine (get_eligible_group_class_funding_candidates,
-- GC-3.2/gc3c) -- exactly the "one canonical engine" requirement recorded in
-- the recovered pre-split GC-3 scope note, read at the resolver level, not
-- the RPC-entry-point level.
--
-- Authorization (Decision 1): a portal identity with
-- client_account_links.status='linked' AND can_manage_bookings=true may
-- self-enroll themselves OR any dependent client they manage under that
-- same flag (no relationship_type filter -- mirrors the already-shipped P6
-- private-lesson self-service RPC family's own confirmed authorization
-- gate, which is materially more specific than the general
-- user_has_client_portal_access "can view" primitive). Tenant scope is
-- always resolved from the target appointment row itself -- this function
-- has no p_studio_id parameter, so a caller can never assert a studio.
--
-- Policy re-check (closes Decision 10's "stale page state" requirement):
-- self_enrollment_allowed is re-read from group_class_enrollment_policies
-- inside this function on every call, never trusted from any client-
-- supplied or cached value. No policy row, or a row with
-- self_enrollment_allowed=false/null, is rejected identically -- this is
-- also how backward compatibility is guaranteed: no pre-existing class has
-- a policy row, so this RPC rejects every one of them exactly as it must.
--
-- Funding selection (Decisions 6-7): live call to
-- get_eligible_group_class_funding_candidates -- never a cached list.
-- Exactly one eligible candidate is auto-used (own_instructor's existing
-- behavior, unchanged). More than one requires the caller's explicit,
-- already-eligible choice -- never silently resolved. Zero eligible
-- candidates is rejected with a distinct, actionable message.
--
-- Duplicate/capacity (Decisions 8-9): both reused verbatim from the
-- existing, already-tested mechanisms -- the appointment_attendees unique
-- constraint (unique_violation catch, identical wording) and GC-3.1's
-- already-universal roster-capacity trigger (its own migration comment
-- explicitly anticipates "staff, instructor, and future self-service paths
-- alike" -- this RPC is that anticipated path, not a new capacity check).
--
-- source='self_service': already a valid value in the live
-- appointment_attendees_source_check constraint (GC-1.1 original design,
-- widened by GC-1.4A to also include 'instructor' -- 'self_service' has
-- been accepted, unused, since GC-1.1). No schema change needed for this.
--
-- created_by=auth.uid(): appointment_attendees.created_by is nullable with
-- no FK constraint (confirmed by direct read of its defining migration,
-- 20260908110000_gc1_1_appointment_attendees_roster_foundation.sql) --
-- enroll_class_attendee already writes auth.uid() into this column
-- unconditionally for both of its existing branches; this is that same
-- established pattern applied a third time, not a new one.
--
-- IMPLEMENTATION-TIME CORRECTION (discovered by live DEV testing, not
-- anticipated by the approved plan): get_eligible_group_class_funding_candidates
-- (GC-3.2/gc3c) embeds its OWN authorization check -- _gc1_4_class_enrollment_authority
-- (staff/instructor only) when p_appointment_id is given, or
-- _gc1_4_has_broad_studio_authority (broad staff only) when it is null. A
-- portal/student caller can never satisfy either branch, so calling that
-- public function directly from self_enroll_class_attendee always raises
-- "Not authorized to resolve funding eligibility for this studio." -- even
-- though self_enroll_class_attendee had already independently verified the
-- caller's own, correct (can_manage_bookings-based) authorization. The
-- resolver's authorization and its candidate-computation math were never
-- separable before this migration, because GC-3.2 had only ever needed one
-- caller class (staff/instructor) to reach it.
--
-- Fix: extract the pure candidate-computation query (identical SQL, not
-- redesigned) into a new internal, ungranted helper,
-- _group_class_funding_candidates_for(...) -- no authorization check of its
-- own, callable only from inside another SECURITY DEFINER function body
-- (same "owner-implicit privilege only" posture GC-3.2's own
-- _gc1_4_has_broad_studio_authority already uses). get_eligible_group_class_funding_candidates
-- is CREATE OR REPLACE'd to keep its exact existing signature, exact
-- existing authorization check, and exact existing external behavior for
-- every current staff/instructor caller -- it now simply delegates its
-- final `return query` to the new internal helper instead of inlining the
-- same SQL itself. This is a pure refactor of an already-shipped function,
-- not a functional change to its public contract: same inputs produce the
-- same outputs for every caller who could already call it successfully.
-- self_enroll_class_attendee calls the new internal helper directly, after
-- its own already-correct authorization check has already passed.

begin;

-- ============================================================================
-- 0. Internal helper -- pure candidate computation, extracted verbatim from
--    get_eligible_group_class_funding_candidates's existing query, with no
--    authorization check of its own (the two callers below each do their
--    own, already-correct authorization before ever reaching this).
-- ============================================================================
create or replace function public._group_class_funding_candidates_for(
  p_studio_id uuid,
  p_client_id uuid,
  p_appointment_id uuid,
  p_exclude_attendee_id uuid
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
  v_as_of timestamptz;
  v_accepted_funding_types text[];
begin
  -- Reproduces both of the original resolver's modes exactly: when a real
  -- appointment is given, its own starts_at/policy govern; when not (the
  -- staff Add Student page's studio-wide precompute mode), falls back to
  -- now()/no filter -- identical to the original's explicit p_appointment_id
  -- IS NULL branch (v_as_of := now(); v_accepted_funding_types := null).
  select starts_at into v_as_of from public.appointments where id = p_appointment_id;
  v_as_of := coalesce(v_as_of, now());

  select accepted_funding_types into v_accepted_funding_types
    from public.group_class_enrollment_policies
    where appointment_id = p_appointment_id;

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

revoke all on function public._group_class_funding_candidates_for(uuid, uuid, uuid, uuid) from public;
revoke all on function public._group_class_funding_candidates_for(uuid, uuid, uuid, uuid) from anon;
revoke all on function public._group_class_funding_candidates_for(uuid, uuid, uuid, uuid) from authenticated;
revoke all on function public._group_class_funding_candidates_for(uuid, uuid, uuid, uuid) from service_role;
-- No grant execute statement follows: reachable only from inside another
-- SECURITY DEFINER function body, matching this codebase's established
-- posture for exactly this class of internal helper.

-- ============================================================================
-- 0b. get_eligible_group_class_funding_candidates -- CREATE OR REPLACE,
--     same signature, same authorization check, same external behavior for
--     every existing (staff/instructor) caller -- now delegates its
--     candidate computation to the internal helper above instead of
--     inlining the identical SQL a second time.
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
  v_authorized boolean;
begin
  if p_appointment_id is not null then
    select studio_id, appointment_type
      into v_appointment_studio_id, v_appointment_type
      from public.appointments
      where id = p_appointment_id;

    if v_appointment_studio_id is null
       or v_appointment_type is distinct from 'group_class'::public.appointment_type
       or v_appointment_studio_id is distinct from p_studio_id
    then
      raise exception 'Group class not found.';
    end if;

    v_authorized := public._gc1_4_class_enrollment_authority(p_studio_id, p_appointment_id) is not null;
  else
    v_authorized := public._gc1_4_has_broad_studio_authority(p_studio_id);
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
  select * from public._group_class_funding_candidates_for(p_studio_id, p_client_id, p_appointment_id, p_exclude_attendee_id);
end;
$$;

revoke all on function public.get_eligible_group_class_funding_candidates(uuid, uuid, uuid, uuid) from public;
revoke all on function public.get_eligible_group_class_funding_candidates(uuid, uuid, uuid, uuid) from anon;
grant execute on function public.get_eligible_group_class_funding_candidates(uuid, uuid, uuid, uuid) to authenticated;
revoke all on function public.get_eligible_group_class_funding_candidates(uuid, uuid, uuid, uuid) from service_role;

create or replace function public.self_enroll_class_attendee(
  p_appointment_id uuid,
  p_client_id uuid,
  p_client_package_id uuid default null,
  p_client_membership_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_studio_id uuid;
  v_authorized boolean;
  v_allowed boolean;
  v_eligible_count int;
  v_candidate_funding_type text;
  v_candidate_source_id uuid;
  v_client_package_id uuid;
  v_client_membership_id uuid;
  v_attendee_id uuid;
begin
  -- 1. Resolve tenant scope from the TARGET ROW. No p_studio_id parameter
  --    exists on this function -- a caller can never assert a studio.
  select studio_id into v_studio_id
    from public.appointments
    where id = p_appointment_id
      and appointment_type = 'group_class'::public.appointment_type;

  if v_studio_id is null then
    raise exception 'Group class not found.';
  end if;

  -- 2. Explicit, narrow authorization (Decision 1) -- NOT
  --    user_has_client_portal_access alone. Mirrors the P6 private-lesson
  --    self-service RPC family's own confirmed gate for mutating booking
  --    actions: a linked relationship with can_manage_bookings=true. No
  --    relationship_type filter -- a guardian managing a dependent client
  --    is authorized identically to a self-link (same generalization P6
  --    already established and this migration deliberately reuses).
  select exists (
    select 1 from public.client_account_links cal
    where cal.user_id = auth.uid()
      and cal.studio_id = v_studio_id
      and cal.client_id = p_client_id
      and cal.status = 'linked'
      and cal.can_manage_bookings = true
  ) into v_authorized;

  if not v_authorized then
    raise exception 'Not authorized to enroll this client into this class.';
  end if;

  -- 3. Policy re-check -- self_enrollment_allowed is re-verified here, live,
  --    never trusted from any client-supplied or cached page state.
  select self_enrollment_allowed into v_allowed
    from public.group_class_enrollment_policies
    where appointment_id = p_appointment_id;

  if v_allowed is not true then
    raise exception 'This class is not open for self-enrollment.';
  end if;

  -- 4. Client belongs to this studio (defense in depth, mirrors
  --    enroll_class_attendee's own equivalent check).
  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.studio_id = v_studio_id
  ) then
    raise exception 'Client not found for this studio.';
  end if;

  -- 5. Re-resolve eligibility live -- calls the internal helper directly,
  --    not the public get_eligible_group_class_funding_candidates wrapper:
  --    that wrapper's own embedded authorization check (staff/instructor
  --    only) can never be satisfied by this portal caller, who has already
  --    passed this function's own, independent, correct authorization in
  --    step 2 above. Never a cached list, closing the "stale page state"
  --    requirement.
  select count(*), (array_agg(funding_type))[1], (array_agg(source_id))[1]
    into v_eligible_count, v_candidate_funding_type, v_candidate_source_id
    from public._group_class_funding_candidates_for(v_studio_id, p_client_id, p_appointment_id, null);

  if v_eligible_count = 0 then
    raise exception 'No eligible package or membership found for this class.';
  elsif v_eligible_count = 1 then
    -- Decision 6: auto-use the sole candidate, ignore any caller-supplied IDs.
    v_client_package_id := case when v_candidate_funding_type = 'package' then v_candidate_source_id end;
    v_client_membership_id := case when v_candidate_funding_type = 'membership' then v_candidate_source_id end;
  else
    -- Decision 7: caller must supply exactly one explicit choice, and it
    -- must be one of the actually-eligible candidates just resolved above
    -- -- never trust a raw caller-supplied ID without re-checking it
    -- against the live eligible set.
    if (p_client_package_id is null) = (p_client_membership_id is null) then
      raise exception 'A single funding source choice is required.';
    end if;

    if p_client_package_id is not null then
      if not exists (
        select 1 from public._group_class_funding_candidates_for(v_studio_id, p_client_id, p_appointment_id, null)
        where funding_type = 'package' and source_id = p_client_package_id
      ) then
        raise exception 'Selected package is not an eligible funding source for this class.';
      end if;
    else
      if not exists (
        select 1 from public._group_class_funding_candidates_for(v_studio_id, p_client_id, p_appointment_id, null)
        where funding_type = 'membership' and source_id = p_client_membership_id
      ) then
        raise exception 'Selected membership is not an eligible funding source for this class.';
      end if;
    end if;

    v_client_package_id := p_client_package_id;
    v_client_membership_id := p_client_membership_id;
  end if;

  -- 6. Insert. Capacity race handled entirely by GC-3.1's already-universal
  --    roster-capacity trigger (Decision 9 -- no duplicated check here,
  --    avoiding a TOCTOU gap between an RPC-side check and this insert).
  --    Duplicate enrollment handled by the existing unique_violation catch
  --    (Decision 8), reused verbatim.
  begin
    insert into public.appointment_attendees (
      studio_id, appointment_id, client_id, status, source,
      billing_type, client_package_id, client_membership_id, created_by
    )
    values (
      v_studio_id, p_appointment_id, p_client_id, 'booked', 'self_service',
      case when v_client_package_id is not null then 'package_credit' else 'membership' end,
      v_client_package_id, v_client_membership_id, auth.uid()
    )
    returning id into v_attendee_id;
  exception when unique_violation then
    raise exception 'You are already enrolled in this class.';
  end;

  return v_attendee_id;
end;
$$;

revoke all on function public.self_enroll_class_attendee(uuid, uuid, uuid, uuid) from public;
revoke all on function public.self_enroll_class_attendee(uuid, uuid, uuid, uuid) from anon;
grant execute on function public.self_enroll_class_attendee(uuid, uuid, uuid, uuid) to authenticated;
revoke all on function public.self_enroll_class_attendee(uuid, uuid, uuid, uuid) from service_role;

-- ============================================================================
-- IMPLEMENTATION-TIME ADDITION (discovered while designing the portal page,
-- not anticipated by the approved plan): the plan assumed the portal page
-- could read group_class_enrollment_policies.self_enrollment_allowed
-- directly and call the public get_eligible_group_class_funding_candidates
-- RPC to precompute the 4 portal states (see plan section 51, item 4).
-- Neither works for a portal caller:
--   - group_class_enrollment_policies' own RLS (GC-3.2, unchanged, correctly
--     scoped) only allows SELECT for platform_admin/broad staff/the class's
--     own instructor -- a portal student has no read access to that table.
--   - get_eligible_group_class_funding_candidates still requires
--     staff/instructor authorization (unchanged, correctly preserved for
--     its existing callers) -- a portal caller calling it directly hits the
--     same "Not authorized" error self_enroll_class_attendee hit before
--     this migration's own fix.
-- Both functions below are SECURITY DEFINER, which bypasses RLS on every
-- table they read -- so each one's authorization predicate must be fully
-- self-contained and cannot lean on RLS having already filtered anything.
-- Neither delegates any part of its authorization decision to the
-- underlying tables' own RLS policies.
-- ============================================================================

-- 7. Portal visibility helper. Positively establishes, in order, before
--    returning any policy value: (a) the appointment exists; (b) it is a
--    group_class; (c) tenant scope is derived from that appointment, never
--    a caller-supplied id; (d) the caller has a client_account_links row at
--    that studio with status='linked'; (e) the class is actually
--    publicly_discoverable=true -- matching gc3e branch 5's own visibility
--    predicate exactly. If any of these fail, returns NULL -- a linked
--    portal user cannot probe self_enrollment_allowed for a
--    non-discoverable class merely by supplying its UUID: publicly_discoverable
--    and self_enrollment_allowed are fetched together in a single select
--    (condition (e)'s check), but the function only ever returns
--    self_enrollment_allowed's value to the caller once that same select
--    has confirmed publicly_discoverable=true -- a non-discoverable class's
--    row is read internally (to evaluate the gate) but its
--    self_enrollment_allowed value never leaves the function.
--    condition (d) intentionally does not require can_manage_bookings: this
--    is a read-only visibility check mirroring gc3e branch 5's own (weaker)
--    read gate, not a mutating action -- the actual enrollment write
--    (self_enroll_class_attendee) and the funding preview below both
--    independently require the stronger can_manage_bookings gate on their
--    own, unaffected by this function's gate.
--    Queried directly against group_class_enrollment_policies (not via
--    gc3e's is_group_class_publicly_discoverable, which is defined in the
--    migration applied AFTER this one -- a forward reference this file
--    cannot take). Safe from the RLS-recursion issue gc3e's own header
--    documents: that recursion is specifically a cycle between two tables'
--    OWN RLS POLICIES referencing each other. This is a direct read inside
--    a SECURITY DEFINER function body (owned by the table owner;
--    group_class_enrollment_policies carries no FORCE ROW LEVEL SECURITY),
--    so RLS is bypassed for this read entirely -- no policy evaluation
--    occurs here to recurse from, identical to every other cross-table
--    check already in this migration (e.g. self_enroll_class_attendee's
--    own reads of appointments/client_account_links/clients).
create or replace function public.get_group_class_self_enrollment_flag(p_appointment_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = 'public'
as $$
declare
  v_studio_id uuid;
  v_appointment_type public.appointment_type;
  v_linked boolean;
  v_discoverable boolean;
  v_allowed boolean;
begin
  -- (a)-(c): appointment exists, is a group_class, tenant scope from the
  -- target row only -- no p_studio_id parameter exists on this function.
  select studio_id, appointment_type
    into v_studio_id, v_appointment_type
    from public.appointments
    where id = p_appointment_id;

  if v_studio_id is null or v_appointment_type is distinct from 'group_class'::public.appointment_type then
    return null;
  end if;

  -- (d): caller has a linked portal relationship at this studio.
  select exists (
    select 1 from public.client_account_links cal
    where cal.user_id = auth.uid()
      and cal.studio_id = v_studio_id
      and cal.status = 'linked'
  ) into v_linked;

  if not v_linked then
    return null;
  end if;

  -- (e): both flags are fetched together here, but self_enrollment_allowed
  -- (v_allowed) is only ever returned to the caller further below, after
  -- publicly_discoverable is confirmed true -- a non-discoverable class's
  -- self_enrollment_allowed value is read internally but never returned.
  select publicly_discoverable, self_enrollment_allowed
    into v_discoverable, v_allowed
    from public.group_class_enrollment_policies
    where appointment_id = p_appointment_id;

  if coalesce(v_discoverable, false) is not true then
    return null;
  end if;

  return coalesce(v_allowed, false);
end;
$$;

revoke all on function public.get_group_class_self_enrollment_flag(uuid) from public;
revoke all on function public.get_group_class_self_enrollment_flag(uuid) from anon;
grant execute on function public.get_group_class_self_enrollment_flag(uuid) to authenticated;
revoke all on function public.get_group_class_self_enrollment_flag(uuid) from service_role;

-- 8. Funding-eligibility preview. REVISED (security review): authorization
--    is now checked before anything that could reveal object existence, so
--    the function never lets a caller distinguish "this appointment/client
--    doesn't exist" from "you're not authorized for it" -- both, and every
--    other failure short of full success, produce the identical, uniform
--    empty result (zero rows, no exception raised anywhere in this
--    function). Order, before ever delegating to
--    _group_class_funding_candidates_for:
--      (a) resolve the target appointment's studio_id and confirm it is a
--          group_class -- tenant scope always derives from the target row,
--          never a caller-supplied id. An invalid/non-group-class target
--          returns zero rows rather than raising -- revealing "not found"
--          vs. "not authorized vs. "not eligible" via different signals is
--          exactly the probing surface this revision closes.
--      (b) IMMEDIATELY check the caller's exact client_account_links
--          relationship -- user_id/studio_id/client_id/status='linked'/
--          can_manage_bookings=true -- the identical, stronger gate
--          self_enroll_class_attendee's own step 2 uses for the real write,
--          checked before any other object (clients, the policy row) is
--          ever touched. Failing this returns zero rows, indistinguishable
--          from (a)'s failure -- no separate signal reveals whether the
--          client exists at that studio.
--      (c) only once (b) has passed: defense-in-depth check that the
--          client genuinely belongs to this studio. Necessary despite (b)
--          already matching cal.studio_id/cal.client_id together, because
--          client_account_links.studio_id and .client_id are independent
--          FKs (to studios/clients respectively) -- there is no composite
--          FK, CHECK, or trigger anywhere in this schema guaranteeing the
--          referenced client's own clients.studio_id actually equals the
--          link's studio_id. Confirmed by direct inspection of every
--          client_account_links-touching migration: no such constraint
--          exists. A mismatch here would be a genuine data-integrity
--          anomaly, not an expected caller error -- also folded into a
--          silent zero-row result rather than a distinct exception, so it
--          adds no new probing signal either.
--      (d) publicly_discoverable=true and self_enrollment_allowed=true --
--          domain-state gates, not authorization: a class that isn't
--          currently discoverable or self-enrollment-enabled simply has no
--          self-service funding candidates to preview for anyone, exactly
--          like "zero eligible sources" is already a normal, non-error
--          outcome elsewhere in this design.
--    This function must never become a general bypass around the
--    staff/instructor authorization on get_eligible_group_class_funding_candidates:
--    it exposes a candidate row only when (b), (c), and (d) all
--    independently pass -- none is skippable, and none alone is
--    sufficient.
create or replace function public.preview_self_enrollment_funding_candidates(
  p_appointment_id uuid,
  p_client_id uuid
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
stable
security definer
set search_path = 'public'
as $$
declare
  v_studio_id uuid;
  v_appointment_type public.appointment_type;
  v_authorized boolean;
  v_client_in_studio boolean;
  v_discoverable boolean;
  v_allowed boolean;
begin
  -- (a): appointment exists, is a group_class, tenant scope from the target
  -- row only. Invalid target -> zero rows, not an exception.
  select studio_id, appointment_type
    into v_studio_id, v_appointment_type
    from public.appointments
    where id = p_appointment_id;

  if v_studio_id is null or v_appointment_type is distinct from 'group_class'::public.appointment_type then
    return;
  end if;

  -- (b): exact caller authorization, checked immediately -- before the
  -- clients table or the policy row is ever touched. Not authorized ->
  -- zero rows, identical in shape to (a)'s failure.
  select exists (
    select 1 from public.client_account_links cal
    where cal.user_id = auth.uid()
      and cal.studio_id = v_studio_id
      and cal.client_id = p_client_id
      and cal.status = 'linked'
      and cal.can_manage_bookings = true
  ) into v_authorized;

  if not v_authorized then
    return;
  end if;

  -- (c): defense-in-depth only, reached solely for an already-authorized
  -- caller -- see header comment for why this is still a real check
  -- despite (b) having already matched studio_id/client_id together.
  select exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.studio_id = v_studio_id
  ) into v_client_in_studio;

  if not v_client_in_studio then
    return;
  end if;

  -- (d): domain-state gates, not authorization -- see header comment.
  select publicly_discoverable, self_enrollment_allowed
    into v_discoverable, v_allowed
    from public.group_class_enrollment_policies
    where appointment_id = p_appointment_id;

  if coalesce(v_discoverable, false) is not true or coalesce(v_allowed, false) is not true then
    return;
  end if;

  return query
  select * from public._group_class_funding_candidates_for(v_studio_id, p_client_id, p_appointment_id, null);
end;
$$;

revoke all on function public.preview_self_enrollment_funding_candidates(uuid, uuid) from public;
revoke all on function public.preview_self_enrollment_funding_candidates(uuid, uuid) from anon;
grant execute on function public.preview_self_enrollment_funding_candidates(uuid, uuid) to authenticated;
revoke all on function public.preview_self_enrollment_funding_candidates(uuid, uuid) from service_role;

commit;
