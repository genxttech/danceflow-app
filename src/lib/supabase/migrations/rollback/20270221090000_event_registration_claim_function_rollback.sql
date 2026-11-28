-- Rollback of 20270221090000_event_registration_claim_function.sql.
-- Drops the function only. Registrations already claimed keep their user_id (that is the buyer's own data, and clearing it
-- would hide tickets again); no data is changed.
begin;
drop function if exists public.claim_my_event_registrations();
commit;
