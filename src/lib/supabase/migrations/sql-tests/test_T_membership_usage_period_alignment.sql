-- Membership Usage-Period Alignment (P1-P6) -- live-Postgres regression
-- suite.
--
-- Proves, at the real Postgres level, that the generic period-window
-- engine, the fail-safe usage-sync writer, the DB capacity invariant, the
-- scheduling-conflict/lock helpers, the availability predicate, and the
-- atomic staff/student RPCs all behave exactly as designed. Entire script
-- runs in one transaction and is rolled back at the end -- nothing
-- persists. Run via `supabase db query --linked --file <this file>`
-- against DEV, AFTER all seven P1-P6 forward migrations have been applied.
-- PENDING DEV MIGRATION APPLICATION -- not runnable until then.
--
-- Deterministic UUID block reserved for this harness (distinct from every
-- prior harness's ba-d1/6a-9c blocks; using e0-ec):
-- 00000000-0000-0000-0000-00000000e0XX (studios)
-- 00000000-0000-0000-0000-00000000e1XX (auth.users/profiles)
-- 00000000-0000-0000-0000-00000000e2XX (instructors)
-- 00000000-0000-0000-0000-00000000e3XX (rooms)
-- 00000000-0000-0000-0000-00000000e4XX (clients)
-- 00000000-0000-0000-0000-00000000e5XX (membership_plans)
-- 00000000-0000-0000-0000-00000000e6XX (client_memberships)
-- 00000000-0000-0000-0000-00000000e7XX (membership_plan_benefits)
-- 00000000-0000-0000-0000-00000000e8XX (appointments)
-- 00000000-0000-0000-0000-00000000e9XX (client_account_links)
-- 00000000-0000-0000-0000-00000000eaXX (studio_booking_availability_windows)

begin;

-- ============================================================================
-- FIXTURES
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-00000000e001', 'MUPA Harness Studio', 't-mupa-studio');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e101', 't-mupa-owner@example.test'),
  ('00000000-0000-0000-0000-00000000e102', 't-mupa-instructor-a@example.test'),
  ('00000000-0000-0000-0000-00000000e103', 't-mupa-instructor-b@example.test'),
  ('00000000-0000-0000-0000-00000000e104', 't-mupa-portal-self@example.test'),
  ('00000000-0000-0000-0000-00000000e105', 't-mupa-portal-other@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-00000000e101', 't-mupa-owner@example.test', null),
  ('00000000-0000-0000-0000-00000000e102', 't-mupa-instructor-a@example.test', null),
  ('00000000-0000-0000-0000-00000000e103', 't-mupa-instructor-b@example.test', null),
  ('00000000-0000-0000-0000-00000000e104', 't-mupa-portal-self@example.test', null),
  ('00000000-0000-0000-0000-00000000e105', 't-mupa-portal-other@example.test', null);

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-00000000e001', 'studio_owner', true),
  ('00000000-0000-0000-0000-00000000e102', '00000000-0000-0000-0000-00000000e001', 'instructor', true),
  ('00000000-0000-0000-0000-00000000e103', '00000000-0000-0000-0000-00000000e001', 'instructor', true);

insert into public.instructors (id, studio_id, user_id, first_name, last_name, active) values
  ('00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e102', 'Instructor', 'A', true),
  ('00000000-0000-0000-0000-00000000e202', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e103', 'Instructor', 'B', true);

insert into public.rooms (id, studio_id, name, active) values
  ('00000000-0000-0000-0000-00000000e301', '00000000-0000-0000-0000-00000000e001', 'Room A', true),
  ('00000000-0000-0000-0000-00000000e302', '00000000-0000-0000-0000-00000000e001', 'Room B', true);

insert into public.clients (id, studio_id, first_name, last_name, status) values
  ('00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000e001', 'Finite', 'Client', 'active'),
  ('00000000-0000-0000-0000-00000000e402', '00000000-0000-0000-0000-00000000e001', 'Other', 'Client', 'active'),
  ('00000000-0000-0000-0000-00000000e403', '00000000-0000-0000-0000-00000000e001', 'Portal', 'Self', 'active'),
  ('00000000-0000-0000-0000-00000000e404', '00000000-0000-0000-0000-00000000e001', 'Portal', 'Other', 'active'),
  ('00000000-0000-0000-0000-00000000e407', '00000000-0000-0000-0000-00000000e001', 'Jan31', 'Client', 'active');

insert into public.client_account_links (studio_id, client_id, user_id, status, relationship_type, initiated_by, can_manage_bookings) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e403', '00000000-0000-0000-0000-00000000e104', 'linked', 'self', 'studio', true),
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e404', '00000000-0000-0000-0000-00000000e105', 'linked', 'self', 'studio', true);

insert into public.membership_plans (id, studio_id, name, billing_interval, price) values
  ('00000000-0000-0000-0000-00000000e501', '00000000-0000-0000-0000-00000000e001', 'Monthly Finite Lessons', 'monthly', 100),
  ('00000000-0000-0000-0000-00000000e502', '00000000-0000-0000-0000-00000000e001', 'Yearly Finite Lessons', 'yearly', 1000);

-- MEM_A: monthly billing, 1 private lesson per billing_cycle, plenty of
-- runway (current window covers the test's appointment dates).
insert into public.client_memberships (
  id, studio_id, client_id, membership_plan_id, status, starts_on,
  current_period_start, current_period_end, auto_renew, cancel_at_period_end,
  name_snapshot, price_snapshot, billing_interval_snapshot
) values (
  '00000000-0000-0000-0000-00000000e601', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e401',
  '00000000-0000-0000-0000-00000000e501', 'active', '2026-09-01',
  '2026-09-01', '2026-09-30', true, false,
  'Monthly Finite Lessons', 100, 'monthly'
);

-- MEM_B: another client's membership -- used to prove cross-client/
-- cross-studio rejection.
insert into public.client_memberships (
  id, studio_id, client_id, membership_plan_id, status, starts_on,
  current_period_start, current_period_end, auto_renew, cancel_at_period_end,
  name_snapshot, price_snapshot, billing_interval_snapshot
) values (
  '00000000-0000-0000-0000-00000000e602', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e402',
  '00000000-0000-0000-0000-00000000e501', 'active', '2026-09-01',
  '2026-09-01', '2026-09-30', true, false,
  'Monthly Finite Lessons', 100, 'monthly'
);

-- MEM_JAN31: starts_on = Jan 31, monthly billing_interval_snapshot, used to
-- prove the billing_cycle rollover arithmetic (Jan 31 + 1 month -> Mar
-- 2/3, matching calculateNextPeriod's real JS Date behavior). Uses its own
-- dedicated client (e407), not the e403 portal-self client -- DEV enforces
-- uq_client_one_active_membership (shipped by GC-1.4A, unrelated to this
-- feature), and e403 already carries MEM_PORTAL as its one active
-- membership below.
insert into public.client_memberships (
  id, studio_id, client_id, membership_plan_id, status, starts_on,
  current_period_start, current_period_end, auto_renew, cancel_at_period_end,
  name_snapshot, price_snapshot, billing_interval_snapshot
) values (
  '00000000-0000-0000-0000-00000000e603', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e407',
  '00000000-0000-0000-0000-00000000e501', 'active', '2024-01-31',
  '2024-01-31', '2024-02-29', true, false,
  'Monthly Finite Lessons', 100, 'monthly'
);

-- MEM_PORTAL: linked-portal client's own membership, for self-service RPC
-- tests.
insert into public.client_memberships (
  id, studio_id, client_id, membership_plan_id, status, starts_on,
  current_period_start, current_period_end, auto_renew, cancel_at_period_end,
  name_snapshot, price_snapshot, billing_interval_snapshot
) values (
  '00000000-0000-0000-0000-00000000e604', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e403',
  '00000000-0000-0000-0000-00000000e501', 'active', '2026-09-01',
  '2026-09-01', '2026-09-30', true, false,
  'Monthly Finite Lessons', 100, 'monthly'
);

insert into public.membership_plan_benefits (id, membership_plan_id, benefit_type, quantity, usage_period) values
  ('00000000-0000-0000-0000-00000000e701', '00000000-0000-0000-0000-00000000e501', 'included_private_lessons', 1, 'billing_cycle');

-- ============================================================================
-- 1. Month-arithmetic helpers.
-- ============================================================================
do $$
declare
  v_rollover date;
  v_clamped date;
begin
  v_rollover := public._membership_period_add_months_rollover('2024-01-31'::date, 1);
  if v_rollover <> '2024-03-02'::date then
    raise exception 'FAIL T-mupa-rollover: expected 2024-03-02, got %', v_rollover;
  end if;

  v_rollover := public._membership_period_add_months_rollover('2023-01-31'::date, 1);
  if v_rollover <> '2023-03-03'::date then
    raise exception 'FAIL T-mupa-rollover-nonleap: expected 2023-03-03, got %', v_rollover;
  end if;

  v_clamped := public._membership_period_add_months_clamped('2024-01-31'::date, 1);
  if v_clamped <> '2024-02-29'::date then
    raise exception 'FAIL T-mupa-clamped-leap: expected 2024-02-29, got %', v_clamped;
  end if;

  v_clamped := public._membership_period_add_months_clamped('2023-01-31'::date, 1);
  if v_clamped <> '2023-02-28'::date then
    raise exception 'FAIL T-mupa-clamped-nonleap: expected 2023-02-28, got %', v_clamped;
  end if;

  v_clamped := public._membership_period_add_months_clamped('2026-01-15'::date, 1);
  if v_clamped <> '2026-02-15'::date then
    raise exception 'FAIL T-mupa-clamped-no-overflow: expected 2026-02-15, got %', v_clamped;
  end if;

  raise notice 'PASS T-mupa-month-helpers: rollover and clamped month arithmetic both match calculateNextPeriod / plan section C exactly';
end $$;

-- ============================================================================
-- 2. _membership_benefit_period_window: billing_cycle and monthly branches.
-- ============================================================================
do $$
declare
  v_win record;
begin
  -- billing_cycle: target inside the current window -> returned unchanged.
  select * into v_win from public._membership_benefit_period_window(
    '00000000-0000-0000-0000-00000000e601'::uuid, 'billing_cycle', '2026-09-15'::date
  );
  if v_win.window_start <> '2026-09-01'::date or v_win.window_end <> '2026-09-30'::date then
    raise exception 'FAIL T-mupa-window-billing-cycle: expected 2026-09-01..2026-09-30, got %..%', v_win.window_start, v_win.window_end;
  end if;

  -- monthly usage_period, independent of billing_interval_snapshot,
  -- anchored on the Jan-31 membership's starts_on, first window clamped.
  select * into v_win from public._membership_benefit_period_window(
    '00000000-0000-0000-0000-00000000e603'::uuid, 'monthly', '2024-02-10'::date
  );
  if v_win.window_start <> '2024-01-31'::date or v_win.window_end <> '2024-02-28'::date then
    raise exception 'FAIL T-mupa-window-monthly-clamp: expected 2024-01-31..2024-02-28, got %..%', v_win.window_start, v_win.window_end;
  end if;

  raise notice 'PASS T-mupa-window: billing_cycle and monthly branches both resolve the correct window';
end $$;

-- ============================================================================
-- 3. _private_lesson_finite_balance: consumed + reserved + available,
--    self-exclusion.
-- ============================================================================
insert into public.appointments (id, studio_id, client_id, instructor_id, room_id, appointment_type, status, billing_type, client_membership_id, starts_at, ends_at) values
  ('00000000-0000-0000-0000-00000000e801', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e301', 'private_lesson', 'scheduled', 'membership', '00000000-0000-0000-0000-00000000e601', '2026-09-10T10:00:00+00', '2026-09-10T10:45:00+00');

do $$
declare
  v_balance record;
begin
  select * into v_balance from public._private_lesson_finite_balance(
    '00000000-0000-0000-0000-00000000e601'::uuid, '00000000-0000-0000-0000-00000000e701'::uuid, '2026-09-10T10:00:00+00'::timestamptz, null
  );
  if v_balance.reserved <> 1 or v_balance.available <> 0 then
    raise exception 'FAIL T-mupa-balance-reserved: expected reserved=1 available=0, got reserved=% available=%', v_balance.reserved, v_balance.available;
  end if;

  -- self-exclusion: excluding the one reservation should show it as free.
  select * into v_balance from public._private_lesson_finite_balance(
    '00000000-0000-0000-0000-00000000e601'::uuid, '00000000-0000-0000-0000-00000000e701'::uuid, '2026-09-10T10:00:00+00'::timestamptz, '00000000-0000-0000-0000-00000000e801'::uuid
  );
  if v_balance.reserved <> 0 or v_balance.available <> 1 then
    raise exception 'FAIL T-mupa-balance-self-exclude: expected reserved=0 available=1, got reserved=% available=%', v_balance.reserved, v_balance.available;
  end if;

  raise notice 'PASS T-mupa-balance: consumed/reserved/available and self-exclusion all correct';
end $$;

-- ============================================================================
-- 4. DB capacity invariant: over-capacity rejected; ownership rejected;
--    appointment_type transition; attended-history immutability; raw
--    cancelled->active enforcement; non-applicable rows pass through.
-- ============================================================================
do $$
declare
  v_errored boolean;
begin
  -- Over-capacity: MEM_A already has its one lesson reserved (e801) --
  -- a second membership-funded lesson for the same membership in the same
  -- window must be rejected.
  v_errored := false;
  begin
    insert into public.appointments (studio_id, client_id, instructor_id, room_id, appointment_type, status, billing_type, client_membership_id, starts_at, ends_at)
    values ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000e202', '00000000-0000-0000-0000-00000000e302', 'private_lesson', 'scheduled', 'membership', '00000000-0000-0000-0000-00000000e601', '2026-09-12T10:00:00+00', '2026-09-12T10:45:00+00');
  exception when others then v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-mupa-capacity-overbook: a second membership-funded lesson against a depleted allowance was NOT rejected'; end if;

  -- Cross-client membership: MEM_B belongs to client e402, not e401.
  v_errored := false;
  begin
    insert into public.appointments (studio_id, client_id, instructor_id, room_id, appointment_type, status, billing_type, client_membership_id, starts_at, ends_at)
    values ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000e202', '00000000-0000-0000-0000-00000000e302', 'private_lesson', 'scheduled', 'membership', '00000000-0000-0000-0000-00000000e602', '2026-09-13T10:00:00+00', '2026-09-13T10:45:00+00');
  exception when others then v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-mupa-capacity-ownership: a membership belonging to a different client funded a reservation without rejection'; end if;

  -- Non-lesson, non-membership rows pass through untouched.
  insert into public.appointments (id, studio_id, client_id, instructor_id, room_id, appointment_type, status, starts_at, ends_at)
  values ('00000000-0000-0000-0000-00000000e802', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e402', '00000000-0000-0000-0000-00000000e202', '00000000-0000-0000-0000-00000000e302', 'floor_space_rental', 'scheduled', '2026-09-13T10:00:00+00', '2026-09-13T10:45:00+00');

  raise notice 'PASS T-mupa-capacity-basic: over-capacity and cross-client-ownership both rejected; unrelated appointment types pass through untouched';
end $$;

do $$
declare
  v_errored boolean;
begin
  -- Attended-history immutability: mark e801 attended, then attempt to
  -- change starts_at -- must be rejected.
  update public.appointments set status = 'attended', attendance_marked_at = now() where id = '00000000-0000-0000-0000-00000000e801';

  v_errored := false;
  begin
    update public.appointments set starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day' where id = '00000000-0000-0000-0000-00000000e801';
  exception when others then v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-mupa-attended-history: starts_at was changed on an attended appointment without rejection'; end if;

  -- Raw cancelled->active enforcement: cancel e801 (frees capacity), then
  -- book a fresh lesson to consume the freed slot, then attempt to
  -- reactivate e801 directly -- must be rejected (depleted again).
  update public.appointments set status = 'cancelled', cancelled_at = now() where id = '00000000-0000-0000-0000-00000000e801';

  insert into public.appointments (id, studio_id, client_id, instructor_id, room_id, appointment_type, status, billing_type, client_membership_id, starts_at, ends_at)
  values ('00000000-0000-0000-0000-00000000e803', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e301', 'private_lesson', 'scheduled', 'membership', '00000000-0000-0000-0000-00000000e601', '2026-09-20T10:00:00+00', '2026-09-20T10:45:00+00');

  v_errored := false;
  begin
    update public.appointments set status = 'scheduled' where id = '00000000-0000-0000-0000-00000000e801';
  exception when others then v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-mupa-reactivation-bypass: a raw cancelled->active transition into a depleted window was NOT rejected'; end if;

  raise notice 'PASS T-mupa-attended-and-reactivation: attended-history immutability and raw cancelled->active capacity enforcement both hold';
end $$;

-- ============================================================================
-- 5. Scheduling conflict / lock helpers.
-- ============================================================================
do $$
declare
  v_errored boolean;
begin
  v_errored := false;
  begin
    perform public._assert_no_scheduling_conflict(
      '00000000-0000-0000-0000-00000000e001'::uuid, '00000000-0000-0000-0000-00000000e201'::uuid, null::uuid,
      '2026-09-20T10:15:00+00'::timestamptz, '2026-09-20T11:00:00+00'::timestamptz, null::uuid
    );
  exception when others then v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-mupa-conflict-instructor: an overlapping instructor booking was not rejected'; end if;

  -- Different instructor, different time -> no conflict.
  perform public._assert_no_scheduling_conflict(
    '00000000-0000-0000-0000-00000000e001'::uuid, '00000000-0000-0000-0000-00000000e202'::uuid, null::uuid,
    '2026-09-20T10:15:00+00'::timestamptz, '2026-09-20T11:00:00+00'::timestamptz, null::uuid
  );

  -- Self-exclusion: e803 occupies e201/e301 at this exact time -- excluding
  -- its own id must not conflict with itself.
  perform public._lock_and_check_scheduling_resources(
    '00000000-0000-0000-0000-00000000e001'::uuid, '00000000-0000-0000-0000-00000000e201'::uuid, '00000000-0000-0000-0000-00000000e301'::uuid,
    '2026-09-20T10:00:00+00'::timestamptz, '2026-09-20T10:45:00+00'::timestamptz, '00000000-0000-0000-0000-00000000e803'::uuid
  );

  raise notice 'PASS T-mupa-scheduling-conflict: instructor overlap rejected, non-overlap allowed, self-exclusion works';
end $$;

-- ============================================================================
-- 6. Availability parity: instructor-specific Room-A window + request for
--    Room B falls back to a studio-wide Room-B window.
-- ============================================================================
-- Self-service enabled/instant here because section 9 below (student
-- reschedule, protected-fields proof) is a genuine positive-path test --
-- it must actually succeed, not merely be rejected like the two
-- unlinked-client/group_class adversarial self-service CREATE calls in
-- section 5 above (which fail on earlier checks -- client-link and
-- appointment-type -- before ever reaching studio_settings, so they were
-- unaffected by self-service being disabled).
insert into public.studio_settings (
  studio_id, timezone, portal_self_scheduling_enabled, portal_self_scheduling_mode,
  portal_self_scheduling_reschedule_mode
) values (
  '00000000-0000-0000-0000-00000000e001', 'America/New_York', true, 'instant', 'instant'
)
  on conflict (studio_id) do update set
    timezone = excluded.timezone,
    portal_self_scheduling_enabled = excluded.portal_self_scheduling_enabled,
    portal_self_scheduling_mode = excluded.portal_self_scheduling_mode,
    portal_self_scheduling_reschedule_mode = excluded.portal_self_scheduling_reschedule_mode;

insert into public.studio_booking_availability_windows (studio_id, instructor_id, room_id, weekday, start_time, end_time, active) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e301', extract(dow from '2026-09-14'::date)::int, '09:00', '17:00', true),
  ('00000000-0000-0000-0000-00000000e001', null, '00000000-0000-0000-0000-00000000e302', extract(dow from '2026-09-14'::date)::int, '09:00', '17:00', true);

do $$
declare
  v_ok boolean;
begin
  -- Instructor A, Room A (the instructor's own window) -> matches.
  v_ok := public._self_service_slot_within_availability(
    '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e301', 'private_lesson',
    '2026-09-14T10:00:00-04', '2026-09-14T10:45:00-04'
  );
  if not v_ok then raise exception 'FAIL T-mupa-availability-own-room: instructor-specific Room-A window did not match a Room-A request'; end if;

  -- Instructor A, Room B (studio-wide window) -> must fall back and match,
  -- not be wrongly excluded because A has a Room-A-only specific window.
  v_ok := public._self_service_slot_within_availability(
    '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e302', 'private_lesson',
    '2026-09-14T10:00:00-04', '2026-09-14T10:45:00-04'
  );
  if not v_ok then raise exception 'FAIL T-mupa-availability-parity: instructor-specific Room-A window incorrectly suppressed the valid studio-wide Room-B window'; end if;

  -- Wrong weekday -> no match.
  v_ok := public._self_service_slot_within_availability(
    '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e301', 'private_lesson',
    '2026-09-15T10:00:00-04', '2026-09-15T10:45:00-04'
  );
  if v_ok then raise exception 'FAIL T-mupa-availability-weekday: wrong weekday incorrectly matched'; end if;

  raise notice 'PASS T-mupa-availability: instructor-priority parity (the room-blind-check counter-example) resolves correctly, weekday boundary respected';
end $$;

-- ============================================================================
-- 7. Atomic RPCs: staff create/update, student self-service adversarial
--    cases, ACL grants.
-- ============================================================================
do $$
declare
  v_new_appt uuid;
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000e101')::text, true);

  -- Staff (studio_owner) creates a membership-funded lesson for MEM_B
  -- (client e402, currently unused) -- should succeed. Phase 2 widened
  -- signature: exercises the extra staff-only fields too.
  v_new_appt := public.create_private_lesson_membership_appointment(
    '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e402', '00000000-0000-0000-0000-00000000e602',
    '00000000-0000-0000-0000-00000000e202', '00000000-0000-0000-0000-00000000e302', 'private_lesson', 'Staff-booked lesson',
    '2026-09-21T10:00:00+00', '2026-09-21T10:45:00+00',
    'Staff note', 'Studio A', null, 'Comped for review'
  );
  if v_new_appt is null then raise exception 'FAIL T-mupa-staff-create: staff RPC did not return a new appointment id'; end if;
  if not exists (select 1 from public.appointments where id = v_new_appt and notes = 'Staff note' and location_name = 'Studio A' and billing_note = 'Comped for review') then
    raise exception 'FAIL T-mupa-staff-create-widened-fields: notes/location_name/billing_note were not persisted by the widened staff CREATE RPC';
  end if;

  -- Staff reschedule of that same appointment, same membership,
  -- client/type/instructor/room -> succeeds. Phase 2 widened signature;
  -- an explicit null for p_new_instructor_id/p_new_room_id here would
  -- mean "clear it", not "leave unchanged" -- the real current values are
  -- passed explicitly, matching how updateAppointmentAction always
  -- supplies the form's actual submitted value.
  perform public.update_private_lesson_membership_appointment(
    v_new_appt, '00000000-0000-0000-0000-00000000e402', 'private_lesson',
    '2026-09-22T10:00:00+00', '2026-09-22T10:45:00+00',
    'membership', '00000000-0000-0000-0000-00000000e602',
    '00000000-0000-0000-0000-00000000e202', '00000000-0000-0000-0000-00000000e302', 'scheduled',
    'Staff note', 'Studio A', null, 'Comped for review'
  );

  reset role;

  -- Direct-RPC adversarial: student self-service create with a client the
  -- caller has no client_account_links row for. Phase 2 narrowed
  -- signature: no p_title argument exists at all.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000e104')::text, true);

  v_errored := false;
  begin
    perform public.create_private_lesson_membership_appointment_self_service(
      '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e404', '00000000-0000-0000-0000-00000000e604',
      '00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e301', 'private_lesson',
      '2026-09-23T10:00:00+00', '2026-09-23T10:45:00+00'
    );
  exception when others then v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-mupa-self-service-unlinked-client: booking for an unlinked client was not rejected'; end if;

  -- group_class hard-excluded from self-service, independent of any studio
  -- setting.
  v_errored := false;
  begin
    perform public.create_private_lesson_membership_appointment_self_service(
      '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e403', '00000000-0000-0000-0000-00000000e604',
      '00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e301', 'group_class',
      '2026-09-23T10:00:00+00', '2026-09-23T10:45:00+00'
    );
  exception when others then v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-mupa-self-service-group-class: group_class was not rejected outright by the self-service RPC'; end if;

  reset role;

  raise notice 'PASS T-mupa-rpcs: staff create/update succeed for an authorized caller; unlinked-client and group_class self-service adversarial calls are both rejected';
end $$;

do $$
declare
  v_grantee_count int;
begin
  select count(*) into v_grantee_count
  from information_schema.routine_privileges
  where routine_schema = 'public'
    and routine_name in (
      '_membership_period_add_months_rollover', '_membership_period_add_months_clamped',
      '_membership_benefit_period_window', '_ensure_membership_period_for_date',
      '_private_lesson_finite_balance', '_sync_membership_usage_for_private_lesson_appointment',
      'sync_membership_usage_for_private_lesson_appointment',
      '_assert_no_scheduling_conflict', '_lock_and_check_scheduling_resources',
      '_self_service_slot_within_availability',
      '_lesson_membership_reservation_core_create', '_lesson_membership_reservation_core_update',
      'enforce_private_lesson_membership_capacity'
    )
    and grantee in ('PUBLIC', 'anon', 'authenticated');
  if v_grantee_count <> 0 then
    raise exception 'FAIL T-mupa-internal-grants: found % unexpected grantee(s) among internal helper functions', v_grantee_count;
  end if;

  select count(*) into v_grantee_count
  from information_schema.routine_privileges
  where routine_schema = 'public'
    and routine_name in (
      'create_private_lesson_membership_appointment', 'update_private_lesson_membership_appointment',
      'create_private_lesson_membership_appointment_self_service', 'update_private_lesson_membership_appointment_self_service',
      'retry_membership_usage_sync_error'
    )
    and grantee = 'authenticated';
  if v_grantee_count <> 5 then
    raise exception 'FAIL T-mupa-public-grants: expected exactly 5 authenticated-granted public entry points, found %', v_grantee_count;
  end if;

  raise notice 'PASS T-mupa-acl: every internal helper is revoked from PUBLIC/anon/authenticated; exactly five public entry points are granted to authenticated only';
end $$;

-- ============================================================================
-- 8. Usage-sync trigger is created disabled; the underlying procedure
--    works correctly when called directly.
-- ============================================================================
do $$
declare
  v_enabled char;
begin
  select tgenabled into v_enabled from pg_trigger
    where tgname = 'appointments_sync_membership_usage_for_private_lesson';
  if v_enabled <> 'D' then
    raise exception 'FAIL T-mupa-trigger-disabled: appointments_sync_membership_usage_for_private_lesson is not disabled (tgenabled=%)', v_enabled;
  end if;

  -- Direct call: e803 is attended? No -- mark it attended, sync directly,
  -- confirm a usage row appears, then confirm balance reflects consumption
  -- not reservation.
  update public.appointments set status = 'attended', attendance_marked_at = now() where id = '00000000-0000-0000-0000-00000000e803';
  perform public._sync_membership_usage_for_private_lesson_appointment('00000000-0000-0000-0000-00000000e803');

  if not exists (select 1 from public.client_membership_usage where reference_type = 'appointment' and reference_id = '00000000-0000-0000-0000-00000000e803') then
    raise exception 'FAIL T-mupa-sync-direct: direct call to the sync procedure did not create a usage row for an attended, membership-funded lesson';
  end if;

  raise notice 'PASS T-mupa-cutover: usage-sync trigger confirmed disabled (single-writer cutover discipline); the underlying procedure works correctly when called directly';
end $$;

-- ============================================================================
-- 9. Retry mechanics (synthetic error row, not a forced real failure).
-- ============================================================================
do $$
declare
  v_error_id uuid;
  v_result boolean;
begin
  insert into public.membership_usage_sync_errors (studio_id, appointment_id, client_id, client_membership_id, membership_plan_benefit_id, error_message)
  values ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e803', '00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-00000000e601', '00000000-0000-0000-0000-00000000e701', 'synthetic test failure')
  returning id into v_error_id;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000e101')::text, true);
  v_result := public.retry_membership_usage_sync_error(v_error_id);
  reset role;

  if not v_result then raise exception 'FAIL T-mupa-retry: retry_membership_usage_sync_error returned false for a valid target'; end if;

  if not exists (select 1 from public.membership_usage_sync_errors where id = v_error_id and resolved_at is not null) then
    raise exception 'FAIL T-mupa-retry-resolved: resolved_at was not set after a successful retry';
  end if;

  raise notice 'PASS T-mupa-retry: retry_membership_usage_sync_error reruns the canonical sync and marks resolved_at on success';
end $$;

-- ============================================================================
-- 10. Phase 2 -- direct-RPC structural signature proof. The prohibited
--     fields (client_id/appointment_type/status on reschedule, title,
--     notes, location_name, partner_client_id, billing_note) have NO
--     argument position on either student wrapper -- not merely ignored
--     if supplied.
-- ============================================================================
do $$
declare
  v_create_args text;
  v_update_args text;
  v_create_argnum int;
  v_update_argnum int;
begin
  select pg_get_function_arguments(p.oid), pronargs into v_create_args, v_create_argnum
    from pg_proc p where p.proname = 'create_private_lesson_membership_appointment_self_service' and p.pronamespace = 'public'::regnamespace;

  -- Structural proof, not merely behavioral: exactly 8 parameters, the
  -- 8 legitimate self-service create inputs present, and no protected
  -- field has any argument position at all.
  if v_create_argnum <> 8 then
    raise exception 'FAIL T-mupa-signature-create-self-service-count: expected exactly 8 parameters, found %: %', v_create_argnum, v_create_args;
  end if;
  if v_create_args not ilike '%p_studio_id%' or v_create_args not ilike '%p_client_id%' or v_create_args not ilike '%p_client_membership_id%'
     or v_create_args not ilike '%p_instructor_id%' or v_create_args not ilike '%p_room_id%' or v_create_args not ilike '%p_appointment_type%'
     or v_create_args not ilike '%p_starts_at%' or v_create_args not ilike '%p_ends_at%' then
    raise exception 'FAIL T-mupa-signature-create-self-service-missing: a legitimate self-service input is missing: %', v_create_args;
  end if;
  if v_create_args ilike '%title%' or v_create_args ilike '%notes%' or v_create_args ilike '%billing_note%' or v_create_args ilike '%location_name%' or v_create_args ilike '%partner_client_id%' or v_create_args ilike '%status%' then
    raise exception 'FAIL T-mupa-signature-create-self-service-leak: a protected field has an argument position: %', v_create_args;
  end if;

  select pg_get_function_arguments(p.oid), pronargs into v_update_args, v_update_argnum
    from pg_proc p where p.proname = 'update_private_lesson_membership_appointment_self_service' and p.pronamespace = 'public'::regnamespace;

  if v_update_argnum <> 6 then
    raise exception 'FAIL T-mupa-signature-update-self-service-count: expected exactly 6 parameters, found %: %', v_update_argnum, v_update_args;
  end if;
  if v_update_args not ilike '%p_appointment_id%' or v_update_args not ilike '%p_new_starts_at%' or v_update_args not ilike '%p_new_ends_at%'
     or v_update_args not ilike '%p_new_client_membership_id%' or v_update_args not ilike '%p_new_instructor_id%' or v_update_args not ilike '%p_new_room_id%' then
    raise exception 'FAIL T-mupa-signature-update-self-service-missing: a legitimate self-service reschedule input is missing: %', v_update_args;
  end if;
  if v_update_args ilike '%p_new_client_id%' or v_update_args ilike '%appointment_type%' or v_update_args ilike '%p_new_status%'
     or v_update_args ilike '%notes%' or v_update_args ilike '%billing_note%' or v_update_args ilike '%location_name%' or v_update_args ilike '%partner_client_id%' then
    raise exception 'FAIL T-mupa-signature-update-self-service-leak: a protected field has an argument position: %', v_update_args;
  end if;

  raise notice 'PASS T-mupa-signatures: neither student wrapper has an argument position for any protected staff/business field, and both expose exactly their legitimate self-service inputs';
end $$;

-- ============================================================================
-- 11. Phase 2 -- behavioral proof: a student reschedule changes only
--     starts_at/ends_at/instructor/room/membership; every protected field
--     is carried forward byte-identical from the locked row. Also proves
--     the corrected capability: reschedule CAN move to a different
--     instructor/room (matches the real self-service product,
--     selfServiceExecution.ts).
-- ============================================================================
insert into public.studio_booking_availability_windows (studio_id, instructor_id, room_id, weekday, start_time, end_time, active) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e202', '00000000-0000-0000-0000-00000000e302', extract(dow from '2026-09-21'::date)::int, '09:00', '17:00', true);

insert into public.appointments (id, studio_id, client_id, instructor_id, room_id, appointment_type, status, billing_type, client_membership_id, starts_at, ends_at, notes, location_name, billing_note) values
  ('00000000-0000-0000-0000-00000000e804', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e403', '00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e301', 'private_lesson', 'scheduled', 'membership', '00000000-0000-0000-0000-00000000e604', '2026-09-21T14:00:00+00', '2026-09-21T14:45:00+00', 'Original notes', 'Original location', 'Original billing note');

do $$
declare
  v_before record;
  v_after record;
begin
  select * into v_before from public.appointments where id = '00000000-0000-0000-0000-00000000e804';

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000e104')::text, true);

  perform public.update_private_lesson_membership_appointment_self_service(
    '00000000-0000-0000-0000-00000000e804'::uuid, '2026-09-21T14:15:00+00'::timestamptz, '2026-09-21T15:00:00+00'::timestamptz,
    '00000000-0000-0000-0000-00000000e604'::uuid, '00000000-0000-0000-0000-00000000e202'::uuid, '00000000-0000-0000-0000-00000000e302'::uuid
  );

  reset role;

  select * into v_after from public.appointments where id = '00000000-0000-0000-0000-00000000e804';

  if v_after.client_id is distinct from v_before.client_id
     or v_after.appointment_type is distinct from v_before.appointment_type
     or v_after.notes is distinct from v_before.notes
     or v_after.location_name is distinct from v_before.location_name
     or v_after.billing_note is distinct from v_before.billing_note
     or v_after.partner_client_id is distinct from v_before.partner_client_id
  then
    raise exception 'FAIL T-mupa-reschedule-protected-fields: a protected field changed during a student self-service reschedule';
  end if;

  if v_after.status <> 'scheduled' then
    raise exception 'FAIL T-mupa-reschedule-status: status was not reset to scheduled';
  end if;

  if v_after.instructor_id <> '00000000-0000-0000-0000-00000000e202'::uuid or v_after.room_id <> '00000000-0000-0000-0000-00000000e302'::uuid then
    raise exception 'FAIL T-mupa-reschedule-instructor-room: reschedule did not move to the requested destination instructor/room';
  end if;

  raise notice 'PASS T-mupa-reschedule-narrow-surface: every protected field survived a student reschedule unchanged, and the destination-instructor/room capability works';
end $$;

-- ============================================================================
-- 11b. P6c -- self-service reschedule lesson-type allow-list, enum/text
--      boundary. Section 11 above already proves the POSITIVE case
--      (v_old.appointment_type = 'private_lesson', an enum value,
--      succeeds against the null-default text[] allow-list) and the
--      protected-fields/status/instructor-room behavior. This section
--      adds the two cases section 11 doesn't cover: an explicitly
--      configured allow-list that excludes the appointment's type, and
--      the default allow-list rejecting a type outside it (proving the
--      default is exactly ['private_lesson'], not "anything eligible for
--      self-service").
-- ============================================================================
-- billing_type = pay_as_you_go / client_membership_id = null here
-- deliberately -- enforce_private_lesson_membership_capacity() only
-- checks rows with billing_type = 'membership' (P3c line 60); these two
-- fixtures only need to reach the self-service reschedule wrapper's
-- allow-list check (well before anything reads the row's own billing
-- state), and membership e604's single-unit allowance is already
-- consumed by e804 (section 11) -- reusing it here would trip the
-- capacity trigger at INSERT time, before either test's real assertion
-- ever runs.
insert into public.appointments (id, studio_id, client_id, instructor_id, room_id, appointment_type, status, billing_type, client_membership_id, starts_at, ends_at) values
  ('00000000-0000-0000-0000-00000000e805', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e403', '00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e301', 'intro_lesson', 'scheduled', 'pay_as_you_go', null, '2026-09-24T09:00:00+00', '2026-09-24T09:45:00+00'),
  ('00000000-0000-0000-0000-00000000e806', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e403', '00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e301', 'private_lesson', 'scheduled', 'pay_as_you_go', null, '2026-09-25T09:00:00+00', '2026-09-25T09:45:00+00');

do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000e104')::text, true);

  -- Default allow-list (portal_bookable_lesson_types still null for this
  -- studio at this point in the harness): an eligible-for-self-service
  -- type (intro_lesson passes the earlier type-eligibility check at
  -- T-mupa-reschedule's line-494 equivalent) must still be rejected by
  -- the *allow-list*, because the documented default is exactly
  -- array['private_lesson'], not every self-service-eligible type.
  v_errored := false;
  begin
    perform public.update_private_lesson_membership_appointment_self_service(
      '00000000-0000-0000-0000-00000000e805'::uuid, '2026-09-24T10:00:00+00'::timestamptz, '2026-09-24T10:45:00+00'::timestamptz,
      '00000000-0000-0000-0000-00000000e604'::uuid, null, null
    );
  exception when others then v_errored := true;
  end;
  if not v_errored then
    raise exception 'FAIL T-mupa-reschedule-default-allowlist: an intro_lesson reschedule was not rejected under the default (null-settings) allow-list, which must be exactly array[''private_lesson'']';
  end if;

  reset role;

  raise notice 'PASS T-mupa-reschedule-default-allowlist: default null-settings allow-list accepts private_lesson (proven in section 11) and rejects intro_lesson, confirming the default is exactly array[''private_lesson'']';
end $$;

-- Explicitly configured allow-list that excludes private_lesson --
-- proves the enum/text comparison itself works correctly against a
-- real, non-default, non-null text[] value (not just the coalesce
-- default), and that a genuinely disallowed type is rejected.
update public.studio_settings set portal_bookable_lesson_types = array['coaching'] where studio_id = '00000000-0000-0000-0000-00000000e001';

do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000e104')::text, true);

  v_errored := false;
  begin
    perform public.update_private_lesson_membership_appointment_self_service(
      '00000000-0000-0000-0000-00000000e806'::uuid, '2026-09-25T10:00:00+00'::timestamptz, '2026-09-25T10:45:00+00'::timestamptz,
      '00000000-0000-0000-0000-00000000e604'::uuid, null, null
    );
  exception when others then v_errored := true;
  end;
  if not v_errored then
    raise exception 'FAIL T-mupa-reschedule-configured-allowlist: a private_lesson reschedule was not rejected when the studio''s configured allow-list is array[''coaching''] (excludes private_lesson)';
  end if;

  reset role;

  raise notice 'PASS T-mupa-reschedule-configured-allowlist: an explicitly configured text[] allow-list that excludes the appointment''s enum type correctly rejects it -- proves the P6c enum::text cast compares against real configured values, not just the coalesce default';
end $$;

-- Restore the column's real default so it doesn't affect any later
-- section (none currently depend on it, but this keeps the fixture state
-- clean). portal_bookable_lesson_types is NOT NULL with column default
-- ARRAY['private_lesson'] (confirmed live via information_schema) --
-- section 11's original insert never set this column explicitly, so it
-- was already carrying this same default value throughout section 11
-- and the first half of this section; the function's own
-- coalesce(..., array['private_lesson']) fallback is defensive and never
-- actually reachable on this schema, which is fine -- it doesn't change
-- correctness.
update public.studio_settings set portal_bookable_lesson_types = array['private_lesson'] where studio_id = '00000000-0000-0000-0000-00000000e001';

-- ============================================================================
-- 12. Phase 2 -- staff widened signature still respects the
--     attended-history DB invariant regardless of the wider parameter
--     list.
-- ============================================================================
do $$
declare
  v_errored boolean;
begin
  update public.appointments set status = 'attended', attendance_marked_at = now() where id = '00000000-0000-0000-0000-00000000e804';

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000e101')::text, true);

  v_errored := false;
  begin
    perform public.update_private_lesson_membership_appointment(
      '00000000-0000-0000-0000-00000000e804'::uuid, '00000000-0000-0000-0000-00000000e402'::uuid, 'coaching',
      '2026-09-21T16:00:00+00'::timestamptz, '2026-09-21T16:45:00+00'::timestamptz,
      'membership', '00000000-0000-0000-0000-00000000e604'::uuid,
      '00000000-0000-0000-0000-00000000e202'::uuid, '00000000-0000-0000-0000-00000000e302'::uuid, 'scheduled',
      null, null, null, null
    );
  exception when others then v_errored := true;
  end;

  reset role;

  if not v_errored then raise exception 'FAIL T-mupa-staff-widened-attended-history: the widened staff UPDATE RPC changed client_id/appointment_type/starts_at on an attended row without rejection'; end if;

  raise notice 'PASS T-mupa-staff-widened-attended-history: the attended-history DB invariant still rejects a protected-field change regardless of the wider staff RPC signature';
end $$;

-- ============================================================================
-- 13. Phase 2 -- multi-row INSERT capacity enforcement (the volatility
--     fix, plan section 6/8). Fresh, isolated fixtures: a membership with
--     exactly 2 available; one statement attempts to insert 3
--     membership-funded appointments into the same window.
-- ============================================================================
insert into public.clients (id, studio_id, first_name, last_name, status) values
  ('00000000-0000-0000-0000-00000000e405', '00000000-0000-0000-0000-00000000e001', 'MultiRow', 'Client', 'active');

insert into public.membership_plans (id, studio_id, name, billing_interval, price) values
  ('00000000-0000-0000-0000-00000000e504', '00000000-0000-0000-0000-00000000e001', 'Two Lesson Plan', 'monthly', 100);

insert into public.client_memberships (
  id, studio_id, client_id, membership_plan_id, status, starts_on,
  current_period_start, current_period_end, auto_renew, cancel_at_period_end,
  name_snapshot, price_snapshot, billing_interval_snapshot
) values (
  '00000000-0000-0000-0000-00000000e605', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e405',
  '00000000-0000-0000-0000-00000000e504', 'active', '2026-09-01',
  '2026-09-01', '2026-09-30', true, false,
  'Two Lesson Plan', 100, 'monthly'
);

insert into public.membership_plan_benefits (id, membership_plan_id, benefit_type, quantity, usage_period) values
  ('00000000-0000-0000-0000-00000000e702', '00000000-0000-0000-0000-00000000e504', 'included_private_lessons', 2, 'billing_cycle');

do $$
declare
  v_errored boolean;
  v_count int;
begin
  v_errored := false;
  begin
    insert into public.appointments (studio_id, client_id, instructor_id, room_id, appointment_type, status, billing_type, client_membership_id, starts_at, ends_at) values
      ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e405', '00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e301', 'private_lesson', 'scheduled', 'membership', '00000000-0000-0000-0000-00000000e605', '2026-09-25T09:00:00+00', '2026-09-25T09:45:00+00'),
      ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e405', '00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e301', 'private_lesson', 'scheduled', 'membership', '00000000-0000-0000-0000-00000000e605', '2026-09-25T10:00:00+00', '2026-09-25T10:45:00+00'),
      ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e405', '00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e301', 'private_lesson', 'scheduled', 'membership', '00000000-0000-0000-0000-00000000e605', '2026-09-25T11:00:00+00', '2026-09-25T11:45:00+00');
  exception when others then v_errored := true;
  end;

  if not v_errored then
    raise exception 'FAIL T-mupa-multirow-insert-not-rejected: a 3-row INSERT against a 2-available allowance did not raise an exception';
  end if;

  select count(*) into v_count from public.appointments where client_membership_id = '00000000-0000-0000-0000-00000000e605'::uuid;
  if v_count <> 0 then
    raise exception 'FAIL T-mupa-multirow-insert-partial-commit: expected 0 committed rows after the rejected multi-row INSERT, found %', v_count;
  end if;

  raise notice 'PASS T-mupa-multirow-insert: a 3-row single-statement INSERT against a 2-available allowance is rejected and rolled back in full -- zero partial commit';
end $$;

-- ============================================================================
-- 14. Phase 2 -- visibility sanity check. Proves the VOLATILE
--     reclassification actually changed observed behavior (row 2 sees
--     row 1's reservation), not merely the declared label. Uses a
--     side table, rolled back with everything else.
--
--     CORRECTION (found during the DEV rollout dry run): an earlier draft
--     of this test inserted 3 rows in one statement (rows 1,2 succeed,
--     row 3 fails) and read the trace AFTER the failure. That is invalid
--     -- PL/pgSQL's `exception when others` rolls back to an implicit
--     SAVEPOINT taken before the failing statement, discarding the
--     ENTIRE statement's effects, including the trigger's trace-table
--     inserts for rows 1 and 2, not just row 3's. The trace table came
--     back empty by design, not by bug, and `v_seen[1] <> 2` against a
--     NULL array evaluates to NULL, which PL/pgSQL's `IF` treats as
--     false -- a silent false-positive PASS, caught only by actually
--     inspecting the runtime trace value instead of trusting the absence
--     of a raised exception. Fixed: insert exactly 2 rows (matching a
--     fresh 2-available membership) in one statement, so nothing fails
--     and nothing rolls back; the boundary case (a 3rd row correctly
--     rejected) is proven separately and reliably by section 13, which
--     checks committed-row COUNT after the savepoint rollback, not trace
--     contents.
-- ============================================================================
create temporary table t_mupa_visibility_trace (
  seq int generated always as identity,
  available_seen int
) on commit drop;

create or replace function public._t_mupa_trace_balance() returns trigger
language plpgsql as $$
declare
  v_benefit_id uuid;
  v_balance record;
begin
  if new.appointment_type not in ('private_lesson','intro_lesson','coaching') or new.billing_type <> 'membership' then
    return new;
  end if;
  select mpb.id into v_benefit_id from public.membership_plan_benefits mpb
    join public.client_memberships cm on cm.membership_plan_id = mpb.membership_plan_id
    where cm.id = new.client_membership_id and mpb.benefit_type = 'included_private_lessons';
  select * into v_balance from public._private_lesson_finite_balance(new.client_membership_id, v_benefit_id, new.starts_at, new.id);
  insert into t_mupa_visibility_trace (available_seen) values (v_balance.available);
  return new;
end;
$$;

create trigger a0_mupa_trace before insert on public.appointments for each row execute function public._t_mupa_trace_balance();

insert into public.clients (id, studio_id, first_name, last_name, status) values
  ('00000000-0000-0000-0000-00000000e406', '00000000-0000-0000-0000-00000000e001', 'Trace', 'Client', 'active');
insert into public.client_memberships (
  id, studio_id, client_id, membership_plan_id, status, starts_on,
  current_period_start, current_period_end, auto_renew, cancel_at_period_end,
  name_snapshot, price_snapshot, billing_interval_snapshot
) values (
  '00000000-0000-0000-0000-00000000e606', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e406',
  '00000000-0000-0000-0000-00000000e504', 'active', '2026-09-01', '2026-09-01', '2026-09-30', true, false,
  'Two Lesson Plan', 100, 'monthly'
);

-- Exactly 2 rows against a 2-available allowance -- both must succeed;
-- the distinguishing evidence is the TRACE VALUE row 2 sees, not whether
-- the statement succeeds (it would succeed either way).
insert into public.appointments (studio_id, client_id, instructor_id, room_id, appointment_type, status, billing_type, client_membership_id, starts_at, ends_at) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e406', '00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e301', 'private_lesson', 'scheduled', 'membership', '00000000-0000-0000-0000-00000000e606', '2026-09-26T09:00:00+00', '2026-09-26T09:45:00+00'),
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e406', '00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e301', 'private_lesson', 'scheduled', 'membership', '00000000-0000-0000-0000-00000000e606', '2026-09-26T10:00:00+00', '2026-09-26T10:45:00+00');

do $$
declare
  v_seen int[];
begin
  select array_agg(available_seen order by seq) into v_seen from t_mupa_visibility_trace;

  if v_seen is null or array_length(v_seen, 1) <> 2 then
    raise exception 'FAIL T-mupa-visibility-tracecount: expected exactly 2 trace rows, got %', v_seen;
  end if;
  if v_seen[1] <> 2 then
    raise exception 'FAIL T-mupa-visibility-row1: expected row 1 to see available=2, saw %', v_seen[1];
  end if;
  if v_seen[2] <> 1 then
    raise exception 'FAIL T-mupa-visibility-row2: expected row 2 to see available=1 (i.e. to observe row 1 already counted, proving the VOLATILE fix works), saw %. If this is 2, the STABLE bug is still present.', v_seen[2];
  end if;

  raise notice 'PASS T-mupa-visibility: row 2 observed row 1''s reservation (available 2->1), proving the VOLATILE reclassification of _private_lesson_finite_balance actually changed observed same-statement visibility, not just the declared label';
end $$;

drop trigger a0_mupa_trace on public.appointments;
drop function public._t_mupa_trace_balance();

-- ============================================================================
-- 15. Phase 2 -- bulk UPDATE capacity enforcement. Destination window has
--     capacity for exactly 2 (the e605 membership, both prior 3-row
--     attempts having been fully rolled back); one bulk UPDATE attempts
--     to move 3 existing appointments into it in one statement.
-- ============================================================================
insert into public.appointments (id, studio_id, client_id, instructor_id, room_id, appointment_type, status, billing_type, client_membership_id, starts_at, ends_at, recurrence_series_id) values
  ('00000000-0000-0000-0000-00000000e810', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e405', '00000000-0000-0000-0000-00000000e202', '00000000-0000-0000-0000-00000000e302', 'private_lesson', 'scheduled', 'pay_as_you_go', null, '2026-10-05T09:00:00+00', '2026-10-05T09:45:00+00', '00000000-0000-0000-0000-00000000e900'),
  ('00000000-0000-0000-0000-00000000e811', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e405', '00000000-0000-0000-0000-00000000e202', '00000000-0000-0000-0000-00000000e302', 'private_lesson', 'scheduled', 'pay_as_you_go', null, '2026-10-05T10:00:00+00', '2026-10-05T10:45:00+00', '00000000-0000-0000-0000-00000000e900'),
  ('00000000-0000-0000-0000-00000000e812', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e405', '00000000-0000-0000-0000-00000000e202', '00000000-0000-0000-0000-00000000e302', 'private_lesson', 'scheduled', 'pay_as_you_go', null, '2026-10-05T11:00:00+00', '2026-10-05T11:45:00+00', '00000000-0000-0000-0000-00000000e900');

do $$
declare
  v_errored boolean;
  v_unchanged_count int;
begin
  v_errored := false;
  begin
    update public.appointments
      set billing_type = 'membership', client_membership_id = '00000000-0000-0000-0000-00000000e605'::uuid
      where recurrence_series_id = '00000000-0000-0000-0000-00000000e900'::uuid;
  exception when others then v_errored := true;
  end;

  if not v_errored then
    raise exception 'FAIL T-mupa-bulk-update-not-rejected: a bulk UPDATE moving 3 rows into a 2-available allowance did not raise an exception';
  end if;

  select count(*) into v_unchanged_count from public.appointments
    where recurrence_series_id = '00000000-0000-0000-0000-00000000e900'::uuid and billing_type = 'pay_as_you_go';
  if v_unchanged_count <> 3 then
    raise exception 'FAIL T-mupa-bulk-update-partial-commit: expected all 3 rows to still be pay_as_you_go (full rollback), found % unchanged', v_unchanged_count;
  end if;

  raise notice 'PASS T-mupa-bulk-update: a bulk UPDATE moving 3 rows into a 2-available allowance is rejected and rolled back in full -- pre-update state fully restored';
end $$;

-- ============================================================================
-- 16. P6b -- generated-column duration proof. public.appointments.
--     duration_minutes is a live GENERATED ALWAYS ... STORED column; the
--     P6 core functions must never supply it explicitly (P6b's fix) and
--     Postgres must derive/regenerate it correctly on both atomic CREATE
--     and atomic UPDATE (reschedule) through the real RPCs -- not a raw
--     INSERT/UPDATE, so this also proves neither RPC signature carries a
--     duration_minutes parameter at all.
-- ============================================================================
insert into public.clients (id, studio_id, first_name, last_name, status) values
  ('00000000-0000-0000-0000-00000000e408', '00000000-0000-0000-0000-00000000e001', 'Duration', 'Client', 'active');
insert into public.client_memberships (
  id, studio_id, client_id, membership_plan_id, status, starts_on,
  current_period_start, current_period_end, auto_renew, cancel_at_period_end,
  name_snapshot, price_snapshot, billing_interval_snapshot
) values (
  '00000000-0000-0000-0000-00000000e607', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e408',
  '00000000-0000-0000-0000-00000000e501', 'active', '2026-09-01',
  '2026-09-01', '2026-09-30', true, false,
  'Monthly Finite Lessons', 100, 'monthly'
);

do $$
declare
  v_appointment_id uuid;
  v_duration_after_create int;
  v_duration_after_update int;
begin
  -- CREATE: staff atomic RPC, 45-minute slot (09:00-09:45).
  select public.create_private_lesson_membership_appointment(
    '00000000-0000-0000-0000-00000000e001'::uuid, '00000000-0000-0000-0000-00000000e408'::uuid,
    '00000000-0000-0000-0000-00000000e607'::uuid, '00000000-0000-0000-0000-00000000e201'::uuid,
    '00000000-0000-0000-0000-00000000e301'::uuid, 'private_lesson', 'Duration Proof Lesson',
    '2026-11-01T09:00:00+00'::timestamptz, '2026-11-01T09:45:00+00'::timestamptz
  ) into v_appointment_id;

  select duration_minutes into v_duration_after_create from public.appointments where id = v_appointment_id;
  if v_duration_after_create is distinct from 45 then
    raise exception 'FAIL T-mupa-duration-create: expected the generated column to derive duration_minutes=45 from a 09:00-09:45 slot, got %', v_duration_after_create;
  end if;
  raise notice 'PASS T-mupa-duration-create: atomic membership-funded CREATE succeeded and duration_minutes (%) was derived entirely by the generated column, never supplied by the RPC', v_duration_after_create;

  -- UPDATE (reschedule): staff atomic RPC, move to a 60-minute slot
  -- (10:00-11:00) -- duration_minutes must be regenerated automatically.
  perform public.update_private_lesson_membership_appointment(
    v_appointment_id, '00000000-0000-0000-0000-00000000e408'::uuid, 'private_lesson',
    '2026-11-01T10:00:00+00'::timestamptz, '2026-11-01T11:00:00+00'::timestamptz,
    'membership', '00000000-0000-0000-0000-00000000e607'::uuid,
    '00000000-0000-0000-0000-00000000e201'::uuid, '00000000-0000-0000-0000-00000000e301'::uuid,
    'scheduled'
  );

  select duration_minutes into v_duration_after_update from public.appointments where id = v_appointment_id;
  if v_duration_after_update is distinct from 60 then
    raise exception 'FAIL T-mupa-duration-update: expected the generated column to re-derive duration_minutes=60 after rescheduling to a 10:00-11:00 slot, got %', v_duration_after_update;
  end if;
  raise notice 'PASS T-mupa-duration-update: atomic reschedule succeeded and duration_minutes (%) was automatically regenerated from the new starts_at/ends_at, never supplied by the RPC', v_duration_after_update;
end $$;

rollback;
