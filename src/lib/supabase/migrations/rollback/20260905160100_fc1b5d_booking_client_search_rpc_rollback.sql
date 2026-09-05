-- Rollback for 20260905160100_fc1b5d_booking_client_search_rpc.sql
--
-- Drops the booking-client discovery RPC. Safe to run independently of the
-- teaching-access RPC's migration/rollback. No RLS policy is touched by
-- either the forward migration or this rollback.
drop function if exists public.search_bookable_clients_for_instructor(uuid, text, int);
