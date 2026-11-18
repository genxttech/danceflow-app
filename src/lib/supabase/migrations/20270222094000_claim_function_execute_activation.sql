-- ACTIVATION of the claim RPC: grants execute on public.claim_my_event_registrations() to authenticated ONLY.
-- Apply in the SAME session immediately AFTER the restricted-reader cutover 20270222093000 (cutover first, then this grant), so the RPC is
-- never executable while dancers can still read the base tables directly. No grant to public, anon or service_role.
-- Prerequisites: 20270222090500 applied (execute withheld), 20270222092000 views and 20270222093000 cutover applied.
-- Git-only: do NOT apply to hosted databases without the owner's authorization.

begin;

revoke all on function public.claim_my_event_registrations() from public, anon, service_role;
grant execute on function public.claim_my_event_registrations() to authenticated;

commit;
