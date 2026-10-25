-- Rollback of 20261224090000 (TW-4F F5 cancellation target read). The function is read-only and owns no data: a plain DROP.
-- Roll the application back first (or leave it: without the function the panel falls back to the manual cancellation path).
begin;
drop function if exists public.tw4_rfl_cancel_target(uuid, uuid);
commit;
