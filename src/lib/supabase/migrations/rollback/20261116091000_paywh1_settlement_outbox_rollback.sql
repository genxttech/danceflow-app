-- Rollback of 20261116091000_paywh1_settlement_outbox.sql. Run AFTER 20261116092000's rollback (its settlement
-- function inserts into the outbox).
--
-- Preconditions (the script refuses otherwise): no outbox effect is pending / processing / failed -- drain it first,
-- otherwise customer confirmations, leads and fee sync for already-settled orders would be lost. Dead effects are
-- reported and must be handled manually before rollback.
-- Not restored: notifications.dedupe_key and outbound_deliveries claim columns are dropped (their data is metadata).

begin;

do $$
begin
  if exists (select 1 from public.event_settlement_outbox where status in ('pending', 'processing', 'failed', 'dead')) then
    raise exception 'paywh1 rollback refused: undrained settlement outbox effects exist';
  end if;
end $$;

drop function if exists public.claim_event_settlement_outbox(uuid, integer, integer, uuid);
drop function if exists public.complete_event_settlement_outbox(uuid, uuid, boolean, text);
drop table if exists public.event_settlement_outbox;

drop function if exists public.capture_event_registration_lead(uuid);
drop index if exists public.notifications_dedupe_key_uidx;
alter table public.notifications drop column if exists dedupe_key;

drop function if exists public.claim_outbound_deliveries(uuid, integer, integer);
drop index if exists public.outbound_deliveries_queued_claim_idx;
alter table public.outbound_deliveries
  drop column if exists claim_owner,
  drop column if exists claim_expires_at;

notify pgrst, 'reload schema';

commit;
