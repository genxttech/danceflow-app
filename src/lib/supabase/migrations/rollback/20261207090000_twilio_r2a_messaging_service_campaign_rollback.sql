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

-- the generic resolver as of 20261201090000
create or replace function public.tw4_credit_resolve_reservation(p_reservation_id uuid, p_outcome text, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $
declare
  r public.studio_sms_credit_reservations;
  s public.studio_sms_spend_events;
begin
  perform public._tw4c_admin(p_actor);
  if p_outcome not in ('captured', 'released') or p_note is null or char_length(btrim(p_note)) < 10 then
    raise exception 'an outcome and a written reason (10+ characters) are required' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_credit_reservations x where x.id = p_reservation_id;
  if r.id is null then
    raise exception 'unknown reservation' using errcode = '22023';
  end if;
  perform public._tw4c_lock(r.legal_entity_id);
  select * into r from public.studio_sms_credit_reservations x where x.id = p_reservation_id for update;
  if r.reservation_key like 'commit:%' then
    raise exception 'a recurring set-aside is captured only by its charge and released by revoking the authorization' using errcode = '22023';
  end if;
  if r.reservation_key like 'sms:%' then
    raise exception 'a text''s reservation is resolved only through tw4_usage_resolve' using errcode = '22023';
  end if;
  if (r.status = 'captured' and p_outcome = 'captured') or (r.status = 'released' and p_outcome = 'released') then
    return jsonb_build_object('status', r.status, 'replayed', true);
  end if;
  if r.status <> 'reserved' then
    raise exception 'the reservation is already %', r.status using errcode = '22023';
  end if;
  if p_outcome = 'captured' then
    if r.funding = 'credit' then
      perform public._tw4c_post(r.legal_entity_id, r.studio_id, 'capture', -r.amount_cents, -r.amount_cents, 'capture:' || r.reservation_key, r.id, 'admin', p_actor, btrim(p_note));
    end if;
    update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = r.id;
  else
    if r.funding = 'credit' then
      perform public._tw4c_post(r.legal_entity_id, r.studio_id, 'release', 0, -r.amount_cents, 'release:' || r.reservation_key, r.id, 'admin', p_actor, btrim(p_note));
    end if;
    update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where id = r.id;
    select * into s from public.studio_sms_spend_events x where x.credit_reservation_id = r.id;
    if s.id is not null then
      perform set_config('tw4.credit_settle', 'on', true);
      update public.studio_sms_spend_events set status = 'void' where id = s.id;
      perform set_config('tw4.credit_settle', 'off', true);
    end if;
  end if;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (r.studio_id, null, 'platform_admin', p_actor, case when p_outcome = 'captured' then 'credit_captured' else 'credit_released' end, left('reservation=' || r.id || ';admin', 300));
  return jsonb_build_object('status', p_outcome, 'replayed', false);
end $;

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
