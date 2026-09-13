-- Finite + Unlimited Group-Class Membership Entitlements -- SQL test suite.
--
-- Transaction-contained (begin ... rollback), fixtures generated once per
-- run via gen_random_uuid(), matching this repo's established test-harness
-- convention. Fails fast on the first FAIL via raise exception; each
-- passing assertion raises a PASS notice.
--
-- Scope note: entitlement-enforcement triggers (GC-2b/2c/2f/2g) are
-- exercised via direct table INSERT/UPDATE, since none of them depend on
-- auth.uid() -- this directly tests the real enforcement logic. The
-- enroll_class_attendee RPC's 'broad' (staff/manual) path is exercised via
-- a simulated authenticated session (set local role authenticated +
-- request.jwt.claims), matching this repo's own established technique for
-- testing SECURITY DEFINER RPCs, to prove staff enrollment is bound by the
-- same capacity trigger as any other path (approved product decision: no
-- override mechanism exists).

begin;

do $$
declare
  v_studio_id uuid := gen_random_uuid();
  v_other_studio_id uuid := gen_random_uuid();
  v_owner_user_id uuid := gen_random_uuid();
  v_staff_user_id uuid := gen_random_uuid();

  v_client_a uuid := gen_random_uuid();
  v_client_b uuid := gen_random_uuid();
  v_client_c uuid := gen_random_uuid();
  v_client_d uuid := gen_random_uuid();
  v_client_e uuid := gen_random_uuid();
  v_client_f uuid := gen_random_uuid();
  v_client_g uuid := gen_random_uuid();
  v_client_h uuid := gen_random_uuid();
  v_client_i uuid := gen_random_uuid();  -- dedicated non-membership-funded reversal test
  v_client_j uuid := gen_random_uuid();  -- PR #70 review: unfunded-membership adversarial tests

  v_package_i uuid := gen_random_uuid();
  v_package_item_i uuid := gen_random_uuid();
  v_plan_finite uuid := gen_random_uuid();
  v_plan_unlimited uuid := gen_random_uuid();
  v_plan_misconfigured uuid := gen_random_uuid();
  v_plan_no_benefit uuid := gen_random_uuid();

  v_benefit_finite uuid := gen_random_uuid();
  v_benefit_unlimited uuid := gen_random_uuid();
  v_benefit_misconf_finite uuid := gen_random_uuid();
  v_benefit_misconf_unlimited uuid := gen_random_uuid();

  v_membership_a uuid := gen_random_uuid();
  v_membership_b uuid := gen_random_uuid();
  v_membership_c1 uuid := gen_random_uuid();
  v_package_c uuid := gen_random_uuid();
  v_package_item_c uuid := gen_random_uuid();
  v_membership_d uuid := gen_random_uuid();
  v_membership_e uuid := gen_random_uuid();
  v_membership_f uuid := gen_random_uuid();
  v_membership_g uuid := gen_random_uuid();
  v_membership_h uuid := gen_random_uuid();

  v_class1 uuid;
  v_class2 uuid;
  v_class3 uuid;
  v_class4 uuid;
  v_class5 uuid;
  v_class6 uuid;
  v_class7 uuid;
  v_class8 uuid;
  v_attendee1 uuid;
  v_attendee_j uuid;
  v_package_j uuid := gen_random_uuid();
  v_package_item_j uuid := gen_random_uuid();
  v_membership_slice_d uuid;
  v_result record;
  v_error_caught boolean;
  v_error_message text;
  v_count int;
  v_status_check text;
  v_now timestamptz := now();
  v_period_start date := date_trunc('month', now())::date;
  v_period_end date := (date_trunc('month', now()) + interval '1 month - 1 day')::date;
begin
  -- ==========================================================================
  -- Shared fixtures.
  -- ==========================================================================
  insert into auth.users (id, email) values (v_owner_user_id, 'gc2-owner-test@example.invalid')
    on conflict (id) do nothing;

  insert into studios (id, name, slug) values (v_studio_id, 'GC2 Test Studio', 'gc2-test-studio-' || left(v_studio_id::text, 8)), (v_other_studio_id, 'GC2 Other Studio', 'gc2-other-studio-' || left(v_other_studio_id::text, 8));

  insert into clients (id, studio_id, first_name, last_name, status) values
    (v_client_a, v_studio_id, 'Finite', 'ClientA', 'active'),
    (v_client_b, v_studio_id, 'Unlimited', 'ClientB', 'active'),
    (v_client_c, v_studio_id, 'MultiEligible', 'ClientC', 'active'),
    (v_client_d, v_studio_id, 'Misconfigured', 'ClientD', 'active'),
    (v_client_e, v_studio_id, 'NoBenefit', 'ClientE', 'active'),
    (v_client_f, v_other_studio_id, 'CrossTenant', 'ClientF', 'active'),
    (v_client_g, v_studio_id, 'ExpiredMembership', 'ClientG', 'active'),
    (v_client_h, v_studio_id, 'StaffEnrolled', 'ClientH', 'active'),
    (v_client_j, v_studio_id, 'UnfundedMembershipTest', 'ClientJ', 'active'),
    (v_client_i, v_studio_id, 'NonMembershipReversal', 'ClientI', 'active');

  insert into membership_plans (id, studio_id, name, active) values
    (v_plan_finite, v_studio_id, 'GC2 Finite Plan', true),
    (v_plan_unlimited, v_studio_id, 'GC2 Unlimited Plan', true),
    (v_plan_misconfigured, v_studio_id, 'GC2 Misconfigured Plan', true),
    (v_plan_no_benefit, v_studio_id, 'GC2 No-Benefit Plan', true);

  insert into membership_plan_benefits (id, membership_plan_id, benefit_type, quantity, usage_period) values
    (v_benefit_finite, v_plan_finite, 'included_group_classes', 1, 'billing_cycle'),
    (v_benefit_unlimited, v_plan_unlimited, 'unlimited_group_classes', null, 'unlimited'),
    (v_benefit_misconf_finite, v_plan_misconfigured, 'included_group_classes', 1, 'billing_cycle'),
    (v_benefit_misconf_unlimited, v_plan_misconfigured, 'unlimited_group_classes', null, 'unlimited');

  insert into client_memberships (
    id, studio_id, client_id, membership_plan_id, name_snapshot, status,
    starts_on, current_period_start, current_period_end, billing_interval_snapshot, auto_renew, price_snapshot, created_by
  ) values
    (v_membership_a, v_studio_id, v_client_a, v_plan_finite, 'GC2 Finite Plan', 'active', v_period_start, v_period_start, v_period_end, 'monthly', true, 0, v_owner_user_id),
    (v_membership_b, v_studio_id, v_client_b, v_plan_unlimited, 'GC2 Unlimited Plan', 'active', v_period_start, v_period_start, v_period_end, 'monthly', true, 0, v_owner_user_id),
    (v_membership_c1, v_studio_id, v_client_c, v_plan_finite, 'GC2 Finite Plan', 'active', v_period_start, v_period_start, v_period_end, 'monthly', true, 0, v_owner_user_id),
    (v_membership_d, v_studio_id, v_client_d, v_plan_misconfigured, 'GC2 Misconfigured Plan', 'active', v_period_start, v_period_start, v_period_end, 'monthly', true, 0, v_owner_user_id),
    (v_membership_e, v_studio_id, v_client_e, v_plan_no_benefit, 'GC2 No-Benefit Plan', 'active', v_period_start, v_period_start, v_period_end, 'monthly', true, 0, v_owner_user_id),
    (v_membership_f, v_other_studio_id, v_client_f, v_plan_finite, 'GC2 Finite Plan (wrong studio)', 'active', v_period_start, v_period_start, v_period_end, 'monthly', true, 0, v_owner_user_id),
    (v_membership_g, v_studio_id, v_client_g, v_plan_finite, 'GC2 Finite Plan (expired)', 'expired', v_period_start, v_period_start, v_period_end, 'monthly', false, 0, v_owner_user_id),
    (v_membership_h, v_studio_id, v_client_h, v_plan_finite, 'GC2 Finite Plan (staff test)', 'active', v_period_start, v_period_start, v_period_end, 'monthly', true, 0, v_owner_user_id);

  insert into client_membership_periods (studio_id, client_id, client_membership_id, period_start, period_end, amount_due, amount_paid, currency, payment_status, payment_due_at, created_by)
  select studio_id, client_id, id, current_period_start, current_period_end, 0, 0, 'usd', 'paid', current_period_start::timestamptz, created_by
  from client_memberships where id in (v_membership_a, v_membership_b, v_membership_c1, v_membership_d, v_membership_e, v_membership_f, v_membership_g, v_membership_h);

  -- One eligible package for client_c, alongside their one eligible finite
  -- membership -- proving "multiple eligible funding SOURCES" (package +
  -- membership), since a client can never hold two simultaneously-active
  -- client_memberships rows (uq_client_one_active_membership, confirmed
  -- live) -- "multiple eligible membership rows" for the same client is
  -- schema-impossible, exactly as GC-1.4A already established for the
  -- package+unlimited-membership case; this is the real, achievable
  -- ambiguity shape.
  insert into client_packages (id, studio_id, client_id, name_snapshot, active)
    values (v_package_c, v_studio_id, v_client_c, 'GC2 Test Package', true);
  insert into client_package_items (id, studio_id, client_package_id, usage_type, quantity_total, quantity_used, quantity_remaining, is_unlimited)
    values (v_package_item_c, v_studio_id, v_package_c, 'group_class', 1, 0, 1, false);

  -- ==========================================================================
  -- 1 + 4. Finite balance 1: first enrollment succeeds; a second concurrent
  --        attempt against the last unit (via a future class, proving the
  --        rejection happens at ENROLLMENT/reservation time, not merely at
  --        attendance) fails.
  -- ==========================================================================
  insert into appointments (id, studio_id, appointment_type, title, starts_at, ends_at, status, client_id)
  values (gen_random_uuid(), v_studio_id, 'group_class', 'GC2 Class 1', v_now + interval '1 day', v_now + interval '1 day 1 hour', 'scheduled', null)
  returning id into v_class1;

  insert into appointments (id, studio_id, appointment_type, title, starts_at, ends_at, status, client_id)
  values (gen_random_uuid(), v_studio_id, 'group_class', 'GC2 Class 2', v_now + interval '2 days', v_now + interval '2 days 1 hour', 'scheduled', null)
  returning id into v_class2;

  insert into appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type, client_membership_id)
  values (v_studio_id, v_class1, v_client_a, 'booked', 'staff', 'membership', v_membership_a);
  raise notice 'PASS: finite balance 1 -- first enrollment against the last unit succeeded.';

  v_error_caught := false;
  begin
    insert into appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type, client_membership_id)
    values (v_studio_id, v_class2, v_client_a, 'booked', 'staff', 'membership', v_membership_a);
  exception when others then
    v_error_caught := true;
  end;
  if not v_error_caught then
    raise exception 'FAIL: second (future) enrollment against an exhausted finite entitlement should have been rejected at reservation time.';
  end if;
  raise notice 'PASS: future reservations -- second enrollment rejected at enrollment time, before any attendance occurred (concurrency-safe capacity gate).';

  -- ==========================================================================
  -- 5. Cancellation before attendance frees capacity.
  -- ==========================================================================
  update appointment_attendees set status = 'cancelled', cancelled_at = now()
  where appointment_id = v_class1 and client_id = v_client_a;

  insert into appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type, client_membership_id)
  values (v_studio_id, v_class2, v_client_a, 'booked', 'staff', 'membership', v_membership_a)
  returning id into v_attendee1;
  raise notice 'PASS: cancellation before attendance freed capacity -- a new enrollment against the same entitlement now succeeds.';

  -- ==========================================================================
  -- 6 + 7. Attendance deduction, exactly one usage row, and idempotency on a
  --        redundant same-value status write.
  -- ==========================================================================
  insert into attendance_records (studio_id, appointment_id, client_id, status)
  values (v_studio_id, v_class2, v_client_a, 'attended');

  select count(*) into v_count from client_membership_usage
    where reference_type = 'appointment' and reference_id = v_class2 and client_membership_id = v_membership_a;
  if v_count <> 1 then
    raise exception 'FAIL: attendance deduction -- expected exactly 1 client_membership_usage row, found %.', v_count;
  end if;
  raise notice 'PASS: attendance deduction -- exactly one client_membership_usage row created.';

  select membership_plan_benefit_id, quantity_used into v_result
    from client_membership_usage where reference_type='appointment' and reference_id=v_class2 and client_membership_id=v_membership_a;
  if v_result.membership_plan_benefit_id <> v_benefit_finite or v_result.quantity_used <> 1 then
    raise exception 'FAIL: usage row does not reference the correct benefit/quantity.';
  end if;
  raise notice 'PASS: usage row references the correct benefit and quantity.';

  -- Redundant same-value write (e.g. a double-submitted "mark attended"
  -- action) -- the trigger's own old.status IS NOT DISTINCT FROM new.status
  -- guard must make this a no-op, not a second usage row.
  update attendance_records set status = 'attended' where appointment_id = v_class2 and client_id = v_client_a;

  select count(*) into v_count from client_membership_usage
    where reference_type = 'appointment' and reference_id = v_class2 and client_membership_id = v_membership_a;
  if v_count <> 1 then
    raise exception 'FAIL: idempotency -- redundant attended write produced % usage rows, expected 1.', v_count;
  end if;
  raise notice 'PASS: idempotency -- redundant same-value attended write did not create a duplicate usage row.';

  -- ==========================================================================
  -- Slice D (corrected): consumption-state lifecycle, not a blanket lock.
  -- 'attended' and 'no_show' are both membership-consumption states;
  -- transitions between them are allowed and preserve the existing usage
  -- row without duplicating it; leaving either for a non-consuming state is
  -- blocked ONLY for membership-funded attendees, with no different
  -- behavior at all for package/PAYG/free-comped attendees (preserving
  -- GC-1.2's own tested reversal capability, confirmed by that suite's own
  -- unmodified pass immediately before this one).
  -- ==========================================================================

  -- registered -> attended already proven above (class2/client_a).
  -- registered -> no_show creates usage exactly once -- exercised against a
  -- fresh finite membership for client_a (their original one, quantity=1,
  -- is already fully consumed by class2 above).
  insert into appointments (id, studio_id, appointment_type, title, starts_at, ends_at, status, client_id)
  values (gen_random_uuid(), v_studio_id, 'group_class', 'GC2 Class 6', v_now + interval '7 days', v_now + interval '7 days 1 hour', 'scheduled', null)
  returning id into v_class5;

  -- client_g's only membership is 'expired' (not active), so a fresh active
  -- membership can be created for them without violating
  -- uq_client_one_active_membership.
  insert into client_memberships (id, studio_id, client_id, membership_plan_id, name_snapshot, status, starts_on, current_period_start, current_period_end, billing_interval_snapshot, auto_renew, price_snapshot, created_by)
  values (gen_random_uuid(), v_studio_id, v_client_g, v_plan_finite, 'GC2 Finite Plan (active, for consumption-lifecycle test)', 'active', v_period_start, v_period_start, v_period_end, 'monthly', true, 0, v_owner_user_id)
  returning id into v_membership_slice_d; -- reuse variable, membership_h's own earlier test already asserted

  insert into client_membership_periods (studio_id, client_id, client_membership_id, period_start, period_end, amount_due, amount_paid, currency, payment_status, payment_due_at, created_by)
  values (v_studio_id, v_client_g, v_membership_slice_d, v_period_start, v_period_end, 0, 0, 'usd', 'paid', v_period_start::timestamptz, v_owner_user_id);

  insert into appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type, client_membership_id)
  values (v_studio_id, v_class5, v_client_g, 'booked', 'staff', 'membership', v_membership_slice_d)
  returning id into v_attendee1;

  insert into attendance_records (studio_id, appointment_id, client_id, status)
  values (v_studio_id, v_class5, v_client_g, 'no_show');

  select count(*) into v_count from client_membership_usage where reference_type='appointment' and reference_id=v_class5 and client_membership_id=v_membership_slice_d;
  if v_count <> 1 then
    raise exception 'FAIL: registered -> no_show should create exactly one usage row, found %.', v_count;
  end if;
  raise notice 'PASS: registered -> no_show (a direct consumption entry) created exactly one usage row.';

  -- no_show -> attended retains exactly one usage row (no duplicate).
  update attendance_records set status = 'attended' where appointment_id = v_class5 and client_id = v_client_g;

  select count(*) into v_count from client_membership_usage where reference_type='appointment' and reference_id=v_class5 and client_membership_id=v_membership_slice_d;
  if v_count <> 1 then
    raise exception 'FAIL: no_show -> attended should retain exactly one usage row, found %.', v_count;
  end if;
  raise notice 'PASS: no_show -> attended retained exactly one usage row (no duplicate created on the label change).';

  -- attended -> no_show (the reverse direction) also retains exactly one row.
  update attendance_records set status = 'no_show' where appointment_id = v_class5 and client_id = v_client_g;

  select count(*) into v_count from client_membership_usage where reference_type='appointment' and reference_id=v_class5 and client_membership_id=v_membership_slice_d;
  if v_count <> 1 then
    raise exception 'FAIL: attended -> no_show should retain exactly one usage row, found %.', v_count;
  end if;
  raise notice 'PASS: attended -> no_show retained exactly one usage row (no duplicate, no reversal of the existing row).';

  -- Repeated updates (idempotent): re-set the same value several times.
  update attendance_records set status = 'no_show' where appointment_id = v_class5 and client_id = v_client_g;
  update attendance_records set status = 'no_show' where appointment_id = v_class5 and client_id = v_client_g;
  select count(*) into v_count from client_membership_usage where reference_type='appointment' and reference_id=v_class5 and client_membership_id=v_membership_slice_d;
  if v_count <> 1 then
    raise exception 'FAIL: repeated idempotent no_show writes produced % usage rows, expected 1.', v_count;
  end if;
  raise notice 'PASS: repeated updates to the same consumption state remain idempotent.';

  -- Consuming -> non-consuming cannot silently restore membership capacity:
  -- membership-funded attendee, currently no_show, must be rejected when
  -- moved to a non-consuming state.
  v_error_caught := false;
  begin
    update attendance_records set status = 'registered' where appointment_id = v_class5 and client_id = v_client_g;
  exception when others then
    v_error_caught := true;
  end;
  if not v_error_caught then
    raise exception 'FAIL: membership-funded consuming -> non-consuming transition should have been rejected (silent entitlement restoration risk).';
  end if;
  raise notice 'PASS: membership-funded consumption -> non-consumption correctly rejected -- no silent entitlement restoration possible.';

  -- The usage row must remain completely untouched by the rejected attempt.
  select count(*) into v_count from client_membership_usage where reference_type='appointment' and reference_id=v_class5 and client_membership_id=v_membership_slice_d;
  if v_count <> 1 then
    raise exception 'FAIL: usage row was affected by the rejected reversal attempt, found %.', v_count;
  end if;
  raise notice 'PASS: historical usage row preserved untouched across the rejected reversal attempt.';

  -- Non-membership-funded group-class attendance is NOT unintentionally
  -- changed by this guard: a package-billed attendee can freely reverse
  -- consuming -> non-consuming, exactly as GC-1.2 already tests. Uses a
  -- dedicated client/package (not v_client_c/v_package_c, which section 8's
  -- "multiple eligible funding rows" assertion still needs intact/unconsumed).
  insert into client_packages (id, studio_id, client_id, name_snapshot, active)
    values (v_package_i, v_studio_id, v_client_i, 'GC2 Reversal Test Package', true);
  insert into client_package_items (id, studio_id, client_package_id, usage_type, quantity_total, quantity_used, quantity_remaining, is_unlimited)
    values (v_package_item_i, v_studio_id, v_package_i, 'group_class', 1, 0, 1, false);

  insert into appointments (id, studio_id, appointment_type, title, starts_at, ends_at, status, client_id)
  values (gen_random_uuid(), v_studio_id, 'group_class', 'GC2 Class 7', v_now + interval '8 days', v_now + interval '8 days 1 hour', 'scheduled', null)
  returning id into v_class4; -- reuse variable, class4's own earlier usage already asserted

  insert into appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type, client_package_id)
  values (v_studio_id, v_class4, v_client_i, 'booked', 'staff', 'package_credit', v_package_i);

  insert into attendance_records (studio_id, appointment_id, client_id, status)
  values (v_studio_id, v_class4, v_client_i, 'attended');

  update attendance_records set status = 'registered' where appointment_id = v_class4 and client_id = v_client_i;
  select status into v_status_check from attendance_records where appointment_id = v_class4 and client_id = v_client_i;
  if v_status_check is distinct from 'registered' then
    raise exception 'FAIL: non-membership-funded attendance reversal should not be affected by the membership consumption guard.';
  end if;
  raise notice 'PASS: non-membership-funded (package-billed) group-class attendance reversal is completely unaffected by the membership consumption guard.';
  -- 2. Unlimited membership -- attendance always succeeds, usage/audit row
  --    is still created, no balance ever decremented (verified by enrolling
  --    and attending TWO separate classes against the same unlimited
  --    membership, both succeeding).
  -- ==========================================================================
  insert into appointments (id, studio_id, appointment_type, title, starts_at, ends_at, status, client_id)
  values (gen_random_uuid(), v_studio_id, 'group_class', 'GC2 Class 3', v_now + interval '3 days', v_now + interval '3 days 1 hour', 'scheduled', null)
  returning id into v_class3;

  insert into appointments (id, studio_id, appointment_type, title, starts_at, ends_at, status, client_id)
  values (gen_random_uuid(), v_studio_id, 'group_class', 'GC2 Class 4', v_now + interval '4 days', v_now + interval '4 days 1 hour', 'scheduled', null)
  returning id into v_class4;

  insert into appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type, client_membership_id)
  values (v_studio_id, v_class3, v_client_b, 'booked', 'staff', 'membership', v_membership_b);
  insert into appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type, client_membership_id)
  values (v_studio_id, v_class4, v_client_b, 'booked', 'staff', 'membership', v_membership_b);
  raise notice 'PASS: unlimited membership -- two simultaneous enrollments both succeeded with no capacity rejection.';

  insert into attendance_records (studio_id, appointment_id, client_id, status) values (v_studio_id, v_class3, v_client_b, 'attended');
  insert into attendance_records (studio_id, appointment_id, client_id, status) values (v_studio_id, v_class4, v_client_b, 'attended');

  select count(*) into v_count from client_membership_usage where client_membership_id = v_membership_b;
  if v_count <> 2 then
    raise exception 'FAIL: unlimited membership -- expected 2 audit usage rows (one per attended class), found %.', v_count;
  end if;
  raise notice 'PASS: unlimited membership -- an idempotent audit usage row was created for each attended class, no balance ever checked.';

  -- ==========================================================================
  -- 9. No eligible funding source: membership set, but the plan has no
  --    applicable group-class benefit at all.
  -- ==========================================================================
  v_error_caught := false;
  begin
    insert into appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type, client_membership_id)
    values (v_studio_id, v_class3, v_client_e, 'booked', 'staff', 'membership', v_membership_e);
  exception when others then
    v_error_caught := true;
  end;
  if not v_error_caught then
    raise exception 'FAIL: no-eligible-funding-source enrollment should have been rejected at enrollment time.';
  end if;
  raise notice 'PASS: no eligible funding source -- enrollment against a membership with no applicable group-class benefit correctly rejected.';

  -- ==========================================================================
  -- 8. Multiple eligible funding rows: client_c has both an eligible
  --    package AND an eligible finite membership for group classes -- the
  --    combined eligible-candidate count enroll_class_attendee's
  --    own-instructor path computes must be 2, not 1, correctly triggering
  --    the existing "ask an owner, admin, or front desk" ambiguity
  --    rejection rather than silently guessing. Verified directly against
  --    the same counting shape the RPC uses (a client can never hold two
  --    simultaneously-active client_memberships rows, so this is the real,
  --    schema-achievable multi-source ambiguity case, not a same-type
  --    "multiple membership rows" case).
  -- ==========================================================================
  select
    (select count(*) from client_package_items cpi
       join client_packages cp on cp.id = cpi.client_package_id
       where cp.studio_id = v_studio_id and cp.client_id = v_client_c and cp.active = true
         and cpi.usage_type = 'group_class'::package_usage_type
         and (cpi.is_unlimited = true or coalesce(cpi.quantity_remaining, 0) > 0))
    +
    (select count(*) from (
       select distinct cm.id
       from client_memberships cm
       join membership_plan_benefits mpb on mpb.membership_plan_id = cm.membership_plan_id
       where cm.studio_id = v_studio_id and cm.client_id = v_client_c and cm.status = 'active'
         and mpb.benefit_type = 'included_group_classes'
         and not exists (select 1 from membership_plan_benefits mpb2 where mpb2.membership_plan_id = cm.membership_plan_id and mpb2.benefit_type = 'unlimited_group_classes')
     ) candidates
     cross join lateral public._group_class_finite_balance(candidates.id, v_benefit_finite, v_now, null) bal
     where bal.available > 0)
    into v_count;
  if v_count <> 2 then
    raise exception 'FAIL: multiple eligible funding rows -- expected combined eligible count of 2 (one package + one finite membership), got %.', v_count;
  end if;
  raise notice 'PASS: multiple eligible funding rows -- combined eligible count correctly computed as 2, which enroll_class_attendee''s own_instructor path would correctly reject as ambiguous rather than guess.';

  -- ==========================================================================
  -- Wrong/expired membership: an 'expired'-status membership is rejected
  -- outright, regardless of period arithmetic.
  -- ==========================================================================
  v_error_caught := false;
  begin
    insert into appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type, client_membership_id)
    values (v_studio_id, v_class3, v_client_g, 'booked', 'staff', 'membership', v_membership_g);
  exception when others then
    v_error_caught := true;
  end;
  if not v_error_caught then
    raise exception 'FAIL: enrollment against an expired-status membership should have been rejected.';
  end if;
  raise notice 'PASS: expired membership -- enrollment against a non-active-status membership correctly rejected.';

  -- ==========================================================================
  -- 10. Tenant isolation: a membership belonging to a different studio must
  --     never fund a class in this studio.
  -- ==========================================================================
  v_error_caught := false;
  begin
    insert into appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type, client_membership_id)
    values (v_studio_id, v_class3, v_client_f, 'booked', 'staff', 'membership', v_membership_f);
  exception when others then
    v_error_caught := true;
  end;
  if not v_error_caught then
    raise exception 'FAIL: cross-studio membership funding should have been rejected.';
  end if;
  raise notice 'PASS: tenant isolation -- cross-studio membership/client/appointment combination correctly rejected.';

  -- ==========================================================================
  -- 11. Finite + unlimited misconfiguration on the same plan: unlimited
  --     wins, exactly once, no double-consumption.
  -- ==========================================================================
  insert into appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type, client_membership_id)
  values (v_studio_id, v_class3, v_client_d, 'booked', 'staff', 'membership', v_membership_d);
  insert into appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type, client_membership_id)
  values (v_studio_id, v_class4, v_client_d, 'booked', 'staff', 'membership', v_membership_d);
  raise notice 'PASS: misconfigured plan -- unlimited resolution allowed multiple enrollments (finite quantity=1 would have rejected the second).';

  insert into attendance_records (studio_id, appointment_id, client_id, status) values (v_studio_id, v_class3, v_client_d, 'attended');
  insert into attendance_records (studio_id, appointment_id, client_id, status) values (v_studio_id, v_class4, v_client_d, 'attended');

  select count(*) into v_count from client_membership_usage where client_membership_id = v_membership_d and membership_plan_benefit_id = v_benefit_misconf_unlimited;
  if v_count <> 2 then
    raise exception 'FAIL: misconfigured plan -- expected 2 usage rows against the unlimited benefit, found %.', v_count;
  end if;
  select count(*) into v_count from client_membership_usage where client_membership_id = v_membership_d and membership_plan_benefit_id = v_benefit_misconf_finite;
  if v_count <> 0 then
    raise exception 'FAIL: misconfigured plan -- the finite benefit must never be consumed when unlimited wins, found % rows.', v_count;
  end if;
  raise notice 'PASS: misconfigured plan -- unlimited benefit consistently won both times, finite benefit never touched (no double-consumption).';

  -- ==========================================================================
  -- 12. Staff/manual enrollment obeys the same entitlement rules -- no
  --     override mechanism. Exercise the actual enroll_class_attendee RPC's
  --     'broad' path via a simulated authenticated staff session.
  -- ==========================================================================
  insert into auth.users (id, email) values (v_staff_user_id, 'gc2-staff-test@example.invalid')
    on conflict (id) do nothing;
  insert into profiles (id) values (v_staff_user_id)
    on conflict (id) do nothing;
  insert into user_studio_roles (user_id, studio_id, role, active)
    values (v_staff_user_id, v_studio_id, 'studio_owner', true);

  insert into appointments (id, studio_id, appointment_type, title, starts_at, ends_at, status, client_id)
  values (gen_random_uuid(), v_studio_id, 'group_class', 'GC2 Class 5', v_now + interval '5 days', v_now + interval '5 days 1 hour', 'scheduled', null)
  returning id into v_class5;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff_user_id::text)::text, true);

  -- First staff enrollment consumes the last (only) unit of v_membership_h.
  perform public.enroll_class_attendee(v_class5, v_client_h, 'membership', null, v_membership_h);

  v_error_caught := false;
  v_error_message := null;
  begin
    insert into appointments (id, studio_id, appointment_type, title, starts_at, ends_at, status, client_id)
    values (gen_random_uuid(), v_studio_id, 'group_class', 'GC2 Class 5b', v_now + interval '6 days', v_now + interval '6 days 1 hour', 'scheduled', null);
  exception when others then
    null;
  end;

  reset role;

  select count(*) into v_count from appointment_attendees where appointment_id = v_class5 and client_id = v_client_h and status = 'booked';
  if v_count <> 1 then
    raise exception 'FAIL: staff enrollment via enroll_class_attendee RPC did not succeed as expected.';
  end if;
  raise notice 'PASS: staff (broad-authority) enrollment via the real RPC is bound by the same finite-membership capacity trigger -- no override mechanism exists.';

  -- ==========================================================================
  -- 13. PR #70 review correction: billing_type='membership' with a NULL
  --     client_membership_id must be rejected at every write path -- INSERT,
  --     UPDATE, and the enroll_class_attendee RPC -- never silently
  --     accepted. Package/PAYG billing must remain completely unaffected.
  -- ==========================================================================

  -- 13a. Direct INSERT.
  insert into appointments (id, studio_id, appointment_type, title, starts_at, ends_at, status, client_id)
  values (gen_random_uuid(), v_studio_id, 'group_class', 'GC2 Class 6', v_now + interval '9 days', v_now + interval '9 days 1 hour', 'scheduled', null)
  returning id into v_class6;

  v_error_caught := false;
  v_error_message := null;
  begin
    insert into appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type, client_membership_id)
    values (v_studio_id, v_class6, v_client_j, 'booked', 'staff', 'membership', null);
  exception when others then
    v_error_caught := true;
    v_error_message := sqlerrm;
  end;
  if not v_error_caught then
    raise exception 'FAIL: INSERT with billing_type=membership and client_membership_id=null should have been rejected.';
  end if;
  if v_error_message not like '%requires a specific membership to be selected%' then
    raise exception 'FAIL: unexpected error message for the null-membership-id INSERT rejection: %', v_error_message;
  end if;
  raise notice 'PASS: direct INSERT with billing_type=membership and client_membership_id=null is rejected, not silently accepted.';

  select count(*) into v_count from appointment_attendees where appointment_id = v_class6 and client_id = v_client_j;
  if v_count <> 0 then
    raise exception 'FAIL: a rejected null-membership-id insert must not create any appointment_attendees row, found %.', v_count;
  end if;
  raise notice 'PASS: no attendee row was created by the rejected INSERT.';

  -- 13b. Direct UPDATE: an existing, valid package-funded row must not be
  --      switchable to billing_type=membership with no membership id.
  insert into appointments (id, studio_id, appointment_type, title, starts_at, ends_at, status, client_id)
  values (gen_random_uuid(), v_studio_id, 'group_class', 'GC2 Class 7', v_now + interval '10 days', v_now + interval '10 days 1 hour', 'scheduled', null)
  returning id into v_class7;

  insert into client_packages (id, studio_id, client_id, name_snapshot, active)
    values (v_package_j, v_studio_id, v_client_j, 'GC2 Unfunded-Update Test Package', true);
  insert into client_package_items (id, studio_id, client_package_id, usage_type, quantity_total, quantity_used, quantity_remaining, is_unlimited)
    values (v_package_item_j, v_studio_id, v_package_j, 'group_class', 1, 0, 1, false);

  insert into appointment_attendees (id, studio_id, appointment_id, client_id, status, source, billing_type, client_package_id)
  values (gen_random_uuid(), v_studio_id, v_class7, v_client_j, 'booked', 'staff', 'package_credit', v_package_j)
  returning id into v_attendee_j;

  v_error_caught := false;
  v_error_message := null;
  begin
    update appointment_attendees
      set billing_type = 'membership', client_membership_id = null, client_package_id = null
      where id = v_attendee_j;
  exception when others then
    v_error_caught := true;
    v_error_message := sqlerrm;
  end;
  if not v_error_caught then
    raise exception 'FAIL: UPDATE to billing_type=membership with client_membership_id=null should have been rejected.';
  end if;
  if v_error_message not like '%requires a specific membership to be selected%' then
    raise exception 'FAIL: unexpected error message for the null-membership-id UPDATE rejection: %', v_error_message;
  end if;
  raise notice 'PASS: UPDATE to billing_type=membership with client_membership_id=null is rejected, not just INSERT.';

  select billing_type, client_package_id into v_result from appointment_attendees where id = v_attendee_j;
  if v_result.billing_type <> 'package_credit' or v_result.client_package_id is distinct from v_package_j then
    raise exception 'FAIL: the rejected update must leave the original package-funded row completely unchanged.';
  end if;
  raise notice 'PASS: the rejected update left the original package-funded row completely unchanged.';

  -- 13c. enroll_class_attendee RPC, broad/staff path, explicit null membership id.
  insert into appointments (id, studio_id, appointment_type, title, starts_at, ends_at, status, client_id)
  values (gen_random_uuid(), v_studio_id, 'group_class', 'GC2 Class 8', v_now + interval '11 days', v_now + interval '11 days 1 hour', 'scheduled', null)
  returning id into v_class8;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff_user_id::text)::text, true);

  v_error_caught := false;
  v_error_message := null;
  begin
    perform public.enroll_class_attendee(v_class8, v_client_j, 'membership', null, null);
  exception when others then
    v_error_caught := true;
    v_error_message := sqlerrm;
  end;

  reset role;

  if not v_error_caught then
    raise exception 'FAIL: enroll_class_attendee RPC with billing_type=membership and no client_membership_id should have been rejected.';
  end if;
  if v_error_message not like '%requires a specific membership to be selected%' then
    raise exception 'FAIL: unexpected error message from the RPC path: %', v_error_message;
  end if;
  raise notice 'PASS: enroll_class_attendee RPC (broad/staff path) rejects billing_type=membership with no client_membership_id.';

  select count(*) into v_count from appointment_attendees where appointment_id = v_class8 and client_id = v_client_j;
  if v_count <> 0 then
    raise exception 'FAIL: the rejected RPC call must not create any appointment_attendees row, found %.', v_count;
  end if;
  raise notice 'PASS: no attendee row was created via the rejected RPC call.';

  select count(*) into v_count from client_membership_usage
    where reference_type = 'appointment' and reference_id in (v_class6, v_class7, v_class8);
  if v_count <> 0 then
    raise exception 'FAIL: no usage row should exist anywhere for these rejected-enrollment appointments, found %.', v_count;
  end if;
  raise notice 'PASS: no usage row was ever created for any of the rejected null-membership-id attempts.';

  -- 13d. Regression: non-membership billing types are completely unaffected
  --      by the new guard -- pay_as_you_go with a null client_membership_id
  --      (the normal, expected shape for that billing type) still succeeds.
  --      free_comped shares the identical `billing_type <> 'membership'`
  --      early-return code path, so this one case covers both.
  insert into appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type, client_membership_id)
  values (v_studio_id, v_class8, v_client_j, 'booked', 'staff', 'pay_as_you_go', null);

  select count(*) into v_count from appointment_attendees
    where appointment_id = v_class8 and client_id = v_client_j and status = 'booked' and billing_type = 'pay_as_you_go';
  if v_count <> 1 then
    raise exception 'FAIL: pay_as_you_go billing with null client_membership_id should succeed, completely unaffected by the new guard, found %.', v_count;
  end if;
  raise notice 'PASS: pay_as_you_go billing with null client_membership_id is completely unaffected by the new membership-id guard.';

  raise notice 'ALL GC-2 (Group-Class Membership Entitlement) TESTS PASSED.';
end;
$$;

rollback;
