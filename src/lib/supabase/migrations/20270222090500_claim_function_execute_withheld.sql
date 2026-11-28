-- Release-order guard: public.claim_my_event_registrations() is installed (20270221090000) and restricted to buyer-originated sources
-- (20270222090000), but those two files end with `grant execute ... to authenticated`. This migration WITHHOLDS execute again so the claim RPC
-- is not callable by ordinary signed-in users until the column-restricted reader cutover is complete (20270222093000), after which
-- 20270222094000 restores ONLY the intended permission. Existing callers treat a permission error as "nothing claimed" (fail closed).
-- Reviewed files 20270221090000 and 20270222090000 are deliberately left byte-for-byte unchanged; this file must sort after the latter.
-- Owner stays postgres (which keeps its implicit privilege); no grant to public, anon, authenticated or service_role.
-- Git-only: do NOT apply to hosted databases without the owner's authorization.

begin;

revoke all on function public.claim_my_event_registrations() from public, anon, authenticated, service_role;

commit;
