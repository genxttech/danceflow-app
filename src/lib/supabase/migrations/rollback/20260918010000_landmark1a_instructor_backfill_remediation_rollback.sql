-- Rollback for 20260918010000_landmark1a_instructor_backfill_remediation.sql
--
-- Restores each snapshotted row's exact prior (user_id, can_instruct)
-- from this environment's own snapshot table, then drops the snapshot.
-- Touches no row that the forward migration itself did not change.
-- Audit events are never deleted or reversed -- instructor_audit_events
-- is append-only by design (Landmark 1A Slice 1); the historical record
-- of this migration having run is preserved even after a rollback.
-- Does not alter Slice 1/2 infrastructure (the can_instruct column, the
-- audit table/trigger/policy, the linkage RPC/helper) in any way.

begin;

update public.instructors i
set user_id = snap.user_id,
    can_instruct = snap.can_instruct
from migration_support.instructor_backfill_snapshot_20260918010000 snap
where i.id = snap.instructor_id;

drop table if exists migration_support.instructor_backfill_snapshot_20260918010000;

commit;
