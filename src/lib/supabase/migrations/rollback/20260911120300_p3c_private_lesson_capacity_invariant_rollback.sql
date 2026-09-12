-- Rollback for 20260911120300_p3c_private_lesson_capacity_invariant.sql

begin;

drop trigger if exists appointments_enforce_private_lesson_membership_capacity on public.appointments;
drop function if exists public.enforce_private_lesson_membership_capacity();

commit;
