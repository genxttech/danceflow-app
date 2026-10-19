-- Rollback for 20261121090000_twilio_tw4f3a_subaccounts.sql (TW-4F-3a).
-- Refuses once any legal entity, location link or request, subaccount, subaccount confirmation, spend event, ledger account sid or new audit row exists:
-- that is evidence and must not be dropped silently. Order: application first, then this script (it does not touch the 4F-1b objects).
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_legal_entities') is null then
    raise exception 'TW-4F-3a rollback: not applied';
  end if;
  if exists (select 1 from public.studio_sms_legal_entities)
     or exists (select 1 from public.studio_sms_entity_studios)
     or exists (select 1 from public.studio_sms_location_requests)
     or exists (select 1 from public.studio_sms_twilio_accounts)
     or exists (select 1 from public.studio_sms_subaccount_confirmations)
     or exists (select 1 from public.studio_sms_spend_events)
     or exists (select 1 from public.studio_sms_provisioning_steps where twilio_account_sid is not null)
     or exists (select 1 from public.studio_sms_onboarding_audit where action in
          ('entity_created', 'location_attested', 'location_decided', 'spend_cap_set', 'spend_authorized', 'spend_reserved', 'subaccount_confirmed', 'runner_subaccount')) then
    raise exception 'TW-4F-3a rollback refused: entities, subaccounts, spend or account evidence exist' using errcode = '55000';
  end if;
end $$;

drop trigger studio_sms_provisioning_steps_account_guard on public.studio_sms_provisioning_steps;
alter table public.studio_sms_provisioning_steps drop column twilio_account_sid;

drop function public.tw4_entity_create_for_studio(uuid, uuid, text), public.tw4_entity_decide_link(uuid, uuid, uuid, boolean, text),
  public.tw4_entity_set_spend_cap(uuid, int, uuid), public.tw4_spend_authorize(uuid, text, int, text, uuid), public.tw4_spend_reserve(uuid, text, text),
  public.tw4_subaccount_confirm(uuid, uuid), public.tw4_subaccount_begin(uuid, uuid, text, text), public.tw4_subaccount_finish(uuid, uuid, text, text),
  public.tw4_runner_account(uuid, text), public.tw4_entity_for_studio(uuid, uuid), public.sms_location_attest(uuid, text, text, text);

drop table public.studio_sms_spend_events, public.studio_sms_subaccount_confirmations, public.studio_sms_twilio_accounts,
  public.studio_sms_entity_studios, public.studio_sms_location_requests, public.studio_sms_legal_entities;

drop function public._tw4f3a_name_key(text);
drop function public._tw4f3a_steps_account_guard(), public._tw4f3a_audit(uuid, uuid, text, text), public._tw4f3a_committed(uuid), public._tw4f3a_evidence_guard();

alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action in (
  'access_enabled', 'access_disabled', 'draft_created', 'ein_stored', 'ein_purged', 'submitted', 'cancelled', 'state_changed',
  'runner_step', 'runner_ein_read', 'runner_lease', 'runner_window', 'runner_submission_confirmed', 'runner_evaluation'));

commit;
