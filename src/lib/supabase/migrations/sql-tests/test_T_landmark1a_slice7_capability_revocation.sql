-- Landmark 1A -- Slice 7: Instructor Capability Revocation & Future-Work
-- Protection -- live regression suite.
--
-- Exercises the canonical hold helpers, the three enforcement triggers
-- (appointments, booking_requests, student_booking_action_requests) and
-- revoke_instructor_capability against disposable synthetic fixtures.
-- One transaction, rolled back at the end -- nothing persists. Assumes
-- 20260918050000 has been applied. Authenticated callers are simulated with
-- `set local role authenticated` + set_config('request.jwt.claims', ...)
-- (same pattern as the Slice 2 / Slice 6 suites).
--
-- Deterministic UUID block: 00000000-0000-0000-0000-00001a7{SS}{yyy}
--   SS = studio index (01 = A, 02 = B); yyy = 3-hex entity sequence.
--   x001/x002 staff, x101.. instructor users, x201.. instructors,
--   x301 client.

begin;

-- ============================================================================
-- Fixtures
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-00001a701000', 'Slice7 Studio A', 't-landmark1a-s7-studio-a'),
  ('00000000-0000-0000-0000-00001a702000', 'Slice7 Studio B', 't-landmark1a-s7-studio-b');

insert into auth.users (id, email)
select ('00000000-0000-0000-0000-00001a701' || lpad(gs::text, 3, '0'))::uuid,
       't-landmark1a-s7-a-user' || gs || '@example.test'
from unnest(array[1, 2, 101, 102, 103, 105, 106, 107, 108, 109, 110, 111]) gs;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00001a702101', 't-landmark1a-s7-b-user101@example.test');

insert into public.profiles (id, email, full_name)
select id, email, 'Slice7 ' || email from auth.users
where email like 't-landmark1a-s7-%'
on conflict (id) do nothing;

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-00001a701001', '00000000-0000-0000-0000-00001a701000', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001a701002', '00000000-0000-0000-0000-00001a701000', 'front_desk', true);

-- Studio A instructors.
--  201 iCap      active, capable, linked      (transition-test subject)
--  202 iIncap    active, can_instruct=false, linked
--  203 iInactive inactive, capable, linked
--  204 iUnlinked active, capable, user_id NULL
--  205 iR1       revoke: clean, hybrid-attested (only-can_instruct proof)
--  206 iR2       revoke: blocked by appointment
--  207 iR3       revoke: blocked by booking request
--  208 iR4       revoke: blocked by action request (reschedule w/ appointment_id)
--  209 iR5       revoke: only non-blocking rows -> succeeds
--  210 iR6       revoke: blocked by an approved-instant (book) action request
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-00001a701201', '00000000-0000-0000-0000-00001a701000', '00000000-0000-0000-0000-00001a701101', 'Cap', 'S7', true, true),
  ('00000000-0000-0000-0000-00001a701202', '00000000-0000-0000-0000-00001a701000', '00000000-0000-0000-0000-00001a701102', 'Incap', 'S7', true, false),
  ('00000000-0000-0000-0000-00001a701203', '00000000-0000-0000-0000-00001a701000', '00000000-0000-0000-0000-00001a701103', 'Inactive', 'S7', false, true),
  ('00000000-0000-0000-0000-00001a701204', '00000000-0000-0000-0000-00001a701000', null, 'Unlinked', 'S7', true, true),
  ('00000000-0000-0000-0000-00001a701205', '00000000-0000-0000-0000-00001a701000', '00000000-0000-0000-0000-00001a701105', 'R1', 'S7', true, true),
  ('00000000-0000-0000-0000-00001a701206', '00000000-0000-0000-0000-00001a701000', '00000000-0000-0000-0000-00001a701106', 'R2', 'S7', true, true),
  ('00000000-0000-0000-0000-00001a701207', '00000000-0000-0000-0000-00001a701000', '00000000-0000-0000-0000-00001a701107', 'R3', 'S7', true, true),
  ('00000000-0000-0000-0000-00001a701208', '00000000-0000-0000-0000-00001a701000', '00000000-0000-0000-0000-00001a701108', 'R4', 'S7', true, true),
  ('00000000-0000-0000-0000-00001a701209', '00000000-0000-0000-0000-00001a701000', '00000000-0000-0000-0000-00001a701109', 'R5', 'S7', true, true),
  ('00000000-0000-0000-0000-00001a701210', '00000000-0000-0000-0000-00001a701000', '00000000-0000-0000-0000-00001a701110', 'R6', 'S7', true, true);
update public.instructors set hybrid_client_assignment_attested = true
  where id = '00000000-0000-0000-0000-00001a701205';

-- Studio B instructor (capable there; cross-studio negatives use it at A).
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-00001a702201', '00000000-0000-0000-0000-00001a702000', '00000000-0000-0000-0000-00001a702101', 'B', 'S7', true, true);

insert into public.clients (id, studio_id, first_name, last_name, status)
values ('00000000-0000-0000-0000-00001a701301', '00000000-0000-0000-0000-00001a701000', 'Test', 'Client', 'active');

-- ---------------------------------------------------------------------------
-- Session helpers (pg_temp; postgres-role sections only)
-- ---------------------------------------------------------------------------

create function pg_temp.fails(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlerrm;
end $$;

create function pg_temp.assignability_msg() returns text language sql as $$
  select 'This instructor is no longer available for assignment.'
$$;

create function pg_temp.mk_appt(
  p_instr uuid, p_type text, p_start interval, p_status text default 'scheduled'
) returns uuid language sql as $$
  insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, title, starts_at, ends_at, status)
  values ('00000000-0000-0000-0000-00001a701000', '00000000-0000-0000-0000-00001a701301', p_instr,
          p_type::public.appointment_type, 't', now() + p_start, now() + p_start + interval '1 hour',
          p_status::public.appointment_status)
  returning id
$$;

create function pg_temp.mk_br(
  p_instr uuid, p_status text, p_type text, p_start interval, p_appt uuid default null
) returns uuid language sql as $$
  insert into public.booking_requests (studio_id, client_id, instructor_id, source, status, appointment_type,
                                       requested_starts_at, requested_ends_at, appointment_id)
  values ('00000000-0000-0000-0000-00001a701000', '00000000-0000-0000-0000-00001a701301', p_instr,
          'portal_schedule', p_status, p_type, now() + p_start, now() + p_start + interval '1 hour', p_appt)
  returning id
$$;

create function pg_temp.mk_ar(
  p_instr uuid, p_action text, p_status text, p_lesson text, p_start interval,
  p_mode text default 'approval_required', p_appt uuid default null
) returns uuid language sql as $$
  insert into public.student_booking_action_requests (studio_id, client_id, appointment_id, action_type, mode, status,
                                                      lesson_type, instructor_id, requested_starts_at, requested_ends_at)
  values ('00000000-0000-0000-0000-00001a701000', '00000000-0000-0000-0000-00001a701301', p_appt, p_action, p_mode, p_status,
          p_lesson, p_instr, now() + p_start, now() + p_start + interval '1 hour')
  returning id
$$;

-- ============================================================================
-- A. Canonical helpers
-- ============================================================================

do $$
declare
  v_label text;
  v_expected boolean;
  v_def text;
  v_vals text[];
  v_n int := 0;
begin
  -- A1. Every appointment_type enum label is explicitly classified.
  for v_label in select e.enumlabel from pg_type t join pg_enum e on e.enumtypid = t.oid where t.typname = 'appointment_type' loop
    v_expected := case v_label
      when 'private_lesson' then true when 'group_class' then true when 'intro_lesson' then true
      when 'coaching' then true when 'practice_party' then true when 'event' then true
      when 'floor_space_rental' then false when 'room_unavailable' then false
      else null end;
    assert v_expected is not null, format('A1 FAILED: appointment_type label %s is not classified by this suite -- classify it and the helper explicitly', v_label);
    assert public._landmark1a_is_instructional_type(v_label) = v_expected, format('A1 FAILED: is_instructional_type(%s) wrong', v_label);
    v_n := v_n + 1;
  end loop;
  assert v_n = 8, format('A1 FAILED: expected 8 appointment_type labels, saw %s', v_n);
  raise notice 'A1 PASSED: all appointment types classified (6 instructional, 2 excluded)';

  -- A2. NULL type fails closed.
  assert public._landmark1a_is_instructional_type(null) = true, 'A2 FAILED: null type must be instructional (fail-closed)';
  raise notice 'A2 PASSED: null type fails closed as instructional';

  -- A3. Every appointment_status label is classified against the hold predicate.
  v_n := 0;
  for v_label in select e.enumlabel from pg_type t join pg_enum e on e.enumtypid = t.oid where t.typname = 'appointment_status' loop
    v_expected := case v_label
      when 'scheduled' then true when 'confirmed' then true when 'rescheduled' then true
      when 'attended' then false when 'cancelled' then false when 'no_show' then false
      else null end;
    assert v_expected is not null, format('A3 FAILED: appointment_status label %s is not classified', v_label);
    assert public._landmark1a_appointment_holds_instructor('private_lesson', v_label, now() + interval '1 day') = v_expected,
      format('A3 FAILED: appointment holds(%s) wrong', v_label);
    v_n := v_n + 1;
  end loop;
  assert v_n = 6, format('A3 FAILED: expected 6 status labels, saw %s', v_n);
  raise notice 'A3 PASSED: all appointment statuses classified';

  -- A4. Appointment hold: null / unknown status fails closed; past, non-instructional do not hold; null type holds.
  assert public._landmark1a_appointment_holds_instructor('private_lesson', null, now() + interval '1 day') = true, 'A4 FAILED: null status must hold';
  assert public._landmark1a_appointment_holds_instructor('private_lesson', 'weird_new_status', now() + interval '1 day') = true, 'A4 FAILED: unknown status must hold';
  assert public._landmark1a_appointment_holds_instructor('private_lesson', 'scheduled', now() - interval '1 minute') = false, 'A4 FAILED: ended appointment must not hold';
  assert public._landmark1a_appointment_holds_instructor('private_lesson', 'scheduled', now() + interval '1 minute') = true, 'A4 FAILED: in-progress/ends-in-future must hold';
  assert public._landmark1a_appointment_holds_instructor('floor_space_rental', 'scheduled', now() + interval '1 day') = false, 'A4 FAILED: floor rental must not hold';
  assert public._landmark1a_appointment_holds_instructor(null, 'scheduled', now() + interval '1 day') = true, 'A4 FAILED: null type must hold';
  raise notice 'A4 PASSED: appointment hold predicate semantics';

  -- A5. CHECK-constraint value sets are exactly what this suite classified (a new value fails here).
  select pg_get_constraintdef(oid) into v_def from pg_constraint where conname = 'booking_requests_status_check';
  select array_agg(m[1] order by m[1]) into v_vals from regexp_matches(v_def, '''([a-z_]+)''::text', 'g') m;
  assert v_vals = array['approved','cancelled','declined','pending'], format('A5 FAILED: booking_requests.status CHECK changed: %s', v_vals);
  select pg_get_constraintdef(oid) into v_def from pg_constraint where conname = 'student_booking_action_requests_status_check';
  select array_agg(m[1] order by m[1]) into v_vals from regexp_matches(v_def, '''([a-z_]+)''::text', 'g') m;
  assert v_vals = array['approved','cancelled','declined','executed','expired','failed','pending'], format('A5 FAILED: action status CHECK changed: %s', v_vals);
  select pg_get_constraintdef(oid) into v_def from pg_constraint where conname = 'student_booking_action_requests_action_type_check';
  select array_agg(m[1] order by m[1]) into v_vals from regexp_matches(v_def, '''([a-z_]+)''::text', 'g') m;
  assert v_vals = array['book','cancel','reschedule'], format('A5 FAILED: action_type CHECK changed: %s', v_vals);
  raise notice 'A5 PASSED: request CHECK value sets match the classified sets';

  -- A6. Booking-request hold: every status; materialized (appointment_id) does not hold; past does not; non-instructional does not.
  assert public._landmark1a_booking_request_holds_instructor('pending', null, now() + interval '1 day', 'intro_lesson') = true, 'A6 FAILED: pending must hold';
  assert public._landmark1a_booking_request_holds_instructor('approved', null, now() + interval '1 day', 'intro_lesson') = true, 'A6 FAILED: approved w/o appointment must hold';
  assert public._landmark1a_booking_request_holds_instructor('approved', gen_random_uuid(), now() + interval '1 day', 'intro_lesson') = false, 'A6 FAILED: approved+appointment_id (materialized) must not hold';
  assert public._landmark1a_booking_request_holds_instructor('declined', null, now() + interval '1 day', 'intro_lesson') = false, 'A6 FAILED: declined must not hold';
  assert public._landmark1a_booking_request_holds_instructor('cancelled', null, now() + interval '1 day', 'intro_lesson') = false, 'A6 FAILED: cancelled must not hold';
  assert public._landmark1a_booking_request_holds_instructor('pending', null, now() - interval '1 day', 'intro_lesson') = false, 'A6 FAILED: past start must not hold';
  assert public._landmark1a_booking_request_holds_instructor('pending', null, null, 'intro_lesson') = false, 'A6 FAILED: null start must not hold';
  assert public._landmark1a_booking_request_holds_instructor('pending', null, now() + interval '1 day', 'floor_space_rental') = false, 'A6 FAILED: non-instructional must not hold';
  assert public._landmark1a_booking_request_holds_instructor('pending', null, now() + interval '1 day', null) = true, 'A6 FAILED: null type must hold';
  raise notice 'A6 PASSED: booking-request hold predicate';

  -- A7. Action-request hold: reschedule carrying an appointment id still holds; cancel does not; terminal/past/non-instructional do not.
  assert public._landmark1a_action_request_holds_instructor('pending', 'book', now() + interval '1 day', 'private_lesson') = true, 'A7 FAILED: pending book must hold';
  assert public._landmark1a_action_request_holds_instructor('approved', 'book', now() + interval '1 day', 'private_lesson') = true, 'A7 FAILED: approved (instant) book must hold';
  assert public._landmark1a_action_request_holds_instructor('pending', 'reschedule', now() + interval '1 day', 'private_lesson') = true, 'A7 FAILED: reschedule must hold (no appointment_id condition)';
  assert public._landmark1a_action_request_holds_instructor('pending', 'cancel', now() + interval '1 day', 'private_lesson') = false, 'A7 FAILED: cancel must not hold';
  assert public._landmark1a_action_request_holds_instructor('executed', 'book', now() + interval '1 day', 'private_lesson') = false, 'A7 FAILED: executed must not hold';
  assert public._landmark1a_action_request_holds_instructor('declined', 'book', now() + interval '1 day', 'private_lesson') = false, 'A7 FAILED: declined must not hold';
  assert public._landmark1a_action_request_holds_instructor('failed', 'book', now() + interval '1 day', 'private_lesson') = false, 'A7 FAILED: failed must not hold';
  assert public._landmark1a_action_request_holds_instructor('expired', 'book', now() + interval '1 day', 'private_lesson') = false, 'A7 FAILED: expired must not hold';
  assert public._landmark1a_action_request_holds_instructor('cancelled', 'book', now() + interval '1 day', 'private_lesson') = false, 'A7 FAILED: cancelled must not hold';
  assert public._landmark1a_action_request_holds_instructor('pending', 'book', now() - interval '1 day', 'private_lesson') = false, 'A7 FAILED: past start must not hold';
  assert public._landmark1a_action_request_holds_instructor('pending', 'book', null, 'private_lesson') = false, 'A7 FAILED: null start must not hold';
  assert public._landmark1a_action_request_holds_instructor('pending', 'book', now() + interval '1 day', 'floor_space_rental') = false, 'A7 FAILED: non-instructional must not hold';
  assert public._landmark1a_action_request_holds_instructor('pending', 'book', now() + interval '1 day', null) = true, 'A7 FAILED: null lesson type must hold (execution defaults to private_lesson)';
  raise notice 'A7 PASSED: action-request hold predicate';
end $$;

-- ============================================================================
-- B. Appointment enforcement
-- ============================================================================

do $$
declare
  v_cap constant uuid := '00000000-0000-0000-0000-00001a701201';
  v_incap constant uuid := '00000000-0000-0000-0000-00001a701202';
  v_inactive constant uuid := '00000000-0000-0000-0000-00001a701203';
  v_unlinked constant uuid := '00000000-0000-0000-0000-00001a701204';
  v_b constant uuid := '00000000-0000-0000-0000-00001a702201';
  v_a uuid;
  v_err text;
begin
  -- B1. Slice 5 insert behavior unchanged: valid succeeds, invalid rejected.
  v_a := pg_temp.mk_appt(v_cap, 'private_lesson', interval '1 day');
  assert v_a is not null, 'B1 FAILED: valid instructor insert should succeed';
  assert pg_temp.fails(format('select pg_temp.mk_appt(%L, ''private_lesson'', interval ''1 day'')', v_incap)) = pg_temp.assignability_msg(), 'B1 FAILED: incapable insert';
  assert pg_temp.fails(format('select pg_temp.mk_appt(%L, ''private_lesson'', interval ''1 day'')', v_inactive)) = pg_temp.assignability_msg(), 'B1 FAILED: inactive insert';
  assert pg_temp.fails(format('select pg_temp.mk_appt(%L, ''private_lesson'', interval ''1 day'')', v_unlinked)) = pg_temp.assignability_msg(), 'B1 FAILED: unlinked insert';
  assert pg_temp.fails(format('select pg_temp.mk_appt(%L, ''private_lesson'', interval ''1 day'')', v_b)) = pg_temp.assignability_msg(), 'B1 FAILED: cross-studio insert';
  -- Slice 5 preserved: even a historical / terminal INSERT is validated.
  assert pg_temp.fails(format('select pg_temp.mk_appt(%L, ''private_lesson'', interval ''-3 days'', ''cancelled'')', v_incap)) = pg_temp.assignability_msg(), 'B1 FAILED: historical terminal insert must still validate (Slice 5)';
  -- Non-instructional and null-instructor inserts unaffected.
  assert pg_temp.mk_appt(v_incap, 'floor_space_rental', interval '1 day') is not null, 'B1 FAILED: floor rental unaffected';
  raise notice 'B1 PASSED: Slice 5 insert behavior preserved';

  -- B2. Instructor retarget still validates (even on a terminal row -- Slice 5 preserved).
  v_a := pg_temp.mk_appt(v_cap, 'private_lesson', interval '2 days', 'cancelled');
  assert pg_temp.fails(format('update public.appointments set instructor_id = %L where id = %L', v_incap, v_a)) = pg_temp.assignability_msg(), 'B2 FAILED: retarget to incapable';
  assert pg_temp.fails(format('update public.appointments set instructor_id = %L where id = %L', v_b, v_a)) = pg_temp.assignability_msg(), 'B2 FAILED: retarget cross-studio';
  raise notice 'B2 PASSED: instructor retarget validates';

  -- B3. cancelled -> scheduled (future), instructor since made incapable: REJECTED.
  v_a := pg_temp.mk_appt(v_cap, 'private_lesson', interval '3 days');
  update public.appointments set status = 'cancelled' where id = v_a;
  update public.instructors set can_instruct = false where id = v_cap;
  assert pg_temp.fails(format('update public.appointments set status = ''scheduled'' where id = %L', v_a)) = pg_temp.assignability_msg(), 'B3 FAILED: cancelled->scheduled must be rejected';
  assert pg_temp.fails(format('update public.appointments set status = ''confirmed'' where id = %L', v_a)) = pg_temp.assignability_msg(), 'B3 FAILED: cancelled->confirmed must be rejected';
  assert pg_temp.fails(format('update public.appointments set status = ''rescheduled'' where id = %L', v_a)) = pg_temp.assignability_msg(), 'B3 FAILED: cancelled->rescheduled must be rejected';
  raise notice 'B3 PASSED: cancelled -> live rejected for incapable instructor';

  -- B4. no_show -> confirmed on a type the lifecycle trigger does not guard (event): REJECTED.
  update public.instructors set can_instruct = true where id = v_cap;
  v_a := pg_temp.mk_appt(v_cap, 'event', interval '4 days');
  update public.appointments set status = 'no_show' where id = v_a;
  update public.instructors set can_instruct = false where id = v_cap;
  assert pg_temp.fails(format('update public.appointments set status = ''confirmed'' where id = %L', v_a)) = pg_temp.assignability_msg(), 'B4 FAILED: no_show->confirmed (event) must be rejected';
  -- And attended -> live for practice_party.
  update public.instructors set can_instruct = true where id = v_cap;
  v_a := pg_temp.mk_appt(v_cap, 'practice_party', interval '4 days');
  update public.appointments set status = 'attended' where id = v_a;
  update public.instructors set can_instruct = false where id = v_cap;
  assert pg_temp.fails(format('update public.appointments set status = ''scheduled'' where id = %L', v_a)) = pg_temp.assignability_msg(), 'B4 FAILED: attended->scheduled (practice_party) must be rejected';
  -- Private lessons: the pre-existing lifecycle trigger rejects first (unchanged behavior).
  update public.instructors set can_instruct = true where id = v_cap;
  v_a := pg_temp.mk_appt(v_cap, 'private_lesson', interval '4 days');
  update public.appointments set status = 'no_show' where id = v_a;
  update public.instructors set can_instruct = false where id = v_cap;
  v_err := pg_temp.fails(format('update public.appointments set status = ''confirmed'' where id = %L', v_a));
  assert v_err like 'Attended lessons cannot be cancelled%', format('B4 FAILED: private no_show->confirmed should hit the existing lifecycle guard, got: %s', v_err);
  raise notice 'B4 PASSED: no_show/attended -> live rejected (lifecycle guard still first for private lessons)';

  -- B5. historical -> future ends_at move, instructor incapable: REJECTED.
  update public.instructors set can_instruct = true where id = v_cap;
  v_a := pg_temp.mk_appt(v_cap, 'private_lesson', interval '-3 days');
  update public.instructors set can_instruct = false where id = v_cap;
  assert pg_temp.fails(format('update public.appointments set starts_at = now() + interval ''5 days'', ends_at = now() + interval ''5 days 1 hour'' where id = %L', v_a)) = pg_temp.assignability_msg(), 'B5 FAILED: past->future must be rejected';
  -- ends_at-only move (starts_at untouched, still valid) is also rejected.
  assert pg_temp.fails(format('update public.appointments set ends_at = now() + interval ''1 day'' where id = %L', v_a)) = pg_temp.assignability_msg(), 'B5 FAILED: ends_at-only past->future must be rejected';
  raise notice 'B5 PASSED: past -> future rejected for incapable instructor';

  -- B6. non-instructional -> instructional, instructor incapable: REJECTED.
  v_a := pg_temp.mk_appt(v_incap, 'floor_space_rental', interval '6 days');
  assert pg_temp.fails(format('update public.appointments set appointment_type = ''private_lesson'' where id = %L', v_a)) = pg_temp.assignability_msg(), 'B6 FAILED: non-instr->instr must be rejected';
  raise notice 'B6 PASSED: non-instructional -> instructional rejected';

  -- B7. studio move: rejected (instructor not in destination studio).
  update public.instructors set can_instruct = true where id = v_cap;
  v_a := pg_temp.mk_appt(v_cap, 'private_lesson', interval '7 days');
  assert pg_temp.fails(format('update public.appointments set studio_id = %L where id = %L', '00000000-0000-0000-0000-00001a702000', v_a)) = pg_temp.assignability_msg(), 'B7 FAILED: studio move must be rejected';
  raise notice 'B7 PASSED: studio move rejected';

  -- B8. Continuously-live edits succeed WITHOUT validation, even after the instructor is incapable.
  v_a := pg_temp.mk_appt(v_cap, 'private_lesson', interval '8 days');
  update public.appointments set status = 'confirmed' where id = v_a; -- capable: succeeds
  assert (select status::text from public.appointments where id = v_a) = 'confirmed', 'B8 FAILED: capable scheduled->confirmed';
  update public.instructors set can_instruct = false where id = v_cap;
  update public.appointments set status = 'rescheduled' where id = v_a; -- live -> live: no validation
  update public.appointments set status = 'scheduled', ends_at = now() + interval '9 days', starts_at = now() + interval '9 days' - interval '1 hour' where id = v_a; -- future -> future
  update public.appointments set notes = 'metadata only' where id = v_a;
  update public.appointments set room_id = null, payment_status = 'paid' where id = v_a;
  assert (select notes from public.appointments where id = v_a) = 'metadata only', 'B8 FAILED: metadata edit';
  raise notice 'B8 PASSED: continuously-live and metadata edits never validate';

  -- B9. Removal of work always possible with an incapable instructor.
  update public.appointments set status = 'cancelled' where id = v_a; -- live -> cancelled
  assert (select status::text from public.appointments where id = v_a) = 'cancelled', 'B9 FAILED: live->cancelled';
  update public.instructors set can_instruct = true where id = v_cap;
  v_a := pg_temp.mk_appt(v_cap, 'private_lesson', interval '10 days');
  update public.instructors set can_instruct = false where id = v_cap;
  update public.appointments set starts_at = now() - interval '2 days', ends_at = now() - interval '2 days' + interval '1 hour' where id = v_a; -- live -> past
  update public.appointments set status = 'attended' where id = v_a; -- past, terminal cleanup
  delete from public.appointments where id = v_a; -- DELETE
  update public.instructors set can_instruct = true where id = v_cap;
  v_a := pg_temp.mk_appt(v_cap, 'private_lesson', interval '11 days');
  update public.instructors set can_instruct = false where id = v_cap;
  delete from public.appointments where id = v_a;
  assert not exists (select 1 from public.appointments where id = v_a), 'B9 FAILED: DELETE';
  raise notice 'B9 PASSED: cancel / move-to-past / complete / DELETE remain possible';

  update public.instructors set can_instruct = true where id = v_cap;
end $$;

-- ============================================================================
-- C. Request-table enforcement
-- ============================================================================

do $$
declare
  v_cap constant uuid := '00000000-0000-0000-0000-00001a701201';
  v_incap constant uuid := '00000000-0000-0000-0000-00001a701202';
  v_inactive constant uuid := '00000000-0000-0000-0000-00001a701203';
  v_unlinked constant uuid := '00000000-0000-0000-0000-00001a701204';
  v_b constant uuid := '00000000-0000-0000-0000-00001a702201';
  v_msg text := 'This instructor is no longer available for assignment.';
  v_r uuid;
  v_appt uuid;
begin
  -- ---- booking_requests ----
  v_r := pg_temp.mk_br(v_cap, 'pending', 'intro_lesson', interval '1 day');
  assert v_r is not null, 'C1 FAILED: valid booking request';
  assert pg_temp.fails(format('select pg_temp.mk_br(%L, ''pending'', ''intro_lesson'', interval ''1 day'')', v_incap)) = v_msg, 'C1 FAILED: incapable';
  assert pg_temp.fails(format('select pg_temp.mk_br(%L, ''pending'', ''intro_lesson'', interval ''1 day'')', v_inactive)) = v_msg, 'C1 FAILED: inactive';
  assert pg_temp.fails(format('select pg_temp.mk_br(%L, ''pending'', ''intro_lesson'', interval ''1 day'')', v_unlinked)) = v_msg, 'C1 FAILED: unlinked';
  assert pg_temp.fails(format('select pg_temp.mk_br(%L, ''pending'', ''intro_lesson'', interval ''1 day'')', v_b)) = v_msg, 'C1 FAILED: cross-studio';
  assert pg_temp.fails(format('select pg_temp.mk_br(%L, ''approved'', ''intro_lesson'', interval ''1 day'')', v_incap)) = v_msg, 'C1 FAILED: approved(no appt) incapable';
  raise notice 'C1 PASSED: booking_requests INSERT validated (valid, incapable, inactive, unlinked, cross-studio)';

  -- Non-live / non-gated inserts with an incapable instructor succeed.
  assert pg_temp.mk_br(v_incap, 'declined', 'intro_lesson', interval '1 day') is not null, 'C2 FAILED: declined insert';
  assert pg_temp.mk_br(v_incap, 'cancelled', 'intro_lesson', interval '1 day') is not null, 'C2 FAILED: cancelled insert';
  assert pg_temp.mk_br(v_incap, 'pending', 'intro_lesson', interval '-1 day') is not null, 'C2 FAILED: past insert';
  assert pg_temp.mk_br(v_incap, 'pending', 'floor_space_rental', interval '1 day') is not null, 'C2 FAILED: non-instructional insert';
  assert pg_temp.mk_br(null, 'pending', 'intro_lesson', interval '1 day') is not null, 'C2 FAILED: null instructor insert';
  raise notice 'C2 PASSED: non-live booking_requests inserts are not gated';

  -- Reopen declined -> pending revalidates; approved-without-appointment too.
  v_r := pg_temp.mk_br(v_incap, 'declined', 'intro_lesson', interval '2 days');
  assert pg_temp.fails(format('update public.booking_requests set status = ''pending'' where id = %L', v_r)) = v_msg, 'C3 FAILED: reopen';
  assert pg_temp.fails(format('update public.booking_requests set status = ''approved'' where id = %L', v_r)) = v_msg, 'C3 FAILED: declined->approved(no appt)';
  -- past -> future move revalidates.
  v_r := pg_temp.mk_br(v_incap, 'pending', 'intro_lesson', interval '-2 days');
  assert pg_temp.fails(format('update public.booking_requests set requested_starts_at = now() + interval ''3 days'', requested_ends_at = now() + interval ''3 days 1 hour'' where id = %L', v_r)) = v_msg, 'C3 FAILED: past->future';
  raise notice 'C3 PASSED: booking_requests reopen / past->future revalidate';

  -- Retarget revalidates.
  v_r := pg_temp.mk_br(v_cap, 'pending', 'intro_lesson', interval '3 days');
  assert pg_temp.fails(format('update public.booking_requests set instructor_id = %L where id = %L', v_incap, v_r)) = v_msg, 'C4 FAILED: retarget';
  assert pg_temp.fails(format('update public.booking_requests set instructor_id = %L where id = %L', v_b, v_r)) = v_msg, 'C4 FAILED: retarget cross-studio';
  raise notice 'C4 PASSED: booking_requests retarget revalidates';

  -- Terminal cleanup + materialization remain possible with an incapable instructor.
  update public.instructors set can_instruct = false where id = v_cap;
  update public.booking_requests set status = 'declined' where id = v_r;      -- live -> declined
  v_r := pg_temp.mk_br(v_incap, 'declined', 'intro_lesson', interval '4 days');
  update public.booking_requests set staff_note = 'cleanup' where id = v_r;   -- non-hold metadata
  update public.instructors set can_instruct = true where id = v_cap;
  v_r := pg_temp.mk_br(v_cap, 'pending', 'intro_lesson', interval '5 days');
  v_appt := pg_temp.mk_appt(v_cap, 'intro_lesson', interval '5 days');
  update public.instructors set can_instruct = false where id = v_cap;
  update public.booking_requests set status = 'approved', appointment_id = v_appt where id = v_r; -- materialization
  update public.booking_requests set status = 'cancelled' where id = v_r;
  update public.instructors set can_instruct = true where id = v_cap;
  raise notice 'C5 PASSED: booking_requests terminal cleanup and materialization are not gated';

  -- ---- student_booking_action_requests ----
  v_r := pg_temp.mk_ar(v_cap, 'book', 'pending', 'private_lesson', interval '1 day');
  assert v_r is not null, 'C6 FAILED: valid book';
  assert pg_temp.fails(format('select pg_temp.mk_ar(%L, ''book'', ''pending'', ''private_lesson'', interval ''1 day'')', v_incap)) = v_msg, 'C6 FAILED: incapable book';
  assert pg_temp.fails(format('select pg_temp.mk_ar(%L, ''book'', ''approved'', ''private_lesson'', interval ''1 day'', ''instant'')', v_incap)) = v_msg, 'C6 FAILED: instant approved book';
  assert pg_temp.fails(format('select pg_temp.mk_ar(%L, ''book'', ''pending'', ''private_lesson'', interval ''1 day'')', v_inactive)) = v_msg, 'C6 FAILED: inactive';
  assert pg_temp.fails(format('select pg_temp.mk_ar(%L, ''book'', ''pending'', ''private_lesson'', interval ''1 day'')', v_unlinked)) = v_msg, 'C6 FAILED: unlinked';
  assert pg_temp.fails(format('select pg_temp.mk_ar(%L, ''book'', ''pending'', ''private_lesson'', interval ''1 day'')', v_b)) = v_msg, 'C6 FAILED: cross-studio';
  assert pg_temp.fails(format('select pg_temp.mk_ar(%L, ''book'', ''pending'', null, interval ''1 day'')', v_incap)) = v_msg, 'C6 FAILED: null lesson type fails closed';
  raise notice 'C6 PASSED: action-request book INSERT validated';

  -- reschedule carrying an existing appointment id is still gated.
  v_appt := pg_temp.mk_appt(v_cap, 'private_lesson', interval '2 days');
  assert pg_temp.mk_ar(v_cap, 'reschedule', 'pending', 'private_lesson', interval '3 days', 'approval_required', v_appt) is not null, 'C7 FAILED: valid reschedule';
  assert pg_temp.fails(format('select pg_temp.mk_ar(%L, ''reschedule'', ''pending'', ''private_lesson'', interval ''3 days'', ''approval_required'', %L)', v_incap, v_appt)) = v_msg, 'C7 FAILED: reschedule retargeting incapable instructor';
  raise notice 'C7 PASSED: reschedule request (with appointment_id) validated';

  -- cancel actions and terminal states are never gated as work creation.
  assert pg_temp.mk_ar(v_incap, 'cancel', 'pending', 'private_lesson', interval '1 day') is not null, 'C8 FAILED: cancel action';
  assert pg_temp.mk_ar(v_incap, 'cancel', 'approved', 'private_lesson', interval '1 day', 'instant') is not null, 'C8 FAILED: instant cancel action';
  assert pg_temp.mk_ar(v_incap, 'book', 'declined', 'private_lesson', interval '1 day') is not null, 'C8 FAILED: declined';
  assert pg_temp.mk_ar(v_incap, 'book', 'executed', 'private_lesson', interval '1 day') is not null, 'C8 FAILED: executed';
  assert pg_temp.mk_ar(v_incap, 'book', 'failed', 'private_lesson', interval '1 day') is not null, 'C8 FAILED: failed';
  assert pg_temp.mk_ar(v_incap, 'book', 'expired', 'private_lesson', interval '1 day') is not null, 'C8 FAILED: expired';
  assert pg_temp.mk_ar(v_incap, 'book', 'cancelled', 'private_lesson', interval '1 day') is not null, 'C8 FAILED: cancelled';
  assert pg_temp.mk_ar(v_incap, 'book', 'pending', 'floor_space_rental', interval '1 day') is not null, 'C8 FAILED: non-instructional';
  assert pg_temp.mk_ar(v_incap, 'book', 'pending', 'private_lesson', interval '-1 day') is not null, 'C8 FAILED: past start';
  raise notice 'C8 PASSED: cancel actions / terminal states / past / non-instructional not gated';

  -- reopen, retarget, and cleanup.
  v_r := pg_temp.mk_ar(v_incap, 'book', 'declined', 'private_lesson', interval '2 days');
  assert pg_temp.fails(format('update public.student_booking_action_requests set status = ''pending'' where id = %L', v_r)) = v_msg, 'C9 FAILED: reopen';
  v_r := pg_temp.mk_ar(v_cap, 'book', 'pending', 'private_lesson', interval '2 days');
  assert pg_temp.fails(format('update public.student_booking_action_requests set instructor_id = %L where id = %L', v_incap, v_r)) = v_msg, 'C9 FAILED: retarget';
  assert pg_temp.fails(format('update public.student_booking_action_requests set instructor_id = %L where id = %L', v_b, v_r)) = v_msg, 'C9 FAILED: retarget cross-studio';
  update public.instructors set can_instruct = false where id = v_cap;
  update public.student_booking_action_requests set status = 'executed', executed_at = now() where id = v_r; -- terminal cleanup
  update public.instructors set can_instruct = true where id = v_cap;
  v_r := pg_temp.mk_ar(v_cap, 'book', 'pending', 'private_lesson', interval '2 days');
  update public.instructors set can_instruct = false where id = v_cap;
  update public.student_booking_action_requests set status = 'approved', decision_at = now() where id = v_r; -- pending -> approved: still live, no revalidation
  update public.student_booking_action_requests set status = 'failed', failure_reason = 'x' where id = v_r;
  update public.instructors set can_instruct = true where id = v_cap;
  raise notice 'C9 PASSED: action-request reopen/retarget revalidate; cleanup and pending->approved do not';
end $$;

-- ============================================================================
-- D. revoke_instructor_capability
-- ============================================================================

do $$
declare
  v_r1 constant uuid := '00000000-0000-0000-0000-00001a701205';
  v_r2 constant uuid := '00000000-0000-0000-0000-00001a701206';
  v_r3 constant uuid := '00000000-0000-0000-0000-00001a701207';
  v_r4 constant uuid := '00000000-0000-0000-0000-00001a701208';
  v_r5 constant uuid := '00000000-0000-0000-0000-00001a701209';
  v_r6 constant uuid := '00000000-0000-0000-0000-00001a701210';
  v_a constant uuid := '00000000-0000-0000-0000-00001a701000';
  v_b constant uuid := '00000000-0000-0000-0000-00001a702000';
  v_appt uuid;
  v_before jsonb;
  v_after jsonb;
  v_n int;
  v_err text;
begin
  -- Set up blockers (postgres role).
  perform pg_temp.mk_appt(v_r2, 'private_lesson', interval '1 day');
  perform pg_temp.mk_br(v_r3, 'pending', 'intro_lesson', interval '1 day');
  v_appt := pg_temp.mk_appt(v_r4, 'private_lesson', interval '1 day');
  update public.appointments set status = 'cancelled' where id = v_appt; -- reschedule target appt is terminal; request alone must block
  perform pg_temp.mk_ar(v_r4, 'reschedule', 'pending', 'private_lesson', interval '2 days', 'approval_required', v_appt);
  perform pg_temp.mk_ar(v_r6, 'book', 'approved', 'private_lesson', interval '2 days', 'instant');
  -- R5: only rows that must NOT block.
  v_appt := pg_temp.mk_appt(v_r5, 'private_lesson', interval '1 day');
  update public.appointments set status = 'cancelled' where id = v_appt;                        -- future, terminal
  perform pg_temp.mk_appt(v_r5, 'private_lesson', interval '-3 days');                          -- past
  perform pg_temp.mk_appt(v_r5, 'floor_space_rental', interval '1 day');                        -- non-instructional
  perform pg_temp.mk_br(v_r5, 'declined', 'intro_lesson', interval '1 day');
  perform pg_temp.mk_br(v_r5, 'cancelled', 'intro_lesson', interval '1 day');
  perform pg_temp.mk_br(v_r5, 'pending', 'intro_lesson', interval '-1 day');                    -- past
  perform pg_temp.mk_br(v_r5, 'pending', 'floor_space_rental', interval '1 day');               -- non-instructional
  perform pg_temp.mk_ar(v_r5, 'cancel', 'pending', 'private_lesson', interval '1 day');         -- cancel action
  perform pg_temp.mk_ar(v_r5, 'book', 'executed', 'private_lesson', interval '1 day');
  perform pg_temp.mk_ar(v_r5, 'book', 'declined', 'private_lesson', interval '1 day');
  perform pg_temp.mk_ar(v_r5, 'book', 'pending', 'floor_space_rental', interval '1 day');

  -- D1. Unauthenticated.
  begin
    perform public.revoke_instructor_capability(v_a, v_r1);
    assert false, 'D1 FAILED: expected unauthenticated rejection';
  exception when others then
    assert sqlerrm = 'Not authenticated.', format('D1 FAILED: got %s', sqlerrm);
  end;
  raise notice 'D1 PASSED: unauthenticated rejected';

  -- D2. Front-desk (not owner/admin) rejected.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a701002', 'email', 't-landmark1a-s7-a-user2@example.test')::text, true);
  begin
    perform public.revoke_instructor_capability(v_a, v_r1);
    assert false, 'D2 FAILED: expected unauthorized rejection';
  exception when others then
    assert sqlerrm = 'Not authorized to manage instructors for this studio.', format('D2 FAILED: got %s', sqlerrm);
  end;
  reset role;
  raise notice 'D2 PASSED: front_desk rejected';

  -- D3/D4. Admin of A: cross-studio rejected both ways.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a701001', 'email', 't-landmark1a-s7-a-user1@example.test')::text, true);
  begin
    perform public.revoke_instructor_capability(v_b, '00000000-0000-0000-0000-00001a702201');
    assert false, 'D3 FAILED: admin of A must not revoke in studio B';
  exception when others then
    assert sqlerrm = 'Not authorized to manage instructors for this studio.', format('D3 FAILED: got %s', sqlerrm);
  end;
  begin
    perform public.revoke_instructor_capability(v_a, '00000000-0000-0000-0000-00001a702201');
    assert false, 'D4 FAILED: studio-B instructor id under studio-A must not resolve';
  exception when others then
    assert sqlerrm = 'Instructor not found for this studio.', format('D4 FAILED: got %s', sqlerrm);
  end;
  reset role;
  assert (select can_instruct from public.instructors where id = '00000000-0000-0000-0000-00001a702201') = true, 'D4 FAILED: B instructor mutated';
  raise notice 'D3/D4 PASSED: cross-studio rejected';

  -- D5. Blockers: each class blocks, nothing mutates, counts in message, no PII.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a701001', 'email', 't-landmark1a-s7-a-user1@example.test')::text, true);
  begin
    perform public.revoke_instructor_capability(v_a, v_r2);
    assert false, 'D5 FAILED: appointment blocker';
  exception when others then
    assert sqlerrm like '%1 upcoming appointment(s), 0 booking request(s), 0 self-service action request(s)%', format('D5 FAILED: got %s', sqlerrm);
  end;
  begin
    perform public.revoke_instructor_capability(v_a, v_r3);
    assert false, 'D5 FAILED: booking-request blocker';
  exception when others then
    assert sqlerrm like '%0 upcoming appointment(s), 1 booking request(s), 0 self-service action request(s)%', format('D5 FAILED: got %s', sqlerrm);
  end;
  begin
    perform public.revoke_instructor_capability(v_a, v_r4);
    assert false, 'D5 FAILED: action-request (reschedule) blocker';
  exception when others then
    assert sqlerrm like '%0 upcoming appointment(s), 0 booking request(s), 1 self-service action request(s)%', format('D5 FAILED: got %s', sqlerrm);
  end;
  begin
    perform public.revoke_instructor_capability(v_a, v_r6);
    assert false, 'D5 FAILED: instant-approved book blocker';
  exception when others then
    assert sqlerrm like '%1 self-service action request(s)%', format('D5 FAILED: got %s', sqlerrm);
    assert sqlerrm !~* '(@|example|client)', 'D5 FAILED: error must contain no PII';
  end;
  reset role;
  assert (select count(*) from public.instructors where id in (v_r2, v_r3, v_r4, v_r6) and can_instruct = true) = 4, 'D5 FAILED: a blocked revoke mutated can_instruct';
  assert (select count(*) from public.instructor_audit_events where instructor_id in (v_r2, v_r3, v_r4, v_r6) and event_type = 'capability_revoked') = 0, 'D5 FAILED: a blocked revoke wrote an audit event';
  raise notice 'D5 PASSED: appointment / booking-request / action-request (reschedule, instant) blockers reject with safe counts';

  -- D6. Non-blocking rows do not block; only can_instruct changes; exactly one audit.
  select to_jsonb(i) - 'can_instruct' - 'updated_at' into v_before from public.instructors i where id = v_r1;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a701001', 'email', 't-landmark1a-s7-a-user1@example.test')::text, true);
  perform public.revoke_instructor_capability(v_a, v_r1);
  perform public.revoke_instructor_capability(v_a, v_r5);
  reset role;
  select to_jsonb(i) - 'can_instruct' - 'updated_at' into v_after from public.instructors i where id = v_r1;
  assert v_before = v_after, 'D6 FAILED: revoke changed something other than can_instruct';
  assert (select can_instruct from public.instructors where id = v_r1) = false, 'D6 FAILED: R1 not revoked';
  assert (select can_instruct from public.instructors where id = v_r5) = false, 'D6 FAILED: R5 not revoked despite only non-blocking rows';
  assert (select hybrid_client_assignment_attested from public.instructors where id = v_r1) = true, 'D6 FAILED: hybrid attestation touched';
  select count(*) into v_n from public.instructor_audit_events where instructor_id = v_r1 and event_type = 'capability_revoked';
  assert v_n = 1, format('D6 FAILED: expected exactly 1 capability_revoked audit, got %s', v_n);
  raise notice 'D6 PASSED: clean revoke succeeds; only can_instruct changes; one audit; non-blocking rows do not block';

  -- D7. Already-incapable: idempotent no-op, no second audit.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a701001', 'email', 't-landmark1a-s7-a-user1@example.test')::text, true);
  perform public.revoke_instructor_capability(v_a, v_r1);
  reset role;
  select count(*) into v_n from public.instructor_audit_events where instructor_id = v_r1 and event_type = 'capability_revoked';
  assert v_n = 1, format('D7 FAILED: no-op wrote another audit (%s)', v_n);
  raise notice 'D7 PASSED: already-incapable revoke is a silent no-op';

  -- D8. End-to-end: after revoking R5 its cancelled future appointment cannot be resurrected,
  -- but the terminal rows can still be cleaned up / cancelled.
  v_appt := (select id from public.appointments where instructor_id = v_r5 and status = 'cancelled' and ends_at > now() limit 1);
  v_err := pg_temp.fails(format('update public.appointments set status = ''scheduled'' where id = %L', v_appt));
  assert v_err = 'This instructor is no longer available for assignment.', format('D8 FAILED: resurrection after revoke not rejected: %s', v_err);
  assert pg_temp.fails(format('select pg_temp.mk_appt(%L, ''private_lesson'', interval ''1 day'')', v_r5)) = 'This instructor is no longer available for assignment.', 'D8 FAILED: new appointment after revoke';
  assert pg_temp.fails(format('select pg_temp.mk_br(%L, ''pending'', ''intro_lesson'', interval ''1 day'')', v_r5)) = 'This instructor is no longer available for assignment.', 'D8 FAILED: new booking request after revoke';
  assert pg_temp.fails(format('select pg_temp.mk_ar(%L, ''book'', ''pending'', ''private_lesson'', interval ''1 day'')', v_r5)) = 'This instructor is no longer available for assignment.', 'D8 FAILED: new action request after revoke';
  raise notice 'D8 PASSED: after revocation no new future work can attach (appointment, resurrection, booking request, action request)';

  -- D9. Seat freed: the revoked instructor no longer matches the counted predicate.
  assert not exists (select 1 from public.instructors where id = v_r1 and active = true and can_instruct = true and user_id is not null), 'D9 FAILED: revoked instructor still counted';
  raise notice 'D9 PASSED: revoked instructor no longer satisfies the counted-seat predicate';
end $$;

-- ============================================================================
-- E. Static checks
-- ============================================================================

do $$
declare
  v_def text;
  v_fn text;
begin
  -- E1. No Slice 6 seat RPC/helper references the three work tables; the
  -- revoke RPC only ever READS them (no insert/update/delete/for update).
  foreach v_fn in array array[
    'public.grant_instructor_capability(uuid,uuid)',
    'public.reactivate_instructor(uuid,uuid)',
    'public.promote_hybrid_instructor(uuid,uuid,boolean,text)',
    'public._landmark1a_lock_instructor_for_transition(uuid,uuid)',
    'public._landmark1a_authorize_counted_transition(uuid,public.instructors)'
  ] loop
    v_def := pg_get_functiondef(v_fn::regprocedure);
    assert v_def !~* '(appointments|booking_requests|student_booking_action_requests)',
      format('E1 FAILED: %s references a work table (shared->exclusive upgrade / lock inversion risk)', v_fn);
  end loop;
  v_def := pg_get_functiondef('public.revoke_instructor_capability(uuid,uuid)'::regprocedure);
  assert v_def !~* '(insert\s+into|update|delete\s+from)\s+public\.(appointments|booking_requests|student_booking_action_requests)',
    'E1 FAILED: revoke RPC writes a work table';
  assert v_def !~* 'for\s+update\s+of\s+(a|r)\b', 'E1 FAILED: revoke RPC row-locks work tables';
  raise notice 'E1 PASSED: no lock-inversion surface between seat RPCs and work-table writers';

  -- E2. Single SQL source of truth for the instructional type list.
  select string_agg(p.proname, ',') into v_def
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname like '\_landmark1a\_%'
    and p.proname <> '_landmark1a_is_instructional_type'
    and p.prosrc like '%''practice_party''%';
  assert v_def is null, format('E2 FAILED: instructional type list duplicated in: %s', v_def);
  raise notice 'E2 PASSED: instructional type list exists only in _landmark1a_is_instructional_type';

  -- E3. Privileges: helpers/trigger fns unreachable; RPC only authenticated.
  assert not has_function_privilege('authenticated', 'public._landmark1a_is_instructional_type(text)', 'execute'), 'E3 FAILED';
  assert not has_function_privilege('authenticated', 'public._landmark1a_appointment_holds_instructor(text,text,timestamptz)', 'execute'), 'E3 FAILED';
  assert not has_function_privilege('authenticated', 'public._landmark1a_booking_request_holds_instructor(text,uuid,timestamptz,text)', 'execute'), 'E3 FAILED';
  assert not has_function_privilege('authenticated', 'public._landmark1a_action_request_holds_instructor(text,text,timestamptz,text)', 'execute'), 'E3 FAILED';
  assert has_function_privilege('authenticated', 'public.revoke_instructor_capability(uuid,uuid)', 'execute'), 'E3 FAILED: authenticated must execute revoke';
  assert not has_function_privilege('anon', 'public.revoke_instructor_capability(uuid,uuid)', 'execute'), 'E3 FAILED: anon must not execute revoke';
  assert not has_function_privilege('service_role', 'public.revoke_instructor_capability(uuid,uuid)', 'execute'), 'E3 FAILED: service_role must not execute revoke';
  raise notice 'E3 PASSED: privileges';

  raise notice 'LANDMARK 1A SLICE 7 SQL REGRESSION: ALL CASE GROUPS PASSED';
end $$;

rollback;
