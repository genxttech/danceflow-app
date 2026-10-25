-- 20261219090000_twilio_act_pilot_funding_lock_order.sql
-- TW-4F F1: pilot funding continuity and activation lock order (dark; Git-only until separately authorized). Tracker F-1 (P1) and F-10.
--   1. _tw4act_funding no longer refuses the pilot business unconditionally ('pilot_month_two_undefined'). For the pilot business (ConfiDance) funding continuity passes
--      only when the CURRENT service period of every live recurring-fee resource the location depends on (the ledger's number and verified campaign, and any other live
--      fee-bearing resource registered at the location) is covered by a pilot reservation that is still reserved or captured: a per-period written approval
--      (tw4_rfl_pilot_cover) or the purchase's own first-period reservation bound at registration. It fails closed with a specific detail otherwise and reports whether
--      the NEXT period still needs its written approval (informational, never a pass). The non-pilot path is unchanged.
--      Owner policy, unchanged here: the cumulative pilot ceiling is never replenished, every paid pilot period needs its own written approval (current or next period
--      only), the pilot business never holds a standing authorization (TW011), nothing charges a studio. tw4_rfl_pilot_cover and its evidence fields are untouched (U-4).
--   2. Lock order: tw4_act_mark_ready / tw4_act_activate / tw4_act_suspend took the location link before the onboarding row, the inverse of tw4_num_retire, the
--      tw4_num_observe mismatch branch and the number runner. They now take the onboarding row first, then the location link, then (mark ready / activate) the business
--      row, the credit account and the authorizations. Only the act_* side changes.
--   3. The activation checklist gains 'usage_reconciler_ready': usage reconciliation must be healthy (public._tw4usage_reconciler_ready(), slice F3, 20261218090000).
--      Resolved at run time: without F3's helper the item FAILS CLOSED ('reconciler_gate_not_installed'), so applying this file without 20261218 blocks EVERY activation
--      (pilot and credit businesses alike). Hosted apply order: 20261218 then 20261219; rollback order: 20261219 first (F3's rollback refuses while this file is applied).
-- Requires 20261208..20261217 (and 20261218 for any activation to pass). Rollback: rollback/20261219090000_twilio_act_pilot_funding_lock_order_rollback.sql (restores the five replaced bodies byte-exactly).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public._tw4rfl_register_core(uuid,uuid,text,text,text,text,text,uuid,uuid,boolean)') is null or to_regprocedure('public.tw4_rfl_pilot_cover(uuid,text,text,uuid)') is null
     or to_regprocedure('public._tw4act_funding(uuid)') is null or to_regclass('public.studio_sms_provider_cover') is null then
    raise exception 'act-pilot-funding precondition failed: 20261208 .. 20261217 are not all applied';
  end if;
  if to_regprocedure('public._tw4act_pilot_funding(uuid,uuid)') is not null then
    raise exception 'act-pilot-funding precondition failed: already applied';
  end if;
  -- the replaced bodies must still be the 20261208 versions (another slice must not be clobbered silently)
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4act_funding(uuid)'::regprocedure), chr(13), '')), 8) <> '97363f0b' then
    raise exception 'act-pilot-funding precondition failed: public._tw4act_funding(uuid) differs from its main definition';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4act_items(uuid)'::regprocedure), chr(13), '')), 8) <> 'e31b4ad2' then
    raise exception 'act-pilot-funding precondition failed: public._tw4act_items(uuid) differs from its main definition';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_act_mark_ready(uuid,uuid,text)'::regprocedure), chr(13), '')), 8) <> '98531279' then
    raise exception 'act-pilot-funding precondition failed: public.tw4_act_mark_ready(uuid,uuid,text) differs from its main definition';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_act_activate(uuid,uuid,text)'::regprocedure), chr(13), '')), 8) <> 'acbb1c37' then
    raise exception 'act-pilot-funding precondition failed: public.tw4_act_activate(uuid,uuid,text) differs from its main definition';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_act_suspend(uuid,uuid,text)'::regprocedure), chr(13), '')), 8) <> '4bcd3c9d' then
    raise exception 'act-pilot-funding precondition failed: public.tw4_act_suspend(uuid,uuid,text) differs from its main definition';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- pilot funding continuity
-- ---------------------------------------------------------------------------------------------------------------
-- The pilot business has no standing authorization: Twilio's monthly fees for its live resources are paid, period by period, from the cumulative pilot ceiling, each
-- period on its own written approval. Activation needs the CURRENT period of every live fee-bearing resource of the location covered; the next period is reported.
create or replace function public._tw4act_pilot_funding(p_studio_id uuid, p_entity uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  pe public.studio_sms_pilot_exceptions;
  a public.studio_sms_credit_accounts;
  r public.studio_sms_provider_resources;
  v_account text := public._tw4num_account(p_studio_id);
  v_qe public.studio_sms_prov_operations := public._tw4num_campaign(p_studio_id);
  v_p public.studio_sms_num_operations;
  v_cur text;
  v_nxt text;
  v_used bigint;
  v_uncovered text[] := '{}';
  v_next text[] := '{}';
begin
  select * into pe from public.studio_sms_pilot_exceptions y where y.legal_entity_id = p_entity;
  if pe.legal_entity_id is null then
    return jsonb_build_object('ok', false, 'detail', 'not_pilot');
  end if;
  -- TW011 refuses a standing authorization for the pilot business everywhere; if one exists anyway, nothing here may treat the business as covered by it
  if exists (select 1 from public.studio_sms_recurring_authorizations x where x.legal_entity_id = p_entity and x.status = 'active') then
    return jsonb_build_object('ok', false, 'detail', 'pilot_standing_authorization_present', 'pilot', true);
  end if;
  select * into a from public.studio_sms_credit_accounts x where x.legal_entity_id = p_entity;
  if a.legal_entity_id is not null and (a.hold or a.balance_cents < 0) then
    return jsonb_build_object('ok', false, 'detail', 'credit_on_hold', 'pilot', true);
  end if;
  -- the cumulative ceiling (never replenished): every guard that reserves against it refuses to cross it, so an excess here is a defect and blocks
  select coalesce(sum(cr.amount_cents), 0) into v_used from public.studio_sms_credit_reservations cr where cr.legal_entity_id = p_entity and cr.funding = 'pilot' and cr.status in ('reserved', 'captured');
  if v_used > pe.ceiling_cents then
    return jsonb_build_object('ok', false, 'detail', 'pilot_ceiling_exceeded', 'pilot', true, 'pilot_used_cents', v_used, 'pilot_ceiling_cents', pe.ceiling_cents);
  end if;
  v_cur := public._tw4ml_month_key(p_entity, now());
  v_nxt := public._tw4ml_key_add(v_cur, 1);
  -- the resources activation depends on: the ledger's live number and the verified campaign, each registered (live) in the recurring-fee inventory
  select * into v_p from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null
     and x.twilio_account_sid = v_account;
  if v_p.id is null or v_qe.id is null then
    return jsonb_build_object('ok', false, 'detail', 'pilot_resources_unconfirmed', 'pilot', true);
  end if;
  if not exists (select 1 from public.studio_sms_provider_resources x where x.studio_id = p_studio_id and x.legal_entity_id = p_entity and x.resource_kind = 'number'
                  and x.provider_state = 'active' and x.provider_sid = v_p.provider_sid) then
    return jsonb_build_object('ok', false, 'detail', 'pilot_number_not_registered', 'pilot', true);
  end if;
  if not exists (select 1 from public.studio_sms_provider_resources x where x.studio_id = p_studio_id and x.legal_entity_id = p_entity and x.resource_kind = 'campaign'
                  and x.provider_state = 'active' and x.provider_sid = v_qe.provider_sid) then
    return jsonb_build_object('ok', false, 'detail', 'pilot_campaign_not_registered', 'pilot', true);
  end if;
  -- every live fee-bearing resource of the location (Twilio bills each one, whichever the ledger names): a pilot reservation of this business, location and fee kind,
  -- still reserved or captured, bound to the resource for the period. Time alone, a charge or a commitment never covers a pilot period. A first-period reservation bound
  -- at registration covers only the month its money was set aside in (a reservation from an earlier month, registered late, funds no later month: review P2).
  for r in select * from public.studio_sms_provider_resources x where x.studio_id = p_studio_id and x.provider_state = 'active' and x.fee_kind is not null order by x.resource_kind, x.id loop
    if r.legal_entity_id <> p_entity or not exists (
         select 1 from public.studio_sms_provider_cover pc join public.studio_sms_credit_reservations cr on cr.id = pc.reservation_id
          where pc.resource_id = r.id and pc.period_key = v_cur and pc.basis in ('pilot_approval', 'initial_reservation')
            and cr.legal_entity_id = p_entity and cr.studio_id = p_studio_id and cr.funding = 'pilot' and cr.kind = r.fee_kind and cr.status in ('reserved', 'captured')
            and (pc.basis = 'pilot_approval' or public._tw4ml_month_key(p_entity, cr.created_at) = pc.period_key)) then
      v_uncovered := v_uncovered || r.resource_kind;
    end if;
    if not exists (
         select 1 from public.studio_sms_provider_cover pc join public.studio_sms_credit_reservations cr on cr.id = pc.reservation_id
          where pc.resource_id = r.id and pc.period_key = v_nxt and pc.basis in ('pilot_approval', 'initial_reservation')
            and cr.legal_entity_id = p_entity and cr.studio_id = p_studio_id and cr.funding = 'pilot' and cr.kind = r.fee_kind and cr.status in ('reserved', 'captured')
            and (pc.basis = 'pilot_approval' or public._tw4ml_month_key(p_entity, cr.created_at) = pc.period_key)) then
      v_next := v_next || r.resource_kind;
    end if;
  end loop;
  if cardinality(v_uncovered) > 0 then
    return jsonb_build_object('ok', false, 'detail', 'pilot_current_period_unapproved', 'pilot', true, 'period_key', v_cur, 'uncovered', to_jsonb(v_uncovered),
      'next_period_key', v_nxt, 'next_period_needs_approval', cardinality(v_next) > 0, 'next_period_uncovered', to_jsonb(v_next));
  end if;
  return jsonb_build_object('ok', true, 'detail', 'ok', 'pilot', true, 'period_key', v_cur, 'pilot_used_cents', v_used, 'pilot_ceiling_cents', pe.ceiling_cents,
    -- informational: the next period is NOT funded by this pass; it needs its own written approval (tw4_rfl_pilot_cover) before it starts
    'next_period_key', v_nxt, 'next_period_needs_approval', cardinality(v_next) > 0, 'next_period_uncovered', to_jsonb(v_next));
end $$;

-- funding continuity (R2a design 6.1/6.2): Twilio keeps billing a live campaign and number whether or not the owner's authorization still stands
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
    -- 20261219: no standing authorization may exist for the pilot business; each live period is funded by its own written approval within the cumulative ceiling
    return public._tw4act_pilot_funding(p_studio_id, v_entity);
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

-- ---------------------------------------------------------------------------------------------------------------
-- the activation checklist (+ usage reconciliation health)
-- ---------------------------------------------------------------------------------------------------------------
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
  v_recon jsonb := null;
  v_recon_installed boolean := to_regprocedure('public._tw4usage_reconciler_ready()') is not null;
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
  -- 20261219: usage reconciliation health (slice F3, 20261218): resolved dynamically; absent or unreadable FAILS CLOSED (no activation without healthy reconciliation)
  if v_recon_installed then
    begin
      execute 'select public._tw4usage_reconciler_ready()' into v_recon;
    exception when others then
      v_recon := jsonb_build_object('ok', false, 'detail', 'reconciler_error');
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
    -- 20261219: billed usage must be reconciled with the provider on schedule before a location may send (F3's health contract {ok, detail, last_success_at})
    jsonb_build_object('id', 'usage_reconciler_ready', 'ok', coalesce(jsonb_typeof(v_recon -> 'ok') = 'boolean' and (v_recon ->> 'ok')::boolean, false),
      'detail', case when not v_recon_installed then 'reconciler_gate_not_installed'
                     when coalesce(jsonb_typeof(v_recon -> 'ok') = 'boolean' and (v_recon ->> 'ok')::boolean, false) then 'ok'
                     else coalesce(nullif(left(v_recon ->> 'detail', 80), ''), 'reconciler_not_ready') end),
    jsonb_build_object('id', 'funding_continuity', 'ok', coalesce((v_fund ->> 'ok')::boolean, false), 'detail', v_fund ->> 'detail'));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- state changes: one lock order with the number runner, tw4_num_retire and the tw4_num_observe mismatch branch
-- ---------------------------------------------------------------------------------------------------------------
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
  -- 20261219: onboarding row first, then the location link (the order tw4_num_retire, tw4_num_observe and the number runner take); the funding locks follow
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  perform public._tw4sr_lock(p_studio_id);
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
  -- 20261219: onboarding row first, then the location link (the order tw4_num_retire, tw4_num_observe and the number runner take); the funding locks follow
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  perform public._tw4sr_lock(p_studio_id);
  if o.id is null or o.state not in ('ready_for_activation', 'suspended') then
    raise exception 'onboarding state % cannot be activated', coalesce(o.state, 'none') using errcode = 'TW030';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease' using errcode = '55P03';
  end if;
  -- everything is re-evaluated NOW, in the same transaction as the state change (a verification, attestation, authorization or pilot period approval that lapsed since "ready" blocks it)
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
  -- 20261219: onboarding row first, then the location link (the order tw4_num_retire, tw4_num_observe and the number runner take)
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  perform public._tw4sr_lock(p_studio_id);
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

-- ---------------------------------------------------------------------------------------------------------------
-- privileges: the new helper is internal (no API role); create or replace keeps the replaced functions' grants
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4act_pilot_funding(uuid, uuid) from public, anon, authenticated, service_role;

commit;
