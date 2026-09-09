-- Rollback for 20260909090000_sec_p0_revoke_apply_appointment_status_client_execute.sql
--
-- Restores the prior client-role EXECUTE grants exactly as they existed
-- before that migration. Does not touch the function body, owner,
-- signature, search_path, or the service_role grant (never revoked by the
-- forward migration, so nothing to restore there).
grant execute on function public.apply_appointment_status(uuid, public.appointment_status, uuid) to public;
grant execute on function public.apply_appointment_status(uuid, public.appointment_status, uuid) to anon;
grant execute on function public.apply_appointment_status(uuid, public.appointment_status, uuid) to authenticated;
