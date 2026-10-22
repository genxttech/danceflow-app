-- Rollback of 20261208090000 (TW-4F R2b: number provisioning and sender activation).
-- REFUSES once any offer, selection, operation, resource, attestation, compliance check or R2b audit row exists: provider and financial evidence is never destroyed
-- (forward recovery is a new migration). Roll the application back first, and this migration back BEFORE R2a's. Never run this on a shared database that has seen a
-- number run; use an isolated database or a transaction you ROLLBACK.
begin;

set local lock_timeout = '5s';

do $$
declare
  v_t text;
  v_has boolean;
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
  -- the route pin and the inventory acknowledgements are evidence too (dynamic: a database that never had them is fine)
  for v_t in select unnest(array['studio_sms_inbound_route_pins', 'studio_sms_num_inventory_acks', 'studio_sms_num_inventory_checks']) loop
    if to_regclass('public.' || v_t) is not null then
      execute format('select exists (select 1 from public.%I)', v_t) into v_has;
      if v_has then
        raise exception 'R2b rollback refused: number provisioning evidence exists' using errcode = '55000';
      end if;
    end if;
  end loop;
end $$;

-- the PR #249 readiness as of 20261204090000 (the R2b send gate goes away with R2b)
create or replace function public._tw4sr_ready(p_studio_id uuid)
returns public.studio_sms_billed_senders language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s public.studio_sms_billed_senders;
  v public.studio_sms_sender_verifications;
  v_entity uuid;
  v_account text;
  none public.studio_sms_billed_senders;
begin
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  s := public._tw4sr_latest(p_studio_id);
  if v_entity is null or s.id is null or s.status <> 'approved' or s.legal_entity_id <> v_entity
     or s.campaign_sid is null or s.phone_number_sid is null or s.sender_e164 is null or s.verification_id is null then
    return none;
  end if;
  select t.twilio_account_sid into v_account from public.studio_sms_twilio_accounts t where t.legal_entity_id = v_entity and t.status = 'active';
  if v_account is null or v_account <> s.account_sid then
    return none;
  end if;
  -- the latest DECISIVE verification of this studio (an inconclusive re-read changes nothing)
  select * into v from public.studio_sms_sender_verifications x where x.studio_id = p_studio_id and x.outcome in ('verified', 'failed') order by x.seq desc limit 1;
  if v.id is null or v.outcome <> 'verified' or v.created_at < now() - interval '24 hours'
     or (v.source = 'fake' and not public._tw4sr_fake_allowed()) or v.source = 'callback'
     or v.account_sid <> s.account_sid or v.messaging_service_sid <> s.messaging_service_sid or v.campaign_sid is distinct from s.campaign_sid
     or v.phone_number_sid is distinct from s.phone_number_sid or v.sender_e164 is distinct from s.sender_e164 then
    return none;
  end if;
  -- the location's path may have changed since: the verified campaign's use case must still be the one its CURRENT path requires
  if v.evidence->'campaign'->>'us_app_to_person_usecase' is distinct from
     (case public._tw4fi_location_path_nolock(p_studio_id) when 'standard' then 'MIXED' when 'low_volume_standard' then 'LOW_VOLUME' end) then
    return none;
  end if;
  return s;
end $$;
drop function if exists public._tw4sr_ready_core(uuid);
drop function if exists public._tw4act_lock_funding(uuid);
drop function if exists public._tw4num_credit_funded(uuid, uuid);

drop function if exists public.tw4_num_inventory_observe(uuid, text, text[], text, timestamptz);
drop function if exists public._tw4num_known(uuid);
drop function if exists public.tw4_num_registration_facts(uuid);
drop function if exists public.tw4_num_rent_basis(uuid);
drop function if exists public._tw4num_rent_basis_core(uuid);
drop function if exists public.tw4_num_inventory_ack(uuid, uuid, text, text, text);
drop function if exists public.tw4_inbound_route_pin_set(uuid, text, text);
drop function if exists public.tw4_num_withdraw_as_owner(uuid, uuid, text);
drop function if exists public.tw4_num_select_as_owner(uuid, uuid, text, int);
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

drop table if exists public.studio_sms_num_inventory_checks;
drop table if exists public.studio_sms_inbound_route_pins;
drop table if exists public.studio_sms_num_inventory_acks;
drop table public.studio_sms_compliance_checks;
drop table public.studio_sms_optout_attestations;
drop table public.studio_sms_num_resources;
drop table public.studio_sms_num_operations;
drop table public.studio_sms_number_selections;
drop table public.studio_sms_number_offers;
drop function if exists public._tw4num_guard();

-- the shared approval-reference registry as of 20261202090000 (no number_selection source; a registered one means selection evidence exists, refused above)
do $$
begin
  if exists (select 1 from public.studio_sms_approval_refs where source = 'number_selection') then
    raise exception 'R2b rollback refused: number approval references exist' using errcode = '55000';
  end if;
end $$;
do $$
declare
  v_src text;
  v_sources text[];
begin
  select pg_get_constraintdef(c.oid) into v_src from pg_constraint c where c.conrelid = 'public.studio_sms_approval_refs'::regclass and c.conname = 'studio_sms_approval_refs_source_check';
  select array_agg(distinct m[1] order by m[1]) into v_sources from regexp_matches(substring(v_src from 'ANY \((.*)\)'), '([a-z_]+)', 'g') m where m[1] not in ('text', 'array', 'number_selection');
  if v_sources is null or cardinality(v_sources) < 2 then
    raise exception 'could not read the approval-reference sources from %', v_src;
  end if;
  alter table public.studio_sms_approval_refs drop constraint studio_sms_approval_refs_source_check;
  execute format('alter table public.studio_sms_approval_refs add constraint studio_sms_approval_refs_source_check check (source = any (%L::text[]))', v_sources);
end $$;

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
