-- Rollback for 20260913090600_gc2g_group_class_membership_consumption_lifecycle_guard.sql
--
-- Genuinely new trigger + function, no defective-body concern -- safe to
-- drop outright and standalone. Does not touch any client_membership_usage
-- row -- this guard only ever blocks a status write, never mutates data.

begin;

drop trigger if exists attendance_records_enforce_membership_consumption_lifecycle on public.attendance_records;
drop function if exists public.enforce_group_class_membership_consumption_lifecycle();

commit;
