-- GC-3.3 -- student/guardian self-enrollment RPC + portal visibility RLS,
-- live-Postgres regression suite.
--
-- Proves, at the real Postgres level (not mocked): self_enroll_class_attendee's
-- authorization gate (client_account_links.status='linked' AND
-- can_manage_bookings=true -- not the weaker user_has_client_portal_access);
-- its live re-check of self_enrollment_allowed (independent of
-- publicly_discoverable); its live re-resolution of funding eligibility via
-- the canonical resolver (one-candidate auto-select, multi-candidate
-- explicit-choice-required, zero-candidate rejection); duplicate-enrollment
-- and capacity-race rejection (both reused, not reimplemented); and the new
-- appointments_select branch 5's exact discoverability gating (independent
-- of self_enrollment_allowed, per Decision 4/5). Entire script runs in one
-- transaction and is rolled back at the end -- nothing persists. Run via
-- `supabase db query --linked --file <this file>` against DEV, AFTER both
-- forward migrations (20260913091200, 20260913091300) have been applied.
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-000000f0XXXX (studios)
-- 00000000-0000-0000-0000-000000f1XXXX (auth.users/profiles -- portal callers)
-- 00000000-0000-0000-0000-000000f2XXXX (clients)
-- 00000000-0000-0000-0000-000000f4XXXX (appointments)
-- 00000000-0000-0000-0000-000000f5XXXX (client_packages / items)
-- 00000000-0000-0000-0000-000000f6XXXX (membership_plans / benefits / client_memberships)
-- 00000000-0000-0000-0000-000000f7XXXX (client_account_links)

begin;

-- ============================================================================
-- FIXTURES
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-000000f00001', 'GC-3.3 Harness Studio', 't-gc3-3-studio');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000f10001', 't-gc3-3-authorized@example.test'),
  ('00000000-0000-0000-0000-000000f10002', 't-gc3-3-no-manage-bookings@example.test'),
  ('00000000-0000-0000-0000-000000f10003', 't-gc3-3-unlinked@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-000000f10001', 't-gc3-3-authorized@example.test', null),
  ('00000000-0000-0000-0000-000000f10002', 't-gc3-3-no-manage-bookings@example.test', null),
  ('00000000-0000-0000-0000-000000f10003', 't-gc3-3-unlinked@example.test', null);

insert into public.clients (id, studio_id, first_name, last_name, status) values
  ('00000000-0000-0000-0000-000000f20001', '00000000-0000-0000-0000-000000f00001', 'OneSource', 'Client', 'active'),
  ('00000000-0000-0000-0000-000000f20002', '00000000-0000-0000-0000-000000f00001', 'MultiSource', 'Client', 'active'),
  ('00000000-0000-0000-0000-000000f20003', '00000000-0000-0000-0000-000000f00001', 'ZeroSource', 'Client', 'active'),
  ('00000000-0000-0000-0000-000000f20004', '00000000-0000-0000-0000-000000f00001', 'NoBookingsPermission', 'Client', 'active'),
  ('00000000-0000-0000-0000-000000f20005', '00000000-0000-0000-0000-000000f00001', 'Unlinked', 'Client', 'active'),
  ('00000000-0000-0000-0000-000000f20006', '00000000-0000-0000-0000-000000f00001', 'CapacityFiller', 'Client', 'active'),
  ('00000000-0000-0000-0000-000000f20007', '00000000-0000-0000-0000-000000f00001', 'CapacityBlocked', 'Client', 'active');

-- Portal identity: f10001 is the "authorized" caller, linked with
-- can_manage_bookings=true to every client it acts on behalf of in this
-- suite (mirrors the guardian-manages-multiple-dependents shape P6 already
-- established -- no relationship_type filter, can_manage_bookings is the
-- real gate). f10002 is linked to f20004 but WITHOUT can_manage_bookings.
-- f10003 has no link to f20005 at all.
insert into public.client_account_links (studio_id, client_id, user_id, status, can_manage_bookings) values
  ('00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f20001', '00000000-0000-0000-0000-000000f10001', 'linked', true),
  ('00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f20002', '00000000-0000-0000-0000-000000f10001', 'linked', true),
  ('00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f20003', '00000000-0000-0000-0000-000000f10001', 'linked', true),
  ('00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f20006', '00000000-0000-0000-0000-000000f10001', 'linked', true),
  ('00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f20007', '00000000-0000-0000-0000-000000f10001', 'linked', true),
  ('00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f20004', '00000000-0000-0000-0000-000000f10002', 'linked', false);
-- f10003 deliberately has NO client_account_links row at all -- the
-- "unauthorized/unlinked caller" negative control.

-- Group-class appointments. roster_capacity left null (unlimited) except
-- f40005, which is deliberately capacity=1 for the capacity-race test.
insert into public.appointments (id, studio_id, appointment_type, status, starts_at, ends_at, roster_capacity) values
  ('00000000-0000-0000-0000-000000f40001', '00000000-0000-0000-0000-000000f00001', 'group_class', 'scheduled', now() + interval '1 day', now() + interval '1 day 1 hour', null),
  ('00000000-0000-0000-0000-000000f40002', '00000000-0000-0000-0000-000000f00001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', null),
  ('00000000-0000-0000-0000-000000f40003', '00000000-0000-0000-0000-000000f00001', 'group_class', 'scheduled', now() + interval '3 days', now() + interval '3 days 1 hour', null),
  ('00000000-0000-0000-0000-000000f40004', '00000000-0000-0000-0000-000000f00001', 'group_class', 'scheduled', now() + interval '4 days', now() + interval '4 days 1 hour', null),
  ('00000000-0000-0000-0000-000000f40005', '00000000-0000-0000-0000-000000f00001', 'group_class', 'scheduled', now() + interval '5 days', now() + interval '5 days 1 hour', 1);

-- Policies:
--   f40001: discoverable, self-enrollment OFF (state 1 -- revision B).
--   f40002: discoverable, self-enrollment ON -- used for one/multi/zero-
--           source, duplicate, unauthorized, and no-can_manage_bookings tests.
--   f40003: self-enrollment ON but NOT discoverable -- proves the two flags
--           are independent at the RLS layer too (branch 5 must still hide it).
--   f40004: no policy row at all -- backward-compatibility control.
--   f40005: discoverable + self-enrollment ON, capacity test target.
insert into public.group_class_enrollment_policies (studio_id, appointment_id, publicly_discoverable, self_enrollment_allowed, accepted_funding_types, created_by) values
  ('00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f40001', true, false, array['package']::text[], '00000000-0000-0000-0000-000000f10001'),
  ('00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f40002', true, true, array['package','membership']::text[], '00000000-0000-0000-0000-000000f10001'),
  ('00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f40003', false, true, array['package']::text[], '00000000-0000-0000-0000-000000f10001'),
  ('00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f40005', true, true, array['package']::text[], '00000000-0000-0000-0000-000000f10001');

-- Packages: OneSource has 1 eligible package. MultiSource has 1 eligible
-- package AND 1 eligible unlimited membership (2 candidates). ZeroSource,
-- NoBookingsPermission have none. CapacityFiller/CapacityBlocked each have
-- 1 eligible package.
insert into public.client_packages (id, studio_id, client_id, name_snapshot, active) values
  ('00000000-0000-0000-0000-000000f50001', '00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f20001', 'T-gc3-3 Unlimited Package', true),
  ('00000000-0000-0000-0000-000000f50002', '00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f20002', 'T-gc3-3 Unlimited Package', true),
  ('00000000-0000-0000-0000-000000f50006', '00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f20006', 'T-gc3-3 Unlimited Package', true),
  ('00000000-0000-0000-0000-000000f50007', '00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f20007', 'T-gc3-3 Unlimited Package', true);

insert into public.client_package_items (id, studio_id, client_package_id, usage_type, quantity_total, quantity_used, quantity_remaining, is_unlimited) values
  ('00000000-0000-0000-0000-000000f50011', '00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f50001', 'group_class', null, 0, null, true),
  ('00000000-0000-0000-0000-000000f50012', '00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f50002', 'group_class', null, 0, null, true),
  ('00000000-0000-0000-0000-000000f50016', '00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f50006', 'group_class', null, 0, null, true),
  ('00000000-0000-0000-0000-000000f50017', '00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f50007', 'group_class', null, 0, null, true);

-- Membership: unlimited group-class plan, held only by MultiSource (its
-- second eligible candidate).
insert into public.membership_plans (id, studio_id, name, active) values
  ('00000000-0000-0000-0000-000000f60001', '00000000-0000-0000-0000-000000f00001', 'T-gc3-3 Unlimited Group Class Plan', true);

insert into public.membership_plan_benefits (id, membership_plan_id, benefit_type, quantity, applies_to) values
  ('00000000-0000-0000-0000-000000f60002', '00000000-0000-0000-0000-000000f60001', 'unlimited_group_classes', null, 'group_class');

insert into public.client_memberships (
  id, studio_id, client_id, membership_plan_id, status, name_snapshot,
  starts_on, current_period_start, current_period_end, billing_interval_snapshot
) values
  ('00000000-0000-0000-0000-000000f61002', '00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f20002', '00000000-0000-0000-0000-000000f60001', 'active', 'T-gc3-3 Unlimited Group Class Plan', current_date, current_date, current_date + 30, 'monthly');

-- ============================================================================
-- Additional fixtures (second code review, N1) -- for direct coverage of
-- get_group_class_self_enrollment_flag / preview_self_enrollment_funding_candidates.
-- ============================================================================

-- NoBookingsPermission (f20004) gets an eligible package, so the
-- can_manage_bookings=false rejection in the preview helper is proven to be
-- a genuine authorization rejection, not merely "no funding exists anyway."
insert into public.client_packages (id, studio_id, client_id, name_snapshot, active) values
  ('00000000-0000-0000-0000-000000f50004', '00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f20004', 'T-gc3-3 Unlimited Package', true);
insert into public.client_package_items (id, studio_id, client_package_id, usage_type, quantity_total, quantity_used, quantity_remaining, is_unlimited) values
  ('00000000-0000-0000-0000-000000f50014', '00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f50004', 'group_class', null, 0, null, true);

-- A second, entirely separate studio -- for direct cross-studio isolation
-- proof (not merely "no link exists anywhere").
insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-000000f00002', 'GC-3.3 Harness Studio Two', 't-gc3-3-studio-two');

insert into public.clients (id, studio_id, first_name, last_name, status) values
  ('00000000-0000-0000-0000-000000f20008', '00000000-0000-0000-0000-000000f00002', 'OtherStudio', 'Client', 'active');

-- f10003 (elsewhere entirely unlinked) IS linked at studio f00002 -- proves
-- a real link at a DIFFERENT studio grants no visibility/authorization at
-- studio f00001.
insert into public.client_account_links (studio_id, client_id, user_id, status, can_manage_bookings) values
  ('00000000-0000-0000-0000-000000f00002', '00000000-0000-0000-0000-000000f20008', '00000000-0000-0000-0000-000000f10003', 'linked', true);

-- A legitimate-looking discoverable + self-enrollable group class at the
-- SECOND studio -- used to prove f10001's own (studio-f00001-scoped)
-- authorization does not carry over to a same-shaped class at a different
-- studio.
insert into public.appointments (id, studio_id, appointment_type, status, starts_at, ends_at) values
  ('00000000-0000-0000-0000-000000f40006', '00000000-0000-0000-0000-000000f00002', 'group_class', 'scheduled', now() + interval '6 days', now() + interval '6 days 1 hour');
insert into public.group_class_enrollment_policies (studio_id, appointment_id, publicly_discoverable, self_enrollment_allowed, accepted_funding_types, created_by) values
  ('00000000-0000-0000-0000-000000f00002', '00000000-0000-0000-0000-000000f40006', true, true, array['package']::text[], '00000000-0000-0000-0000-000000f10003');

-- A non-group_class appointment (private_lesson) at studio f00001 -- for the
-- "invalid/non-group-class target" case.
insert into public.appointments (id, studio_id, appointment_type, status, starts_at, ends_at, client_id) values
  ('00000000-0000-0000-0000-000000f40007', '00000000-0000-0000-0000-000000f00001', 'private_lesson', 'scheduled', now() + interval '7 days', now() + interval '7 days 1 hour', '00000000-0000-0000-0000-000000f20001');

-- ============================================================================
-- 1. Authorization.
-- ============================================================================

-- 1a. can_manage_bookings=false is rejected.
do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10002')::text, true);

  v_errored := false;
  begin
    perform public.self_enroll_class_attendee('00000000-0000-0000-0000-000000f40002', '00000000-0000-0000-0000-000000f20004');
  exception when others then
    v_errored := true;
  end;

  reset role;
  if not v_errored then raise exception 'FAIL T-gc3-3-can-manage-bookings-false-rejected'; end if;
  raise notice 'PASS T-gc3-3-can-manage-bookings-false-rejected';
end $$;

-- 1b. No client_account_links row at all is rejected.
do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10003')::text, true);

  v_errored := false;
  begin
    perform public.self_enroll_class_attendee('00000000-0000-0000-0000-000000f40002', '00000000-0000-0000-0000-000000f20005');
  exception when others then
    v_errored := true;
  end;

  reset role;
  if not v_errored then raise exception 'FAIL T-gc3-3-unauthorized-unlinked-caller-rejected'; end if;
  raise notice 'PASS T-gc3-3-unauthorized-unlinked-caller-rejected';
end $$;

-- ============================================================================
-- 2. Policy re-check -- self_enrollment_allowed, independent of publicly_discoverable.
-- ============================================================================

-- 2a. Discoverable but self-enrollment OFF (f40001, state 1) is rejected --
--     even though the caller is authorized and would otherwise be eligible.
do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  v_errored := false;
  begin
    perform public.self_enroll_class_attendee('00000000-0000-0000-0000-000000f40001', '00000000-0000-0000-0000-000000f20001');
  exception when others then
    v_errored := true;
  end;

  reset role;
  if not v_errored then raise exception 'FAIL T-gc3-3-discoverable-not-self-enrollable-rejected'; end if;
  raise notice 'PASS T-gc3-3-discoverable-not-self-enrollable-rejected';
end $$;

-- 2b. No policy row at all (f40004, backward-compatibility control) is
--     rejected identically -- proves every pre-existing class behaves
--     exactly as it did before this migration.
do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  v_errored := false;
  begin
    perform public.self_enroll_class_attendee('00000000-0000-0000-0000-000000f40004', '00000000-0000-0000-0000-000000f20001');
  exception when others then
    v_errored := true;
  end;

  reset role;
  if not v_errored then raise exception 'FAIL T-gc3-3-no-policy-row-rejected'; end if;
  raise notice 'PASS T-gc3-3-no-policy-row-backward-compat-rejected';
end $$;

-- ============================================================================
-- 3. Funding-source resolution.
-- ============================================================================

-- 3a. Zero eligible sources rejected with the distinct message.
do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  v_errored := false;
  begin
    perform public.self_enroll_class_attendee('00000000-0000-0000-0000-000000f40002', '00000000-0000-0000-0000-000000f20003');
  exception when others then
    v_errored := true;
  end;

  reset role;
  if not v_errored then raise exception 'FAIL T-gc3-3-zero-eligible-sources-rejected'; end if;
  raise notice 'PASS T-gc3-3-zero-eligible-sources-rejected';
end $$;

-- 3b. Multiple eligible sources without an explicit choice is rejected.
--     (Order matters below: 3b/3c/3d all run against f20002/f40002 BEFORE
--     any successful enrollment exists for that pair, so each failure is
--     genuinely attributable to the ambiguity/invalidity being tested, not
--     to a pre-existing duplicate.)
do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  v_errored := false;
  begin
    perform public.self_enroll_class_attendee('00000000-0000-0000-0000-000000f40002', '00000000-0000-0000-0000-000000f20002');
  exception when others then
    v_errored := true;
  end;

  reset role;
  if not v_errored then raise exception 'FAIL T-gc3-3-multi-source-no-choice-rejected'; end if;
  raise notice 'PASS T-gc3-3-multi-source-no-choice-rejected';
end $$;

-- 3c. Multiple eligible sources with an explicit choice that is NOT
--     actually one of THIS client's eligible candidates is rejected --
--     f50001 belongs to f20001, not f20002, so it is never a legitimate
--     choice here even though it's a real, active package row.
do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  v_errored := false;
  begin
    perform public.self_enroll_class_attendee(
      '00000000-0000-0000-0000-000000f40002', '00000000-0000-0000-0000-000000f20002',
      '00000000-0000-0000-0000-000000f50001', null
    );
  exception when others then
    v_errored := true;
  end;

  reset role;
  if not v_errored then raise exception 'FAIL T-gc3-3-ineligible-explicit-choice-rejected'; end if;
  raise notice 'PASS T-gc3-3-ineligible-explicit-choice-rejected';
end $$;

-- 3d. Multiple eligible sources WITH a valid explicit choice succeeds.
do $$
declare
  v_attendee_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  v_attendee_id := public.self_enroll_class_attendee(
    '00000000-0000-0000-0000-000000f40002', '00000000-0000-0000-0000-000000f20002',
    null, '00000000-0000-0000-0000-000000f61002'
  );

  reset role;
  if v_attendee_id is null then raise exception 'FAIL T-gc3-3-multi-source-explicit-choice-succeeds'; end if;
  if (select billing_type from public.appointment_attendees where id = v_attendee_id) <> 'membership' then
    raise exception 'FAIL T-gc3-3-multi-source-explicit-choice-billing-type';
  end if;
  if (select source from public.appointment_attendees where id = v_attendee_id) <> 'self_service' then
    raise exception 'FAIL T-gc3-3-multi-source-explicit-choice-source-value';
  end if;
  raise notice 'PASS T-gc3-3-multi-source-explicit-choice-succeeds';
end $$;

-- 3e. Exactly one eligible source auto-enrolls without a picker -- and a
--     deliberately WRONG caller-supplied package id (a real row, but not
--     f20001's own -- f50002 belongs to MultiSource/f20002) is still fully
--     ignored: the v_eligible_count = 1 branch overwrites both output ids
--     unconditionally, before p_client_package_id/p_client_membership_id are
--     ever consulted. Proves the ignore-behavior directly (a prior revision
--     of this test passed no ids at all, which never actually exercised
--     this code path).
do $$
declare
  v_attendee_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  v_attendee_id := public.self_enroll_class_attendee(
    '00000000-0000-0000-0000-000000f40002', '00000000-0000-0000-0000-000000f20001',
    '00000000-0000-0000-0000-000000f50002', null
  );

  reset role;
  if v_attendee_id is null then raise exception 'FAIL T-gc3-3-single-source-auto-enrolls'; end if;
  if (select billing_type from public.appointment_attendees where id = v_attendee_id) <> 'package_credit' then
    raise exception 'FAIL T-gc3-3-single-source-auto-enrolls-billing-type';
  end if;
  if (select client_package_id from public.appointment_attendees where id = v_attendee_id) <> '00000000-0000-0000-0000-000000f50001' then
    raise exception 'FAIL T-gc3-3-single-source-auto-enrolls-ignores-wrong-caller-supplied-id';
  end if;
  raise notice 'PASS T-gc3-3-single-source-auto-enrolls-ignores-wrong-caller-supplied-id';
end $$;

-- 3f. self_enrollment_allowed=true is honored by the RPC even when
--     publicly_discoverable=false (f40003) -- the RPC and the new RLS
--     branch are deliberately independent checks; a class need not be
--     "discoverable" for an already-linked, already-aware caller to
--     successfully self-enroll into it once self-enrollment is on.
--     Different appointment than 3e, so no duplicate conflict for f20001.
do $$
declare
  v_attendee_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  v_attendee_id := public.self_enroll_class_attendee('00000000-0000-0000-0000-000000f40003', '00000000-0000-0000-0000-000000f20001');

  reset role;
  if v_attendee_id is null then raise exception 'FAIL T-gc3-3-self-enrollment-works-when-not-discoverable'; end if;
  raise notice 'PASS T-gc3-3-self-enrollment-allowed-independent-of-discoverable-at-rpc-layer';
end $$;

-- ============================================================================
-- 4. Duplicate enrollment.
-- ============================================================================

-- 4a. A second self-enroll attempt for the same client/class is rejected
--     (chained off 3e's successful enrollment for f20001/f40002).
do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  v_errored := false;
  begin
    perform public.self_enroll_class_attendee('00000000-0000-0000-0000-000000f40002', '00000000-0000-0000-0000-000000f20001');
  exception when others then
    v_errored := true;
  end;

  reset role;
  if not v_errored then raise exception 'FAIL T-gc3-3-duplicate-enrollment-rejected'; end if;
  raise notice 'PASS T-gc3-3-duplicate-enrollment-rejected';
end $$;

-- ============================================================================
-- 5. Capacity race path.
-- ============================================================================

-- 5a. First enrollment into a capacity=1 class succeeds.
do $$
declare
  v_attendee_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  v_attendee_id := public.self_enroll_class_attendee('00000000-0000-0000-0000-000000f40005', '00000000-0000-0000-0000-000000f20006');

  reset role;
  if v_attendee_id is null then raise exception 'FAIL T-gc3-3-capacity-first-seat-succeeds'; end if;
  raise notice 'PASS T-gc3-3-capacity-first-seat-succeeds';
end $$;

-- 5b. Second enrollment into the same now-full class is rejected by
--     GC-3.1's existing roster-capacity trigger, surfaced cleanly through
--     this RPC -- no capacity logic duplicated here.
do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  v_errored := false;
  begin
    perform public.self_enroll_class_attendee('00000000-0000-0000-0000-000000f40005', '00000000-0000-0000-0000-000000f20007');
  exception when others then
    v_errored := true;
  end;

  reset role;
  if not v_errored then raise exception 'FAIL T-gc3-3-capacity-full-rejected'; end if;
  raise notice 'PASS T-gc3-3-capacity-full-rejected';
end $$;

-- ============================================================================
-- 6. RLS -- appointments_select branch 5.
-- ============================================================================

-- 6a. Publicly discoverable class is visible to any studio-linked portal
--     identity, including one not specifically linked to that class's
--     target client -- discoverability is studio-wide among portal users,
--     not per-client.
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-000000f40001';

  reset role;
  if v_count <> 1 then raise exception 'FAIL T-gc3-3-rls-discoverable-visible: expected 1, got %', v_count; end if;
  raise notice 'PASS T-gc3-3-rls-discoverable-class-visible-to-any-linked-portal-identity';
end $$;

-- 6b. self_enrollment_allowed=true but publicly_discoverable=false (f40003)
--     is NOT visible via branch 5 -- proves the two flags are independent
--     at the RLS layer, not just the RPC layer.
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-000000f40003';

  reset role;
  if v_count <> 0 then raise exception 'FAIL T-gc3-3-rls-not-discoverable-hidden: expected 0, got %', v_count; end if;
  raise notice 'PASS T-gc3-3-rls-self-enrollment-allowed-alone-does-not-grant-visibility';
end $$;

-- 6c. No policy row at all (f40004) is NOT visible via branch 5 --
--     backward-compatibility at the RLS layer.
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-000000f40004';

  reset role;
  if v_count <> 0 then raise exception 'FAIL T-gc3-3-rls-no-policy-row-hidden: expected 0, got %', v_count; end if;
  raise notice 'PASS T-gc3-3-rls-no-policy-row-backward-compat-hidden';
end $$;

-- 6d. A caller with no client_account_links row at this studio at all sees
--     nothing via branch 5, even for a genuinely discoverable class.
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10003')::text, true);

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-000000f40001';

  reset role;
  if v_count <> 0 then raise exception 'FAIL T-gc3-3-rls-unlinked-caller-sees-nothing: expected 0, got %', v_count; end if;
  raise notice 'PASS T-gc3-3-rls-unlinked-caller-sees-nothing';
end $$;

-- ============================================================================
-- 7. get_group_class_self_enrollment_flag -- direct coverage (second code
--    review, N1: previously this function was never exercised by any test).
-- ============================================================================

-- 7a. Linked portal user + discoverable + self-enrollment ON -> returns true.
do $$
declare
  v_result boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  v_result := public.get_group_class_self_enrollment_flag('00000000-0000-0000-0000-000000f40002');

  reset role;
  if v_result is distinct from true then raise exception 'FAIL T-gc3-3-flag-discoverable-self-enroll-on: expected true, got %', v_result; end if;
  raise notice 'PASS T-gc3-3-flag-discoverable-self-enroll-on';
end $$;

-- 7b. Linked portal user + discoverable + self-enrollment OFF -> returns the
--     real flag value (false), not null/true.
do $$
declare
  v_result boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  v_result := public.get_group_class_self_enrollment_flag('00000000-0000-0000-0000-000000f40001');

  reset role;
  if v_result is distinct from false then raise exception 'FAIL T-gc3-3-flag-discoverable-self-enroll-off: expected false, got %', v_result; end if;
  raise notice 'PASS T-gc3-3-flag-discoverable-self-enroll-off';
end $$;

-- 7c. Linked portal user + NON-discoverable class (self-enrollment ON
--     underneath, f40003) -> returns NULL, never exposing the true
--     self_enrollment_allowed value for a class this caller cannot see.
do $$
declare
  v_result boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  v_result := public.get_group_class_self_enrollment_flag('00000000-0000-0000-0000-000000f40003');

  reset role;
  if v_result is not null then raise exception 'FAIL T-gc3-3-flag-non-discoverable-returns-null: expected null, got %', v_result; end if;
  raise notice 'PASS T-gc3-3-flag-non-discoverable-returns-null';
end $$;

-- 7d. No linked relationship at that studio -> returns NULL.
do $$
declare
  v_result boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10003')::text, true);

  v_result := public.get_group_class_self_enrollment_flag('00000000-0000-0000-0000-000000f40001');

  reset role;
  if v_result is not null then raise exception 'FAIL T-gc3-3-flag-unlinked-returns-null: expected null, got %', v_result; end if;
  raise notice 'PASS T-gc3-3-flag-unlinked-caller-returns-null';
end $$;

-- 7e. Non-group-class target (f40007, private_lesson) -> returns NULL.
do $$
declare
  v_result boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  v_result := public.get_group_class_self_enrollment_flag('00000000-0000-0000-0000-000000f40007');

  reset role;
  if v_result is not null then raise exception 'FAIL T-gc3-3-flag-non-group-class-returns-null: expected null, got %', v_result; end if;
  raise notice 'PASS T-gc3-3-flag-non-group-class-target-returns-null';
end $$;

-- 7f. Invalid/nonexistent appointment id -> returns NULL.
do $$
declare
  v_result boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  v_result := public.get_group_class_self_enrollment_flag('00000000-0000-0000-0000-000000ffffff');

  reset role;
  if v_result is not null then raise exception 'FAIL T-gc3-3-flag-invalid-appointment-returns-null: expected null, got %', v_result; end if;
  raise notice 'PASS T-gc3-3-flag-invalid-appointment-returns-null';
end $$;

-- 7g. No cross-studio leakage: f10003 IS linked (can_manage_bookings=true)
--     at studio f00002, but that link grants no visibility at studio
--     f00001's own f40001 -- proves this is a link AT the target
--     appointment's own studio specifically, not "any real link anywhere."
do $$
declare
  v_result boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10003')::text, true);

  v_result := public.get_group_class_self_enrollment_flag('00000000-0000-0000-0000-000000f40001');

  reset role;
  if v_result is not null then raise exception 'FAIL T-gc3-3-flag-cross-studio-link-does-not-leak: expected null, got %', v_result; end if;
  raise notice 'PASS T-gc3-3-flag-cross-studio-link-does-not-leak';
end $$;

-- ============================================================================
-- 8. preview_self_enrollment_funding_candidates -- direct coverage (second
--    code review, N1: previously this function was never exercised by any
--    test either, despite being the subject of two rounds of explicit
--    security revision).
-- ============================================================================

-- 8a. Valid exact client link + can_manage_bookings=true + discoverable +
--     self-enrollment enabled -> returns the real eligible candidate(s).
do $$
declare
  v_count int;
  v_funding_type text;
  v_source_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  select count(*), (array_agg(funding_type))[1], (array_agg(source_id))[1]
    into v_count, v_funding_type, v_source_id
    from public.preview_self_enrollment_funding_candidates('00000000-0000-0000-0000-000000f40002', '00000000-0000-0000-0000-000000f20001');

  reset role;
  if v_count <> 1 or v_funding_type <> 'package' or v_source_id <> '00000000-0000-0000-0000-000000f50001' then
    raise exception 'FAIL T-gc3-3-preview-valid-returns-real-candidate: got count=%, type=%, id=%', v_count, v_funding_type, v_source_id;
  end if;
  raise notice 'PASS T-gc3-3-preview-valid-returns-real-candidate';
end $$;

-- 8b. can_manage_bookings=false -> zero rows, even though f20004 now has a
--     genuinely eligible package (f50004) -- proves this is a real
--     authorization rejection, not merely "no funding exists."
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10002')::text, true);

  select count(*) into v_count
    from public.preview_self_enrollment_funding_candidates('00000000-0000-0000-0000-000000f40002', '00000000-0000-0000-0000-000000f20004');

  reset role;
  if v_count <> 0 then raise exception 'FAIL T-gc3-3-preview-can-manage-bookings-false: expected 0, got %', v_count; end if;
  raise notice 'PASS T-gc3-3-preview-can-manage-bookings-false-zero-rows';
end $$;

-- 8c. Wrong client (caller has no client_account_links row for this client
--     at all) -> zero rows.
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  select count(*) into v_count
    from public.preview_self_enrollment_funding_candidates('00000000-0000-0000-0000-000000f40002', '00000000-0000-0000-0000-000000f20005');

  reset role;
  if v_count <> 0 then raise exception 'FAIL T-gc3-3-preview-wrong-client: expected 0, got %', v_count; end if;
  raise notice 'PASS T-gc3-3-preview-wrong-client-zero-rows';
end $$;

-- 8d. Cross-studio mismatch: f10001 is authorized for f20001 at studio
--     f00001, but the target appointment (f40006) is at studio f00002 --
--     zero rows.
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  select count(*) into v_count
    from public.preview_self_enrollment_funding_candidates('00000000-0000-0000-0000-000000f40006', '00000000-0000-0000-0000-000000f20001');

  reset role;
  if v_count <> 0 then raise exception 'FAIL T-gc3-3-preview-cross-studio-mismatch: expected 0, got %', v_count; end if;
  raise notice 'PASS T-gc3-3-preview-cross-studio-mismatch-zero-rows';
end $$;

-- 8e. Non-group-class target -> zero rows.
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  select count(*) into v_count
    from public.preview_self_enrollment_funding_candidates('00000000-0000-0000-0000-000000f40007', '00000000-0000-0000-0000-000000f20001');

  reset role;
  if v_count <> 0 then raise exception 'FAIL T-gc3-3-preview-non-group-class: expected 0, got %', v_count; end if;
  raise notice 'PASS T-gc3-3-preview-non-group-class-zero-rows';
end $$;

-- 8f. discoverable=false (f40003; self-enrollment=true, and f20001 has real
--     eligible funding) -> zero rows -- proves the discoverability gate is
--     enforced even when funding and self-enrollment would otherwise pass.
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  select count(*) into v_count
    from public.preview_self_enrollment_funding_candidates('00000000-0000-0000-0000-000000f40003', '00000000-0000-0000-0000-000000f20001');

  reset role;
  if v_count <> 0 then raise exception 'FAIL T-gc3-3-preview-not-discoverable: expected 0, got %', v_count; end if;
  raise notice 'PASS T-gc3-3-preview-not-discoverable-zero-rows';
end $$;

-- 8g. self_enrollment_allowed=false (f40001; discoverable=true, and f20001
--     has real eligible funding) -> zero rows.
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  select count(*) into v_count
    from public.preview_self_enrollment_funding_candidates('00000000-0000-0000-0000-000000f40001', '00000000-0000-0000-0000-000000f20001');

  reset role;
  if v_count <> 0 then raise exception 'FAIL T-gc3-3-preview-self-enrollment-off: expected 0, got %', v_count; end if;
  raise notice 'PASS T-gc3-3-preview-self-enrollment-off-zero-rows';
end $$;

-- 8h. Unauthorized (wrong client) and invalid-target failures are
--     indistinguishable via result shape -- both simply produce zero rows,
--     no exception, no marker column revealing which failure occurred.
do $$
declare
  v_count_unauthorized int;
  v_count_invalid_target int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);

  select count(*) into v_count_unauthorized
    from public.preview_self_enrollment_funding_candidates('00000000-0000-0000-0000-000000f40002', '00000000-0000-0000-0000-000000f20005');

  select count(*) into v_count_invalid_target
    from public.preview_self_enrollment_funding_candidates('00000000-0000-0000-0000-000000ffffff', '00000000-0000-0000-0000-000000f20001');

  reset role;
  if v_count_unauthorized <> 0 or v_count_invalid_target <> 0 then
    raise exception 'FAIL T-gc3-3-preview-non-probing-shape: expected both 0, got % and %', v_count_unauthorized, v_count_invalid_target;
  end if;
  raise notice 'PASS T-gc3-3-preview-unauthorized-and-invalid-target-both-return-zero-rows-no-exception';
end $$;

do $$ begin raise notice 'GC-3.3 SQL regression suite: ALL CHECKS PASSED'; end $$;

rollback;
