-- FC-1B5D2 D2C-0B -- get_client_appointments_for_checkin /
-- get_client_appointment_for_checkin_validation live-RLS/RPC regression
-- tests.
--
-- CORRECTED (post-independent-review): an earlier version of these RPCs
-- accepted a caller-supplied `target_client_id uuid`, authorized only by
-- "active studio membership" -- letting any active studio member retrieve
-- any other real client's appointments by supplying that client's plain,
-- non-secret UUID. Both RPCs now take `qr_token text` instead and resolve
-- the authorized client internally, via the same predicate
-- get_client_by_qr_token_for_checkin already uses. This file's CASE 4 is
-- the attack case the prior version's test suite was missing: a caller who
-- knows another real client's UUID but does not possess that client's QR
-- token must be unable to retrieve that client's appointments -- and here
-- that is structurally true, not merely tested, because the function no
-- longer accepts a client id argument at all.
--
-- Proves, at the real Postgres level (not mocked):
--   1. an authorized active-studio caller with Client A's valid QR token
--      gets Client A's appointment rows only;
--   2. range filtering works (in-range appears, out-of-range excluded);
--   3. exact appointment-id filtering (the validation RPC) works;
--   4. the caller cannot retrieve Client B's real appointments by
--      supplying Client B's real UUID -- because no client-id parameter
--      exists any more, proven by confirming the corrected signature has
--      no uuid-typed client parameter and by confirming Client A's token
--      + Client B's appointment id returns nothing (case 4b);
--   5. valid Client A token + Client B's appointment id -> validation RPC
--      returns no row;
--   6. valid Client B token + Client B's appointment id succeeds only for
--      a caller who still has an active studio relationship;
--   7. wrong/nonexistent token -> no rows;
--   8. wrong studio + a valid token issued for another studio -> no rows;
--   9. no active studio relationship at all -> no rows, even with the
--      exact correct token;
--   10. an anonymous caller is denied at the grant level;
--   11. both externally-callable functions' return definitions contain
--       exactly the intended, minimized field set;
--   12. the corrected signatures exist and the insecure
--       target_client_id-accepting overloads do not.
--
-- Entire script runs in one transaction and is rolled back at the end --
-- nothing persists. Run via `supabase db query --linked --file <this
-- file>` against DEV.
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-0000005fXXXX (distinct from the 5e block used by
-- the QR identity RPC test file).

begin;

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000005f0001', 'FC-1B5D2 D2C-0B Harness Studio A', 't-fc1b5d2-d2c0b-studio-a'),
  ('00000000-0000-0000-0000-0000005f0002', 'FC-1B5D2 D2C-0B Harness Studio B', 't-fc1b5d2-d2c0b-studio-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000005f1001', 't-fc1b5d2-d2c0b-instructor-a@example.test'),
  ('00000000-0000-0000-0000-0000005f1002', 't-fc1b5d2-d2c0b-instructor-b@example.test'),
  ('00000000-0000-0000-0000-0000005f1003', 't-fc1b5d2-d2c0b-noaccount@example.test');

insert into public.profiles (id, email) values
  ('00000000-0000-0000-0000-0000005f1001', 't-fc1b5d2-d2c0b-instructor-a@example.test'),
  ('00000000-0000-0000-0000-0000005f1002', 't-fc1b5d2-d2c0b-instructor-b@example.test'),
  ('00000000-0000-0000-0000-0000005f1003', 't-fc1b5d2-d2c0b-noaccount@example.test');

-- Instructor A has an active role at Studio A only. Instructor B has an
-- active role at Studio B only. The "noaccount" user has no active
-- user_studio_roles row anywhere.
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000005f1001', '00000000-0000-0000-0000-0000005f0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000005f1002', '00000000-0000-0000-0000-0000005f0002', 'instructor', true);

insert into public.clients (id, studio_id, first_name, last_name, email, status, client_qr_token) values
  ('00000000-0000-0000-0000-0000005f3001', '00000000-0000-0000-0000-0000005f0001', 'D2C0B', 'ClientA', 'd2c0b-clienta@example.test', 'active', 't-fc1b5d2-d2c0b-token-clienta'),
  ('00000000-0000-0000-0000-0000005f3002', '00000000-0000-0000-0000-0000005f0001', 'D2C0B', 'ClientB', 'd2c0b-clientb@example.test', 'active', 't-fc1b5d2-d2c0b-token-clientb'),
  ('00000000-0000-0000-0000-0000005f3003', '00000000-0000-0000-0000-0000005f0002', 'D2C0B', 'ClientOtherStudio', 'd2c0b-clientc@example.test', 'active', 't-fc1b5d2-d2c0b-token-clientc');

insert into public.instructors (id, studio_id, first_name, last_name, active) values
  ('00000000-0000-0000-0000-0000005f2001', '00000000-0000-0000-0000-0000005f0001', 'Teach', 'Erson', true);

insert into public.rooms (id, studio_id, name, active) values
  ('00000000-0000-0000-0000-0000005f4001', '00000000-0000-0000-0000-0000005f0001', 'Studio Room 1', true);

-- Fixed, deterministic "today" window -- the test controls range_start/
-- range_end directly, so this does not depend on when the test is run.
-- appt-in-range: Client A, inside the test's queried range.
-- appt-out-of-range: Client A, outside the queried range.
-- appt-other-client: Client B, same studio, same time window as
--   appt-in-range -- proves client isolation.
insert into public.appointments (
  id, studio_id, client_id, instructor_id, room_id, appointment_type, title, status, starts_at, ends_at
) values
  ('00000000-0000-0000-0000-0000005f5001', '00000000-0000-0000-0000-0000005f0001', '00000000-0000-0000-0000-0000005f3001', '00000000-0000-0000-0000-0000005f2001', '00000000-0000-0000-0000-0000005f4001', 'private_lesson', 'Private with Teach Erson', 'scheduled', '2026-09-01T10:00:00+00', '2026-09-01T11:00:00+00'),
  ('00000000-0000-0000-0000-0000005f5002', '00000000-0000-0000-0000-0000005f0001', '00000000-0000-0000-0000-0000005f3001', '00000000-0000-0000-0000-0000005f2001', '00000000-0000-0000-0000-0000005f4001', 'coaching', 'Out of range coaching', 'scheduled', '2026-09-05T10:00:00+00', '2026-09-05T11:00:00+00'),
  ('00000000-0000-0000-0000-0000005f5003', '00000000-0000-0000-0000-0000005f0001', '00000000-0000-0000-0000-0000005f3002', '00000000-0000-0000-0000-0000005f2001', '00000000-0000-0000-0000-0000005f4001', 'private_lesson', 'Private for Client B', 'scheduled', '2026-09-01T10:30:00+00', '2026-09-01T11:30:00+00');

-- ============================================================================
-- CASE 1: authorized active-studio caller with Client A's valid QR token
-- gets exactly Client A's in-range appointment, with the full display
-- field set correct.
-- ============================================================================
do $$
declare
  v_count int;
  v_row record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1001')::text, true);

  select count(*) into v_count
  from public.get_client_appointments_for_checkin(
    '00000000-0000-0000-0000-0000005f0001'::uuid,
    't-fc1b5d2-d2c0b-token-clienta',
    '2026-09-01T00:00:00+00'::timestamptz,
    '2026-09-02T00:00:00+00'::timestamptz
  );

  select * into v_row
  from public.get_client_appointments_for_checkin(
    '00000000-0000-0000-0000-0000005f0001'::uuid,
    't-fc1b5d2-d2c0b-token-clienta',
    '2026-09-01T00:00:00+00'::timestamptz,
    '2026-09-02T00:00:00+00'::timestamptz
  );

  reset role;

  if v_count <> 1 then
    raise exception 'FAIL T-fc1b5d2-d2c0b-1: expected exactly 1 in-range appointment, got %', v_count;
  end if;

  if v_row.id is distinct from '00000000-0000-0000-0000-0000005f5001'::uuid
    or v_row.title is distinct from 'Private with Teach Erson'
    or v_row.appointment_type is distinct from 'private_lesson'
    or v_row.status is distinct from 'scheduled'
    or v_row.instructor_first_name is distinct from 'Teach'
    or v_row.instructor_last_name is distinct from 'Erson'
    or v_row.room_name is distinct from 'Studio Room 1'
  then
    raise exception 'FAIL T-fc1b5d2-d2c0b-1: returned row does not match expected appointment/fields';
  end if;

  raise notice 'PASS T-fc1b5d2-d2c0b-1: authorized caller with the correct token gets the correct in-range display row';
end $$;

-- ============================================================================
-- CASE 2: widening the range to include the out-of-range appointment
-- returns both, ordered by starts_at ascending.
-- ============================================================================
do $$
declare
  v_ids uuid[];
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1001')::text, true);

  select array_agg(id order by starts_at asc) into v_ids
  from public.get_client_appointments_for_checkin(
    '00000000-0000-0000-0000-0000005f0001'::uuid,
    't-fc1b5d2-d2c0b-token-clienta',
    '2026-09-01T00:00:00+00'::timestamptz,
    '2026-09-06T00:00:00+00'::timestamptz
  );

  reset role;

  if v_ids is distinct from array[
    '00000000-0000-0000-0000-0000005f5001'::uuid,
    '00000000-0000-0000-0000-0000005f5002'::uuid
  ] then
    raise exception 'FAIL T-fc1b5d2-d2c0b-2: expected both appointments in starts_at order, got %', v_ids;
  end if;

  raise notice 'PASS T-fc1b5d2-d2c0b-2: range widening + ordering both correct';
end $$;

-- ============================================================================
-- CASE 3: exact appointment-id filtering via the validation RPC, with the
-- correct token.
-- ============================================================================
do $$
declare
  v_count int;
  v_row record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1001')::text, true);

  select count(*) into v_count
  from public.get_client_appointment_for_checkin_validation(
    '00000000-0000-0000-0000-0000005f0001'::uuid,
    't-fc1b5d2-d2c0b-token-clienta',
    '00000000-0000-0000-0000-0000005f5001'::uuid
  );

  select * into v_row
  from public.get_client_appointment_for_checkin_validation(
    '00000000-0000-0000-0000-0000005f0001'::uuid,
    't-fc1b5d2-d2c0b-token-clienta',
    '00000000-0000-0000-0000-0000005f5001'::uuid
  );

  reset role;

  if v_count <> 1 then
    raise exception 'FAIL T-fc1b5d2-d2c0b-3: expected exactly 1 row for exact appointment-id validation, got %', v_count;
  end if;

  if v_row.id is distinct from '00000000-0000-0000-0000-0000005f5001'::uuid
    or v_row.appointment_type is distinct from 'private_lesson'
    or v_row.status is distinct from 'scheduled'
  then
    raise exception 'FAIL T-fc1b5d2-d2c0b-3: validation row does not match expected appointment/fields';
  end if;

  raise notice 'PASS T-fc1b5d2-d2c0b-3: exact appointment-id validation with the correct token returns the correct minimal row';
end $$;

-- ============================================================================
-- CASE 4: THE KEY ATTACK CASE. Instructor A knows Client B's real UUID
-- (e.g. from a URL elsewhere in the app) but does NOT possess Client B's
-- QR token. Structurally, there is no parameter left to even attempt
-- supplying Client B's id -- confirm this by asserting the corrected
-- function signatures contain no uuid-typed client parameter at all.
-- ============================================================================
do $$
declare
  v_display_args text;
  v_validation_args text;
begin
  select pg_get_function_arguments(p.oid) into v_display_args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_client_appointments_for_checkin';

  select pg_get_function_arguments(p.oid) into v_validation_args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_client_appointment_for_checkin_validation';

  if v_display_args is distinct from 'target_studio_id uuid, qr_token text, range_start timestamp with time zone, range_end timestamp with time zone' then
    raise exception 'FAIL T-fc1b5d2-d2c0b-4a: unexpected display RPC signature: %', v_display_args;
  end if;

  if v_validation_args is distinct from 'target_studio_id uuid, qr_token text, target_appointment_id uuid' then
    raise exception 'FAIL T-fc1b5d2-d2c0b-4a: unexpected validation RPC signature: %', v_validation_args;
  end if;

  if v_display_args like '%client_id%' or v_validation_args like '%client_id%' then
    raise exception 'FAIL T-fc1b5d2-d2c0b-4a: a client-id parameter still exists on one of the RPCs';
  end if;

  raise notice 'PASS T-fc1b5d2-d2c0b-4a: neither RPC accepts a client-id parameter -- there is no argument through which Client B''s real UUID could be supplied';
end $$;

-- ============================================================================
-- CASE 4b: corroborating behavioral proof -- Client A's valid token
-- combined with Client B's real appointment id returns nothing (the
-- token-resolved client is Client A; Client B's appointment's client_id
-- never matches).
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1001')::text, true);

  select count(*) into v_count
  from public.get_client_appointment_for_checkin_validation(
    '00000000-0000-0000-0000-0000005f0001'::uuid,
    't-fc1b5d2-d2c0b-token-clienta',
    '00000000-0000-0000-0000-0000005f5003'::uuid
  );

  reset role;

  if v_count <> 0 then
    raise exception 'FAIL T-fc1b5d2-d2c0b-4b: Client A''s token resolved Client B''s appointment, got % rows', v_count;
  end if;

  raise notice 'PASS T-fc1b5d2-d2c0b-4b: Client A''s token + Client B''s appointment id returns nothing';
end $$;

-- ============================================================================
-- CASE 5: valid Client B token + Client B's appointment id succeeds for a
-- caller who still has an active studio relationship at that studio.
-- ============================================================================
do $$
declare
  v_count int;
  v_row record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1001')::text, true);

  select count(*) into v_count
  from public.get_client_appointment_for_checkin_validation(
    '00000000-0000-0000-0000-0000005f0001'::uuid,
    't-fc1b5d2-d2c0b-token-clientb',
    '00000000-0000-0000-0000-0000005f5003'::uuid
  );

  select * into v_row
  from public.get_client_appointment_for_checkin_validation(
    '00000000-0000-0000-0000-0000005f0001'::uuid,
    't-fc1b5d2-d2c0b-token-clientb',
    '00000000-0000-0000-0000-0000005f5003'::uuid
  );

  reset role;

  if v_count <> 1 or v_row.id is distinct from '00000000-0000-0000-0000-0000005f5003'::uuid then
    raise exception 'FAIL T-fc1b5d2-d2c0b-5: expected Client B''s own token to resolve Client B''s own appointment, got % rows', v_count;
  end if;

  raise notice 'PASS T-fc1b5d2-d2c0b-5: possessing Client B''s actual token DOES correctly resolve Client B''s appointment -- this is the legitimate, intended path';
end $$;

-- ============================================================================
-- CASE 6: wrong/nonexistent token -> no rows.
-- ============================================================================
do $$
declare
  v_count_display int;
  v_count_validation int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1001')::text, true);

  select count(*) into v_count_display
  from public.get_client_appointments_for_checkin(
    '00000000-0000-0000-0000-0000005f0001'::uuid,
    'this-token-does-not-exist',
    '2026-09-01T00:00:00+00'::timestamptz,
    '2026-09-02T00:00:00+00'::timestamptz
  );

  select count(*) into v_count_validation
  from public.get_client_appointment_for_checkin_validation(
    '00000000-0000-0000-0000-0000005f0001'::uuid,
    'this-token-does-not-exist',
    '00000000-0000-0000-0000-0000005f5001'::uuid
  );

  reset role;

  if v_count_display <> 0 or v_count_validation <> 0 then
    raise exception 'FAIL T-fc1b5d2-d2c0b-6: wrong token returned rows (display=%, validation=%), expected 0/0', v_count_display, v_count_validation;
  end if;

  raise notice 'PASS T-fc1b5d2-d2c0b-6: wrong token returns nothing on both functions';
end $$;

-- ============================================================================
-- CASE 7: wrong studio -- a valid token issued for Studio A's client,
-- called with Studio B as target_studio_id (even by a caller with a real
-- active role at Studio B) -> no rows.
-- ============================================================================
do $$
declare
  v_count_display int;
  v_count_validation int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1002')::text, true);

  select count(*) into v_count_display
  from public.get_client_appointments_for_checkin(
    '00000000-0000-0000-0000-0000005f0002'::uuid,
    't-fc1b5d2-d2c0b-token-clienta',
    '2026-09-01T00:00:00+00'::timestamptz,
    '2026-09-02T00:00:00+00'::timestamptz
  );

  select count(*) into v_count_validation
  from public.get_client_appointment_for_checkin_validation(
    '00000000-0000-0000-0000-0000005f0002'::uuid,
    't-fc1b5d2-d2c0b-token-clienta',
    '00000000-0000-0000-0000-0000005f5001'::uuid
  );

  reset role;

  if v_count_display <> 0 or v_count_validation <> 0 then
    raise exception 'FAIL T-fc1b5d2-d2c0b-7: cross-studio token use returned rows (display=%, validation=%), expected 0/0', v_count_display, v_count_validation;
  end if;

  raise notice 'PASS T-fc1b5d2-d2c0b-7: a Studio A client token cannot be used against Studio B, even by a real Studio B instructor';
end $$;

-- ============================================================================
-- CASE 8: correct token AND correct studio, but the caller has no active
-- role at that studio at all -> no rows.
-- ============================================================================
do $$
declare
  v_count_display int;
  v_count_validation int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1003')::text, true);

  select count(*) into v_count_display
  from public.get_client_appointments_for_checkin(
    '00000000-0000-0000-0000-0000005f0001'::uuid,
    't-fc1b5d2-d2c0b-token-clienta',
    '2026-09-01T00:00:00+00'::timestamptz,
    '2026-09-02T00:00:00+00'::timestamptz
  );

  select count(*) into v_count_validation
  from public.get_client_appointment_for_checkin_validation(
    '00000000-0000-0000-0000-0000005f0001'::uuid,
    't-fc1b5d2-d2c0b-token-clienta',
    '00000000-0000-0000-0000-0000005f5001'::uuid
  );

  reset role;

  if v_count_display <> 0 or v_count_validation <> 0 then
    raise exception 'FAIL T-fc1b5d2-d2c0b-8: caller with no active studio relationship got rows (display=%, validation=%), expected 0/0', v_count_display, v_count_validation;
  end if;

  raise notice 'PASS T-fc1b5d2-d2c0b-8: no active studio relationship is denied on both functions even with the exact correct token';
end $$;

-- ============================================================================
-- CASE 9: anonymous caller is denied at the grant level (insufficient_
-- privilege), not merely returned an empty result.
-- ============================================================================
do $$
declare
  v_denied_display boolean := false;
  v_denied_validation boolean := false;
begin
  set local role anon;

  begin
    perform count(*)
    from public.get_client_appointments_for_checkin(
      '00000000-0000-0000-0000-0000005f0001'::uuid,
      't-fc1b5d2-d2c0b-token-clienta',
      '2026-09-01T00:00:00+00'::timestamptz,
      '2026-09-02T00:00:00+00'::timestamptz
    );
  exception when insufficient_privilege then
    v_denied_display := true;
  end;

  begin
    perform count(*)
    from public.get_client_appointment_for_checkin_validation(
      '00000000-0000-0000-0000-0000005f0001'::uuid,
      't-fc1b5d2-d2c0b-token-clienta',
      '00000000-0000-0000-0000-0000005f5001'::uuid
    );
  exception when insufficient_privilege then
    v_denied_validation := true;
  end;

  reset role;

  if not v_denied_display or not v_denied_validation then
    raise exception 'FAIL T-fc1b5d2-d2c0b-9: anon role should be denied EXECUTE outright on both functions';
  end if;

  raise notice 'PASS T-fc1b5d2-d2c0b-9: anon role is denied EXECUTE at the grant level on both functions';
end $$;

-- ============================================================================
-- CASE 10: the private helper is also denied to anon and, unlike the two
-- outer RPCs, is denied to authenticated too -- it has no external callers
-- at all, by design.
-- ============================================================================
do $$
declare
  v_denied_anon boolean := false;
  v_denied_authenticated boolean := false;
begin
  set local role anon;
  begin
    perform public._resolve_qr_checkin_client_id('00000000-0000-0000-0000-0000005f0001'::uuid, 't-fc1b5d2-d2c0b-token-clienta');
  exception when insufficient_privilege then
    v_denied_anon := true;
  end;
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1001')::text, true);
  begin
    perform public._resolve_qr_checkin_client_id('00000000-0000-0000-0000-0000005f0001'::uuid, 't-fc1b5d2-d2c0b-token-clienta');
  exception when insufficient_privilege then
    v_denied_authenticated := true;
  end;
  reset role;

  if not v_denied_anon or not v_denied_authenticated then
    raise exception 'FAIL T-fc1b5d2-d2c0b-10: the private helper must be unreachable by both anon and authenticated directly';
  end if;

  raise notice 'PASS T-fc1b5d2-d2c0b-10: the private resolver helper has no external callers at all -- reachable only from inside the two outer SECURITY DEFINER RPCs';
end $$;

-- ============================================================================
-- CASE 11: both externally-callable functions' return definitions contain
-- exactly the intended, minimized field set.
-- ============================================================================
do $$
declare
  v_display_returns text;
  v_validation_returns text;
begin
  select pg_get_function_result(p.oid) into v_display_returns
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_client_appointments_for_checkin';

  select pg_get_function_result(p.oid) into v_validation_returns
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_client_appointment_for_checkin_validation';

  if v_display_returns is distinct from 'TABLE(id uuid, title text, appointment_type text, status text, starts_at timestamp with time zone, ends_at timestamp with time zone, instructor_first_name text, instructor_last_name text, room_name text)' then
    raise exception 'FAIL T-fc1b5d2-d2c0b-11a: unexpected display return shape: %', v_display_returns;
  end if;

  if v_validation_returns is distinct from 'TABLE(id uuid, appointment_type text, status text)' then
    raise exception 'FAIL T-fc1b5d2-d2c0b-11b: unexpected validation return shape: %', v_validation_returns;
  end if;

  if v_display_returns like '%notes%' or v_display_returns like '%payment%' or v_display_returns like '%price%'
    or v_display_returns like '%client_id%' or v_display_returns like '%studio_id%' or v_display_returns like '%created_by%'
    or v_display_returns like '%package%' or v_display_returns like '%membership%'
  then
    raise exception 'FAIL T-fc1b5d2-d2c0b-11c: display return shape contains a field outside the approved set: %', v_display_returns;
  end if;

  if v_validation_returns like '%notes%' or v_validation_returns like '%payment%' or v_validation_returns like '%price%'
    or v_validation_returns like '%client_id%' or v_validation_returns like '%studio_id%' or v_validation_returns like '%created_by%'
    or v_validation_returns like '%title%' or v_validation_returns like '%instructor%' or v_validation_returns like '%room%'
  then
    raise exception 'FAIL T-fc1b5d2-d2c0b-11d: validation return shape contains a field outside the approved set: %', v_validation_returns;
  end if;

  raise notice 'PASS T-fc1b5d2-d2c0b-11: both functions'' return shapes contain exactly the approved minimized field sets';
end $$;

-- ============================================================================
-- CASE 12: the insecure target_client_id-accepting overloads do not exist
-- -- only the corrected, token-accepting signatures are present.
-- ============================================================================
do $$
declare
  v_overload_count int;
begin
  select count(*) into v_overload_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('get_client_appointments_for_checkin', 'get_client_appointment_for_checkin_validation')
    and pg_get_function_arguments(p.oid) like '%target_client_id%';

  if v_overload_count <> 0 then
    raise exception 'FAIL T-fc1b5d2-d2c0b-12: found % insecure target_client_id-accepting overload(s) still present', v_overload_count;
  end if;

  raise notice 'PASS T-fc1b5d2-d2c0b-12: no insecure target_client_id-accepting overload exists on either function';
end $$;

rollback;
