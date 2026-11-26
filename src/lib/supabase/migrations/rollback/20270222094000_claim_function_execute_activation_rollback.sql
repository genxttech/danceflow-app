-- Rollback of 20270222094000: withholds execute again (nobody but the owner can call the claim RPC).
begin;
revoke all on function public.claim_my_event_registrations() from public, anon, authenticated, service_role;
commit;
