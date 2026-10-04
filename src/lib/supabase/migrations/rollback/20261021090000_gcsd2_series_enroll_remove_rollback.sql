-- ============================================================================
-- ROLLBACK for 20261021090000_gcsd2_series_enroll_remove.sql (GC-S1D-2).
--
-- The migration is function-only: it adds four public RPCs and six internal helpers and changes no table, column,
-- index, policy, trigger or data. Rolling back drops exactly those functions. Enrollments and removals already made
-- through them are ordinary appointment_attendees rows / cancellations and remain valid; nothing is reverted.
-- If the application with the series roster controls is still deployed, roll the APPLICATION back first (the series
-- controls would otherwise call functions that no longer exist); the single-class roster workflow is unaffected.
-- ============================================================================

begin;

drop function if exists public.remove_group_class_series_from(uuid, uuid, integer);
drop function if exists public.preview_group_class_series_removal(uuid, uuid);
drop function if exists public.enroll_group_class_series_from(uuid, uuid, text, uuid, uuid, integer);
drop function if exists public.preview_group_class_series_enrollment(uuid, uuid, text, uuid, uuid);
drop function if exists public._gcsd2_remove_run(uuid, uuid, boolean, integer);
drop function if exists public._gcsd2_enroll_run(uuid, uuid, text, uuid, uuid, boolean, integer);
drop function if exists public._gcsd2_lock_series_and_targets(uuid, uuid, uuid);
drop function if exists public._gcsd2_targets(uuid, uuid);
drop function if exists public._gcsd2_check(uuid, uuid, text, uuid, boolean);

commit;
