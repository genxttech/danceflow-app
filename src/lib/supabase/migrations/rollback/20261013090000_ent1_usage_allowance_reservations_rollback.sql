-- 20261013090000_ent1_usage_allowance_reservations_rollback.sql
--
-- Reviewed rollback for ENT-1. NEVER run automatically.
--
-- Order: roll the APPLICATION back first (the campaign send actions call these
-- functions and fail closed without them), then run this file.
--
-- This removes only the reservation table and its two functions. usage_events
-- rows written by settle_usage_reservation are real usage and are KEPT (the
-- existing summary trigger already counted them). Rolling back re-opens the
-- check-then-record concurrency gap for campaign allowance, but nothing else.
--
-- Unsettled batches: run only when no reservation has an open batch
-- (batch_started_at is not null), or their successful sends are lost from usage.

begin;

do $$
begin
  if exists (select 1 from public.usage_reservations where status = 'reserved' and batch_started_at is not null) then
    raise exception 'ENT-1 rollback refused: a reservation has an unsettled batch (successful sends not yet counted)';
  end if;
end $$;

drop function if exists public.settle_usage_reservation(uuid, integer, integer, jsonb);
drop function if exists public.reserve_usage_allowance(text, uuid, uuid, text, integer, integer, date, date, text, text, text, uuid, uuid, uuid[], integer);
drop table if exists public.usage_reservations;

commit;
