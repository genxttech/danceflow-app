-- Rollback for 20260913090500_gc2f_group_class_membership_usage_sync.sql
--
-- Genuinely new trigger + function, no defective-body concern -- safe to
-- drop outright and standalone. Does not touch any client_membership_usage
-- row this trigger may have already written -- those remain valid,
-- preserved history regardless of whether the trigger itself is later
-- removed.

begin;

drop trigger if exists attendance_records_deduct_membership_usage_for_class on public.attendance_records;
drop function if exists public.deduct_membership_usage_for_class_attendee();

commit;
