-- Rollback for 20260913090200_gc2c_group_class_membership_capacity_invariant.sql
--
-- Genuinely new trigger + function, no defective-body concern -- safe to
-- drop outright and standalone.

begin;

drop trigger if exists appointment_attendees_enforce_membership_capacity on public.appointment_attendees;
drop function if exists public.enforce_group_class_membership_capacity();

commit;
