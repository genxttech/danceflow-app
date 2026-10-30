-- Rollback of 20270202100000_apply_studio_subscription_state_rpc.sql. Roll the app back FIRST (it calls this function).
begin;
set local lock_timeout = '5s';
drop function if exists public.apply_studio_subscription_state(uuid, jsonb, timestamptz, jsonb, jsonb);
commit;
