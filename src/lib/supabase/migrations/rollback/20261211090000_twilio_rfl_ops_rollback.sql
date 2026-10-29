-- Rollback of 20261211090000 (RFL operational database controls). Restores tw4_rfl_alerts_claim, tw4_rfl_scan_entity, tw4_rfl_exposure_dispose and
-- tw4_rfl_cancel_authorize to their 20261209090000 bodies BYTE FOR BYTE, then drops every object this migration created.
-- REFUSES (SQLSTATE 55000) once any evidence row of the new tables exists (a switch change, a run, a delivery record, a variance acknowledgement, a dual-control request)
-- or any audit row of the new actions exists: that evidence is never destroyed, and from then on the stance is forward-fix only. Roll the application back first.
-- The audit vocabulary keeps this slice's values (harmless; removing them could orphan audit rows). The alert-kind constraint is restored to its 20261209090000 definition, and the
-- rollback REFUSES (55000) while any alert row uses a kind that only this migration allows, or when the live constraint is not exactly this migration's (a later layer must be rolled back first).
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_rfl_switch_log') is null then
    raise exception 'rfl-ops rollback: not applied';
  end if;
  -- no writer may add evidence between this check and the drops below
  lock table public.studio_sms_rfl_switch_log, public.studio_sms_rfl_runs, public.studio_sms_rfl_alert_deliveries, public.studio_sms_provider_variance_acks,
    public.studio_sms_rfl_dual_requests in access exclusive mode;
  if exists (select 1 from public.studio_sms_rfl_switch_log) or exists (select 1 from public.studio_sms_rfl_runs) or exists (select 1 from public.studio_sms_rfl_alert_deliveries)
     or exists (select 1 from public.studio_sms_provider_variance_acks) or exists (select 1 from public.studio_sms_rfl_dual_requests)
     or exists (select 1 from public.studio_sms_onboarding_audit where action in ('rfl_switch_set', 'rfl_variance_acked', 'rfl_dual_requested', 'rfl_dual_approved', 'rfl_dual_rejected',
          'rfl_dual_invalidated', 'rfl_dual_consumed', 'rfl_alert_delivery')) then
    raise exception 'rfl-ops rollback refused: operational evidence exists' using errcode = '55000';
  end if;
end $$;

-- the alert-kind constraint goes back to its 20261209090000 definition (same name, same kinds, same order). Nothing is deleted or rewritten: a row that uses a kind only
-- 20261211090000 allows (owner_notice_second, owner_unresponsive, alert_delivery_exhausted) REFUSES the rollback (SQLSTATE 55000), and so does a constraint that is not exactly 20261211's.
do $$
declare
  v_old text[] := array['authorization_expiring', 'next_period_uncovered', 'pilot_approval_needed', 'funding_low', 'negative_balance', 'account_on_hold',
    'exposure_open', 'provider_variance', 'inventory_gap', 'cancel_unknown', 'cancelled_authorization_active', 'charged_after_cancellation', 'released_resource_active'];
  v_new text[] := array['owner_notice_second', 'owner_unresponsive', 'alert_delivery_exhausted'];
  v_n int;
  v_name text;
  v_def text;
  v_live text[];
  v_expected text;
begin
  -- no writer may insert a 20261211-only kind between the check and the constraint swap below
  lock table public.studio_sms_provider_alerts in access exclusive mode;
  select count(*) into v_n from pg_constraint c where c.conrelid = 'public.studio_sms_provider_alerts'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%authorization_expiring%';
  if v_n <> 1 then
    raise exception 'rfl-ops rollback refused: expected exactly one alert-kind constraint, found %', v_n using errcode = '55000';
  end if;
  select c.conname, pg_get_constraintdef(c.oid) into v_name, v_def from pg_constraint c
   where c.conrelid = 'public.studio_sms_provider_alerts'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%authorization_expiring%';
  select array_agg(distinct m[1] order by m[1]) into v_live from regexp_matches(substring(v_def from 'ANY (.*)$'), '([a-z][a-z0-9_]*)', 'g') m where m[1] not in ('text', 'array');
  if v_name <> 'studio_sms_provider_alerts_kind_check'
     or v_live is distinct from (select array_agg(distinct x order by x) from unnest(v_old || v_new) x) then
    raise exception 'rfl-ops rollback refused: the alert-kind constraint is not exactly the 20261211 definition (a later change is still applied: roll it back first): % %', v_name, v_def using errcode = '55000';
  end if;
  if exists (select 1 from public.studio_sms_provider_alerts a where a.kind = any (v_new)) then
    raise exception 'rfl-ops rollback refused: alert rows use a kind that only 20261211 allows (owner_notice_second, owner_unresponsive, alert_delivery_exhausted); they are never deleted or rewritten' using errcode = '55000';
  end if;
  alter table public.studio_sms_provider_alerts drop constraint studio_sms_provider_alerts_kind_check;
  alter table public.studio_sms_provider_alerts add constraint studio_sms_provider_alerts_kind_check check (kind in ('authorization_expiring', 'next_period_uncovered', 'pilot_approval_needed', 'funding_low',
    'negative_balance', 'account_on_hold', 'exposure_open', 'provider_variance', 'inventory_gap', 'cancel_unknown', 'cancelled_authorization_active', 'charged_after_cancellation', 'released_resource_active'));
  -- postcondition: the restored definition is exactly what 20261209090000 creates
  v_expected := 'CHECK ((kind = ANY (ARRAY[' || (select string_agg(quote_literal(x) || '::text', ', ' order by o) from unnest(v_old) with ordinality as t(x, o)) || '])))';
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.studio_sms_provider_alerts'::regclass and c.conname = 'studio_sms_provider_alerts_kind_check';
  if v_def is distinct from v_expected then
    raise exception 'rfl-ops rollback postcondition failed: restored alert-kind constraint is % (expected %)', v_def, v_expected;
  end if;
end $$;

-- as of 20261209090000
create or replace function public.tw4_rfl_alerts_claim(p_limit int)
returns table (alert_id uuid, claim_token uuid, legal_entity_id uuid, studio_id uuid, kind text, audience text, severity text, summary text)
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_token uuid := gen_random_uuid();
begin
  return query
  with c as (
    select x.id from public.studio_sms_provider_alerts x
     where (x.status in ('pending', 'failed') or (x.status = 'sending' and x.claimed_at < now() - interval '15 minutes')) and x.attempts < 5
     order by x.created_at, x.id limit least(greatest(coalesce(p_limit, 20), 1), 100) for update skip locked),
  u as (
    update public.studio_sms_provider_alerts a set status = 'sending', attempts = a.attempts + 1, claim_token = v_token, claimed_at = now()
     from c where a.id = c.id returning a.*)
  select u.id, u.claim_token, u.legal_entity_id, u.studio_id, u.kind, u.audience, u.severity, u.summary from u;
end $$;

create or replace function public.tw4_rfl_scan_entity(p_entity_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  r public.studio_sms_provider_resources;
  v_cov text;
  v_cur text;
  v_nxt text;
  v_first text;
  k text;
  v_i int;
  v_reason text;
  v_expected int;
  v_opened int := 0;
  v_closed int := 0;
  v_alerts int := 0;
  v_pilot boolean;
  v_auth public.studio_sms_recurring_authorizations;
  v_next_total bigint := 0;
  e public.studio_sms_provider_exposure;
  v_exp_id uuid;
  v_charge record;
begin
  a := public._tw4rfl_lock(p_entity_id);
  v_pilot := exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = p_entity_id);
  v_cur := public._tw4ml_month_key(p_entity_id, now());
  v_nxt := public._tw4ml_key_add(v_cur, 1);
  for r in select * from public.studio_sms_provider_resources x where x.legal_entity_id = p_entity_id and x.provider_state = 'active' and x.fee_kind is not null order by x.id loop
    v_first := public._tw4ml_month_key(p_entity_id, r.registered_at);
    select p.provider_cost_cents into v_expected from public.studio_sms_price_list p where p.kind = r.fee_kind and p.active;
    -- catch-up: every period since registration (at most the last 12) is judged, so a scan that did not run for a while still records what went uncovered; the
    -- sending gate looks only at the previous and the current period (history never suspends by itself)
    for v_i in -11..0 loop
      k := public._tw4ml_key_add(v_cur, v_i);
      continue when k < v_first;
      v_cov := public._tw4rfl_cover(r, k);
      select * into e from public.studio_sms_provider_exposure x where x.resource_id = r.id and x.period_key = k for update;
      if v_cov like 'covered:%' then
        if e.id is not null and e.state = 'open' and e.reason <> 'billed_after_cancellation' then
          perform set_config('tw4.rfl_write', 'on', true);
          update public.studio_sms_provider_exposure set state = 'closed', closed_at = now(), last_detected_at = now(),
                 disposition = case v_cov when 'covered:charge' then 'covered_by_charge' when 'covered:pilot_approval' then 'covered_by_pilot_approval' else 'covered_by_reservation' end where id = e.id;
          perform set_config('tw4.rfl_write', 'off', true);
          perform public._tw4rfl_audit(r.studio_id, null, 'rfl_exposure_closed', 'resource=' || r.id || ';period=' || k || ';by=' || v_cov);
          v_closed := v_closed + 1;
        end if;
      elsif now() > public._tw4rfl_due_from(r, k) or (e.id is not null and e.provider_billed_cents > 0) then
        v_reason := substr(v_cov, 11);
        if e.id is null then
          insert into public.studio_sms_provider_exposure (resource_id, legal_entity_id, studio_id, period_key, reason, expected_provider_cents)
          values (r.id, r.legal_entity_id, r.studio_id, k, v_reason, v_expected) returning id into v_exp_id;
          perform public._tw4rfl_audit(r.studio_id, null, 'rfl_exposure_opened', 'resource=' || r.id || ';period=' || k || ';reason=' || v_reason);
          perform public._tw4rfl_alert(r.legal_entity_id, r.studio_id, r.id, 'exposure_open', 'exposure:' || v_exp_id, 'both', 'critical',
            'A recurring provider fee is running without a current authorization (' || replace(v_reason, '_', ' ') || '). Texting for this location is suspended while its current or previous period stays uncovered.');
          v_opened := v_opened + 1;
        elsif e.state = 'open' then
          perform set_config('tw4.rfl_write', 'on', true);
          update public.studio_sms_provider_exposure set last_detected_at = now(), reason = case when e.reason = 'billed_after_cancellation' then e.reason else v_reason end where id = e.id;
          perform set_config('tw4.rfl_write', 'off', true);
        elsif e.disposition in ('covered_by_charge', 'covered_by_reservation', 'covered_by_pilot_approval') then
          -- cover disappeared (a released reservation): the period is exposed again; an administrator's written disposition is final and is not reopened by time
          perform set_config('tw4.rfl_write', 'on', true);
          update public.studio_sms_provider_exposure set state = 'open', closed_at = null, disposition = null, reason = v_reason, last_detected_at = now() where id = e.id;
          perform set_config('tw4.rfl_write', 'off', true);
          perform public._tw4rfl_audit(r.studio_id, null, 'rfl_exposure_opened', 'resource=' || r.id || ';period=' || k || ';reason=' || v_reason || ';reopened=true');
          v_opened := v_opened + 1;
        end if;
      end if;
    end loop;
    -- upcoming: will the NEXT period be covered by an owner act? (alerts only; nothing is extended or charged here)
    v_cov := public._tw4rfl_cover(r, v_nxt);
    if v_cov like 'uncovered:%' then
      if v_pilot then
        if public._tw4rfl_alert(r.legal_entity_id, r.studio_id, r.id, 'pilot_approval_needed', r.id || ':' || v_nxt, 'both', 'warning',
             'The ' || replace(r.resource_kind, '_', ' ') || ' fee for ' || v_nxt || ' needs a recorded written approval before that period starts.') then v_alerts := v_alerts + 1; end if;
      else
        select * into v_auth from public.studio_sms_recurring_authorizations x where x.legal_entity_id = r.legal_entity_id and x.studio_id = r.studio_id
           and x.kind = any (public._tw4rfl_charge_kinds(r.fee_kind)) and x.status = 'active' and x.expires_at > now() order by x.created_at desc limit 1;
        if v_auth.id is not null and v_auth.expires_at > public._tw4ml_month_start(p_entity_id, v_nxt) and v_auth.total_limit_cents
             - coalesce((select sum(c.amount_cents) from public.studio_sms_recurring_charges c where c.authorization_id = v_auth.id and c.status = 'charged'), 0) >= v_auth.price_cents then
          v_next_total := v_next_total + v_auth.price_cents;   -- the standing authorization will charge it: only funding can stop it
        else
          if public._tw4rfl_alert(r.legal_entity_id, r.studio_id, r.id, 'next_period_uncovered', r.id || ':' || v_nxt, 'both', 'warning',
               'The authorization for the ' || replace(r.resource_kind, '_', ' ') || ' fee ends or reaches its limit before ' || v_nxt || '. Renew it in your texting settings to keep texting on.') then v_alerts := v_alerts + 1; end if;
        end if;
      end if;
    end if;
  end loop;
  -- authorizations ending within 35 days (once per authorization)
  for v_auth in select x.* from public.studio_sms_recurring_authorizations x where x.legal_entity_id = p_entity_id and x.status = 'active' and x.expires_at > now()
                   and x.expires_at <= now() + interval '35 days' and exists (select 1 from public.studio_sms_provider_resources rr where rr.legal_entity_id = x.legal_entity_id
                   and rr.studio_id = x.studio_id and rr.provider_state = 'active' and rr.fee_kind = any (array[x.kind, case when x.kind = 'monthly' then 'monthly_low_volume' when x.kind = 'monthly_low_volume' then 'monthly' end])) loop
    if public._tw4rfl_alert(p_entity_id, v_auth.studio_id, null, 'authorization_expiring', 'auth:' || v_auth.id, 'both', 'warning',
         'A recurring texting authorization ends on ' || to_char(v_auth.expires_at at time zone public._tw4ml_tz_for(p_entity_id, v_cur), 'YYYY-MM-DD') || '. Reauthorize it before then; DanceFlow never extends it for you.') then v_alerts := v_alerts + 1; end if;
  end loop;
  -- funding: the next period's authorized charges versus spendable credit; negative balance; hold
  if exists (select 1 from public.studio_sms_provider_resources x where x.legal_entity_id = p_entity_id and x.provider_state = 'active' and x.fee_kind is not null) then
    if a.balance_cents < 0 then
      if public._tw4rfl_alert(p_entity_id, null, null, 'negative_balance', p_entity_id || ':' || v_cur, 'admin', 'critical', 'A business with live recurring provider resources has a negative credit balance.') then v_alerts := v_alerts + 1; end if;
    end if;
    if a.hold then
      if public._tw4rfl_alert(p_entity_id, null, null, 'account_on_hold', p_entity_id || ':' || v_cur, 'both', 'warning', 'The credit account is on hold while recurring provider resources are live.') then v_alerts := v_alerts + 1; end if;
    end if;
    if v_next_total > 0 and now() >= public._tw4ml_month_start(p_entity_id, v_nxt) - interval '7 days' and (a.balance_cents - a.reserved_cents) < v_next_total then
      if public._tw4rfl_alert(p_entity_id, null, null, 'funding_low', p_entity_id || ':' || v_nxt, 'both', 'warning',
           'Prepaid credit does not cover the recurring charges due for ' || v_nxt || '. Add credit before that period starts.') then v_alerts := v_alerts + 1; end if;
    end if;
  end if;
  -- provider-cost discrepancies on recurring kinds (once per recorded charge)
  for v_charge in select c.id from public.studio_sms_provider_charges c where c.legal_entity_id = p_entity_id and c.status = 'variance' and c.kind in ('number', 'monthly', 'monthly_low_volume') loop
    if public._tw4rfl_alert(p_entity_id, null, null, 'provider_variance', 'charge:' || v_charge.id, 'admin', 'warning', 'A recurring provider charge differs from its published expected cost.') then v_alerts := v_alerts + 1; end if;
  end loop;
  return jsonb_build_object('opened', v_opened, 'closed', v_closed, 'alerts', v_alerts);
end $$;

create or replace function public.tw4_rfl_exposure_dispose(p_resource_id uuid, p_period_key text, p_actor uuid, p_disposition text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_provider_resources;
  e public.studio_sms_provider_exposure;
begin
  perform public._tw4c_admin(p_actor);
  if p_disposition is null or p_disposition not in ('absorbed', 'not_billed_confirmed') or p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'a disposition (absorbed | not_billed_confirmed) needs a written note of 10 to 500 characters' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_provider_resources x where x.id = p_resource_id;
  if r.id is null then
    raise exception 'unknown resource' using errcode = '22023';
  end if;
  perform public._tw4rfl_lock(r.legal_entity_id);
  select * into e from public.studio_sms_provider_exposure x where x.resource_id = p_resource_id and x.period_key = p_period_key for update;
  if e.id is null then
    -- the scan may not have run yet: an uncovered, past-grace period of a known resource is recorded here, then dispositioned (a covered or in-grace one is not exposure)
    if p_period_key is null or p_period_key !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or r.fee_kind is null or p_period_key < public._tw4ml_month_key(r.legal_entity_id, r.registered_at)
       or public._tw4rfl_cover(r, p_period_key) like 'covered:%' or now() <= public._tw4rfl_due_from(r, p_period_key) then
      raise exception 'no exposure is recorded for that period' using errcode = 'TW041';
    end if;
    insert into public.studio_sms_provider_exposure (resource_id, legal_entity_id, studio_id, period_key, reason, expected_provider_cents)
    values (r.id, r.legal_entity_id, r.studio_id, p_period_key, substr(public._tw4rfl_cover(r, p_period_key), 11),
            (select p.provider_cost_cents from public.studio_sms_price_list p where p.kind = r.fee_kind and p.active)) returning * into e;
  end if;
  if e.state = 'closed' and e.disposition = p_disposition and e.disposed_by = p_actor and e.disposition_note = btrim(p_note) then
    return jsonb_build_object('exposure_id', e.id, 'replayed', true);
  end if;
  if e.state <> 'open' then
    raise exception 'the exposure is already closed (%)', e.disposition using errcode = 'TW041';
  end if;
  if p_disposition = 'not_billed_confirmed' and e.provider_billed_cents > 0 then
    raise exception 'the provider bill is recorded as evidence: this exposure can only be absorbed' using errcode = 'TW042';
  end if;
  perform set_config('tw4.rfl_write', 'on', true);
  update public.studio_sms_provider_exposure set state = 'closed', closed_at = now(), disposition = p_disposition, disposed_by = p_actor, disposition_note = btrim(p_note) where id = e.id;
  perform set_config('tw4.rfl_write', 'off', true);
  perform public._tw4rfl_audit(r.studio_id, p_actor, 'rfl_exposure_disposed', 'resource=' || r.id || ';period=' || p_period_key || ';disposition=' || p_disposition || ';billed_cents=' || e.provider_billed_cents);
  return jsonb_build_object('exposure_id', e.id, 'replayed', false);
end $$;

create or replace function public.tw4_rfl_cancel_authorize(p_resource_id uuid, p_actor uuid, p_approval_ref text, p_decided_by text, p_reason text, p_irreversible_ack boolean)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_provider_resources;
  o public.studio_sms_provider_cancel_ops;
  v_norm text;
  v_oldest timestamptz;
begin
  perform public._tw4c_admin(p_actor);
  if p_decided_by is null or p_decided_by not in ('owner_written', 'founder_written', 'policy_lapse') or p_approval_ref is null or char_length(btrim(p_approval_ref)) < 10
     or p_reason is null or char_length(btrim(p_reason)) < 10 then
    raise exception 'a cancellation needs a decision type, a written approval reference (10+ characters) and a written reason (10+ characters)' using errcode = '22023';
  end if;
  if p_irreversible_ack is distinct from true then
    raise exception 'cancelling a provider resource cannot be undone: the irreversibility acknowledgement is required' using errcode = 'TW042';
  end if;
  select * into r from public.studio_sms_provider_resources x where x.id = p_resource_id;
  if r.id is null then
    raise exception 'unknown resource' using errcode = '22023';
  end if;
  perform public._tw4rfl_lock(r.legal_entity_id);
  select * into r from public.studio_sms_provider_resources x where x.id = p_resource_id for update;
  if r.provider_state <> 'active' then
    raise exception 'the resource is already cancelled' using errcode = 'TW041';
  end if;
  v_norm := public._tw4fi_ref_norm(p_approval_ref);
  select * into o from public.studio_sms_provider_cancel_ops x where x.ref_norm = v_norm;
  if o.id is not null then
    if o.resource_id = r.id and o.authorized_by = p_actor and o.decided_by = p_decided_by and o.status = 'authorized' then
      return jsonb_build_object('operation_id', o.id, 'replayed', true);
    end if;
    raise exception 'this approval reference was already used: one written decision authorizes one cancellation, once' using errcode = 'TW043';
  end if;
  if exists (select 1 from public.studio_sms_provider_cancel_ops x where x.resource_id = r.id and x.status in ('authorized', 'in_flight', 'unknown_outcome')) then
    raise exception 'a cancellation of this resource is already open' using errcode = 'TW043';
  end if;
  if r.resource_kind = 'number' then
    -- a phone number is valuable and unrecoverable: only an explicit owner / founder decision, and never while it is the live sender
    if p_decided_by = 'policy_lapse' then
      raise exception 'a phone number is never released on a policy decision: it needs the owner''s or the founder''s written decision' using errcode = 'TW042';
    end if;
    if public._tw4rfl_live_sender(r) then
      raise exception 'suspend DanceFlow sending for this location before cancelling its number' using errcode = 'TW041';
    end if;
  end if;
  if p_decided_by = 'policy_lapse' then
    select min(e.first_detected_at) into v_oldest from public.studio_sms_provider_exposure e where e.resource_id = r.id and e.state = 'open';
    if v_oldest is null or v_oldest > now() - interval '14 days' then
      raise exception 'a lapse cancellation needs an exposure open for at least 14 days' using errcode = 'TW042';
    end if;
  end if;
  perform public._tw4fi_register(p_approval_ref, 'cancellation', r.legal_entity_id, r.studio_id, null, null, null, null, p_actor);   -- the permanent, shared reference namespace (TW019 when used anywhere)
  insert into public.studio_sms_provider_cancel_ops (resource_id, legal_entity_id, studio_id, decided_by, approval_ref, ref_norm, reason, irreversible_ack, authorized_by)
  values (r.id, r.legal_entity_id, r.studio_id, p_decided_by, btrim(p_approval_ref), v_norm, btrim(p_reason), true, p_actor) returning * into o;
  perform public._tw4rfl_audit(r.studio_id, p_actor, 'rfl_cancel_authorized', 'operation=' || o.id || ';resource=' || r.id || ';kind=' || r.resource_kind || ';by=' || p_decided_by);
  return jsonb_build_object('operation_id', o.id, 'replayed', false);
end $$;

create or replace function public.tw4_rfl_admin_overview(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v jsonb;
begin
  perform public._tw4c_admin(p_actor);
  select jsonb_build_object(
    'resources', coalesce((select jsonb_agg(jsonb_build_object(
        'resource_id', r.id, 'legal_entity_id', r.legal_entity_id, 'studio_id', r.studio_id, 'kind', r.resource_kind, 'fee_kind', r.fee_kind, 'provider_state', r.provider_state,
        'df_sending', public._tw4rfl_df_sending(r.studio_id),
        'current_period', public._tw4rfl_cover(r, public._tw4ml_month_key(r.legal_entity_id, now())),
        'next_period', public._tw4rfl_cover(r, public._tw4ml_key_add(public._tw4ml_month_key(r.legal_entity_id, now()), 1)),
        'open_cancel_operation', (select o.status from public.studio_sms_provider_cancel_ops o where o.resource_id = r.id and o.status in ('authorized', 'in_flight', 'unknown_outcome')))
        order by r.registered_at, r.id) from public.studio_sms_provider_resources r), '[]'::jsonb),
    'open_exposure', coalesce((select jsonb_agg(jsonb_build_object('resource_id', e.resource_id, 'period_key', e.period_key, 'reason', e.reason, 'expected_provider_cents', e.expected_provider_cents,
        'provider_billed_cents', e.provider_billed_cents, 'first_detected_at', e.first_detected_at) order by e.first_detected_at) from public.studio_sms_provider_exposure e where e.state = 'open'), '[]'::jsonb),
    'open_exposure_expected_cents', coalesce((select sum(coalesce(e.expected_provider_cents, 0)) from public.studio_sms_provider_exposure e where e.state = 'open'), 0),
    'open_exposure_billed_cents', coalesce((select sum(e.provider_billed_cents) from public.studio_sms_provider_exposure e where e.state = 'open'), 0),
    'alerts_waiting', (select count(*) from public.studio_sms_provider_alerts a where a.status <> 'delivered'),
    'cancel_operations_open', (select count(*) from public.studio_sms_provider_cancel_ops o where o.status in ('authorized', 'in_flight', 'unknown_outcome'))) into v;
  return v;
end $$;

create or replace function public._tw4rfl_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '%: lifecycle evidence is never deleted', tg_table_name using errcode = '42501';
  end if;
  if tg_table_name = 'studio_sms_provider_resources' then
    if new.id is distinct from old.id or new.legal_entity_id is distinct from old.legal_entity_id or new.studio_id is distinct from old.studio_id
       or new.twilio_account_sid is distinct from old.twilio_account_sid or new.resource_kind is distinct from old.resource_kind or new.provider_sid is distinct from old.provider_sid
       or new.e164 is distinct from old.e164 or new.fee_kind is distinct from old.fee_kind or new.source is distinct from old.source
       or new.source_operation_id is distinct from old.source_operation_id or new.registered_by is distinct from old.registered_by or new.registered_at is distinct from old.registered_at then
      raise exception 'studio_sms_provider_resources: the identity of a resource is fixed' using errcode = '42501';
    end if;
    if old.provider_state = 'cancelled' and new is distinct from old then
      raise exception 'studio_sms_provider_resources: a cancelled resource is final' using errcode = '42501';
    end if;
    if new.provider_state is distinct from old.provider_state and coalesce(current_setting('tw4.rfl_write', true), '') <> 'on' then
      raise exception 'studio_sms_provider_resources: the provider state changes only through the cancellation functions' using errcode = '42501';
    end if;
  elsif tg_table_name = 'studio_sms_provider_cover' then
    raise exception 'studio_sms_provider_cover: cover records are permanent' using errcode = '42501';
  elsif tg_table_name = 'studio_sms_provider_exposure' then
    if new.id is distinct from old.id or new.resource_id is distinct from old.resource_id or new.legal_entity_id is distinct from old.legal_entity_id
       or new.studio_id is distinct from old.studio_id or new.period_key is distinct from old.period_key or new.first_detected_at is distinct from old.first_detected_at
       or new.provider_billed_cents < old.provider_billed_cents or coalesce(current_setting('tw4.rfl_write', true), '') <> 'on' then
      raise exception 'studio_sms_provider_exposure: identity is fixed, billed evidence never decreases, rows change only through the lifecycle functions' using errcode = '42501';
    end if;
  elsif tg_table_name = 'studio_sms_provider_cancel_ops' then
    if new.id is distinct from old.id or new.resource_id is distinct from old.resource_id or new.legal_entity_id is distinct from old.legal_entity_id
       or new.studio_id is distinct from old.studio_id or new.decided_by is distinct from old.decided_by or new.approval_ref is distinct from old.approval_ref
       or new.ref_norm is distinct from old.ref_norm or new.reason is distinct from old.reason or new.irreversible_ack is distinct from old.irreversible_ack
       or new.authorized_by is distinct from old.authorized_by or new.authorized_at is distinct from old.authorized_at or coalesce(current_setting('tw4.rfl_write', true), '') <> 'on' then
      raise exception 'studio_sms_provider_cancel_ops: the decision is fixed' using errcode = '42501';
    end if;
    if (old.status in ('confirmed', 'refused', 'withdrawn') or (old.status = 'abandoned' and new.status <> 'confirmed')) and new.status is distinct from old.status then
      raise exception 'studio_sms_provider_cancel_ops: % is final', old.status using errcode = '42501';
    end if;
    if new.status is distinct from old.status and not (
         (old.status = 'authorized' and new.status in ('in_flight', 'withdrawn')) or (old.status = 'in_flight' and new.status in ('confirmed', 'refused', 'unknown_outcome'))
         or (old.status = 'unknown_outcome' and new.status in ('confirmed', 'abandoned')) or (old.status = 'in_flight' and new.status = 'abandoned')
         or (old.status = 'abandoned' and new.status = 'confirmed')) then
      raise exception 'studio_sms_provider_cancel_ops: % -> % is not a legal transition', old.status, new.status using errcode = '42501';
    end if;
  else
    -- alerts: identity and text are fixed; only the delivery fields move
    if new.id is distinct from old.id or new.legal_entity_id is distinct from old.legal_entity_id or new.studio_id is distinct from old.studio_id
       or new.resource_id is distinct from old.resource_id or new.kind is distinct from old.kind or new.dedupe_key is distinct from old.dedupe_key
       or new.audience is distinct from old.audience or new.severity is distinct from old.severity or new.summary is distinct from old.summary
       or new.created_at is distinct from old.created_at or new.attempts < old.attempts or (old.status = 'delivered' and new is distinct from old) then
      raise exception 'studio_sms_provider_alerts: only delivery fields change, and a delivered alert is final' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- the administrator-email policy (the only thing this migration added to outbound_deliveries)
drop policy rfl_admin_alerts_not_staff_visible on public.outbound_deliveries;
drop trigger profiles_90_rflops_demotion on public.profiles;
drop trigger profiles_90_rflops_demotion_del on public.profiles;
drop trigger studio_sms_provider_cancel_ops_90_epoch_ins on public.studio_sms_provider_cancel_ops;
drop trigger studio_sms_provider_cancel_ops_90_epoch_upd on public.studio_sms_provider_cancel_ops;
drop trigger studio_sms_provider_exposure_90_epoch_ins on public.studio_sms_provider_exposure;
drop trigger studio_sms_provider_exposure_90_epoch_upd on public.studio_sms_provider_exposure;
drop trigger studio_sms_provider_resources_90_epoch_upd on public.studio_sms_provider_resources;

drop function public.tw4_rfl_alert_release(uuid, uuid);
drop function public._tw4rflops_lock_parties(text, uuid, text);
drop function public.tw4_rfl_dual_list(uuid);
drop function public.tw4_rfl_dual_reject(uuid, uuid, text);
drop function public.tw4_rfl_dual_approve(uuid, uuid, text);
drop function public.tw4_rfl_dual_request(uuid, text, uuid, text, text, text, text);
drop function public._tw4rflops_consume(text, public.studio_sms_provider_resources, text, text, text, text, uuid);
drop function public._tw4rflops_facts(text, uuid, text, text, text, text);
drop function public._tw4rflops_epoch();
drop function public._tw4rflops_demotion();
drop function public.tw4_rfl_escalate_delivery();
drop function public.tw4_rfl_alert_delivery_record(uuid, uuid, text, text, text);
drop function public.tw4_rfl_alert_recipients(uuid);
drop function public.tw4_rfl_variance_ack(uuid, uuid, text);
drop function public.tw4_rfl_variance_report(uuid);
drop function public.tw4_rfl_exposure_report(uuid);
drop function public.tw4_rfl_health(uuid);
drop function public.tw4_rfl_scan_finish(uuid, text, jsonb, text);
drop function public.tw4_rfl_scan_begin(text, int);
drop function public.tw4_rfl_set_switch(text, boolean, uuid, text);
drop function public.tw4_rfl_switch_enabled(text);
drop table public.studio_sms_rfl_fact_epochs;
drop table public.studio_sms_rfl_dual_requests;
drop table public.studio_sms_provider_variance_acks;
drop table public.studio_sms_rfl_alert_deliveries;
drop table public.studio_sms_rfl_runs;
drop table public.studio_sms_rfl_switch_log;
drop function public._tw4rflops_request_insert();
drop function public._tw4rflops_guard();

commit;
