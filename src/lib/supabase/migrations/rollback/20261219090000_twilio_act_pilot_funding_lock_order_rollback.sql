-- Rollback of 20261219090000_twilio_act_pilot_funding_lock_order.sql: restores the five replaced bodies exactly as 20261208090000 defines them (pilot funding refused
-- as 'pilot_month_two_undefined', act_* taking the location link before the onboarding row, no usage-reconciler checklist item) and drops _tw4act_pilot_funding.
-- No data is written or deleted by the migration, so nothing else is undone. Refuses if a replaced body changed after 20261219 (roll that migration back first);
-- the restored bodies are verified against their 20261208 fingerprints and the transaction aborts if any differs.
begin;
set local lock_timeout = '5s';
do $$
begin
  if to_regprocedure('public._tw4act_pilot_funding(uuid,uuid)') is null then
    raise exception 'act-pilot-funding rollback precondition failed: the migration is not applied';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4act_funding(uuid)'::regprocedure), chr(13), '')), 8) <> 'f3840739'
     or left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4act_items(uuid)'::regprocedure), chr(13), '')), 8) <> '9a6e8d29'
     or left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4act_pilot_funding(uuid,uuid)'::regprocedure), chr(13), '')), 8) <> '8f7508a6'
     or left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_act_mark_ready(uuid,uuid,text)'::regprocedure), chr(13), '')), 8) <> '22c579d1'
     or left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_act_activate(uuid,uuid,text)'::regprocedure), chr(13), '')), 8) <> '9f85a51f'
     or left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_act_suspend(uuid,uuid,text)'::regprocedure), chr(13), '')), 8) <> '348d6061' then
    raise exception 'act-pilot-funding rollback precondition failed: a replaced function was changed after this migration (roll back the later migration first)';
  end if;
end $$;

create or replace function public._tw4act_funding(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_kind text := public.tw4_location_fee_kinds(p_studio_id) ->> 'campaign_monthly_kind';
  a public.studio_sms_credit_accounts;
  v_c public.studio_sms_recurring_authorizations;
  v_n public.studio_sms_recurring_authorizations;
begin
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    return jsonb_build_object('ok', false, 'detail', 'no_legal_entity');
  end if;
  if exists (select 1 from public.studio_sms_pilot_exceptions y where y.legal_entity_id = v_entity) then
    -- no standing authorization may exist for the pilot business and no month-two operation exists yet: activation stays blocked (explicit, not silent)
    return jsonb_build_object('ok', false, 'detail', 'pilot_month_two_undefined');
  end if;
  if v_kind is null then
    return jsonb_build_object('ok', false, 'detail', 'no_registration_path');
  end if;
  select * into v_c from public.studio_sms_recurring_authorizations r where r.legal_entity_id = v_entity and r.studio_id = p_studio_id and r.kind = v_kind and r.status = 'active'
     and r.expires_at > now() + interval '35 days' and r.price_cents = public._tw4num_price(v_kind);
  select * into v_n from public.studio_sms_recurring_authorizations r where r.legal_entity_id = v_entity and r.studio_id = p_studio_id and r.kind = 'number' and r.status = 'active'
     and r.expires_at > now() + interval '35 days' and r.price_cents = public._tw4num_price('number');
  select * into a from public.studio_sms_credit_accounts x where x.legal_entity_id = v_entity;
  if v_c.id is null then return jsonb_build_object('ok', false, 'detail', 'campaign_authorization_short_or_missing'); end if;
  if v_n.id is null then return jsonb_build_object('ok', false, 'detail', 'number_authorization_short_or_missing'); end if;
  if a.legal_entity_id is null or a.hold or a.balance_cents < 0 then return jsonb_build_object('ok', false, 'detail', 'credit_on_hold'); end if;
  if not public._tw4num_credit_funded(v_entity, v_c.id) then return jsonb_build_object('ok', false, 'detail', 'campaign_rent_unfunded'); end if;
  if not public._tw4num_credit_funded(v_entity, v_n.id) then return jsonb_build_object('ok', false, 'detail', 'number_rent_unfunded'); end if;
  return jsonb_build_object('ok', true, 'detail', 'ok', 'campaign_expires_at', v_c.expires_at, 'number_expires_at', v_n.expires_at);
end $$;

-- every activation condition, evaluated now. [{id, ok, detail}]
create or replace function public._tw4act_items(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_account text := public._tw4num_account(p_studio_id);
  v_ms public.studio_sms_prov_operations := public._tw4num_service(p_studio_id);
  v_qe public.studio_sms_prov_operations := public._tw4num_campaign(p_studio_id);
  v_p public.studio_sms_num_operations;
  v_a public.studio_sms_num_operations;
  v_s public.studio_sms_billed_senders;
  v_ready public.studio_sms_billed_senders;
  v_att public.studio_sms_optout_attestations;
  v_cmp public.studio_sms_compliance_checks;
  v_fund jsonb := public._tw4act_funding(p_studio_id);
  v_sender_ok boolean;
  v_att_ok boolean;
  v_cmp_ok boolean;
  v_rfl jsonb := null;
  v_rfl_match boolean := false;
  v_inv public.studio_sms_num_inventory_checks;
  v_entity uuid;
begin
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  -- the recurring provider-fee lifecycle (PR #259, 20261209): resolved dynamically so this migration applies without it, and the checklist then FAILS CLOSED
  if to_regprocedure('public.tw4_rfl_studio_ready(uuid)') is not null then
    begin
      execute format('select public.tw4_rfl_studio_ready(%L::uuid)', p_studio_id) into v_rfl;
    exception when others then
      v_rfl := jsonb_build_object('ready', false, 'blockers', jsonb_build_array('rfl_error'));   -- an unreadable lifecycle is not a ready one
    end;
  end if;
  select * into v_inv from public.studio_sms_num_inventory_checks c where c.legal_entity_id = v_entity order by c.listed_at desc, c.created_at desc, c.id limit 1;
  select * into v_p from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null and x.twilio_account_sid = v_account;
  select * into v_a from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_attach' and x.status = 'succeeded' and x.superseded_at is null and x.twilio_account_sid = v_account;
  v_ready := public._tw4sr_ready_core(p_studio_id);   -- the PR #249 readiness: the activation checklist cannot depend on being active already
  v_sender_ok := v_ready.id is not null and v_ms.id is not null and v_qe.id is not null and v_p.id is not null
    and v_ready.account_sid = v_account and v_ready.messaging_service_sid = v_ms.provider_sid and v_ready.campaign_sid = v_qe.provider_sid
    and v_ready.phone_number_sid = v_p.provider_sid and v_ready.sender_e164 = v_p.e164;
  select * into v_att from public.studio_sms_optout_attestations a where a.studio_id = p_studio_id order by a.created_at desc limit 1;
  v_att_ok := v_att.id is not null and v_att.created_at > now() - interval '30 days' and v_att.twilio_account_sid = v_account
    and v_att.messaging_service_sid = v_ms.provider_sid and v_att.campaign_sid = v_qe.provider_sid;
  select * into v_cmp from public.studio_sms_compliance_checks c where c.studio_id = p_studio_id order by c.created_at desc limit 1;
  v_cmp_ok := v_cmp.id is not null and v_cmp.outcome = 'passed' and v_cmp.created_at > now() - interval '24 hours' and v_cmp.twilio_account_sid = v_account
    and v_cmp.messaging_service_sid = v_ms.provider_sid and v_cmp.campaign_sid = v_qe.provider_sid
    and v_cmp.expected_inbound = (select pn.origin || '/api/sms/twilio/inbound' from public.studio_sms_inbound_route_pins pn order by pn.id desc limit 1);   -- judged against the CURRENT pin
  -- "ready" is not enough: the lifecycle's inventory must hold THIS ledger's number and campaign (its own check only needs some live number and some live campaign)
  if v_rfl is not null and v_rfl -> 'ready' = 'true'::jsonb then
    begin
      execute format('select exists (select 1 from public.studio_sms_provider_resources r where r.studio_id = %L and r.resource_kind = ''number'' and r.provider_state = ''active'' and r.provider_sid = %L and r.e164 = %L and r.twilio_account_sid = %L)
                          and exists (select 1 from public.studio_sms_provider_resources r where r.studio_id = %L and r.resource_kind = ''campaign'' and r.provider_state = ''active'' and r.provider_sid = %L)',
        p_studio_id, v_p.provider_sid, v_p.e164, v_account, p_studio_id, v_qe.provider_sid) into v_rfl_match;
    exception when others then
      v_rfl_match := false;
    end;
  end if;
  return jsonb_build_array(
    jsonb_build_object('id', 'subaccount_active', 'ok', v_account is not null, 'detail', case when v_account is null then 'no_active_subaccount' else 'ok' end),
    jsonb_build_object('id', 'service_ready', 'ok', v_ms.id is not null, 'detail', case when v_ms.id is null then 'service_not_ready' else 'ok' end),
    jsonb_build_object('id', 'campaign_verified', 'ok', v_qe.id is not null, 'detail', case when v_qe.id is null then 'campaign_not_verified' else 'ok' end),
    jsonb_build_object('id', 'number_owned', 'ok', v_p.id is not null and exists (select 1 from public.studio_sms_num_resources r where r.operation_id = v_p.id and r.status = 'owned'),
      'detail', case when v_p.id is null then 'no_purchase' else 'ok' end),
    jsonb_build_object('id', 'number_attached', 'ok', v_a.id is not null and v_p.id is not null and v_a.provider_sid = v_p.provider_sid
      and exists (select 1 from public.studio_sms_num_resources r where r.operation_id = v_a.id and r.status = 'attached'), 'detail', case when v_a.id is null then 'no_attachment' else 'ok' end),
    jsonb_build_object('id', 'sender_ready', 'ok', coalesce(v_sender_ok, false), 'detail', case when coalesce(v_sender_ok, false) then 'ok' when v_ready.id is null then 'sender_not_verified_or_stale' else 'sender_differs_from_ledger' end),
    jsonb_build_object('id', 'opt_out_attested', 'ok', coalesce(v_att_ok, false), 'detail', case when coalesce(v_att_ok, false) then 'ok' else 'attestation_missing_or_stale' end),
    jsonb_build_object('id', 'compliance_passed', 'ok', coalesce(v_cmp_ok, false), 'detail', case when coalesce(v_cmp_ok, false) then 'ok' when v_cmp.id is null then 'no_compliance_check' else 'compliance_failed_or_stale' end),
    -- exposure monitoring and provider-fee cover: the recurring-fee lifecycle must be installed, the number and campaign registered in its inventory, every period covered, nothing open
    jsonb_build_object('id', 'rfl_ready', 'ok', coalesce(v_rfl -> 'ready' = 'true'::jsonb, false) and v_rfl_match,
      'detail', case when v_rfl is null then 'rfl_not_installed' when not coalesce(v_rfl -> 'ready' = 'true'::jsonb, false) then 'rfl_blockers:' || coalesce((v_rfl -> 'blockers')::text, '?')
                     when not v_rfl_match then 'rfl_inventory_differs_from_ledger' else 'ok' end),
    -- inventory reconciliation: the provider's inventory of this business was reconciled with the ledger, clean, within 24 hours (the runner's refreshInventory records it)
    jsonb_build_object('id', 'inventory_reconciled', 'ok', v_inv.id is not null and v_inv.unknown_count = 0 and v_inv.missing_count = 0 and v_inv.twilio_account_sid is not distinct from v_account and v_inv.listed_at > now() - interval '24 hours',
      'detail', case when v_inv.id is null then 'no_inventory_check' when v_inv.unknown_count > 0 then 'inventory_has_unknown_numbers' when v_inv.missing_count > 0 then 'inventory_missing_ledger_numbers'
                     when v_inv.twilio_account_sid is distinct from v_account then 'inventory_account_differs' when v_inv.listed_at <= now() - interval '24 hours' then 'inventory_check_stale' else 'ok' end),
    jsonb_build_object('id', 'inbound_route_pinned', 'ok', exists (select 1 from public.studio_sms_inbound_route_pins), 'detail', case when exists (select 1 from public.studio_sms_inbound_route_pins) then 'ok' else 'inbound_route_not_pinned' end),
    jsonb_build_object('id', 'funding_continuity', 'ok', (v_fund ->> 'ok')::boolean, 'detail', v_fund ->> 'detail'));
end $$;

create or replace function public.tw4_act_mark_ready(p_studio_id uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
begin
  perform public._tw4c_admin(p_actor);
  if p_note is null or char_length(btrim(p_note)) not between 10 and 300 then
    raise exception 'a documented reason (10-300 characters) is required' using errcode = '22023';
  end if;
  if not public._sms_onb_access_enabled(p_studio_id) then
    raise exception 'not available for this studio' using errcode = '42501';
  end if;
  perform public._tw4sr_lock(p_studio_id);
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null or o.state <> 'campaign_pending' then
    raise exception 'onboarding state % cannot be marked ready', coalesce(o.state, 'none') using errcode = 'TW030';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease' using errcode = '55P03';
  end if;
  perform public._tw4act_lock_funding(p_studio_id);
  perform public._tw4act_require(p_studio_id);
  update public.studio_sms_onboarding set state = 'ready_for_activation', step = 'A1', last_error_code = null, last_error_field = null where id = o.id returning * into o;
  perform public._tw4_r1_audit(o, p_actor, 'state_changed', 'campaign_pending', 'ready_for_activation', left(btrim(p_note), 250));
  perform public._tw4_r1_audit(o, p_actor, 'activation_ready', o.state, o.state, 'checklist passed');
  return jsonb_build_object('state', o.state);
end $$;

create or replace function public.tw4_act_activate(p_studio_id uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_from text;
begin
  perform public._tw4c_admin(p_actor);
  if p_note is null or char_length(btrim(p_note)) not between 10 and 300 then
    raise exception 'a documented reason (10-300 characters) is required' using errcode = '22023';
  end if;
  if not public._sms_onb_access_enabled(p_studio_id) then
    raise exception 'not available for this studio' using errcode = '42501';
  end if;
  perform public._tw4sr_lock(p_studio_id);
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null or o.state not in ('ready_for_activation', 'suspended') then
    raise exception 'onboarding state % cannot be activated', coalesce(o.state, 'none') using errcode = 'TW030';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease' using errcode = '55P03';
  end if;
  -- everything is re-evaluated NOW, in the same transaction as the state change (a verification, attestation or authorization that lapsed since "ready" blocks it)
  perform public._tw4act_lock_funding(p_studio_id);
  perform public._tw4act_require(p_studio_id);
  v_from := o.state;
  update public.studio_sms_onboarding set state = 'active', step = 'A2', last_error_code = null, last_error_field = null where id = o.id returning * into o;
  perform public._tw4_r1_audit(o, p_actor, 'state_changed', v_from, 'active', left(btrim(p_note), 250));
  perform public._tw4_r1_audit(o, p_actor, 'activation_done', o.state, o.state, 'checklist passed');
  return jsonb_build_object('state', o.state);
end $$;

-- immediate stop: the sender is revoked (nothing is sent) and the onboarding is suspended. Reactivation needs the full checklist again.
create or replace function public.tw4_act_suspend(p_studio_id uuid, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  s public.studio_sms_billed_senders;
begin
  perform public._tw4c_admin(p_actor);
  if p_reason is null or char_length(btrim(p_reason)) not between 10 and 300 then
    raise exception 'a documented reason (10-300 characters) is required' using errcode = '22023';
  end if;
  perform public._tw4sr_lock(p_studio_id);
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null or o.state <> 'active' then
    raise exception 'only an active onboarding is suspended' using errcode = 'TW030';
  end if;
  s := public._tw4sr_latest(p_studio_id);
  if s.id is not null and s.status in ('pending', 'approved') then
    perform public.tw4_sender_revoke(p_studio_id, p_actor, 'suspended: ' || btrim(p_reason), false);
  end if;
  update public.studio_sms_onboarding set state = 'suspended', step = 'A3' where id = o.id returning * into o;
  perform public._tw4_r1_audit(o, p_actor, 'state_changed', 'active', 'suspended', left(btrim(p_reason), 250));
  perform public._tw4_r1_audit(o, p_actor, 'activation_suspended', o.state, o.state, 'sender revoked');
  return jsonb_build_object('state', o.state);
end $$;

drop function public._tw4act_pilot_funding(uuid, uuid);

do $$
begin
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4act_funding(uuid)'::regprocedure), chr(13), '')), 8) <> '97363f0b'
     or left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4act_items(uuid)'::regprocedure), chr(13), '')), 8) <> 'e31b4ad2'
     or left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_act_mark_ready(uuid,uuid,text)'::regprocedure), chr(13), '')), 8) <> '98531279'
     or left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_act_activate(uuid,uuid,text)'::regprocedure), chr(13), '')), 8) <> 'acbb1c37'
     or left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_act_suspend(uuid,uuid,text)'::regprocedure), chr(13), '')), 8) <> '4bcd3c9d' then
    raise exception 'act-pilot-funding rollback postcondition failed: a restored body differs from 20261208090000';
  end if;
end $$;

commit;
