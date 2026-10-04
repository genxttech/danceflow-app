-- Rollback for 20261018090000_gcsc4_series_cancellation_lifecycle.sql.
-- Drops the reactivation guard trigger and function, the two series-cancellation RPCs and the
-- two internal helpers. No data is changed and nothing else is touched (the released
-- cancel_group_class_appointment and every S1C-2 / S1C-3 object remain). Series rows already
-- stored as 'cancelled' stay 'cancelled' (the status value is part of the original S1A check).
-- After rollback a tenant can again move a cancelled group class back to a scheduled status by
-- table UPDATE, and the application must not be running the GC-S1C-4 release.

begin;

drop trigger if exists appointments_05_guard_group_class_reactivation on public.appointments;
drop function if exists public._gcsc4_guard_group_class_reactivation();

drop function if exists public.cancel_group_class_series_from(uuid);
drop function if exists public.preview_group_class_series_cancellation(uuid);
drop function if exists public._gcsc4_series_remaining_after(uuid, integer);
drop function if exists public._gcsc4_series_cancel_targets(uuid, integer);

commit;
