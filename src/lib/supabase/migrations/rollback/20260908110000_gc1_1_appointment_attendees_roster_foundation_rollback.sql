-- GC-1.1 rollback -- purely additive migration, so rollback is a total,
-- clean removal with no prior state to restore. Nothing else was altered by
-- the forward migration.

begin;

drop trigger if exists appointment_attendees_enforce_integrity on public.appointment_attendees;
drop function if exists public.enforce_appointment_attendee_integrity();
drop table if exists public.appointment_attendees;

commit;
