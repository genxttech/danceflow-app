-- 20261226090000_twilio_act_console_gates.sql
-- TW-4F J4 (activation console), database half (dark; Git-only until separately authorized). Replaces two F1 (20261219) bodies; nothing else.
--   1. _tw4act_pilot_funding: a cover marked superseded (20261225 supersede evidence) never funds a pilot period. 20261225's _tw4rfl_cover already ignores
--      superseded covers and a superseded cover never meets the other conditions, so the verdict is unchanged: defense in depth, deferred here from F1.
--   2. _tw4act_items: new checklist item 'pilot_ki1_redecided'. Known pilot-ceiling issue KI-1 (double pilot capture when a campaign approval lands in a later month
--      than its reservation; tracker, owner decision 2026-10-23) is an activation gate: for the pilot business the item fails ('ki1_owner_redecision_pending:lifted_only_by_migration'), so
--      tw4_act_mark_ready / tw4_act_activate refuse (TW042) until the owner re-decides KI-1 and a later migration lifts the item (no flag, switch or admin action can). Only mark ready and activate are gated: suspend, sender revoke and RFL suspension still work for the pilot. Other businesses: ok ('not_pilot').
--   3. _tw4act_items: 'number_owned' and 'number_attached' no longer report detail 'ok' while failing (ownership or attachment read-back lost, or an attachment of
--      another number): 'ownership_not_confirmed', 'attachment_differs_from_purchase', 'attachment_not_confirmed'. The ok verdicts are unchanged.
-- Requires 20261219 (bodies fingerprint-checked) and 20261225 (studio_sms_provider_cover.superseded_at). Locks, grants, the non-pilot funding path, the pilot
-- ceiling, tw4_rfl_pilot_cover and every other checklist item are unchanged. Rollback: rollback/20261226090000_twilio_act_console_gates_rollback.sql (restores the
-- 20261219 bodies byte-exactly). NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public._tw4act_pilot_funding(uuid,uuid)') is null or to_regprocedure('public._tw4act_items(uuid)') is null then
    raise exception 'act-console-gates precondition failed: 20261219090000 is not applied';
  end if;
  if not exists (select 1 from pg_attribute a where a.attrelid = 'public.studio_sms_provider_cover'::regclass and a.attname = 'superseded_at' and not a.attisdropped) then
    raise exception 'act-console-gates precondition failed: 20261225090000 is not applied (studio_sms_provider_cover.superseded_at)';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4act_pilot_funding(uuid,uuid)'::regprocedure), chr(13), '')), 8) = '7d9ce80d' then
    raise exception 'act-console-gates precondition failed: already applied';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4act_pilot_funding(uuid,uuid)'::regprocedure), chr(13), '')), 8) <> '8f7508a6' then
    raise exception 'act-console-gates precondition failed: public._tw4act_pilot_funding(uuid,uuid) differs from its 20261219 definition';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4act_items(uuid)'::regprocedure), chr(13), '')), 8) <> '9a6e8d29' then
    raise exception 'act-console-gates precondition failed: public._tw4act_items(uuid) differs from its 20261219 definition';
  end if;
end $$;

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
  -- still reserved or captured, bound to the resource for the period and not superseded (20261226). Time alone, a charge or a commitment never covers a pilot period. A first-period reservation bound
  -- at registration covers only the month its money was set aside in (a reservation from an earlier month, registered late, funds no later month: review P2).
  for r in select * from public.studio_sms_provider_resources x where x.studio_id = p_studio_id and x.provider_state = 'active' and x.fee_kind is not null order by x.resource_kind, x.id loop
    if r.legal_entity_id <> p_entity or not exists (
         select 1 from public.studio_sms_provider_cover pc join public.studio_sms_credit_reservations cr on cr.id = pc.reservation_id
          where pc.resource_id = r.id and pc.period_key = v_cur and pc.basis in ('pilot_approval', 'initial_reservation') and pc.superseded_at is null
            and cr.legal_entity_id = p_entity and cr.studio_id = p_studio_id and cr.funding = 'pilot' and cr.kind = r.fee_kind and cr.status in ('reserved', 'captured')
            and (pc.basis = 'pilot_approval' or public._tw4ml_month_key(p_entity, cr.created_at) = pc.period_key)) then
      v_uncovered := v_uncovered || r.resource_kind;
    end if;
    if not exists (
         select 1 from public.studio_sms_provider_cover pc join public.studio_sms_credit_reservations cr on cr.id = pc.reservation_id
          where pc.resource_id = r.id and pc.period_key = v_nxt and pc.basis in ('pilot_approval', 'initial_reservation') and pc.superseded_at is null
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
  v_pilot boolean;
begin
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  v_pilot := exists (select 1 from public.studio_sms_pilot_exceptions y where y.legal_entity_id = v_entity);   -- 20261226 (KI-1 gate)
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
      'detail', case when v_p.id is null then 'no_purchase'
                     when not exists (select 1 from public.studio_sms_num_resources r where r.operation_id = v_p.id and r.status = 'owned') then 'ownership_not_confirmed' else 'ok' end),   -- 20261226
    jsonb_build_object('id', 'number_attached', 'ok', v_a.id is not null and v_p.id is not null and v_a.provider_sid = v_p.provider_sid
      and exists (select 1 from public.studio_sms_num_resources r where r.operation_id = v_a.id and r.status = 'attached'),
      'detail', case when v_a.id is null then 'no_attachment' when v_p.id is null or v_a.provider_sid is distinct from v_p.provider_sid then 'attachment_differs_from_purchase'
                     when not exists (select 1 from public.studio_sms_num_resources r where r.operation_id = v_a.id and r.status = 'attached') then 'attachment_not_confirmed' else 'ok' end),   -- 20261226
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
    jsonb_build_object('id', 'funding_continuity', 'ok', coalesce((v_fund ->> 'ok')::boolean, false), 'detail', v_fund ->> 'detail'),
    -- 20261226: known pilot-ceiling issue KI-1 (a campaign reservation captured in one month plus a later month's written approval can capture twice for one provider
    -- month) is an owner activation gate: the pilot business is not activated until the owner re-decides it and a migration lifts this item. Other businesses: n/a.
    jsonb_build_object('id', 'pilot_ki1_redecided', 'ok', not v_pilot, 'detail', case when v_pilot then 'ki1_owner_redecision_pending:lifted_only_by_migration' else 'not_pilot' end));
end $$;

-- create or replace keeps both functions' privileges (no API role); the postcondition pins the bodies this file defines
do $$
begin
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4act_pilot_funding(uuid,uuid)'::regprocedure), chr(13), '')), 8) <> '7d9ce80d' or left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4act_items(uuid)'::regprocedure), chr(13), '')), 8) <> 'bdd8399d' then
    raise exception 'act-console-gates postcondition failed: a body differs from this file';
  end if;
end $$;

commit;
