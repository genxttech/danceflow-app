-- Rollback for 20260905160200_fc1b5d_qr_checkin_client_identity_rpc.sql
--
-- Drops the QR check-in identity RPC. No RLS policy is touched by either
-- the forward migration or this rollback.
drop function if exists public.get_client_by_qr_token_for_checkin(uuid, text);
