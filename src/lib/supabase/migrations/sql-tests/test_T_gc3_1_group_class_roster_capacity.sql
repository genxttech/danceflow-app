-- GC-3.1 -- canonical group-class roster capacity invariant, live-Postgres
-- regression suite.
--
-- Proves, at the real Postgres level (not mocked), that appointments.
-- roster_capacity's type-scoping, _group_class_roster_reserved_count, and
-- enforce_group_class_roster_capacity all behave exactly as designed --
-- across staff, instructor, and mixed-billing enrollment paths, with no
-- bypass. Entire script runs in one transaction and is rolled back at the
-- end -- nothing persists. Run via `supabase db query --linked --file
-- <this file>` against DEV, AFTER 20260913090800 has been applied.
--
-- Note on the "concurrent attempts" requirement: this repo's established
-- SQL-test harness runs everything inside a single transaction (see
-- GC-1.4A's and GC-2's own suites), so a genuine two-connection race cannot
-- be expressed here -- sequential attempts against a since-exhausted seat
-- are used as the same proxy this repo's own GC-2 suite already uses for
-- "concurrent". The trigger's `for update` row lock (which is what would
-- actually serialize two real concurrent transactions) was additionally
-- exercised against DEV with two genuinely parallel connections outside
-- this file; see the GC-3.1 implementation report for that result.
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-000000c0XXXX (studios)
-- 00000000-0000-0000-0000-000000c1XXXX (auth.users/profiles)
-- 00000000-0000-0000-0000-000000c2XXXX (instructors)
-- 00000000-0000-0000-0000-000000c3XXXX (clients)
-- 00000000-0000-0000-0000-000000c4XXXX (appointments)
-- 00000000-0000-0000-0000-000000c5XXXX (client_packages / items)
-- 00000000-0000-0000-0000-000000c6XXXX (membership_plans / benefits / client_memberships)

begin;

-- ============================================================================
-- 0. Pre-flight: the migration is purely additive -- no pre-existing row
--    anywhere retroactively gained a non-null roster_capacity.
-- ============================================================================
do $$
declare
  v_bad_count int;
begin
  select count(*) into v_bad_count from public.appointments where roster_capacity is not null;
  if v_bad_count <> 0 then
    raise exception 'FAIL T-gc3-1-preflight-no-retroactive-capacity: expected 0 pre-existing rows with a non-null roster_capacity, got %', v_bad_count;
  end if;
  raise notice 'PASS T-gc3-1-preflight-no-retroactive-capacity';
end $$;

-- ============================================================================
-- FIXTURES
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-000000c00001', 'GC-3.1 Harness Studio', 't-gc3-1-studio');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000c10001', 't-gc3-1-owner@example.test'),
  ('00000000-0000-0000-0000-000000c10002', 't-gc3-1-instructor@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-000000c10001', 't-gc3-1-owner@example.test', null),
  ('00000000-0000-0000-0000-000000c10002', 't-gc3-1-instructor@example.test', null);

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-000000c10001', '00000000-0000-0000-0000-000000c00001', 'studio_owner', true),
  ('00000000-0000-0000-0000-000000c10002', '00000000-0000-0000-0000-000000c00001', 'instructor', true);

insert into public.instructors (id, studio_id, user_id, first_name, last_name, active) values
  ('00000000-0000-0000-0000-000000c20001', '00000000-0000-0000-0000-000000c00001', '00000000-0000-0000-0000-000000c10002', 'Assigned', 'Instructor', true);

insert into public.clients (id, studio_id, first_name, last_name, status) values
  ('00000000-0000-0000-0000-000000c30001', '00000000-0000-0000-0000-000000c00001', 'Alpha', 'Client', 'active'),
  ('00000000-0000-0000-0000-000000c30002', '00000000-0000-0000-0000-000000c00001', 'Bravo', 'Client', 'active'),
  ('00000000-0000-0000-0000-000000c30003', '00000000-0000-0000-0000-000000c00001', 'Charlie', 'Client', 'active'),
  ('00000000-0000-0000-0000-000000c30004', '00000000-0000-0000-0000-000000c00001', 'Package', 'Client', 'active'),
  ('00000000-0000-0000-0000-000000c30005', '00000000-0000-0000-0000-000000c00001', 'Membership', 'Client', 'active'),
  ('00000000-0000-0000-0000-000000c30006', '00000000-0000-0000-0000-000000c00001', 'Delta', 'Client', 'active');

-- Package client: one unlimited group-class package -- deliberately
-- is_unlimited so it stays eligible across every scenario in this file
-- regardless of how many times it's used (enrollment never decrements it;
-- only GC-1.2's attendance-time deduction does, out of scope here).
insert into public.client_packages (id, studio_id, client_id, name_snapshot, active) values
  ('00000000-0000-0000-0000-000000c50001', '00000000-0000-0000-0000-000000c00001', '00000000-0000-0000-0000-000000c30004', 'T-gc3-1 Unlimited Package', true);
insert into public.client_package_items (id, studio_id, client_package_id, usage_type, quantity_total, quantity_used, quantity_remaining, is_unlimited) values
  ('00000000-0000-0000-0000-000000c50002', '00000000-0000-0000-0000-000000c00001', '00000000-0000-0000-0000-000000c50001', 'group_class', null, 0, null, true);

-- Membership client: one active membership with an unlimited group-class benefit.
insert into public.membership_plans (id, studio_id, name, active) values
  ('00000000-0000-0000-0000-000000c60001', '00000000-0000-0000-0000-000000c00001', 'T-gc3-1 Unlimited Group Class Plan', true);
insert into public.membership_plan_benefits (id, membership_plan_id, benefit_type, quantity, applies_to) values
  ('00000000-0000-0000-0000-000000c60002', '00000000-0000-0000-0000-000000c60001', 'unlimited_group_classes', null, 'group_class');
insert into public.client_memberships (
  id, studio_id, client_id, membership_plan_id, status, name_snapshot,
  starts_on, current_period_start, current_period_end, billing_interval_snapshot
) values (
  '00000000-0000-0000-0000-000000c60003', '00000000-0000-0000-0000-000000c00001', '00000000-0000-0000-0000-000000c30005', '00000000-0000-0000-0000-000000c60001',
  'active', 'T-gc3-1 Unlimited Group Class Plan', current_date, current_date, current_date + 30, 'monthly'
);

-- Group-class appointments, one per scenario, all assigned to the same
-- instructor so the instructor-path tests can use any of them.
insert into public.appointments (id, studio_id, instructor_id, appointment_type, status, starts_at, ends_at, roster_capacity) values
  ('00000000-0000-0000-0000-000000c40001', '00000000-0000-0000-0000-000000c00001', '00000000-0000-0000-0000-000000c20001', 'group_class', 'scheduled', now() + interval '1 day', now() + interval '1 day 1 hour', null),
  ('00000000-0000-0000-0000-000000c40002', '00000000-0000-0000-0000-000000c00001', '00000000-0000-0000-0000-000000c20001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', 1),
  ('00000000-0000-0000-0000-000000c40003', '00000000-0000-0000-0000-000000c00001', '00000000-0000-0000-0000-000000c20001', 'group_class', 'scheduled', now() + interval '3 days', now() + interval '3 days 1 hour', 1),
  ('00000000-0000-0000-0000-000000c40004', '00000000-0000-0000-0000-000000c00001', '00000000-0000-0000-0000-000000c20001', 'group_class', 'scheduled', now() + interval '4 days', now() + interval '4 days 1 hour', 1),
  ('00000000-0000-0000-0000-000000c40005', '00000000-0000-0000-0000-000000c00001', '00000000-0000-0000-0000-000000c20001', 'group_class', 'scheduled', now() + interval '5 days', now() + interval '5 days 1 hour', 1),
  ('00000000-0000-0000-0000-000000c40006', '00000000-0000-0000-0000-000000c00001', '00000000-0000-0000-0000-000000c20001', 'group_class', 'scheduled', now() + interval '6 days', now() + interval '6 days 1 hour', 1),
  ('00000000-0000-0000-0000-000000c40007', '00000000-0000-0000-0000-000000c00001', '00000000-0000-0000-0000-000000c20001', 'group_class', 'scheduled', now() + interval '7 days', now() + interval '7 days 1 hour', 1),
  ('00000000-0000-0000-0000-000000c40008', '00000000-0000-0000-0000-000000c00001', '00000000-0000-0000-0000-000000c20001', 'group_class', 'scheduled', now() + interval '8 days', now() + interval '8 days 1 hour', 2);

-- ============================================================================
-- 1. Non-group-class appointments reject a non-null roster_capacity; a
--    group_class row accepts one (and can be toggled back to unlimited).
-- ============================================================================
do $$
declare
  v_lesson_id uuid;
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000c10001')::text, true);

  v_errored := false;
  begin
    insert into public.appointments (studio_id, appointment_type, status, starts_at, ends_at, roster_capacity)
    values ('00000000-0000-0000-0000-000000c00001', 'private_lesson', 'scheduled', now() + interval '1 day', now() + interval '1 day 1 hour', 3);
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc3-1-shape-lesson-insert-with-capacity-blocked'; end if;

  -- Positive control: a plain lesson insert (no capacity) still succeeds.
  insert into public.appointments (studio_id, appointment_type, status, starts_at, ends_at)
  values ('00000000-0000-0000-0000-000000c00001', 'private_lesson', 'scheduled', now() + interval '1 day', now() + interval '1 day 1 hour')
  returning id into v_lesson_id;

  v_errored := false;
  begin
    update public.appointments set roster_capacity = 2 where id = v_lesson_id;
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc3-1-shape-lesson-update-with-capacity-blocked'; end if;

  reset role;
  raise notice 'PASS T-gc3-1-shape-non-group-class-rejects-capacity';
end $$;

do $$
declare
  v_capacity int;
begin
  -- c40002 was inserted directly (fixtures, above) with roster_capacity=1
  -- on a group_class row -- already proves the positive path at insert
  -- time. Confirm it can also be toggled to unlimited and to a different
  -- positive value via UPDATE, using c40002 before any enrollment activity
  -- touches it below -- restored to capacity=1 at the end, the fixture
  -- state section 3 below depends on.
  update public.appointments set roster_capacity = null where id = '00000000-0000-0000-0000-000000c40002';
  select roster_capacity into v_capacity from public.appointments where id = '00000000-0000-0000-0000-000000c40002';
  if v_capacity is not null then raise exception 'FAIL T-gc3-1-shape-group-class-toggle-null: expected null, got %', v_capacity; end if;

  update public.appointments set roster_capacity = 7 where id = '00000000-0000-0000-0000-000000c40002';
  select roster_capacity into v_capacity from public.appointments where id = '00000000-0000-0000-0000-000000c40002';
  if v_capacity <> 7 then raise exception 'FAIL T-gc3-1-shape-group-class-toggle-value: expected 7, got %', v_capacity; end if;

  update public.appointments set roster_capacity = 1 where id = '00000000-0000-0000-0000-000000c40002';

  raise notice 'PASS T-gc3-1-shape-group-class-roster-capacity-mutable';
end $$;

-- ============================================================================
-- 2. capacity NULL -> effectively unlimited; also exercises PAYG/package/
--    free-comped side by side (GC-1/GC-2 workflow-compatibility check).
-- ============================================================================
do $$
declare
  v_id1 uuid;
  v_id2 uuid;
  v_id3 uuid;
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000c10001')::text, true);

  v_id1 := public.enroll_class_attendee('00000000-0000-0000-0000-000000c40001', '00000000-0000-0000-0000-000000c30001', 'free_comped');
  v_id2 := public.enroll_class_attendee(
    '00000000-0000-0000-0000-000000c40001', '00000000-0000-0000-0000-000000c30004', 'package_credit', '00000000-0000-0000-0000-000000c50001'
  );
  v_id3 := public.enroll_class_attendee('00000000-0000-0000-0000-000000c40001', '00000000-0000-0000-0000-000000c30003', 'pay_as_you_go');

  select count(*) into v_count from public.appointment_attendees
    where appointment_id = '00000000-0000-0000-0000-000000c40001' and status = 'booked';
  if v_count <> 3 then raise exception 'FAIL T-gc3-1-unlimited-capacity: expected 3 booked attendees, got %', v_count; end if;

  reset role;
  raise notice 'PASS T-gc3-1-unlimited-capacity-mixed-billing-types';
end $$;

-- ============================================================================
-- 3. capacity 1 -> first enrollment succeeds, second fails.
-- ============================================================================
do $$
declare
  v_first_id uuid;
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000c10001')::text, true);

  v_first_id := public.enroll_class_attendee('00000000-0000-0000-0000-000000c40002', '00000000-0000-0000-0000-000000c30001', 'free_comped');
  if v_first_id is null then raise exception 'FAIL T-gc3-1-capacity-1-first-enrollment'; end if;

  v_errored := false;
  begin
    perform public.enroll_class_attendee('00000000-0000-0000-0000-000000c40002', '00000000-0000-0000-0000-000000c30002', 'free_comped');
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc3-1-capacity-1-second-enrollment-should-fail'; end if;

  reset role;
  raise notice 'PASS T-gc3-1-capacity-1-first-succeeds-second-fails';
end $$;

-- ============================================================================
-- 4. cancelled attendee frees capacity -- a subsequent enrollment succeeds
--    where it otherwise would not.
-- ============================================================================
do $$
declare
  v_first_id uuid;
  v_second_id uuid;
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000c10001')::text, true);

  v_first_id := public.enroll_class_attendee('00000000-0000-0000-0000-000000c40003', '00000000-0000-0000-0000-000000c30001', 'free_comped');

  -- While Alpha still holds the only seat, Bravo is rejected.
  v_errored := false;
  begin
    perform public.enroll_class_attendee('00000000-0000-0000-0000-000000c40003', '00000000-0000-0000-0000-000000c30002', 'free_comped');
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc3-1-cancel-frees-seat-precondition: Bravo should not have fit before the cancellation'; end if;

  perform public.cancel_class_attendee(v_first_id);

  -- Cancelled attendee no longer counts -- Bravo now fits.
  v_second_id := public.enroll_class_attendee('00000000-0000-0000-0000-000000c40003', '00000000-0000-0000-0000-000000c30002', 'free_comped');
  if v_second_id is null then raise exception 'FAIL T-gc3-1-cancel-frees-seat: enrollment after cancellation should have succeeded'; end if;

  reset role;
  raise notice 'PASS T-gc3-1-cancelled-attendee-frees-capacity';
end $$;

-- ============================================================================
-- 5. Update into a counting state respects capacity: a raw UPDATE that
--    flips an existing cancelled row back to 'booked' is gated exactly
--    like a fresh INSERT.
-- ============================================================================
do $$
declare
  v_alpha_id uuid;
  v_bravo_row_id uuid;
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000c10001')::text, true);

  v_alpha_id := public.enroll_class_attendee('00000000-0000-0000-0000-000000c40004', '00000000-0000-0000-0000-000000c30001', 'free_comped');

  -- Bravo's row starts life already-cancelled (inserted directly, not via
  -- enroll_class_attendee, which would itself reject it at capacity) --
  -- this is exactly the shape a staff-side "undo a mis-cancellation" edit
  -- would produce: an existing cancelled row, about to be flipped back.
  insert into public.appointment_attendees (
    studio_id, appointment_id, client_id, status, source, billing_type, cancelled_at, cancelled_by
  ) values (
    '00000000-0000-0000-0000-000000c00001', '00000000-0000-0000-0000-000000c40004', '00000000-0000-0000-0000-000000c30002',
    'cancelled', 'staff', 'free_comped', now(), '00000000-0000-0000-0000-000000c10001'
  ) returning id into v_bravo_row_id;

  -- Class is still full (Alpha booked) -- flipping Bravo's row from
  -- cancelled to booked must be rejected by the SAME capacity trigger a
  -- fresh INSERT would hit.
  v_errored := false;
  begin
    update public.appointment_attendees set status = 'booked', cancelled_at = null, cancelled_by = null where id = v_bravo_row_id;
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc3-1-update-into-counting-state-full: flipping cancelled->booked into a full class should have been rejected'; end if;

  -- Free Alpha's seat, then the identical UPDATE must now succeed.
  perform public.cancel_class_attendee(v_alpha_id);

  update public.appointment_attendees set status = 'booked', cancelled_at = null, cancelled_by = null where id = v_bravo_row_id;

  if (select status from public.appointment_attendees where id = v_bravo_row_id) <> 'booked' then
    raise exception 'FAIL T-gc3-1-update-into-counting-state-available: expected the row to be booked once a seat opened up';
  end if;

  reset role;
  raise notice 'PASS T-gc3-1-update-into-counting-state-respects-capacity';
end $$;

-- ============================================================================
-- 6. Staff path cannot bypass capacity.
-- ============================================================================
do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000c10001')::text, true);

  perform public.enroll_class_attendee('00000000-0000-0000-0000-000000c40005', '00000000-0000-0000-0000-000000c30001', 'free_comped');

  v_errored := false;
  begin
    perform public.enroll_class_attendee('00000000-0000-0000-0000-000000c40005', '00000000-0000-0000-0000-000000c30002', 'free_comped');
  exception when others then
    v_errored := true;
  end;

  reset role;
  if not v_errored then raise exception 'FAIL T-gc3-1-staff-cannot-bypass-capacity: broad staff enrollment into a full class was not rejected'; end if;
  raise notice 'PASS T-gc3-1-staff-path-cannot-bypass-capacity';
end $$;

-- ============================================================================
-- 7. Instructor path cannot bypass capacity (auto-resolved billing still
--    runs into the same trigger as everyone else).
-- ============================================================================
do $$
declare
  v_errored boolean;
begin
  -- Fill the only seat as broad staff first.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000c10001')::text, true);
  perform public.enroll_class_attendee('00000000-0000-0000-0000-000000c40006', '00000000-0000-0000-0000-000000c30001', 'free_comped');
  reset role;

  -- The assigned instructor tries to enroll the Package client (who has a
  -- genuinely eligible, unlimited package -- billing auto-resolution
  -- succeeds) into their own class -- still rejected, at the roster-write
  -- boundary, purely on capacity.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000c10002')::text, true);

  v_errored := false;
  begin
    perform public.enroll_class_attendee('00000000-0000-0000-0000-000000c40006', '00000000-0000-0000-0000-000000c30004');
  exception when others then
    v_errored := true;
  end;

  reset role;
  if not v_errored then raise exception 'FAIL T-gc3-1-instructor-cannot-bypass-capacity: assigned instructor enrolled a client into a full class'; end if;
  raise notice 'PASS T-gc3-1-instructor-path-cannot-bypass-capacity';
end $$;

-- ============================================================================
-- 8. Concurrent-attempts-for-the-final-seat proxy: two different actors
--    (staff, then the assigned instructor) race for the same single seat.
--    Exactly one succeeds -- see the file header for why this is a
--    sequential proxy rather than a genuine two-connection race, and where
--    the real lock-contention verification happened instead.
-- ============================================================================
do $$
declare
  v_staff_id uuid;
  v_errored boolean;
  v_booked_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000c10001')::text, true);
  v_staff_id := public.enroll_class_attendee('00000000-0000-0000-0000-000000c40007', '00000000-0000-0000-0000-000000c30001', 'free_comped');
  reset role;
  if v_staff_id is null then raise exception 'FAIL T-gc3-1-concurrent-final-seat-staff-attempt'; end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000c10002')::text, true);
  v_errored := false;
  begin
    perform public.enroll_class_attendee('00000000-0000-0000-0000-000000c40007', '00000000-0000-0000-0000-000000c30004');
  exception when others then
    v_errored := true;
  end;
  reset role;
  if not v_errored then raise exception 'FAIL T-gc3-1-concurrent-final-seat-second-attempt-should-fail'; end if;

  select count(*) into v_booked_count from public.appointment_attendees
    where appointment_id = '00000000-0000-0000-0000-000000c40007' and status = 'booked';
  if v_booked_count <> 1 then raise exception 'FAIL T-gc3-1-concurrent-final-seat-exactly-one: expected exactly 1 booked attendee, got %', v_booked_count; end if;

  raise notice 'PASS T-gc3-1-concurrent-final-seat-exactly-one-succeeds';
end $$;

-- ============================================================================
-- 9. Mixed billing types under a real (non-null) capacity -- package
--    credit and membership continue to behave correctly (GC-1.2/GC-2
--    workflow compatibility), and capacity is enforced identically
--    regardless of which billing type fills the seat.
-- ============================================================================
do $$
declare
  v_package_attendee uuid;
  v_membership_attendee uuid;
  v_errored boolean;
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000c10001')::text, true);

  v_package_attendee := public.enroll_class_attendee(
    '00000000-0000-0000-0000-000000c40008', '00000000-0000-0000-0000-000000c30004', 'package_credit', '00000000-0000-0000-0000-000000c50001'
  );
  v_membership_attendee := public.enroll_class_attendee(
    '00000000-0000-0000-0000-000000c40008', '00000000-0000-0000-0000-000000c30005', 'membership', null, '00000000-0000-0000-0000-000000c60003'
  );

  select count(*) into v_count from public.appointment_attendees
    where appointment_id = '00000000-0000-0000-0000-000000c40008' and status = 'booked';
  if v_count <> 2 then raise exception 'FAIL T-gc3-1-mixed-billing-capacity-2-both-succeed: expected 2 booked, got %', v_count; end if;

  -- Third attempt (any billing type) is rejected -- capacity 2, both seats taken.
  v_errored := false;
  begin
    perform public.enroll_class_attendee('00000000-0000-0000-0000-000000c40008', '00000000-0000-0000-0000-000000c30006', 'free_comped');
  exception when others then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc3-1-mixed-billing-capacity-2-third-fails: third enrollment should have been rejected'; end if;

  reset role;
  raise notice 'PASS T-gc3-1-mixed-billing-types-respect-shared-capacity';
end $$;

do $$ begin raise notice 'GC-3.1 SQL regression suite: ALL CHECKS PASSED'; end $$;

rollback;
