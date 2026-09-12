-- Rollback for 20260911120200_p3_membership_usage_sync_errors.sql
--
-- Never drops membership_usage_sync_errors -- audit trail preserved
-- regardless (explicit, reasoned exception to "roll back cleanly", per
-- plan section Z / K).

begin;

revoke execute on function public.retry_membership_usage_sync_error(uuid) from authenticated;
drop function if exists public.retry_membership_usage_sync_error(uuid);

drop trigger if exists appointments_sync_membership_usage_for_private_lesson on public.appointments;
drop function if exists public.sync_membership_usage_for_private_lesson_appointment();
drop function if exists public._sync_membership_usage_for_private_lesson_appointment(uuid);

commit;
