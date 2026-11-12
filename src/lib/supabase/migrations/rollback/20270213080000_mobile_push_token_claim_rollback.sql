-- Rollback for 20270213080000_mobile_push_token_claim.sql
--
-- Roll the app back first: builds that register through this function stop
-- registering push tokens without it. Rows already moved stay with their new
-- owner, which is correct for those devices.

begin;

drop function if exists public.claim_mobile_push_token(text, text, text);

commit;
