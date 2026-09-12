-- Rollback for 20260911121000_p6e_attended_appointment_lifecycle_guard.sql
--
-- Unlike P6b/P6c/P6d, this migration introduces a genuinely NEW trigger
-- and function -- it does not replace the body of any pre-existing
-- object, so there is no "restores a known-destructive prior body"
-- concern here. This rollback simply removes what P6e added, in
-- dependency-safe order (the trigger, which depends on the function,
-- before the function itself).

begin;

drop trigger if exists appointments_enforce_attendance_lifecycle on public.appointments;
drop function if exists public.enforce_private_lesson_attendance_lifecycle();

commit;
