-- Rollback of 20261116090000_paywh1_webhook_event_claims.sql. Run last (the settlement functions call
-- _paywh1_require_event_claim) and only after the PAY-WH-1 application has been rolled back.
--
-- Precondition (the script refuses otherwise): no event is in 'processing' with a live lease. Expired 'processing'
-- claims are converted to 'failed' so the pre-PAY-WH-1 route retries them normally.

begin;

do $$
begin
  if exists (select 1 from public.payment_provider_events where status = 'processing' and claim_expires_at > now()) then
    raise exception 'paywh1 rollback refused: webhook events are being processed (live claims)';
  end if;
end $$;

update public.payment_provider_events
set status = 'failed', error_message = coalesce(error_message, 'claim expired during PAY-WH-1 rollback')
where status = 'processing';

drop function if exists public.claim_payment_provider_event(text, text, text, text, uuid, integer);
drop function if exists public.complete_payment_provider_event(text, text, uuid, text, text, text);
drop function if exists public._paywh1_require_event_claim(text, uuid);

drop index if exists public.payment_provider_events_unresolved_idx;
alter table public.payment_provider_events drop constraint if exists payment_provider_events_claim_consistency;
alter table public.payment_provider_events drop constraint if exists payment_provider_events_status_check;
alter table public.payment_provider_events
  drop column if exists claim_owner,
  drop column if exists claim_expires_at,
  drop column if exists attempt_count,
  drop column if exists last_attempt_at,
  drop column if exists last_error_at,
  drop column if exists outcome;

notify pgrst, 'reload schema';

commit;
