-- Rollback for 20260918020000_landmark1a_instructor_assignability_enforcement.sql
--
-- Drops exactly the trigger and the two functions this migration created.
-- No existing RPC body was modified by the forward migration, so there is
-- nothing else to restore. Touches no data.

begin;

drop trigger if exists landmark1a_enforce_appointment_instructor_assignability
  on public.appointments;

drop function if exists public._landmark1a_enforce_appointment_instructor_assignability();

drop function if exists public._landmark1a_assert_assignable_instructor(uuid, uuid);

commit;
