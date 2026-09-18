-- Rollback for 20260918030000_landmark1a_slice5a_capability_activation_bridge.sql
--
-- Two explicit states, never confused:
--   A. Forward migration never committed (e.g. the named-row guard
--      aborted it) -- the snapshot table was never created. This
--      rollback must never be invoked in that state; there is nothing
--      to undo.
--   B. Forward migration committed successfully -- the snapshot table
--      exists with exactly the 5 pre-mutation rows.
--
-- Absence of the expected snapshot is a hard, explicit stop, never a
-- silent no-op -- a "successful" rollback with no real prior-value
-- source to restore from would be a false claim. Restores each
-- environment's own exact captured values, never a hardcoded literal.
-- Never touches instructor_audit_events -- those rows are structurally
-- immutable via Slice 1's BEFORE UPDATE OR DELETE trigger regardless of
-- what this script attempts.

begin;

do $$
begin
  if to_regclass('migration_support.instructor_capability_bridge_snapshot_20260918') is null then
    raise exception
      'Slice 5A rollback blocked: required snapshot table migration_support.instructor_capability_bridge_snapshot_20260918 is missing -- nothing to safely restore from.';
  end if;
end $$;

update public.instructors i
set can_instruct = snap.can_instruct
from migration_support.instructor_capability_bridge_snapshot_20260918 snap
where i.id = snap.instructor_id;

drop table if exists migration_support.instructor_capability_bridge_snapshot_20260918;

commit;
