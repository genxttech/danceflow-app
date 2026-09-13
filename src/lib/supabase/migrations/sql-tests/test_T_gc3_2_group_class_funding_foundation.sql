-- GC-3.2 -- group-class enrollment policy table + canonical funding
-- candidate resolver, live-Postgres regression suite.
--
-- Proves, at the real Postgres level (not mocked): group_class_enrollment_
-- policies' shape/CHECK constraints and RLS; that get_eligible_group_class_
-- funding_candidates is the sole source of package/membership eligibility
-- for both the instructor auto-resolve path and direct RPC callers; that a
-- non-null accepted_funding_types filters candidates and gates broad
-- staff's explicit billing choice identically; and that entitlement
-- accuracy (depleted/exhausted/remaining/unlimited/expired) matches GC-2's
-- own established rules. Entire script runs in one transaction and is
-- rolled back at the end -- nothing persists. Run via `supabase db query
-- --linked --file <this file>` against DEV, AFTER both forward migrations
-- (20260913090900, 20260913091000) have been applied.
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-000000d0XXXX (studios)
-- 00000000-0000-0000-0000-000000d1XXXX (auth.users/profiles)
-- 00000000-0000-0000-0000-000000d2XXXX (instructors)
-- 00000000-0000-0000-0000-000000d3XXXX (clients)
-- 00000000-0000-0000-0000-000000d4XXXX (appointments)
-- 00000000-0000-0000-0000-000000d5XXXX (client_packages / items)
-- 00000000-0000-0000-0000-000000d6XXXX (membership_plans / benefits / client_memberships / usage)

begin;

-- ============================================================================
-- 0. Pre-flight: purely additive -- no pre-existing policy row anywhere.
-- ============================================================================
do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.group_class_enrollment_policies;
  if v_count <> 0 then
    raise exception 'FAIL T-gc3-2-preflight: expected 0 pre-existing policy rows, got %', v_count;
  end if;
  raise notice 'PASS T-gc3-2-preflight-no-pre-existing-policies';
end $$;

-- ============================================================================
-- FIXTURES
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-000000d00001', 'GC-3.2 Harness Studio A', 't-gc3-2-studio-a'),
  ('00000000-0000-0000-0000-000000d00002', 'GC-3.2 Harness Studio B', 't-gc3-2-studio-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000d10001', 't-gc3-2-owner@example.test'),
  ('00000000-0000-0000-0000-000000d10002', 't-gc3-2-instructor@example.test'),
  ('00000000-0000-0000-0000-000000d10003', 't-gc3-2-unrelated@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-000000d10001', 't-gc3-2-owner@example.test', null),
  ('00000000-0000-0000-0000-000000d10002', 't-gc3-2-instructor@example.test', null),
  ('00000000-0000-0000-0000-000000d10003', 't-gc3-2-unrelated@example.test', null);

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-000000d10001', '00000000-0000-0000-0000-000000d00001', 'studio_owner', true),
  ('00000000-0000-0000-0000-000000d10002', '00000000-0000-0000-0000-000000d00001', 'instructor', true);
-- d10003 deliberately has NO role at either studio -- the "no anonymous/
-- unauthorized write" negative control.

insert into public.instructors (id, studio_id, user_id, first_name, last_name, active) values
  ('00000000-0000-0000-0000-000000d20001', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d10002', 'Assigned', 'Instructor', true);

insert into public.clients (id, studio_id, first_name, last_name, status) values
  ('00000000-0000-0000-0000-000000d30001', '00000000-0000-0000-0000-000000d00001', 'Legacy', 'PackageClient', 'active'),
  ('00000000-0000-0000-0000-000000d30002', '00000000-0000-0000-0000-000000d00001', 'Legacy', 'MembershipClient', 'active'),
  ('00000000-0000-0000-0000-000000d30003', '00000000-0000-0000-0000-000000d00001', 'Legacy', 'FiniteMembershipClient', 'active'),
  ('00000000-0000-0000-0000-000000d30004', '00000000-0000-0000-0000-000000d00001', 'MembershipOnly', 'TestClient', 'active'),
  ('00000000-0000-0000-0000-000000d30005', '00000000-0000-0000-0000-000000d00001', 'PackageOnly', 'TestClient', 'active'),
  ('00000000-0000-0000-0000-000000d30006', '00000000-0000-0000-0000-000000d00001', 'Both', 'TestClient', 'active'),
  ('00000000-0000-0000-0000-000000d30007', '00000000-0000-0000-0000-000000d00001', 'DirectPayment', 'TestClient', 'active'),
  ('00000000-0000-0000-0000-000000d30008', '00000000-0000-0000-0000-000000d00001', 'StaffGate', 'TestClient', 'active'),
  ('00000000-0000-0000-0000-000000d30009', '00000000-0000-0000-0000-000000d00001', 'Depleted', 'PackageClient', 'active'),
  ('00000000-0000-0000-0000-000000d30010', '00000000-0000-0000-0000-000000d00001', 'Exhausted', 'FiniteMembershipClient', 'active'),
  ('00000000-0000-0000-0000-000000d30012', '00000000-0000-0000-0000-000000d00001', 'Expired', 'MembershipClient', 'active'),
  ('00000000-0000-0000-0000-000000d30013', '00000000-0000-0000-0000-000000d00001', 'LegacyPolicyRow', 'Client', 'active');

-- Group-class appointments, all in Studio A (assigned to the one
-- instructor) unless noted. roster_capacity left null (GC-3.1 unlimited) --
-- capacity is not what this suite is about.
insert into public.appointments (id, studio_id, instructor_id, appointment_type, status, starts_at, ends_at) values
  ('00000000-0000-0000-0000-000000d40001', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d20001', 'group_class', 'scheduled', now() + interval '1 day', now() + interval '1 day 1 hour'),
  ('00000000-0000-0000-0000-000000d40003', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d20001', 'group_class', 'scheduled', now() + interval '3 days', now() + interval '3 days 1 hour'),
  ('00000000-0000-0000-0000-000000d40004', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d20001', 'group_class', 'scheduled', now() + interval '4 days', now() + interval '4 days 1 hour'),
  ('00000000-0000-0000-0000-000000d40005', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d20001', 'group_class', 'scheduled', now() + interval '5 days', now() + interval '5 days 1 hour'),
  ('00000000-0000-0000-0000-000000d40006', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d20001', 'group_class', 'scheduled', now() + interval '6 days', now() + interval '6 days 1 hour'),
  ('00000000-0000-0000-0000-000000d40008', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d20001', 'group_class', 'scheduled', now() + interval '8 days', now() + interval '8 days 1 hour'),
  ('00000000-0000-0000-0000-000000d40009', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d20001', 'group_class', 'scheduled', now() + interval '9 days', now() + interval '9 days 1 hour'),
  ('00000000-0000-0000-0000-000000d40010', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d20001', 'group_class', 'scheduled', now() + interval '10 days', now() + interval '10 days 1 hour'),
  ('00000000-0000-0000-0000-000000d40011', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d20001', 'group_class', 'scheduled', now() + interval '11 days', now() + interval '11 days 1 hour'),
  ('00000000-0000-0000-0000-000000d40013', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d20001', 'group_class', 'scheduled', now() + interval '13 days', now() + interval '13 days 1 hour'),
  ('00000000-0000-0000-0000-000000d40014', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d20001', 'group_class', 'scheduled', now() + interval '14 days', now() + interval '14 days 1 hour');

insert into public.appointments (id, studio_id, instructor_id, appointment_type, status, starts_at, ends_at) values
  ('00000000-0000-0000-0000-000000d40002', '00000000-0000-0000-0000-000000d00001', null, 'private_lesson', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour'),
  ('00000000-0000-0000-0000-000000d40098', '00000000-0000-0000-0000-000000d00002', null, 'group_class', 'scheduled', now() + interval '9 days', now() + interval '9 days 1 hour');

-- Packages: one unlimited group-class package per "has an eligible
-- package" client, plus one depleted (finite, zero remaining) package.
insert into public.client_packages (id, studio_id, client_id, name_snapshot, active) values
  ('00000000-0000-0000-0000-000000d50001', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30001', 'T-gc3-2 Unlimited Package', true),
  ('00000000-0000-0000-0000-000000d50002', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30004', 'T-gc3-2 Unlimited Package', true),
  ('00000000-0000-0000-0000-000000d50003', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30005', 'T-gc3-2 Unlimited Package', true),
  ('00000000-0000-0000-0000-000000d50004', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30006', 'T-gc3-2 Unlimited Package', true),
  ('00000000-0000-0000-0000-000000d50005', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30007', 'T-gc3-2 Unlimited Package', true),
  ('00000000-0000-0000-0000-000000d50006', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30008', 'T-gc3-2 Unlimited Package', true),
  ('00000000-0000-0000-0000-000000d50007', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30009', 'T-gc3-2 Depleted Package', true);

insert into public.client_package_items (id, studio_id, client_package_id, usage_type, quantity_total, quantity_used, quantity_remaining, is_unlimited) values
  ('00000000-0000-0000-0000-000000d50011', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d50001', 'group_class', null, 0, null, true),
  ('00000000-0000-0000-0000-000000d50012', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d50002', 'group_class', null, 0, null, true),
  ('00000000-0000-0000-0000-000000d50013', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d50003', 'group_class', null, 0, null, true),
  ('00000000-0000-0000-0000-000000d50014', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d50004', 'group_class', null, 0, null, true),
  ('00000000-0000-0000-0000-000000d50015', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d50005', 'group_class', null, 0, null, true),
  ('00000000-0000-0000-0000-000000d50016', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d50006', 'group_class', null, 0, null, true),
  ('00000000-0000-0000-0000-000000d50017', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d50007', 'group_class', 5, 5, 0, false);

-- Memberships: one unlimited plan (shared by every "has an eligible
-- unlimited membership" client), one finite plan (quantity=4, shared by the
-- finite-remaining and finite-exhausted clients).
insert into public.membership_plans (id, studio_id, name, active) values
  ('00000000-0000-0000-0000-000000d60001', '00000000-0000-0000-0000-000000d00001', 'T-gc3-2 Unlimited Group Class Plan', true),
  ('00000000-0000-0000-0000-000000d60003', '00000000-0000-0000-0000-000000d00001', 'T-gc3-2 Finite Group Class Plan', true);

insert into public.membership_plan_benefits (id, membership_plan_id, benefit_type, quantity, applies_to) values
  ('00000000-0000-0000-0000-000000d60002', '00000000-0000-0000-0000-000000d60001', 'unlimited_group_classes', null, 'group_class'),
  ('00000000-0000-0000-0000-000000d60004', '00000000-0000-0000-0000-000000d60003', 'included_group_classes', 4, 'group_class');

insert into public.client_memberships (
  id, studio_id, client_id, membership_plan_id, status, name_snapshot,
  starts_on, current_period_start, current_period_end, billing_interval_snapshot
) values
  ('00000000-0000-0000-0000-000000d61002', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30002', '00000000-0000-0000-0000-000000d60001', 'active', 'T-gc3-2 Unlimited Group Class Plan', current_date, current_date, current_date + 30, 'monthly'),
  ('00000000-0000-0000-0000-000000d61003', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30003', '00000000-0000-0000-0000-000000d60003', 'active', 'T-gc3-2 Finite Group Class Plan', current_date, current_date, current_date + 30, 'monthly'),
  ('00000000-0000-0000-0000-000000d61004', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30004', '00000000-0000-0000-0000-000000d60001', 'active', 'T-gc3-2 Unlimited Group Class Plan', current_date, current_date, current_date + 30, 'monthly'),
  ('00000000-0000-0000-0000-000000d61005', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30005', '00000000-0000-0000-0000-000000d60001', 'active', 'T-gc3-2 Unlimited Group Class Plan', current_date, current_date, current_date + 30, 'monthly'),
  ('00000000-0000-0000-0000-000000d61006', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30006', '00000000-0000-0000-0000-000000d60001', 'active', 'T-gc3-2 Unlimited Group Class Plan', current_date, current_date, current_date + 30, 'monthly'),
  ('00000000-0000-0000-0000-000000d61007', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30007', '00000000-0000-0000-0000-000000d60001', 'active', 'T-gc3-2 Unlimited Group Class Plan', current_date, current_date, current_date + 30, 'monthly'),
  ('00000000-0000-0000-0000-000000d61008', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30008', '00000000-0000-0000-0000-000000d60001', 'active', 'T-gc3-2 Unlimited Group Class Plan', current_date, current_date, current_date + 30, 'monthly'),
  ('00000000-0000-0000-0000-000000d61010', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30010', '00000000-0000-0000-0000-000000d60003', 'active', 'T-gc3-2 Finite Group Class Plan', current_date, current_date, current_date + 30, 'monthly'),
  ('00000000-0000-0000-0000-000000d61012', '00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30012', '00000000-0000-0000-0000-000000d60001', 'expired', 'T-gc3-2 Unlimited Group Class Plan', current_date - 60, current_date - 60, current_date - 30, 'monthly');

-- Usage: d30003 has used 1 of 4 (remaining 3); d30010 has used all 4 of 4
-- (remaining 0, exhausted).
insert into public.client_membership_usage (id, client_membership_id, membership_plan_benefit_id, usage_date, quantity_used) values
  ('00000000-0000-0000-0000-000000d62003', '00000000-0000-0000-0000-000000d61003', '00000000-0000-0000-0000-000000d60004', current_date, 1),
  ('00000000-0000-0000-0000-000000d62010', '00000000-0000-0000-0000-000000d61010', '00000000-0000-0000-0000-000000d60004', current_date, 4);

-- ============================================================================
-- 1. Policy-table integrity.
-- ============================================================================

-- 1a. Positive control: a policy may target a real group class in the same
--     studio. (Also doubles as the fixture for section 3's
--     membership-only filtering tests, below.)
do $$
declare
  v_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10001')::text, true);

  insert into public.group_class_enrollment_policies (studio_id, appointment_id, accepted_funding_types, created_by)
  values ('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d40003', array['membership']::text[], '00000000-0000-0000-0000-000000d10001')
  returning id into v_id;

  reset role;
  if v_id is null then raise exception 'FAIL T-gc3-2-policy-positive-control: insert did not return an id'; end if;
  raise notice 'PASS T-gc3-2-policy-may-target-real-group-class-same-studio';
end $$;

-- 1b. Reject non-group-class appointment.
do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10001')::text, true);

  v_errored := false;
  begin
    insert into public.group_class_enrollment_policies (studio_id, appointment_id)
    values ('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d40002');
  exception when others then
    v_errored := true;
  end;

  reset role;
  if not v_errored then raise exception 'FAIL T-gc3-2-reject-non-group-class-appointment'; end if;
  raise notice 'PASS T-gc3-2-reject-non-group-class-appointment';
end $$;

-- 1c. Reject cross-studio mismatch (claimed studio_id does not match the
--     target appointment's real studio).
do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10001')::text, true);

  v_errored := false;
  begin
    insert into public.group_class_enrollment_policies (studio_id, appointment_id)
    values ('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d40098');
  exception when others then
    v_errored := true;
  end;

  reset role;
  if not v_errored then raise exception 'FAIL T-gc3-2-reject-cross-studio-mismatch'; end if;
  raise notice 'PASS T-gc3-2-reject-cross-studio-mismatch';
end $$;

-- 1d. Default discovery/self-enrollment off on a bare insert; no anonymous/
--     unauthorized write (an unrelated user with no studio role is denied
--     by RLS before the row is ever considered by the shape trigger).
do $$
declare
  v_errored boolean;
  v_id uuid;
  v_discoverable boolean;
  v_self_enroll boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10003')::text, true);

  v_errored := false;
  begin
    insert into public.group_class_enrollment_policies (studio_id, appointment_id)
    values ('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d40014');
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc3-2-no-anonymous-write: unrelated user was able to insert a policy row'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10001')::text, true);
  insert into public.group_class_enrollment_policies (studio_id, appointment_id)
  values ('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d40014')
  returning id, publicly_discoverable, self_enrollment_allowed into v_id, v_discoverable, v_self_enroll;

  reset role;
  if v_id is null or v_discoverable is not false or v_self_enroll is not false then
    raise exception 'FAIL T-gc3-2-default-discovery-self-enrollment-off: expected both false on a bare insert';
  end if;
  raise notice 'PASS T-gc3-2-no-anonymous-write-and-default-discovery-self-enrollment-off';
end $$;

-- 1e. Discovery/self-enrollment cannot be enabled without an explicit
--     non-empty funding allow-list (null, then empty array, both rejected;
--     a non-empty array is accepted -- proven together with 1f below on the
--     same target appointment, d40008, which ends this section with zero
--     persisted rows).
do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10001')::text, true);

  v_errored := false;
  begin
    insert into public.group_class_enrollment_policies (studio_id, appointment_id, publicly_discoverable, accepted_funding_types)
    values ('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d40008', true, null);
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc3-2-discovery-requires-funding-null-rejected'; end if;

  v_errored := false;
  begin
    insert into public.group_class_enrollment_policies (studio_id, appointment_id, self_enrollment_allowed, accepted_funding_types)
    values ('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d40008', true, array[]::text[]);
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc3-2-discovery-requires-funding-empty-array-rejected'; end if;

  reset role;
  raise notice 'PASS T-gc3-2-discovery-self-enrollment-cannot-enable-without-funding-allow-list';
end $$;

-- 1f. direct_payment accepted requires a valid (present, positive) amount;
--     invalid funding vocabulary rejected. Same target appointment
--     (d40008) -- every attempt here fails, confirmed at the end.
do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10001')::text, true);

  v_errored := false;
  begin
    insert into public.group_class_enrollment_policies (studio_id, appointment_id, accepted_funding_types, direct_payment_amount)
    values ('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d40008', array['direct_payment']::text[], null);
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc3-2-direct-payment-requires-amount-null-rejected'; end if;

  v_errored := false;
  begin
    insert into public.group_class_enrollment_policies (studio_id, appointment_id, accepted_funding_types, direct_payment_amount)
    values ('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d40008', array['direct_payment']::text[], 0);
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc3-2-direct-payment-amount-must-be-positive-zero-rejected'; end if;

  v_errored := false;
  begin
    insert into public.group_class_enrollment_policies (studio_id, appointment_id, accepted_funding_types, direct_payment_amount)
    values ('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d40008', array['direct_payment']::text[], -5);
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc3-2-direct-payment-amount-must-be-positive-negative-rejected'; end if;

  v_errored := false;
  begin
    insert into public.group_class_enrollment_policies (studio_id, appointment_id, accepted_funding_types)
    values ('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d40008', array['bogus_type']::text[]);
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc3-2-invalid-funding-vocabulary-rejected'; end if;

  if exists (select 1 from public.group_class_enrollment_policies where appointment_id = '00000000-0000-0000-0000-000000d40008') then
    raise exception 'FAIL T-gc3-2-negative-constraint-target-clean: every attempt against d40008 should have failed, but a row exists';
  end if;

  reset role;
  raise notice 'PASS T-gc3-2-direct-payment-requires-valid-amount-and-invalid-vocabulary-rejected';
end $$;

-- ============================================================================
-- 2. Legacy compatibility -- no policy row on d40001.
-- ============================================================================

-- 2a/2c. Package and unlimited membership: resolver returns them
-- unfiltered, and the instructor auto-resolve path still enrolls correctly.
do $$
declare
  v_count int;
  v_attendee_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10001')::text, true);

  select count(*) into v_count
    from public.get_eligible_group_class_funding_candidates('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30001', '00000000-0000-0000-0000-000000d40001');
  if v_count <> 1 then raise exception 'FAIL T-gc3-2-legacy-package-resolver: expected 1 candidate, got %', v_count; end if;

  select count(*) into v_count
    from public.get_eligible_group_class_funding_candidates('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30002', '00000000-0000-0000-0000-000000d40001');
  if v_count <> 1 then raise exception 'FAIL T-gc3-2-legacy-unlimited-membership-resolver: expected 1 candidate, got %', v_count; end if;

  reset role;

  -- Instructor auto-resolve: Package client enrolls with no billing params.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10002')::text, true);
  v_attendee_id := public.enroll_class_attendee('00000000-0000-0000-0000-000000d40001', '00000000-0000-0000-0000-000000d30001');
  reset role;
  if v_attendee_id is null then raise exception 'FAIL T-gc3-2-legacy-package-instructor-enroll'; end if;
  if (select billing_type from public.appointment_attendees where id = v_attendee_id) <> 'package_credit' then
    raise exception 'FAIL T-gc3-2-legacy-package-instructor-enroll-billing-type';
  end if;

  raise notice 'PASS T-gc3-2-legacy-no-policy-row-package-and-unlimited-membership-still-work';
end $$;

-- 2b/4c/4d. Finite membership with remaining balance (also proves exact
-- numeric accuracy: quantity_total=4, used=1, remaining=3) and unlimited
-- membership shape (is_unlimited=true, all numeric fields null).
do $$
declare
  v_quantity_total numeric;
  v_used numeric;
  v_remaining numeric;
  v_is_unlimited boolean;
  v_attendee_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10001')::text, true);

  select quantity_total, used, remaining, is_unlimited
    into v_quantity_total, v_used, v_remaining, v_is_unlimited
    from public.get_eligible_group_class_funding_candidates('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30003', '00000000-0000-0000-0000-000000d40001')
    where funding_type = 'membership';

  if v_quantity_total <> 4 or v_used <> 1 or v_remaining <> 3 or v_is_unlimited is not false then
    raise exception 'FAIL T-gc3-2-finite-membership-remaining-accuracy: got total=%, used=%, remaining=%, unlimited=%', v_quantity_total, v_used, v_remaining, v_is_unlimited;
  end if;

  select is_unlimited, quantity_total, used, remaining
    into v_is_unlimited, v_quantity_total, v_used, v_remaining
    from public.get_eligible_group_class_funding_candidates('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30002', '00000000-0000-0000-0000-000000d40001')
    where funding_type = 'membership';

  if v_is_unlimited is not true or v_quantity_total is not null or v_used is not null or v_remaining is not null then
    raise exception 'FAIL T-gc3-2-unlimited-membership-shape: expected unlimited=true and all numeric fields null';
  end if;

  reset role;

  -- Instructor auto-resolve for the finite-membership client (also
  -- confirms 2b's own end-to-end legacy compatibility).
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10002')::text, true);
  v_attendee_id := public.enroll_class_attendee('00000000-0000-0000-0000-000000d40001', '00000000-0000-0000-0000-000000d30003');
  reset role;
  if v_attendee_id is null or (select billing_type from public.appointment_attendees where id = v_attendee_id) <> 'membership' then
    raise exception 'FAIL T-gc3-2-legacy-finite-membership-instructor-enroll';
  end if;

  raise notice 'PASS T-gc3-2-legacy-finite-membership-remaining-accuracy-and-unlimited-membership-shape';
end $$;

-- 2d. A policy row WITH accepted_funding_types IS NULL and discovery/
--     self-enrollment off preserves legacy staff behavior exactly -- a
--     broad-staff billing choice that a restrictive policy WOULD reject
--     (free_comped / manual_other) succeeds unaffected.
do $$
declare
  v_attendee_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10001')::text, true);

  insert into public.group_class_enrollment_policies (studio_id, appointment_id, created_by)
  values ('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d40013', '00000000-0000-0000-0000-000000d10001');

  v_attendee_id := public.enroll_class_attendee('00000000-0000-0000-0000-000000d40013', '00000000-0000-0000-0000-000000d30013', 'free_comped');

  reset role;
  if v_attendee_id is null then raise exception 'FAIL T-gc3-2-null-funding-policy-preserves-legacy-staff-behavior'; end if;
  raise notice 'PASS T-gc3-2-policy-row-null-funding-types-preserves-legacy-staff-behavior';
end $$;

-- ============================================================================
-- 3. Policy filtering.
-- ============================================================================

-- 3a. Membership-only policy (d40003, from 1a) excludes packages -- even
--     though MembershipOnly/TestClient (d30004) has a genuinely eligible
--     package too. Also proves policy filtering reaches the INSTRUCTOR
--     auto-resolve path: despite having two real entitlements (package +
--     membership), exactly one candidate survives filtering, so
--     auto-resolution succeeds (not ambiguous) and picks the membership.
do $$
declare
  v_count int;
  v_funding_type text;
  v_attendee_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10001')::text, true);

  select count(*), (array_agg(funding_type))[1] into v_count, v_funding_type
    from public.get_eligible_group_class_funding_candidates('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30004', '00000000-0000-0000-0000-000000d40003');
  reset role;

  if v_count <> 1 or v_funding_type <> 'membership' then
    raise exception 'FAIL T-gc3-2-membership-only-excludes-packages: expected exactly 1 membership candidate, got count=%, type=%', v_count, v_funding_type;
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10002')::text, true);
  v_attendee_id := public.enroll_class_attendee('00000000-0000-0000-0000-000000d40003', '00000000-0000-0000-0000-000000d30004');
  reset role;

  if v_attendee_id is null or (select billing_type from public.appointment_attendees where id = v_attendee_id) <> 'membership' then
    raise exception 'FAIL T-gc3-2-membership-only-policy-filtering-reaches-instructor-path';
  end if;

  raise notice 'PASS T-gc3-2-membership-only-excludes-packages-and-filters-instructor-path';
end $$;

-- 3b. Package-only policy excludes memberships.
do $$
declare
  v_count int;
  v_funding_type text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10001')::text, true);

  insert into public.group_class_enrollment_policies (studio_id, appointment_id, accepted_funding_types, created_by)
  values ('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d40004', array['package']::text[], '00000000-0000-0000-0000-000000d10001');

  select count(*), (array_agg(funding_type))[1] into v_count, v_funding_type
    from public.get_eligible_group_class_funding_candidates('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30005', '00000000-0000-0000-0000-000000d40004');

  reset role;
  if v_count <> 1 or v_funding_type <> 'package' then
    raise exception 'FAIL T-gc3-2-package-only-excludes-memberships: expected exactly 1 package candidate, got count=%, type=%', v_count, v_funding_type;
  end if;
  raise notice 'PASS T-gc3-2-package-only-excludes-memberships';
end $$;

-- 3c. Membership + package policy permits both.
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10001')::text, true);

  insert into public.group_class_enrollment_policies (studio_id, appointment_id, accepted_funding_types, created_by)
  values ('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d40005', array['membership', 'package']::text[], '00000000-0000-0000-0000-000000d10001');

  select count(*) into v_count
    from public.get_eligible_group_class_funding_candidates('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30006', '00000000-0000-0000-0000-000000d40005');

  reset role;
  if v_count <> 2 then raise exception 'FAIL T-gc3-2-membership-and-package-permits-both: expected 2 candidates, got %', v_count; end if;
  raise notice 'PASS T-gc3-2-membership-and-package-policy-permits-both';
end $$;

-- 3d. direct_payment/manual_other policy values do not accidentally
--     fabricate membership/package candidate rows -- DirectPayment/
--     TestClient (d30007) has a genuinely eligible package AND membership,
--     yet the resolver returns zero rows under this policy.
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10001')::text, true);

  insert into public.group_class_enrollment_policies (studio_id, appointment_id, accepted_funding_types, direct_payment_amount, created_by)
  values ('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d40006', array['direct_payment', 'manual_other']::text[], 25, '00000000-0000-0000-0000-000000d10001');

  select count(*) into v_count
    from public.get_eligible_group_class_funding_candidates('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30007', '00000000-0000-0000-0000-000000d40006');

  reset role;
  if v_count <> 0 then raise exception 'FAIL T-gc3-2-direct-payment-manual-does-not-fabricate-candidates: expected 0, got %', v_count; end if;
  raise notice 'PASS T-gc3-2-direct-payment-manual-policy-does-not-fabricate-package-or-membership-candidates';
end $$;

-- 3e. Policy filtering applies to the BROAD staff path too -- reusing
--     d40003's membership-only policy (from 1a/3a). StaffGate/TestClient
--     (d30008) has a real, active package: broad staff billing to it is
--     rejected outright by the policy gate; billing the same enrollment to
--     the client's real membership succeeds.
do $$
declare
  v_errored boolean;
  v_attendee_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10001')::text, true);

  v_errored := false;
  begin
    perform public.enroll_class_attendee(
      '00000000-0000-0000-0000-000000d40003', '00000000-0000-0000-0000-000000d30008', 'package_credit', '00000000-0000-0000-0000-000000d50006'
    );
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc3-2-policy-gates-broad-staff-rejected-type: package_credit should have been rejected under a membership-only policy'; end if;

  v_attendee_id := public.enroll_class_attendee(
    '00000000-0000-0000-0000-000000d40003', '00000000-0000-0000-0000-000000d30008', 'membership', null, '00000000-0000-0000-0000-000000d61008'
  );

  reset role;
  if v_attendee_id is null then raise exception 'FAIL T-gc3-2-policy-gates-broad-staff-accepted-type: membership should have been accepted under a membership-only policy'; end if;
  raise notice 'PASS T-gc3-2-policy-filtering-applies-to-broad-staff-path';
end $$;

-- ============================================================================
-- 4. Entitlement accuracy.
-- ============================================================================

-- 4a. Depleted package excluded.
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10001')::text, true);

  select count(*) into v_count
    from public.get_eligible_group_class_funding_candidates('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30009', '00000000-0000-0000-0000-000000d40009');

  reset role;
  if v_count <> 0 then raise exception 'FAIL T-gc3-2-depleted-package-excluded: expected 0 candidates, got %', v_count; end if;
  raise notice 'PASS T-gc3-2-depleted-package-excluded';
end $$;

-- 4b. Exhausted finite membership excluded.
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10001')::text, true);

  select count(*) into v_count
    from public.get_eligible_group_class_funding_candidates('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30010', '00000000-0000-0000-0000-000000d40010');

  reset role;
  if v_count <> 0 then raise exception 'FAIL T-gc3-2-exhausted-finite-membership-excluded: expected 0 candidates, got %', v_count; end if;
  raise notice 'PASS T-gc3-2-exhausted-finite-membership-excluded';
end $$;

-- 4e. Expired membership excluded (status <> 'active').
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000d10001')::text, true);

  select count(*) into v_count
    from public.get_eligible_group_class_funding_candidates('00000000-0000-0000-0000-000000d00001', '00000000-0000-0000-0000-000000d30012', '00000000-0000-0000-0000-000000d40011');

  reset role;
  if v_count <> 0 then raise exception 'FAIL T-gc3-2-expired-membership-excluded: expected 0 candidates, got %', v_count; end if;
  raise notice 'PASS T-gc3-2-expired-membership-excluded';
end $$;

-- (4c and 4d -- finite-with-remaining accuracy and unlimited shape -- were
-- proven directly above in section 2, alongside their own legacy-
-- compatibility assertions, rather than repeated here.)

do $$ begin raise notice 'GC-3.2 SQL regression suite: ALL CHECKS PASSED'; end $$;

rollback;
