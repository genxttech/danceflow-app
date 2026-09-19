-- Landmark 1A -- Slice 7 rollback verification.
--
-- Run AFTER applying
-- rollback/20260918050000_landmark1a_slice7_instructor_capability_revocation_rollback.sql
-- (and BEFORE re-applying the forward migration). Read-only: asserts the
-- database is back to the exact Slice 5 appointment-enforcement state and
-- that no Slice 7 object remains. Whitespace-normalized md5 is used because
-- PROD's copies of the Slice 5 bodies carry CRLF line endings; the
-- fingerprints below were recorded from DEV and PROD before Slice 7.

do $$
declare
  v_def text;
begin
  -- Exact Slice 5 function bodies (whitespace-normalized).
  assert (select md5(regexp_replace(prosrc, '\s+', '', 'g')) from pg_proc
          where pronamespace = 'public'::regnamespace and proname = '_landmark1a_assert_assignable_instructor')
         = '3bd2e01128fe4ee74485ef8c1f02cd81',
    'ROLLBACK FAILED: _landmark1a_assert_assignable_instructor is not the Slice 5 body';
  assert (select md5(regexp_replace(prosrc, '\s+', '', 'g')) from pg_proc
          where pronamespace = 'public'::regnamespace and proname = '_landmark1a_enforce_appointment_instructor_assignability')
         = 'abf3b94c8224ff2207e7f15e96ae8d17',
    'ROLLBACK FAILED: appointment trigger function is not the Slice 5 body';

  -- Assert helper carries no advisory lock again.
  select prosrc into v_def from pg_proc
    where pronamespace = 'public'::regnamespace and proname = '_landmark1a_assert_assignable_instructor';
  assert v_def !~* 'advisory', 'ROLLBACK FAILED: assert helper still takes an advisory lock';

  -- Exact Slice 5 trigger definition (original column list).
  select pg_get_triggerdef(oid) into v_def from pg_trigger
    where tgname = 'landmark1a_enforce_appointment_instructor_assignability' and tgrelid = 'public.appointments'::regclass;
  assert v_def like '%BEFORE INSERT OR UPDATE OF instructor_id, studio_id, appointment_type ON public.appointments%',
    format('ROLLBACK FAILED: appointment trigger definition: %s', v_def);

  -- Nothing from Slice 7 remains.
  assert not exists (
    select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname in (
      'revoke_instructor_capability', '_landmark1a_is_instructional_type',
      '_landmark1a_appointment_holds_instructor', '_landmark1a_booking_request_holds_instructor',
      '_landmark1a_action_request_holds_instructor',
      '_landmark1a_enforce_booking_request_instructor_assignability',
      '_landmark1a_enforce_action_request_instructor_assignability')),
    'ROLLBACK FAILED: a Slice 7 function remains';
  assert not exists (
    select 1 from pg_trigger where tgname in (
      'landmark1a_enforce_booking_request_instructor_assignability',
      'landmark1a_enforce_action_request_instructor_assignability')),
    'ROLLBACK FAILED: a Slice 7 request trigger remains';

  -- Slice 5/6 objects untouched by rollback.
  assert exists (select 1 from pg_proc where proname = 'grant_instructor_capability'), 'Slice 6 RPC missing';
  assert exists (select 1 from pg_proc where proname = '_landmark1a_lock_instructor_for_transition'), 'Slice 6 helper missing';

  raise notice 'SLICE 7 ROLLBACK FINGERPRINTS: exact Slice 5 state restored';
end $$;
