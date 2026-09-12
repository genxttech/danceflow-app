-- Rollback for 20260911120400_p4_scheduling_conflict_and_lock_helpers.sql

begin;

drop function if exists public._lock_and_check_scheduling_resources(uuid, uuid, uuid, timestamptz, timestamptz, uuid);
drop function if exists public._assert_no_scheduling_conflict(uuid, uuid, uuid, timestamptz, timestamptz, uuid);

commit;
