-- 20261013090000_ent1_usage_allowance_reservations_rollback.sql
--
-- Reviewed rollback for ENT-1. NEVER run automatically.
--
-- Order: roll the APPLICATION back first (the campaign send actions call these
-- functions and fail closed without them), then run this file.
--
-- This removes only the reservation table and its three functions. usage_events
-- rows written by finalize_usage_reservation are real usage and are KEPT (the
-- existing summary trigger already counted them). Rolling back re-opens the
-- check-then-record concurrency gap for campaign allowance, but nothing else.

begin;

drop function if exists public.release_usage_reservation(uuid);
drop function if exists public.finalize_usage_reservation(uuid, integer, jsonb);
drop function if exists public.reserve_usage_allowance(text, uuid, uuid, text, integer, integer, date, date, text, text, text, uuid, uuid, integer);
drop table if exists public.usage_reservations;

commit;
