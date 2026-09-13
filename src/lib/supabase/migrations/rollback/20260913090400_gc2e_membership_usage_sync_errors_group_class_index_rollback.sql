-- Rollback for 20260913090400_gc2e_membership_usage_sync_errors_group_class_index.sql
--
-- Genuinely new, standalone index on an already-existing, previously-unused
-- column -- safe to drop outright. Does not remove the attendance_record_id
-- column itself (it predates this slice and is not owned by it).

begin;

drop index if exists public.uq_membership_usage_sync_errors_unresolved_attendance_reason;

commit;
