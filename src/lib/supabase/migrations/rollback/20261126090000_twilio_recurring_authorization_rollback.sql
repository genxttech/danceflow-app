-- Rollback of 20261126090000 (recurring SMS service-charge authorization). Refuses once any authorization or charge record exists (financial evidence).
-- Roll the application back first. Restores the audit action list of 20261122090000.
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_recurring_authorizations') is null then
    raise exception 'recurring-authorization rollback: not applied';
  end if;
  if exists (select 1 from public.studio_sms_recurring_authorizations) or exists (select 1 from public.studio_sms_recurring_charges)
     or exists (select 1 from public.studio_sms_onboarding_audit where action like 'recurring\_%') then
    raise exception 'recurring-authorization rollback refused: authorizations, charges or audit evidence exist' using errcode = '55000';
  end if;
end $$;

drop function public.tw4_recurring_authorize(uuid, uuid, text, int, int, int), public.tw4_recurring_revoke(uuid, uuid), public.sms_recurring_overview(uuid),
  public.sms_recurring_admin_overview(), public.tw4_recurring_charge(uuid, text), public.tw4_recurring_due(text), public.tw4_recurring_service_state(uuid),
  public._tw4rc_service_state(uuid), public._tw4rc_service_issue(uuid), public._tw4rc_usd(bigint);
drop table public.studio_sms_recurring_charges;
drop table public.studio_sms_recurring_authorizations;
drop function public._tw4rc_guard();

alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action in (
  'access_enabled', 'access_disabled', 'draft_created', 'ein_stored', 'ein_purged', 'submitted', 'cancelled', 'state_changed',
  'runner_step', 'runner_ein_read', 'runner_lease', 'runner_window', 'runner_submission_confirmed', 'runner_evaluation',
  'entity_created', 'location_attested', 'location_decided', 'spend_cap_set', 'spend_authorized', 'spend_reserved',
  'subaccount_confirmed', 'runner_subaccount',
  'credit_topup', 'credit_reversal', 'credit_adjustment', 'credit_hold', 'credit_reserved', 'credit_captured', 'credit_released', 'price_set', 'credit_pilot_exception', 'spend_withdrawn'));

commit;
