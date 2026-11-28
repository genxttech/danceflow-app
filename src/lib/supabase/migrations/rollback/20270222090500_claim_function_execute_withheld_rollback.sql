-- Rollback of 20270222090500: restores the ACL left by 20270222090000 (execute for authenticated only).
-- Do not run while the cutover (20270222093000) is NOT applied unless the owner wants the claim RPC callable again.
begin;
revoke all on function public.claim_my_event_registrations() from public, anon, authenticated, service_role;
grant execute on function public.claim_my_event_registrations() to authenticated;
commit;
