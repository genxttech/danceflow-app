-- ============================================================================
-- ROLLBACK for 20261022090000_gcsd3_series_enrollment_settings.sql (GC-S1D-3).
--
-- The migration is function-only: it adds two public RPCs and three internal helpers and changes no table, column, index,
-- policy, trigger or data. Rolling back drops exactly those functions. Enrollment settings already changed through them are
-- ordinary group_class_enrollment_policies rows and remain valid; nothing is reverted.
-- If the application with the series settings control is still deployed, roll the APPLICATION back first (the control would
-- otherwise call functions that no longer exist); the single-class settings editor is unaffected.
-- ============================================================================

begin;

drop function if exists public.apply_group_class_series_enrollment_settings(uuid, boolean, boolean, boolean, boolean, integer);
drop function if exists public.preview_group_class_series_enrollment_settings(uuid, boolean, boolean, boolean, boolean);
drop function if exists public._gcsd3_run(uuid, boolean, boolean, boolean, boolean, boolean, integer);
drop function if exists public._gcsd3_targets(uuid);
drop function if exists public._gcsd3_check(uuid);

commit;
