-- Rollback of 20261209090000 (recurring provider-fee lifecycle). Restores _tw4rc_service_state as of 20261128090000 and drops the inventory, cover, exposure,
-- cancellation and alert objects.
-- REFUSES once any resource, cover record, exposure, cancellation operation or alert exists: provider and financial evidence is never destroyed, and from then on the
-- stance is forward-fix only. Roll the application back first. The audit vocabulary keeps the lifecycle actions (harmless; removing them could orphan audit rows).
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_provider_resources') is null then
    raise exception 'recurring-fee-lifecycle rollback: not applied';
  end if;
  -- no writer may add evidence between this check and the drops below
  lock table public.studio_sms_provider_resources, public.studio_sms_provider_cover, public.studio_sms_provider_exposure, public.studio_sms_provider_cancel_ops,
    public.studio_sms_provider_alerts in access exclusive mode;
  if exists (select 1 from public.studio_sms_provider_resources) or exists (select 1 from public.studio_sms_provider_cover) or exists (select 1 from public.studio_sms_provider_exposure)
     or exists (select 1 from public.studio_sms_provider_cancel_ops) or exists (select 1 from public.studio_sms_provider_alerts)
     or exists (select 1 from public.studio_sms_onboarding_audit where action like 'rfl\_%') then
    raise exception 'recurring-fee-lifecycle rollback refused: lifecycle evidence exists' using errcode = '55000';
  end if;
end $$;

-- as of 20261128090000 (the sending gate without the lifecycle check)
create or replace function public._tw4rc_service_state(p_studio_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a record;
  v_cur text;
  k text;
  v_state text := 'none';
  v_grace_from timestamptz;
begin
  for a in select * from public.studio_sms_recurring_authorizations x where x.studio_id = p_studio_id and x.status = 'active' and x.expires_at > now()
                and not exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = x.legal_entity_id) loop   -- a pilot business is governed by per-operation approvals, not by this state
    v_cur := public._tw4ml_month_key(a.legal_entity_id, now());
    if v_state = 'none' then v_state := 'active'; end if;
    -- the current and the previous service month are the ones that can still be charged: an unpaid one that is still collectible keeps the service in its state
    foreach k in array array[public._tw4ml_key_add(v_cur, -1), v_cur] loop
      continue when k < public._tw4ml_month_key(a.legal_entity_id, a.starts_at) or public._tw4ml_month_start(a.legal_entity_id, k) >= a.expires_at;
      -- paid under THIS or an earlier authorization of the same location and fee (revoke + authorize again must not make a paid month look overdue)
      continue when exists (select 1 from public.studio_sms_recurring_charges c where c.legal_entity_id = a.legal_entity_id and c.studio_id = a.studio_id and c.kind = a.kind and c.period_key = k and c.status = 'charged');
      v_grace_from := greatest(public._tw4ml_month_start(a.legal_entity_id, k), a.starts_at);
      if now() > v_grace_from + interval '7 days' then
        return 'suspended';
      end if;
      v_state := 'past_due';
    end loop;
  end loop;
  return v_state;
end $$;


-- as of 20261203090000 (without the retired-resource refusal)
create or replace function public.tw4_recurring_charge(p_authorization_id uuid, p_period_key text, p_run_id uuid default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_recurring_authorizations;
  acct public.studio_sms_credit_accounts;
  p public.studio_sms_price_list;
  c public.studio_sms_recurring_charges;
  cr public.studio_sms_credit_reservations;
  v_cur text;
  v_spent bigint;
  v_status text;
  v_reason text;
  v_res uuid;
  v_key text;
begin
  if p_period_key is null or p_period_key !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  select * into a from public.studio_sms_recurring_authorizations x where x.id = p_authorization_id;
  if a.id is null then
    raise exception 'unknown authorization' using errcode = '22023';
  end if;
  -- entity row first (the order tw4_spend_reserve / tw4_spend_authorize use), then the account row
  perform 1 from public.studio_sms_legal_entities le where le.id = a.legal_entity_id for no key update;
  acct := public._tw4c_lock(a.legal_entity_id);   -- the one lock every credit mutation takes: charges, top-ups, holds, limit changes and revocations are serialized
  -- a scheduler run is fenced by its lease and by the kill switch, checked AFTER the locks
  if p_run_id is not null and not exists (select 1 from public.studio_sms_recurring_runs r where r.id = p_run_id and r.status = 'running' and r.lease_expires_at > clock_timestamp()) then
    raise exception 'the scheduler run is not active' using errcode = '22023';
  end if;
  if p_run_id is not null and not coalesce((select l.enabled from public.studio_sms_recurring_switch_log l order by l.changed_at desc, l.id desc limit 1), false) then
    raise exception 'the scheduler is switched off' using errcode = '22023';
  end if;
  perform public._tw4ml_ensure_tz(a.legal_entity_id);
  v_cur := public._tw4ml_month_key(a.legal_entity_id, now());
  -- only the current or the previous service month (in the business's timezone) can be charged: never the future, never ancient history
  if p_period_key <> v_cur and p_period_key <> public._tw4ml_key_add(v_cur, -1) then
    raise exception 'this period cannot be charged now' using errcode = '22023';
  end if;
  select * into a from public.studio_sms_recurring_authorizations x where x.id = p_authorization_id for update;
  select * into c from public.studio_sms_recurring_charges x where x.authorization_id = a.id and x.period_key = p_period_key for update;
  if c.id is not null and c.status = 'charged' then
    return jsonb_build_object('outcome', 'charged', 'replayed', true);
  end if;

  v_status := null;
  select coalesce(sum(x.amount_cents), 0) into v_spent from public.studio_sms_recurring_charges x where x.authorization_id = a.id and x.status = 'charged';
  select * into p from public.studio_sms_price_list x where x.kind = a.kind and x.active;
  -- the first month's set-aside funds, if still held, are what this charge captures (no second reservation); they are already counted in the month they were set aside in, so capturing them needs no new room
  if a.commitment_reservation_id is not null then
    select * into cr from public.studio_sms_credit_reservations x where x.id = a.commitment_reservation_id for update;
    if cr.id is not null and cr.status = 'reserved' then
    else
      cr := null;
    end if;
  end if;
  if a.status <> 'active' then
    v_status := 'refused'; v_reason := 'revoked';
  elsif a.expires_at <= now() or public._tw4ml_month_start(a.legal_entity_id, p_period_key) >= a.expires_at or p_period_key < public._tw4ml_month_key(a.legal_entity_id, a.starts_at) then
    v_status := 'refused'; v_reason := 'outside the authorized term';
  elsif p.id is null or p.customer_price_cents <> a.price_cents then
    v_status := 'refused'; v_reason := 'price changed: the owner must authorize again';
  elsif exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = a.legal_entity_id) then
    v_status := 'refused'; v_reason := 'pilot business: each recurring operation needs its own approval';   -- the pilot ceiling is never consumed by a schedule
  elsif exists (select 1 from public.studio_sms_recurring_charges x where x.legal_entity_id = a.legal_entity_id and x.studio_id = a.studio_id and x.kind = a.kind and x.period_key = p_period_key and x.status = 'charged' and x.authorization_id <> a.id) then
    v_status := 'refused'; v_reason := 'this period was already charged under another authorization';   -- revoke + authorize again never charges one period twice
  elsif v_spent + a.price_cents > a.total_limit_cents then
    v_status := 'refused'; v_reason := 'authorized spending limit reached';
  -- owner decision (PR 248): an authorized recurring fee is checked against the month's spending WITHOUT inbound texts, so inbound volume (which can
  -- never be refused) cannot hold the business's phone number or messaging service; inbound still counts for everything else
  elsif cr.id is null and public._tw4in_spend_without_inbound(a.legal_entity_id, v_cur) + a.price_cents > public._tw4ml_effective_limit(a.legal_entity_id, v_cur) then
    v_status := 'held'; v_reason := 'monthly spending limit reached';   -- retried: next month, or when the owner raises the limit
  elsif acct.hold then
    v_status := 'held'; v_reason := 'the credit account is on hold';
  elsif (cr.id is null and (acct.balance_cents < 0 or (acct.balance_cents - acct.reserved_cents) < a.price_cents))
     or (cr.id is not null and (acct.balance_cents < 0 or acct.balance_cents < cr.amount_cents)) then
    v_status := 'unfunded'; v_reason := 'insufficient settled credit';   -- settled credit only: a refunded or reversed top-up can leave a set-aside with nothing behind it; there is no fallback funding of any kind
  end if;

  if v_status is not null then
    if c.id is null then
      insert into public.studio_sms_recurring_charges (authorization_id, legal_entity_id, studio_id, kind, period_key, amount_cents, status, reason, run_id)
      values (a.id, a.legal_entity_id, a.studio_id, a.kind, p_period_key, a.price_cents, v_status, v_reason, p_run_id);
    else
      update public.studio_sms_recurring_charges set status = v_status, reason = v_reason, attempts = attempts + 1, attempted_at = clock_timestamp(), run_id = p_run_id where id = c.id;
    end if;
    insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
    values (a.studio_id, null, 'system', null, 'recurring_' || v_status, left('authorization=' || a.id || ';period=' || p_period_key || ';' || v_reason, 300));
    return jsonb_build_object('outcome', v_status, 'reason', v_reason, 'replayed', false);
  end if;

  if cr.id is not null then
    -- capture the funds that were set aside when the owner authorized
    v_res := cr.id;
    perform public._tw4c_post(a.legal_entity_id, a.studio_id, 'capture', -cr.amount_cents, -cr.amount_cents, 'capture:' || cr.reservation_key, cr.id, 'recurring=' || a.id || ';period=' || p_period_key, null, null);
    update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = cr.id;
  else
    -- funded and within the authorization: reserve and capture in one transaction (no reservation is ever left open by a charge)
    v_key := 'rec:' || a.id || ':' || p_period_key;
    insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
    values (a.legal_entity_id, a.studio_id, a.kind, a.price_cents, 'credit', v_key) returning id into v_res;
    perform public._tw4c_post(a.legal_entity_id, a.studio_id, 'reserve', 0, a.price_cents, 'reserve:' || v_key, v_res, 'recurring=' || a.id, null, null);
    perform public._tw4c_post(a.legal_entity_id, a.studio_id, 'capture', -a.price_cents, -a.price_cents, 'capture:' || v_key, v_res, 'recurring=' || a.id || ';period=' || p_period_key, null, null);
    update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = v_res;
  end if;
  if c.id is null then
    insert into public.studio_sms_recurring_charges (authorization_id, legal_entity_id, studio_id, kind, period_key, amount_cents, status, reservation_id, charged_at, run_id)
    values (a.id, a.legal_entity_id, a.studio_id, a.kind, p_period_key, a.price_cents, 'charged', v_res, clock_timestamp(), p_run_id);
  else
    update public.studio_sms_recurring_charges set status = 'charged', reason = null, reservation_id = v_res, charged_at = clock_timestamp(), attempts = attempts + 1, attempted_at = clock_timestamp(), run_id = p_run_id where id = c.id;
  end if;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (a.studio_id, null, 'system', null, 'recurring_charged', left('authorization=' || a.id || ';period=' || p_period_key || ';cents=' || a.price_cents, 300));
  return jsonb_build_object('outcome', 'charged', 'replayed', false, 'amount_cents', a.price_cents);
end $$;

drop trigger studio_sms_recurring_authorizations_30_rfl on public.studio_sms_recurring_authorizations;
drop trigger studio_sms_spend_events_35_rfl on public.studio_sms_spend_events;
drop trigger studio_sms_credit_reservations_35_rfl on public.studio_sms_credit_reservations;
drop function public._tw4rfl_oneoff_guard();
drop function public._tw4rfl_auth_guard();
drop function public.sms_rfl_owner_overview(uuid);
drop function public.tw4_rfl_admin_overview(uuid);
drop function public.tw4_rfl_alert_finish(uuid, uuid, boolean, text);
drop function public.tw4_rfl_alerts_claim(int);
drop function public.tw4_rfl_studio_ready(uuid);
drop function public.tw4_rfl_cancel_resolve(uuid, uuid, text, text, text);
drop function public.tw4_rfl_cancel_finish(uuid, uuid, text, text, text);
drop function public.tw4_rfl_cancel_begin(uuid, uuid);
drop function public.tw4_rfl_cancel_withdraw(uuid, uuid, text);
drop function public.tw4_rfl_cancel_authorize(uuid, uuid, text, text, text, boolean);
drop function public.tw4_rfl_suspend_df(uuid, uuid, text, boolean);
drop function public.tw4_rfl_exposure_dispose(uuid, text, uuid, text, text);
drop function public.tw4_rfl_observe_provider_bill(uuid, text, text, int, uuid);
drop function public.tw4_rfl_inventory_gaps();
drop function public.tw4_rfl_scan_entity(uuid);
drop function public.tw4_rfl_scan_entities();
drop function public.tw4_rfl_pilot_cover(uuid, text, text, uuid);
drop function public.tw4_rfl_register(uuid, uuid, text, text, text, text, text, uuid, uuid);
drop function public._tw4rfl_mark_cancelled(public.studio_sms_provider_resources, uuid, text, uuid, timestamptz);
drop function public._tw4rfl_df_sending(uuid);
drop function public._tw4rfl_alert(uuid, uuid, uuid, text, text, text, text, text);
drop function public._tw4rfl_gate_suspended(uuid);
drop function public._tw4rfl_retired(uuid, uuid, text[], text);
drop function public._tw4rfl_replacement(public.studio_sms_provider_resources, text);
drop function public._tw4rfl_live_sender(public.studio_sms_provider_resources);
drop function public._tw4rfl_cover(public.studio_sms_provider_resources, text);
drop function public._tw4rfl_due_from(public.studio_sms_provider_resources, text);
drop function public._tw4rfl_charge_kinds(text);
drop function public._tw4rfl_lock(uuid);
drop function public._tw4rfl_audit(uuid, uuid, text, text);
drop table public.studio_sms_provider_alerts;
drop table public.studio_sms_provider_cancel_ops;
drop table public.studio_sms_provider_exposure;
drop table public.studio_sms_provider_cover;
drop table public.studio_sms_provider_resources;
drop function public._tw4rfl_guard();
-- the approval-reference registry: remove ONLY this migration's 'cancellation' source (a sibling's sources stay; no cancellation rows can exist: refused above)
do $$
declare
  v_src text;
  v_shape text;
  v_sources text[];
  v_clause text := ' OR (source = ''cancellation''::text AND spend_event_id IS NULL AND kind IS NULL AND amount_cents IS NULL AND funding IS NULL AND studio_id IS NOT NULL)';
  v_clause_pg text := ' OR ((source = ''cancellation''::text) AND (spend_event_id IS NULL) AND (kind IS NULL) AND (amount_cents IS NULL) AND (funding IS NULL) AND (studio_id IS NOT NULL))';
begin
  select pg_get_constraintdef(c.oid) into v_src from pg_constraint c where c.conrelid = 'public.studio_sms_approval_refs'::regclass and c.conname = 'studio_sms_approval_refs_source_check';
  select pg_get_constraintdef(c.oid) into v_shape from pg_constraint c where c.conrelid = 'public.studio_sms_approval_refs'::regclass and c.conname = 'studio_sms_approval_refs_shape';
  select array_agg(distinct m[1] order by m[1]) into v_sources from regexp_matches(substring(v_src from 'ANY ((.*))'), '([a-z_]+)', 'g') m where m[1] not in ('text', 'array', 'cancellation');
  alter table public.studio_sms_approval_refs drop constraint studio_sms_approval_refs_source_check;
  execute format('alter table public.studio_sms_approval_refs add constraint studio_sms_approval_refs_source_check check (source = any (%L::text[]))', v_sources);
  v_shape := replace(replace(v_shape, v_clause_pg, ''), v_clause, '');
  if position('cancellation' in v_shape) > 0 then
    raise exception 'recurring-fee-lifecycle rollback: could not remove the cancellation clause from %', v_shape;
  end if;
  alter table public.studio_sms_approval_refs drop constraint studio_sms_approval_refs_shape;
  execute 'alter table public.studio_sms_approval_refs add constraint studio_sms_approval_refs_shape ' || v_shape;
end $$;

commit;
