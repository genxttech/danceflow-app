-- Rollback for 20260907040000_fc1b5d2_d2c0b_qr_checkin_appointment_rpc.sql
--
-- Drops both externally-callable QR check-in appointment RPCs and the
-- private token-resolution helper, restoring the pre-D2C-0B state. No RLS
-- policy is touched by either the forward migration or this rollback --
-- dropping these functions has no effect on any table's RLS.
drop function if exists public.get_client_appointments_for_checkin(uuid, text, timestamptz, timestamptz);
drop function if exists public.get_client_appointment_for_checkin_validation(uuid, text, uuid);
drop function if exists public._resolve_qr_checkin_client_id(uuid, text);
