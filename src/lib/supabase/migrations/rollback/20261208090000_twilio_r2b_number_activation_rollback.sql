-- Rollback of 20261208090000 (TW-4F R2b: number provisioning and sender activation).
-- REFUSES once any offer, selection, operation, resource, attestation, compliance check or R2b audit row exists: provider and financial evidence is never destroyed
-- (forward recovery is a new migration). Roll the application back first, and this migration back BEFORE R2a's. Never run this on a shared database that has seen a
-- number run; use an isolated database or a transaction you ROLLBACK.
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_num_operations') is null then
    raise exception 'R2b rollback: not applied';
  end if;
  if exists (select 1 from public.studio_sms_number_offers) or exists (select 1 from public.studio_sms_number_selections) or exists (select 1 from public.studio_sms_num_operations)
     or exists (select 1 from public.studio_sms_num_resources) or exists (select 1 from public.studio_sms_optout_attestations) or exists (select 1 from public.studio_sms_compliance_checks)
     or exists (select 1 from public.studio_sms_onboarding_audit where action in ('num_offered', 'num_selected', 'num_withdrawn', 'num_started', 'num_finished', 'num_observed', 'num_resolved',
                  'num_retired', 'optout_attested', 'compliance_checked', 'activation_ready', 'activation_done', 'activation_suspended')) then
    raise exception 'R2b rollback refused: number provisioning evidence exists' using errcode = '55000';
  end if;
end $$;

drop function if exists public.tw4_act_exposure(uuid);
drop function if exists public.tw4_act_suspend(uuid, uuid, text);
drop function if exists public.tw4_act_activate(uuid, uuid, text);
drop function if exists public.tw4_act_mark_ready(uuid, uuid, text);
drop function if exists public.tw4_act_check(uuid, uuid);
drop function if exists public._tw4act_require(uuid);
drop function if exists public._tw4act_items(uuid);
drop function if exists public._tw4act_funding(uuid);
drop function if exists public.tw4_act_verify_sender(uuid, uuid, uuid, jsonb, text);
drop function if exists public.tw4_act_compliance_record(uuid, uuid, jsonb, text, text, text);
drop function if exists public.tw4_act_attest(uuid, uuid, jsonb, text);
drop function if exists public.tw4_num_status(uuid, uuid);
drop function if exists public.tw4_num_record_sender(uuid, uuid);
drop function if exists public.tw4_num_retire(uuid, uuid, text);
drop function if exists public.tw4_num_reopen(uuid, uuid, text);
drop function if exists public.tw4_num_settle_admin(uuid, uuid, text, text);
drop function if exists public.tw4_num_resolve(uuid, uuid, text, text, text);
drop function if exists public.tw4_num_observe(uuid, text, uuid, jsonb, text, text);
drop function if exists public.tw4_num_finish(uuid, text, uuid, text, text, text, text);
drop function if exists public.tw4_num_begin(uuid, text, text, text, text, jsonb, uuid);
drop function if exists public.tw4_num_context(uuid, text);
drop function if exists public.tw4_num_claim(uuid, uuid, text, integer, text);
drop function if exists public.tw4_num_withdraw(uuid, uuid, uuid, text);
drop function if exists public.tw4_num_select(uuid, uuid, uuid, text, int, text);
drop function if exists public.tw4_num_offer_record(uuid, uuid, text, jsonb, jsonb, text, text);
drop function if exists public._tw4num_free_selection(uuid, uuid, text);
drop function if exists public._tw4num_settle_if_held(uuid, text, text);
drop function if exists public._tw4num_requirements(uuid);
drop function if exists public._tw4num_reserve(public.studio_sms_onboarding, uuid, int);
drop function if exists public._tw4num_taken(text, uuid);
drop function if exists public._tw4num_price(text);
drop function if exists public._tw4num_campaign(uuid);
drop function if exists public._tw4num_service(uuid);
drop function if exists public._tw4num_account(uuid);

drop table public.studio_sms_compliance_checks;
drop table public.studio_sms_optout_attestations;
drop table public.studio_sms_num_resources;
drop table public.studio_sms_num_operations;
drop table public.studio_sms_number_selections;
drop table public.studio_sms_number_offers;
drop function if exists public._tw4num_guard();

-- audit vocabulary without the R2b actions (the live list minus ours)
do $$
declare
  v_def text;
  v_actions text[];
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.studio_sms_onboarding_audit'::regclass and c.conname = 'studio_sms_onboarding_audit_action_check';
  select array_agg(distinct m[1] order by m[1]) into v_actions from regexp_matches(substring(v_def from 'ANY \((.*)\)'), '([a-z][a-z0-9_]*)', 'g') m
   where m[1] <> 'text' and m[1] not in ('num_offered', 'num_selected', 'num_withdrawn', 'num_started', 'num_finished', 'num_observed', 'num_resolved', 'num_retired',
     'optout_attested', 'compliance_checked', 'activation_ready', 'activation_done', 'activation_suspended');
  if v_actions is null or cardinality(v_actions) < 10 then
    raise exception 'could not read the audit actions from %', v_def;
  end if;
  alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
  execute format('alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action = any (%L::text[]))', v_actions);
end $$;

commit;
