-- Rollback of 20261129090000_twilio_tw4f_provider_integration.sql. Roll the APPLICATION back first (the webhook routes and runner call these functions).
-- Refuses once any webhook receipt or tier decision exists: those rows are evidence (replay protection, an admin's tier choice).
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.sms_webhook_receipts') is null then
    raise exception 'rollback refused: 20261129090000 is not applied';
  end if;
  if exists (select 1 from public.sms_webhook_receipts) or exists (select 1 from public.studio_sms_tier_decisions) then
    raise exception 'rollback refused: webhook receipts or tier decisions exist (evidence)';
  end if;
  if exists (select 1 from public.studio_sms_onboarding where tier is not null) then
    raise exception 'rollback refused: an onboarding has a chosen tier';
  end if;
end $$;

drop function public.tw4_runner_tier(uuid, text);
drop function public.tw4_onboarding_set_tier(uuid, uuid, text, text);
drop table public.studio_sms_tier_decisions;
drop function public.sms_webhook_receipt_record(text, text, text);
drop function public.sms_webhook_receipt_seen(text, text);
drop table public.sms_webhook_receipts;
drop function public._sms_webhook_receipts_guard();
drop function public.tw4_webhook_account(text);

commit;
