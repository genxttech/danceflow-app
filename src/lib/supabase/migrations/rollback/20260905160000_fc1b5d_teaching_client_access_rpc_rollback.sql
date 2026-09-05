-- Rollback for 20260905160000_fc1b5d_teaching_client_access_rpc.sql
--
-- Drops the teaching-client access RPC. Safe to run independently of the
-- booking-search RPC's migration/rollback. No RLS policy is touched by
-- either the forward migration or this rollback.
drop function if exists public.get_teaching_clients_for_instructor(uuid, uuid);
