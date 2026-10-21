-- Rollback of 20261207090000 (TW-4F R2a: provisioning ledger for the Messaging Service and campaign).
-- REFUSES once any operation, resource or provisioning audit row exists: provider and financial evidence is never destroyed (forward recovery is a new migration).
-- Roll the application back first. Never run this on a shared database that has seen a provisioning run; use an isolated database or a transaction you ROLLBACK.
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_prov_operations') is null then
    raise exception 'R2a rollback: not applied';
  end if;
  if exists (select 1 from public.studio_sms_prov_operations) or exists (select 1 from public.studio_sms_prov_resources)
     or exists (select 1 from public.studio_sms_onboarding_audit where action in ('prov_started', 'prov_finished', 'prov_observed', 'prov_resolved')) then
    raise exception 'R2a rollback refused: provisioning evidence exists' using errcode = '55000';
  end if;
end $$;

drop function if exists public.tw4_prov_status(uuid, uuid);
drop function if exists public.tw4_prov_reopen(uuid, uuid, text);
drop function if exists public.tw4_prov_resolve(uuid, uuid, text, text, text);
drop function if exists public.tw4_prov_observe(uuid, text, uuid, jsonb, text, text, text);
drop function if exists public.tw4_prov_finish(uuid, text, uuid, text, text, text, text);
drop function if exists public.tw4_prov_begin(uuid, text, text, text, text, jsonb, uuid);
drop function if exists public.tw4_prov_context(uuid, text);
drop function if exists public.tw4_prov_claim(uuid, uuid, text, integer, text);
drop function if exists public._tw4prov_campaign_requirements(uuid);
drop function if exists public._tw4prov_settle(uuid, text, text, text);
drop function if exists public._tw4prov_reserve(public.studio_sms_onboarding, text, uuid);
drop function if exists public._tw4prov_brand(uuid);
drop function if exists public._tw4prov_use_case(text);

drop table public.studio_sms_prov_resources;
drop table public.studio_sms_prov_operations;
drop function if exists public._tw4prov_guard();

-- audit vocabulary without the provisioning actions (the live list minus ours)
do $$
declare
  v_def text;
  v_actions text[];
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.studio_sms_onboarding_audit'::regclass and c.conname = 'studio_sms_onboarding_audit_action_check';
  select array_agg(distinct m[1] order by m[1]) into v_actions from regexp_matches(substring(v_def from 'ANY \((.*)\)'), '([a-z][a-z0-9_]*)', 'g') m
   where m[1] <> 'text' and m[1] not in ('prov_started', 'prov_finished', 'prov_observed', 'prov_resolved');
  if v_actions is null or cardinality(v_actions) < 10 then
    raise exception 'could not read the audit actions from %', v_def;
  end if;
  alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
  execute format('alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action = any (%L::text[]))', v_actions);
end $$;

commit;
