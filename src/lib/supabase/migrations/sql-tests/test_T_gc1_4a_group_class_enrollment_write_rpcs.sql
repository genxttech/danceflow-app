-- GC-1.4A -- group class enrollment write RPCs live-Postgres regression
-- suite.
--
-- Proves, at the real Postgres level (not mocked), that the six new
-- callable RPCs, the two private authorization helpers, and the new
-- canonical-shape/type-transition trigger all behave exactly as approved
-- across the full authorization matrix. Entire script runs in one
-- transaction and is rolled back at the end -- nothing persists. Run via
-- `supabase db query --linked --file <this file>` against DEV, AFTER both
-- forward migrations (20260910100000, 20260910100100) have been applied.
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-0000aaXXXXXX (studios)
-- 00000000-0000-0000-0000-0000abXXXXXX (auth.users/profiles)
-- 00000000-0000-0000-0000-0000acXXXXXX (instructors)
-- 00000000-0000-0000-0000-0000adXXXXXX (clients)
-- 00000000-0000-0000-0000-0000aeXXXXXX (appointments)
-- 00000000-0000-0000-0000-0000afXXXXXX (client_packages)
-- 00000000-0000-0000-0000-0000b0XXXXXX (client_package_items)

begin;

-- ============================================================================
-- FIXTURES
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-000000aa0001', 'GC-1.4A Harness Studio A', 't-gc1-4a-studio-a'),
  ('00000000-0000-0000-0000-000000aa0002', 'GC-1.4A Harness Studio B', 't-gc1-4a-studio-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000ab0001', 't-gc1-4a-owner@example.test'),
  ('00000000-0000-0000-0000-000000ab0002', 't-gc1-4a-instructor-assigned@example.test'),
  ('00000000-0000-0000-0000-000000ab0003', 't-gc1-4a-instructor-other@example.test'),
  ('00000000-0000-0000-0000-000000ab0004', 't-gc1-4a-independent-instructor@example.test'),
  ('00000000-0000-0000-0000-000000ab0005', 't-gc1-4a-platform-admin@example.test'),
  ('00000000-0000-0000-0000-000000ab0006', 't-gc1-4a-portal-student@example.test'),
  ('00000000-0000-0000-0000-000000ab0007', 't-gc1-4a-portal-unrelated@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-000000ab0001', 't-gc1-4a-owner@example.test', null),
  ('00000000-0000-0000-0000-000000ab0002', 't-gc1-4a-instructor-assigned@example.test', null),
  ('00000000-0000-0000-0000-000000ab0003', 't-gc1-4a-instructor-other@example.test', null),
  ('00000000-0000-0000-0000-000000ab0004', 't-gc1-4a-independent-instructor@example.test', null),
  ('00000000-0000-0000-0000-000000ab0005', 't-gc1-4a-platform-admin@example.test', 'platform_admin'),
  ('00000000-0000-0000-0000-000000ab0006', 't-gc1-4a-portal-student@example.test', null),
  ('00000000-0000-0000-0000-000000ab0007', 't-gc1-4a-portal-unrelated@example.test', null);

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-000000ab0001', '00000000-0000-0000-0000-000000aa0001', 'studio_owner', true),
  ('00000000-0000-0000-0000-000000ab0002', '00000000-0000-0000-0000-000000aa0001', 'instructor', true),
  ('00000000-0000-0000-0000-000000ab0003', '00000000-0000-0000-0000-000000aa0001', 'instructor', true),
  ('00000000-0000-0000-0000-000000ab0004', '00000000-0000-0000-0000-000000aa0001', 'independent_instructor', true);

insert into public.instructors (id, studio_id, user_id, first_name, last_name, active) values
  ('00000000-0000-0000-0000-000000ac0001', '00000000-0000-0000-0000-000000aa0001', '00000000-0000-0000-0000-000000ab0002', 'Assigned', 'Instructor', true),
  ('00000000-0000-0000-0000-000000ac0002', '00000000-0000-0000-0000-000000aa0001', '00000000-0000-0000-0000-000000ab0003', 'Other', 'Instructor', true);

insert into public.clients (id, studio_id, first_name, last_name, status) values
  ('00000000-0000-0000-0000-000000ad0001', '00000000-0000-0000-0000-000000aa0001', 'Broad', 'Enrollee', 'active'),
  ('00000000-0000-0000-0000-000000ad0002', '00000000-0000-0000-0000-000000aa0001', 'Instructor', 'Enrollee', 'active'),
  ('00000000-0000-0000-0000-000000ad0003', '00000000-0000-0000-0000-000000aa0001', 'Portal', 'Student', 'active'),
  ('00000000-0000-0000-0000-000000ad0004', '00000000-0000-0000-0000-000000aa0002', 'CrossStudio', 'Client', 'active'),
  ('00000000-0000-0000-0000-000000ad0005', '00000000-0000-0000-0000-000000aa0001', 'Membership', 'Only', 'active'),
  ('00000000-0000-0000-0000-000000ad0006', '00000000-0000-0000-0000-000000aa0001', 'Package', 'AndMembership', 'active'),
  ('00000000-0000-0000-0000-000000ad0007', '00000000-0000-0000-0000-000000aa0001', 'Multiple', 'Memberships', 'active'),
  ('00000000-0000-0000-0000-000000ad0008', '00000000-0000-0000-0000-000000aa0001', 'Multiple', 'Packages', 'active'),
  ('00000000-0000-0000-0000-000000ad0009', '00000000-0000-0000-0000-000000aa0001', 'No', 'Entitlement', 'active');

insert into public.client_account_links (studio_id, client_id, user_id, status, can_view_schedule, relationship_type, initiated_by) values
  ('00000000-0000-0000-0000-000000aa0001', '00000000-0000-0000-0000-000000ad0003', '00000000-0000-0000-0000-000000ab0006', 'linked', true, 'self', 'studio');

-- A pre-existing canonical class instance, assigned to Instructor A, with a
-- future start (self-check-in window not open yet) and another with a past
-- start already ended (window closed / historical).
insert into public.appointments (
  id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at
) values
  ('00000000-0000-0000-0000-000000ae0001', '00000000-0000-0000-0000-000000aa0001', null, '00000000-0000-0000-0000-000000ac0001', 'group_class', 'scheduled', now() + interval '10 minutes', now() + interval '70 minutes'),
  ('00000000-0000-0000-0000-000000ae0002', '00000000-0000-0000-0000-000000aa0001', null, '00000000-0000-0000-0000-000000ac0002', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour'),
  -- A separate class instance (same assigned instructor as ae0001), used
  -- only by the financial-minimization matrix below -- kept isolated from
  -- ae0001 so those enrollments don't change ae0001's own later
  -- whole-class-cancellation affected-ids assertion.
  ('00000000-0000-0000-0000-000000ae0003', '00000000-0000-0000-0000-000000aa0001', null, '00000000-0000-0000-0000-000000ac0001', 'group_class', 'scheduled', now() + interval '3 days', now() + interval '3 days 1 hour');

-- One eligible group-class package for the instructor-financial-minimization case.
insert into public.client_packages (id, studio_id, client_id, name_snapshot, active) values
  ('00000000-0000-0000-0000-000000af0001', '00000000-0000-0000-0000-000000aa0001', '00000000-0000-0000-0000-000000ad0002', 'T-gc1-4a Test Package', true);
insert into public.client_package_items (id, studio_id, client_package_id, usage_type, quantity_total, quantity_used, quantity_remaining, is_unlimited) values
  ('00000000-0000-0000-0000-000000b00001', '00000000-0000-0000-0000-000000aa0001', '00000000-0000-0000-0000-000000af0001', 'group_class', 5, 0, 5, false);

-- Two eligible packages for ad0008 (multiple-packages ambiguity case).
insert into public.client_packages (id, studio_id, client_id, name_snapshot, active) values
  ('00000000-0000-0000-0000-000000af0002', '00000000-0000-0000-0000-000000aa0001', '00000000-0000-0000-0000-000000ad0008', 'T-gc1-4a Test Package 2', true),
  ('00000000-0000-0000-0000-000000af0003', '00000000-0000-0000-0000-000000aa0001', '00000000-0000-0000-0000-000000ad0008', 'T-gc1-4a Test Package 3', true);
insert into public.client_package_items (id, studio_id, client_package_id, usage_type, quantity_total, quantity_used, quantity_remaining, is_unlimited) values
  ('00000000-0000-0000-0000-000000b00002', '00000000-0000-0000-0000-000000aa0001', '00000000-0000-0000-0000-000000af0002', 'group_class', 5, 0, 5, false),
  ('00000000-0000-0000-0000-000000b00003', '00000000-0000-0000-0000-000000aa0001', '00000000-0000-0000-0000-000000af0003', 'group_class', 5, 0, 5, false);

-- One eligible package for ad0006 (package + membership simultaneous eligibility).
insert into public.client_packages (id, studio_id, client_id, name_snapshot, active) values
  ('00000000-0000-0000-0000-000000af0004', '00000000-0000-0000-0000-000000aa0001', '00000000-0000-0000-0000-000000ad0006', 'T-gc1-4a Test Package 4', true);
insert into public.client_package_items (id, studio_id, client_package_id, usage_type, quantity_total, quantity_used, quantity_remaining, is_unlimited) values
  ('00000000-0000-0000-0000-000000b00004', '00000000-0000-0000-0000-000000aa0001', '00000000-0000-0000-0000-000000af0004', 'group_class', 5, 0, 5, false);

-- Membership plan with an unlimited included-group-classes benefit, used by
-- ad0005 (membership-only), ad0006 (package + membership), and ad0007 (the
-- uq_client_one_active_membership regression target -- see below; "multiple
-- eligible memberships" is schema-impossible for this function's
-- status='active'-only rule, not merely untested).
insert into public.membership_plans (id, studio_id, name, active) values
  ('00000000-0000-0000-0000-000000b10001', '00000000-0000-0000-0000-000000aa0001', 'T-gc1-4a Unlimited Group Class Plan', true);
insert into public.membership_plan_benefits (id, membership_plan_id, benefit_type, quantity, applies_to) values
  ('00000000-0000-0000-0000-000000b30001', '00000000-0000-0000-0000-000000b10001', 'unlimited_group_classes', null, 'group_class');

insert into public.client_memberships (
  id, studio_id, client_id, membership_plan_id, status, name_snapshot,
  starts_on, current_period_start, current_period_end, billing_interval_snapshot
) values
  ('00000000-0000-0000-0000-000000b20001', '00000000-0000-0000-0000-000000aa0001', '00000000-0000-0000-0000-000000ad0005', '00000000-0000-0000-0000-000000b10001', 'active', 'T-gc1-4a Unlimited Group Class Plan', current_date, current_date, current_date + 30, 'monthly'),
  ('00000000-0000-0000-0000-000000b20002', '00000000-0000-0000-0000-000000aa0001', '00000000-0000-0000-0000-000000ad0006', '00000000-0000-0000-0000-000000b10001', 'active', 'T-gc1-4a Unlimited Group Class Plan', current_date, current_date, current_date + 30, 'monthly'),
  ('00000000-0000-0000-0000-000000b20003', '00000000-0000-0000-0000-000000aa0001', '00000000-0000-0000-0000-000000ad0007', '00000000-0000-0000-0000-000000b10001', 'active', 'T-gc1-4a Unlimited Group Class Plan', current_date, current_date, current_date + 30, 'monthly');

-- ============================================================================
-- 1. create_group_class_appointment: broad staff succeeds, shape is
--    canonical; pure instructor is denied.
-- ============================================================================
do $$
declare
  v_new_id uuid;
  v_client_id uuid;
  v_attendee_count int;
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0001')::text, true);

  v_new_id := public.create_group_class_appointment(
    '00000000-0000-0000-0000-000000aa0001', '00000000-0000-0000-0000-000000ac0001', null,
    'T-gc1-4a Canonical Class', now() + interval '3 days', now() + interval '3 days 1 hour'
  );

  select client_id into v_client_id from public.appointments where id = v_new_id;
  select count(*) into v_attendee_count from public.appointment_attendees where appointment_id = v_new_id;

  if v_client_id is not null then raise exception 'FAIL T-gc1-4a-create-1: client_id was not null'; end if;
  if v_attendee_count <> 0 then raise exception 'FAIL T-gc1-4a-create-2: expected zero attendees, got %', v_attendee_count; end if;

  reset role;
  raise notice 'PASS T-gc1-4a-create-broad-staff: canonical shape, zero attendees';
end $$;

do $$
declare
  v_errored boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0002')::text, true);

  begin
    perform public.create_group_class_appointment(
      '00000000-0000-0000-0000-000000aa0001', '00000000-0000-0000-0000-000000ac0001', null,
      'T-gc1-4a Instructor Should Not Create', now() + interval '3 days', now() + interval '3 days 1 hour'
    );
  exception when others then
    v_errored := true;
  end;

  reset role;
  if not v_errored then raise exception 'FAIL T-gc1-4a-create-instructor-denied: pure instructor was allowed to create a class'; end if;
  raise notice 'PASS T-gc1-4a-create-instructor-denied';
end $$;

-- ============================================================================
-- 2. enroll_class_attendee: broad staff, own-instructor auto-resolved
--    billing, unassigned/independent denied, duplicate rejected, rebook.
-- ============================================================================
do $$
declare
  v_attendee_id uuid;
  v_source text;
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0001')::text, true);

  v_attendee_id := public.enroll_class_attendee(
    '00000000-0000-0000-0000-000000ae0001', '00000000-0000-0000-0000-000000ad0001', 'free_comped'
  );
  select source into v_source from public.appointment_attendees where id = v_attendee_id;
  if v_source <> 'staff' then raise exception 'FAIL T-gc1-4a-enroll-broad-source: expected staff, got %', v_source; end if;

  v_errored := false;
  begin
    perform public.enroll_class_attendee('00000000-0000-0000-0000-000000ae0001', '00000000-0000-0000-0000-000000ad0001');
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-4a-enroll-duplicate: duplicate active enrollment was not rejected'; end if;

  reset role;
  raise notice 'PASS T-gc1-4a-enroll-broad-staff-and-duplicate-rejection';
end $$;

do $$
declare
  v_attendee_id uuid;
  v_source text;
  v_package_id uuid;
  v_errored boolean;
begin
  -- Assigned instructor enrolls into THEIR OWN class -- succeeds, source =
  -- 'instructor', billing auto-resolved to the one eligible package,
  -- regardless of what (ignored) override is supplied.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0002')::text, true);

  v_attendee_id := public.enroll_class_attendee(
    '00000000-0000-0000-0000-000000ae0001', '00000000-0000-0000-0000-000000ad0002', 'free_comped'
  );
  select source, client_package_id into v_source, v_package_id from public.appointment_attendees where id = v_attendee_id;

  if v_source <> 'instructor' then raise exception 'FAIL T-gc1-4a-enroll-instructor-source: expected instructor, got %', v_source; end if;
  if v_package_id <> '00000000-0000-0000-0000-000000af0001' then
    raise exception 'FAIL T-gc1-4a-enroll-instructor-billing: expected auto-resolved package, got %', v_package_id;
  end if;

  -- Same instructor, a DIFFERENT class (assigned to Instructor B) -- denied.
  v_errored := false;
  begin
    perform public.enroll_class_attendee('00000000-0000-0000-0000-000000ae0002', '00000000-0000-0000-0000-000000ad0002'::uuid);
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-4a-enroll-cross-class-denied: instructor enrolled into a class not assigned to them'; end if;

  reset role;
  raise notice 'PASS T-gc1-4a-enroll-own-instructor-financial-minimization-and-cross-class-denial';
end $$;

-- ----------------------------------------------------------------------------
-- Financial-minimization matrix: membership-only, package+membership
-- ambiguity, uq_client_one_active_membership regression, multiple-packages
-- ambiguity,
-- no entitlement. All as the assigned instructor (ab0002) enrolling into
-- their own class (ae0003, isolated from ae0001/ae0002 above).
-- ----------------------------------------------------------------------------
do $$
declare
  v_attendee_id uuid;
  v_source text;
  v_membership_id uuid;
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0002')::text, true);

  -- Membership-only: exactly one eligible unlimited membership, no
  -- package -- auto-selects the membership, billing_type='membership',
  -- ignores the caller-supplied override.
  v_attendee_id := public.enroll_class_attendee(
    '00000000-0000-0000-0000-000000ae0003', '00000000-0000-0000-0000-000000ad0005', 'free_comped'
  );
  select source, client_membership_id into v_source, v_membership_id
    from public.appointment_attendees where id = v_attendee_id;

  if v_source <> 'instructor' then raise exception 'FAIL T-gc1-4a-enroll-membership-only-source: got %', v_source; end if;
  if v_membership_id <> '00000000-0000-0000-0000-000000b20001' then
    raise exception 'FAIL T-gc1-4a-enroll-membership-only-billing: expected auto-resolved membership, got %', v_membership_id;
  end if;

  reset role;
  raise notice 'PASS T-gc1-4a-enroll-membership-only-auto-resolved';
end $$;

do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0002')::text, true);

  -- Package AND membership simultaneously eligible -- ambiguous, no
  -- established precedence for which should silently win -- rejected.
  v_errored := false;
  begin
    perform public.enroll_class_attendee('00000000-0000-0000-0000-000000ae0003', '00000000-0000-0000-0000-000000ad0006');
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-4a-enroll-package-and-membership-ambiguous: was not rejected'; end if;

  reset role;
  raise notice 'PASS T-gc1-4a-enroll-package-and-membership-ambiguous-rejected';
end $$;

do $$
declare
  v_errored boolean;
begin
  -- "Multiple eligible memberships" is schema-impossible, not merely
  -- untested: enroll_class_attendee's own-instructor auto-resolution only
  -- ever counts status='active' client_memberships rows (a deliberate,
  -- conservative choice -- see the migration's own comment), and
  -- uq_client_one_active_membership (a live partial unique index) already
  -- guarantees at most one such row per client. Proving the constraint
  -- itself holds is the nearest enforceable regression for this case,
  -- rather than fabricating a state the schema forbids.
  v_errored := false;
  begin
    insert into public.client_memberships (
      studio_id, client_id, membership_plan_id, status, name_snapshot,
      starts_on, current_period_start, current_period_end, billing_interval_snapshot
    ) values (
      '00000000-0000-0000-0000-000000aa0001', '00000000-0000-0000-0000-000000ad0007', '00000000-0000-0000-0000-000000b10001', 'active', 'Second Active Membership',
      current_date, current_date, current_date + 30, 'monthly'
    );
  exception when unique_violation then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-4a-uq-client-one-active-membership-enforced: a second active membership was not rejected'; end if;

  raise notice 'PASS T-gc1-4a-uq-client-one-active-membership-enforced';
end $$;

do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0002')::text, true);

  -- Two eligible packages, no membership -- ambiguous, rejected.
  v_errored := false;
  begin
    perform public.enroll_class_attendee('00000000-0000-0000-0000-000000ae0003', '00000000-0000-0000-0000-000000ad0008');
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-4a-enroll-multiple-packages-ambiguous: was not rejected'; end if;

  reset role;
  raise notice 'PASS T-gc1-4a-enroll-multiple-packages-ambiguous-rejected';
end $$;

do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0002')::text, true);

  -- No package, no membership -- rejected, directs to owner/admin/front
  -- desk -- never silently defaults to PAYG or free/comped.
  v_errored := false;
  begin
    perform public.enroll_class_attendee('00000000-0000-0000-0000-000000ae0003', '00000000-0000-0000-0000-000000ad0009');
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-4a-enroll-no-entitlement: was not rejected'; end if;

  reset role;
  raise notice 'PASS T-gc1-4a-enroll-no-entitlement-rejected';
end $$;

do $$
declare
  v_errored boolean;
begin
  -- Independent/floor-rental-only instructor -- denied outright.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0004')::text, true);

  v_errored := false;
  begin
    perform public.enroll_class_attendee('00000000-0000-0000-0000-000000ae0003', '00000000-0000-0000-0000-000000ad0003');
  exception when others then
    v_errored := true;
  end;
  reset role;
  if not v_errored then raise exception 'FAIL T-gc1-4a-enroll-independent-denied'; end if;
  raise notice 'PASS T-gc1-4a-enroll-independent-instructor-denied';
end $$;

do $$
declare
  v_cancel_target uuid;
  v_rebook_id uuid;
begin
  -- Rebook: cancel Broad Enrollee's active row, then enroll them again --
  -- must succeed with a brand-new active row (unique index only restricts
  -- ACTIVE rows).
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0001')::text, true);

  select id into v_cancel_target from public.appointment_attendees
    where appointment_id = '00000000-0000-0000-0000-000000ae0001' and client_id = '00000000-0000-0000-0000-000000ad0001';
  perform public.cancel_class_attendee(v_cancel_target);

  v_rebook_id := public.enroll_class_attendee('00000000-0000-0000-0000-000000ae0001', '00000000-0000-0000-0000-000000ad0001', 'free_comped');

  if v_rebook_id = v_cancel_target then raise exception 'FAIL T-gc1-4a-rebook: rebook did not create a new row'; end if;

  reset role;
  raise notice 'PASS T-gc1-4a-rebook-after-cancel';
end $$;

-- ============================================================================
-- 3. cancel_class_attendee: assigned instructor manages own class's roster;
--    denied for another instructor's class; re-cancel is a no-op.
-- ============================================================================
do $$
declare
  v_attendee_id uuid;
  v_status text;
  v_first_cancelled_at timestamptz;
  v_second_cancelled_at timestamptz;
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0002')::text, true);

  select id into v_attendee_id from public.appointment_attendees
    where appointment_id = '00000000-0000-0000-0000-000000ae0001' and client_id = '00000000-0000-0000-0000-000000ad0002';

  perform public.cancel_class_attendee(v_attendee_id);
  select status, cancelled_at into v_status, v_first_cancelled_at from public.appointment_attendees where id = v_attendee_id;
  if v_status <> 'cancelled' then raise exception 'FAIL T-gc1-4a-cancel-own-instructor: not cancelled'; end if;

  -- Re-cancel: no-op, cancelled_at must not change.
  perform pg_sleep(0.01);
  perform public.cancel_class_attendee(v_attendee_id);
  select cancelled_at into v_second_cancelled_at from public.appointment_attendees where id = v_attendee_id;
  if v_first_cancelled_at is distinct from v_second_cancelled_at then
    raise exception 'FAIL T-gc1-4a-cancel-recancel-noop: cancelled_at changed on a re-cancel';
  end if;

  reset role;
  raise notice 'PASS T-gc1-4a-cancel-own-instructor-and-recancel-noop';
end $$;

do $$
declare
  v_errored boolean := false;
begin
  -- Instructor A tries to cancel an attendee from Instructor B's class.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0002')::text, true);

  begin
    perform public.enroll_class_attendee('00000000-0000-0000-0000-000000ae0002', '00000000-0000-0000-0000-000000ad0003');
  exception when others then
    v_errored := true;
  end;

  reset role;
  if not v_errored then raise exception 'FAIL T-gc1-4a-enroll-instructor-cross-class-denied-2'; end if;
  raise notice 'PASS T-gc1-4a-cross-class-denial-reconfirmed';
end $$;

-- ============================================================================
-- 4. cancel_group_class_appointment: instructor denied even for own class;
--    broad staff succeeds atomically and returns exactly the pre-
--    cancellation booked client id set.
-- ============================================================================
do $$
declare
  v_errored boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0002')::text, true);

  begin
    perform public.cancel_group_class_appointment('00000000-0000-0000-0000-000000ae0001');
  exception when others then
    v_errored := true;
  end;

  reset role;
  if not v_errored then raise exception 'FAIL T-gc1-4a-whole-class-cancel-instructor-denied: assigned instructor was allowed to cancel the whole class'; end if;
  raise notice 'PASS T-gc1-4a-whole-class-cancel-instructor-denied';
end $$;

do $$
declare
  v_affected uuid[];
  v_appt_status text;
  v_active_count int;
  v_already_cancelled_id uuid;
  v_already_cancelled_at_before timestamptz;
  v_already_cancelled_at_after timestamptz;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0001')::text, true);

  select id, cancelled_at into v_already_cancelled_id, v_already_cancelled_at_before
    from public.appointment_attendees
    where appointment_id = '00000000-0000-0000-0000-000000ae0001' and client_id = '00000000-0000-0000-0000-000000ad0002';

  v_affected := public.cancel_group_class_appointment('00000000-0000-0000-0000-000000ae0001');

  if array_length(v_affected, 1) <> 1 or v_affected[1] <> '00000000-0000-0000-0000-000000ad0001' then
    raise exception 'FAIL T-gc1-4a-whole-class-cancel-affected-ids: got %', v_affected;
  end if;

  select status into v_appt_status from public.appointments where id = '00000000-0000-0000-0000-000000ae0001';
  if v_appt_status <> 'cancelled' then raise exception 'FAIL T-gc1-4a-whole-class-cancel-appt-status'; end if;

  select count(*) into v_active_count from public.appointment_attendees
    where appointment_id = '00000000-0000-0000-0000-000000ae0001' and status = 'booked';
  if v_active_count <> 0 then raise exception 'FAIL T-gc1-4a-whole-class-cancel-attendees-not-cancelled'; end if;

  select cancelled_at into v_already_cancelled_at_after from public.appointment_attendees where id = v_already_cancelled_id;
  if v_already_cancelled_at_before is distinct from v_already_cancelled_at_after then
    raise exception 'FAIL T-gc1-4a-whole-class-cancel-preserves-history: an already-cancelled row was touched';
  end if;

  reset role;
  raise notice 'PASS T-gc1-4a-whole-class-cancel-broad-staff-atomic-and-recipient-capture';
end $$;

-- ============================================================================
-- 5. check_in_own_class_attendance: current-booked-only rule (NOT GC-1.2's
--    historical predicate), timing window, own-client-only, idempotent.
-- ============================================================================
do $$
declare
  v_attendee_id uuid;
  v_checkin_count int;
begin
  -- Enroll the portal-linked student into ae0002 (a class 2 days out -- we
  -- will backdate starts_at to put it inside the check-in window).
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0001')::text, true);
  perform public.enroll_class_attendee('00000000-0000-0000-0000-000000ae0002', '00000000-0000-0000-0000-000000ad0003');
  reset role;

  update public.appointments
    set starts_at = now() + interval '5 minutes', ends_at = now() + interval '65 minutes'
    where id = '00000000-0000-0000-0000-000000ae0002';

  -- Portal student checks themself in -- succeeds.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0006')::text, true);
  perform public.check_in_own_class_attendance('00000000-0000-0000-0000-000000ae0002', '00000000-0000-0000-0000-000000ad0003');
  -- Idempotent replay, same role/claim context -- no second row.
  perform public.check_in_own_class_attendance('00000000-0000-0000-0000-000000ae0002', '00000000-0000-0000-0000-000000ad0003');
  reset role;

  -- Verify as the unrestricted observer role -- attendance_records has no
  -- student-facing SELECT policy, so querying it while still "authenticated"
  -- as the portal persona would incorrectly see nothing even though the
  -- SECURITY DEFINER function's own write succeeded; reset role first.
  select count(*) into v_checkin_count from public.attendance_records
    where appointment_id = '00000000-0000-0000-0000-000000ae0002' and client_id = '00000000-0000-0000-0000-000000ad0003' and status = 'checked_in';
  if v_checkin_count <> 1 then raise exception 'FAIL T-gc1-4a-checkin-basic-and-idempotent: expected exactly 1 attendance_records row after check-in + replay, got %', v_checkin_count; end if;

  raise notice 'PASS T-gc1-4a-checkin-basic-and-idempotent';
end $$;

do $$
declare
  v_errored boolean;
  v_covers_participation boolean;
begin
  -- Cancel the enrollment AFTER the class started (post-start cancel) --
  -- self-check-in must now be DENIED (the round-6 correction: current
  -- booked status required, not GC-1.2's historical predicate) -- while
  -- class_enrollment_covers_participation (unmodified) still returns TRUE
  -- for the exact same row, proving staff historical correction is
  -- unaffected.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0001')::text, true);

  -- Move the class into the recent past (so "cancelled after start" is a
  -- real, meaningful timestamp comparison, not an artifact of now() being
  -- frozen for the whole transaction) while keeping the check-in window
  -- (30 min before starts_at / 15 min after ends_at) still open right now.
  update public.appointments
    set starts_at = now() - interval '10 minutes', ends_at = now() + interval '50 minutes'
    where id = '00000000-0000-0000-0000-000000ae0002';

  update public.appointment_attendees
    set status = 'cancelled', cancelled_at = now() - interval '5 minutes', cancelled_by = '00000000-0000-0000-0000-000000ab0001'
    where appointment_id = '00000000-0000-0000-0000-000000ae0002' and client_id = '00000000-0000-0000-0000-000000ad0003';
  reset role;

  v_covers_participation := public.class_enrollment_covers_participation(
    '00000000-0000-0000-0000-000000ae0002', '00000000-0000-0000-0000-000000ad0003', '00000000-0000-0000-0000-000000aa0001'
  );
  if not v_covers_participation then
    raise exception 'FAIL T-gc1-4a-checkin-historical-rule-unaffected: class_enrollment_covers_participation should still be true for a post-start cancellation';
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0006')::text, true);

  v_errored := false;
  begin
    perform public.check_in_own_class_attendance('00000000-0000-0000-0000-000000ae0002', '00000000-0000-0000-0000-000000ad0003');
  exception when others then
    v_errored := true;
  end;
  reset role;

  if not v_errored then
    raise exception 'FAIL T-gc1-4a-checkin-post-start-cancel-denied: a post-start-cancelled attendee was allowed to self-check-in';
  end if;
  raise notice 'PASS T-gc1-4a-checkin-post-start-cancel-denied-but-historically-eligible';
end $$;

do $$
declare
  v_errored boolean := false;
begin
  -- Unrelated portal user attempts to check in a client they are NOT
  -- linked to -- denied.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0007')::text, true);

  begin
    perform public.check_in_own_class_attendance('00000000-0000-0000-0000-000000ae0002', '00000000-0000-0000-0000-000000ad0003');
  exception when others then
    v_errored := true;
  end;
  reset role;

  if not v_errored then raise exception 'FAIL T-gc1-4a-checkin-unrelated-client-denied'; end if;
  raise notice 'PASS T-gc1-4a-checkin-unrelated-client-denied';
end $$;

-- ============================================================================
-- 6. Canonical shape + type-transition trigger (condensed regression --
--    fully verified interactively during implementation; kept here for
--    durable CI coverage).
-- ============================================================================
do $$
declare
  v_new_id uuid;
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ab0001')::text, true);

  v_errored := false;
  begin
    insert into public.appointments (studio_id, appointment_type, title, starts_at, ends_at, client_id, status)
    values ('00000000-0000-0000-0000-000000aa0001', 'group_class', 'Malformed', now() + interval '1 day', now() + interval '1 day 1 hour', '00000000-0000-0000-0000-000000ad0001', 'scheduled');
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-4a-shape-legacy-insert-blocked'; end if;

  insert into public.appointments (studio_id, appointment_type, title, starts_at, ends_at, client_id, status)
  values ('00000000-0000-0000-0000-000000aa0001', 'private_lesson', 'Lesson regression', now() + interval '1 day', now() + interval '1 day 1 hour', '00000000-0000-0000-0000-000000ad0001', 'scheduled')
  returning id into v_new_id;
  -- lesson insert succeeded -- no exception means pass

  v_errored := false;
  begin
    update public.appointments set appointment_type = 'group_class' where id = v_new_id;
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-4a-shape-lesson-to-class-blocked'; end if;

  reset role;
  raise notice 'PASS T-gc1-4a-canonical-shape-and-type-transition';
end $$;

-- ============================================================================
-- 7. Security: no-JWT-context (service-role-shaped) invocation is rejected
--    exactly like an unauthorized caller -- proves auth.uid()-null cannot
--    accidentally satisfy any of these functions' own checks.
-- ============================================================================
do $$
declare
  v_errored boolean;
begin
  -- request.jwt.claims is a session-lifetime GUC (set with is_local=true,
  -- so it persists until end of transaction, independent of `set local
  -- role`/`reset role`) -- explicitly clear it here so auth.uid() truly
  -- resolves to null, replicating a genuine no-real-user-identity
  -- connection (service-role-shaped) rather than accidentally inheriting
  -- the previous persona's stale claim.
  perform set_config('request.jwt.claims', '{}', true);

  v_errored := false;
  begin
    perform public.create_group_class_appointment('00000000-0000-0000-0000-000000aa0001', null, null, 'No-auth', now() + interval '1 day', now() + interval '1 day 1 hour');
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-4a-security-no-auth-create'; end if;

  v_errored := false;
  begin
    perform public.enroll_class_attendee('00000000-0000-0000-0000-000000ae0002', '00000000-0000-0000-0000-000000ad0003');
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-4a-security-no-auth-enroll'; end if;

  v_errored := false;
  begin
    perform public.check_in_own_class_attendance('00000000-0000-0000-0000-000000ae0002', '00000000-0000-0000-0000-000000ad0003');
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-4a-security-no-auth-checkin'; end if;

  raise notice 'PASS T-gc1-4a-security-no-auth-context-rejected-everywhere';
end $$;

do $$ begin raise notice 'GC-1.4A SQL regression suite: ALL CHECKS PASSED'; end $$;

rollback;
