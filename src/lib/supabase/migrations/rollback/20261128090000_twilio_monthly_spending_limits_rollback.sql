-- Rollback of 20261128090000 (monthly spending limits): restores the previous function bodies. Refuses once monthly limits, timezone changes, ceilings or recurring
-- commitment reservations exist (financial/audit evidence). Roll the application back first.
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_monthly_limits') is null then
    raise exception 'monthly-limits rollback: not applied';
  end if;
  if exists (select 1 from public.studio_sms_monthly_limits) or exists (select 1 from public.studio_sms_limit_ceilings)
     or exists (select 1 from public.studio_sms_entity_timezones where set_by_role <> 'system' or effective_month <> '1970-01')
     or exists (select 1 from public.studio_sms_recurring_authorizations where commitment_reservation_id is not null)
     or exists (select 1 from public.studio_sms_onboarding_audit where action in ('monthly_limit_set', 'monthly_limit_ceiling', 'entity_timezone_set')) then
    raise exception 'monthly-limits rollback refused: limits, ceilings, timezone changes or set-aside commitments exist' using errcode = '55000';
  end if;
end $$;

drop function public.tw4_recurring_due_list();
drop function public.tw4_recurring_release_ended();
drop function public.tw4_monthly_limit_set(uuid, uuid, int, text, boolean, text), public.tw4_monthly_limit_set_admin(uuid, uuid, int, text, text),
  public.tw4_entity_timezone_set(uuid, uuid, text, text), public.tw4_entity_timezone_set_admin(uuid, uuid, text, text), public.tw4_limit_ceiling_set_platform(uuid, int, text),
  public.tw4_limit_ceiling_approve_entity(uuid, uuid, int, text), public.sms_monthly_limit_overview(uuid);

create or replace function public._tw4f3a_committed(p_entity uuid)
returns bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce((select sum(amount_cents) from public.studio_sms_spend_events where legal_entity_id = p_entity and status in ('authorized', 'reserved')), 0)
       + coalesce((select sum(amount_cents) from public.studio_sms_recurring_charges where legal_entity_id = p_entity and status = 'charged'), 0);
$$;

create or replace function public.tw4_credit_debit_usage(p_entity_id uuid, p_studio_id uuid, p_cents int, p_key text, p_ref text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
begin
  if p_cents is null or p_cents <= 0 or p_studio_id is null then
    raise exception 'invalid usage amount or location' using errcode = '22023';
  end if;
  a := public._tw4c_lock(p_entity_id);
  -- a replay of a debit that already happened must succeed even if the account has since run low
  if exists (select 1 from public.studio_sms_credit_ledger l where l.legal_entity_id = p_entity_id and l.idempotency_key = 'usage:' || p_key) then
    return public._tw4c_post(p_entity_id, p_studio_id, 'usage_charge', -p_cents, 0, 'usage:' || p_key, null, p_ref, null, null);
  end if;
  perform public._tw4c_require_funds(a, p_cents);
  return public._tw4c_post(p_entity_id, p_studio_id, 'usage_charge', -p_cents, 0, 'usage:' || p_key, null, p_ref, null, null);
end $$;

create or replace function public._tw4rc_promised(p_entity uuid)
returns bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(sum(greatest(a.total_limit_cents - coalesce((select sum(c.amount_cents) from public.studio_sms_recurring_charges c where c.authorization_id = a.id and c.status = 'charged'), 0), 0)), 0)
    from public.studio_sms_recurring_authorizations a
   where a.legal_entity_id = p_entity and a.status = 'active' and a.expires_at > now();
$$;

create or replace function public.tw4_recurring_authorize(p_studio_id uuid, p_user_id uuid, p_kind text, p_acknowledged_price_cents int, p_term_months int, p_total_limit_cents int)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_price public.studio_sms_price_list;
  v_limit int;
  v_id uuid;
  v_statement text;
begin
  if p_user_id is null or p_studio_id is null or not exists (
       select 1 from public.user_studio_roles r where r.user_id = p_user_id and r.studio_id = p_studio_id and r.active = true and r.role = 'studio_owner') then
    raise exception 'only the studio owner can authorize recurring charges' using errcode = '42501';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    raise exception 'this studio has no verified legal business yet' using errcode = 'TW010';
  end if;
  if p_kind is null or p_kind not in ('number', 'monthly') or p_term_months is null or p_term_months not between 1 and 12 then
    raise exception 'invalid recurring authorization' using errcode = '22023';
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = v_entity for share;   -- serialized with pilot-exception creation and cap changes (entity lock first, then the account lock: the order tw4_spend_reserve uses)
  perform public._tw4c_lock(v_entity);   -- one decision at a time per legal business
  -- the founder-authorized pilot business: every recurring fee-bearing operation needs its own explicit approval (tw4_spend_authorize, funding 'pilot', one location, written
  -- reference), so a standing authorization is refused outright and can never stand in for those approvals
  if exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = v_entity) then
    raise exception 'pilot business: each recurring operation needs its own approval' using errcode = 'TW011';
  end if;
  select * into v_price from public.studio_sms_price_list x where x.kind = p_kind and x.active;
  if v_price.id is null then
    raise exception 'no published price for %', p_kind using errcode = 'TW008';
  end if;
  if p_acknowledged_price_cents is distinct from v_price.customer_price_cents then
    raise exception 'the price changed: review and authorize again' using errcode = 'TW008';   -- the owner must have seen the CURRENT price
  end if;
  -- the term IS the spending control: the total limit is the price times the months, so every month of the term can be charged and none beyond it
  v_limit := v_price.customer_price_cents * p_term_months;
  if p_total_limit_cents is not null and p_total_limit_cents <> v_limit then
    raise exception 'the total limit must be the price times the term' using errcode = '22023';
  end if;
  -- an authorization whose term has ended can never charge again: close it so it neither blocks this renewal nor counts as active
  with closed as (
    update public.studio_sms_recurring_authorizations x set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = p_user_id
     where x.legal_entity_id = v_entity and x.studio_id = p_studio_id and x.kind = p_kind and x.status = 'active' and x.expires_at <= now()
    returning x.id, x.studio_id, x.kind)
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  select c.studio_id, null, 'system', p_user_id, 'recurring_revoked', left('authorization=' || c.id || ';kind=' || c.kind || ';term ended', 300) from closed c;
  if exists (select 1 from public.studio_sms_recurring_authorizations a where a.legal_entity_id = v_entity and a.studio_id = p_studio_id and a.kind = p_kind and a.status = 'active') then
    raise exception 'this charge is already authorized for this location' using errcode = '23505';
  end if;
  -- recurring charges count toward the legal business's spending cap like every other fee: the WHOLE term must fit now (the cap is enforced again at every charge)
  if public._tw4f3a_committed(v_entity) + public._tw4rc_promised(v_entity) + v_limit > (select e.spend_cap_cents from public.studio_sms_legal_entities e where e.id = v_entity) then
    raise exception 'this term would exceed the legal business spending cap' using errcode = 'TW004';
  end if;
  -- the acknowledgement is built HERE from the validated numbers (never taken from a caller); the application shows the identical text before the owner agrees
  v_statement := 'I authorize DanceFlow to deduct ' || public._tw4rc_usd(v_price.customer_price_cents) || ' per month for '
    || case p_kind when 'number' then 'texting phone number rent' else 'monthly texting service' end
    || ' from my legal business''s prepaid texting credit, for up to ' || p_term_months || ' month' || case when p_term_months = 1 then '' else 's' end
    || ' and no more than ' || public._tw4rc_usd(v_limit) || ' in total, whichever comes first. '
    || 'The charge is taken only if enough settled credit is available and it fits within my business''s spending limit. No card is charged, no credit is added automatically, and I can revoke this at any time. '
    || 'Final prices and terms are pending approval.';
  -- the term is N whole UTC service months, the month of authorization first: N charges fit exactly, and the term ends on a month boundary
  insert into public.studio_sms_recurring_authorizations (legal_entity_id, studio_id, kind, price_cents, term_months, total_limit_cents, expires_at, authorized_by, statement)
  values (v_entity, p_studio_id, p_kind, v_price.customer_price_cents, p_term_months, v_limit,
          (date_trunc('month', timezone('UTC', now())) + make_interval(months => p_term_months)) at time zone 'UTC', p_user_id, v_statement)
  returning id into v_id;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (p_studio_id, null, 'system', p_user_id, 'recurring_authorized', left('authorization=' || v_id || ';kind=' || p_kind || ';cents=' || v_price.customer_price_cents || ';months=' || p_term_months || ';limit=' || v_limit, 300));
  return jsonb_build_object('authorization_id', v_id, 'price_cents', v_price.customer_price_cents, 'total_limit_cents', v_limit);
end $$;

create or replace function public.tw4_recurring_revoke(p_authorization_id uuid, p_user_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare a public.studio_sms_recurring_authorizations;
begin
  select * into a from public.studio_sms_recurring_authorizations x where x.id = p_authorization_id;
  if p_user_id is null or a.id is null or not exists (
       select 1 from public.user_studio_roles r where r.user_id = p_user_id and r.studio_id = a.studio_id and r.active = true and r.role = 'studio_owner') then
    raise exception 'only the studio owner can revoke a recurring authorization' using errcode = '42501';   -- the same answer for an unknown id and another tenant's
  end if;
  perform public._tw4c_lock(a.legal_entity_id);   -- a charge in flight finishes first; nothing is charged after this commits
  select * into a from public.studio_sms_recurring_authorizations x where x.id = p_authorization_id for update;
  if a.status = 'revoked' then
    return jsonb_build_object('status', 'revoked', 'replayed', true);
  end if;
  update public.studio_sms_recurring_authorizations set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = p_user_id where id = a.id;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (a.studio_id, null, 'system', p_user_id, 'recurring_revoked', left('authorization=' || a.id || ';kind=' || a.kind, 300));
  return jsonb_build_object('status', 'revoked', 'replayed', false);
end $$;

create or replace function public.tw4_recurring_charge(p_authorization_id uuid, p_period_key text, p_run_id uuid default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_recurring_authorizations;
  acct public.studio_sms_credit_accounts;
  p public.studio_sms_price_list;
  c public.studio_sms_recurring_charges;
  v_month date;
  v_now_month date := date_trunc('month', timezone('UTC', now()))::date;
  v_spent bigint;
  v_status text;
  v_reason text;
  v_res uuid;
  v_key text;
begin
  if p_period_key is null or p_period_key !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  v_month := (p_period_key || '-01')::date;
  -- only the current or the previous service month can be charged (never the future, never ancient history)
  if v_month > v_now_month or v_month < (v_now_month - interval '1 month')::date then
    raise exception 'this period cannot be charged now' using errcode = '22023';
  end if;
  select * into a from public.studio_sms_recurring_authorizations x where x.id = p_authorization_id;
  if a.id is null then
    raise exception 'unknown authorization' using errcode = '22023';
  end if;
  -- entity row first (the order tw4_spend_reserve / tw4_spend_authorize use), then the account row: a setup authorization and a recurring charge cannot both pass the shared spending cap
  perform 1 from public.studio_sms_legal_entities le where le.id = a.legal_entity_id for no key update;
  acct := public._tw4c_lock(a.legal_entity_id);   -- the one lock every credit mutation takes: charges, top-ups, holds and revocations are serialized
  -- a scheduler run is fenced by its lease and by the kill switch, checked AFTER the locks (a runner that waited out its lease on them, or whose switch was turned off, charges nothing)
  if p_run_id is not null and not exists (select 1 from public.studio_sms_recurring_runs r where r.id = p_run_id and r.status = 'running' and r.lease_expires_at > clock_timestamp()) then
    raise exception 'the scheduler run is not active' using errcode = '22023';
  end if;
  if p_run_id is not null and not coalesce((select l.enabled from public.studio_sms_recurring_switch_log l order by l.changed_at desc, l.id desc limit 1), false) then
    raise exception 'the scheduler is switched off' using errcode = '22023';
  end if;
  select * into a from public.studio_sms_recurring_authorizations x where x.id = p_authorization_id for update;
  select * into c from public.studio_sms_recurring_charges x where x.authorization_id = a.id and x.period_key = p_period_key for update;
  if c.id is not null and c.status = 'charged' then
    return jsonb_build_object('outcome', 'charged', 'replayed', true);
  end if;

  v_status := null;
  select coalesce(sum(x.amount_cents), 0) into v_spent from public.studio_sms_recurring_charges x where x.authorization_id = a.id and x.status = 'charged';
  select * into p from public.studio_sms_price_list x where x.kind = a.kind and x.active;
  if a.status <> 'active' then
    v_status := 'refused'; v_reason := 'revoked';
  elsif a.expires_at <= now() or (v_month::timestamp at time zone 'UTC') >= a.expires_at or v_month < date_trunc('month', timezone('UTC', a.starts_at))::date then
    v_status := 'refused'; v_reason := 'outside the authorized term';
  elsif p.id is null or p.customer_price_cents <> a.price_cents then
    v_status := 'refused'; v_reason := 'price changed: the owner must authorize again';
  elsif exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = a.legal_entity_id) then
    v_status := 'refused'; v_reason := 'pilot business: each recurring operation needs its own approval';   -- the pilot ceiling is never consumed by a schedule
  elsif exists (select 1 from public.studio_sms_recurring_charges x where x.legal_entity_id = a.legal_entity_id and x.studio_id = a.studio_id and x.kind = a.kind and x.period_key = p_period_key and x.status = 'charged' and x.authorization_id <> a.id) then
    v_status := 'refused'; v_reason := 'this period was already charged under another authorization';   -- revoke + authorize again never charges one period twice
  elsif v_spent + a.price_cents > a.total_limit_cents then
    v_status := 'refused'; v_reason := 'authorized spending limit reached';
  elsif public._tw4f3a_committed(a.legal_entity_id) + a.price_cents > (select e.spend_cap_cents from public.studio_sms_legal_entities e where e.id = a.legal_entity_id) then
    v_status := 'held'; v_reason := 'legal-business spending cap reached';   -- counts every authorized, reserved and recurring fee; retried if the cap is raised
  elsif acct.hold then
    v_status := 'held'; v_reason := 'the credit account is on hold';
  elsif acct.balance_cents < 0 or (acct.balance_cents - acct.reserved_cents) < a.price_cents then
    v_status := 'unfunded'; v_reason := 'insufficient settled credit';   -- settled credit only: there is no fallback funding of any kind
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

  -- funded and within the authorization: reserve and capture in one transaction (no reservation is ever left open by a charge)
  v_key := 'rec:' || a.id || ':' || p_period_key;
  insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
  values (a.legal_entity_id, a.studio_id, a.kind, a.price_cents, 'credit', v_key) returning id into v_res;
  perform public._tw4c_post(a.legal_entity_id, a.studio_id, 'reserve', 0, a.price_cents, 'reserve:' || v_key, v_res, 'recurring=' || a.id, null, null);
  perform public._tw4c_post(a.legal_entity_id, a.studio_id, 'capture', -a.price_cents, -a.price_cents, 'capture:' || v_key, v_res, 'recurring=' || a.id || ';period=' || p_period_key, null, null);
  update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = v_res;
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

create or replace function public.tw4_recurring_due(p_period_key text)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_period_key is null or p_period_key !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  return coalesce((select jsonb_agg(a.id order by a.created_at) from public.studio_sms_recurring_authorizations a
     where a.status = 'active' and a.expires_at > now() and date_trunc('month', timezone('UTC', a.starts_at))::date <= (p_period_key || '-01')::date
       and ((p_period_key || '-01')::date::timestamp at time zone 'UTC') < a.expires_at
       and not exists (select 1 from public.studio_sms_recurring_charges c where c.authorization_id = a.id and c.period_key = p_period_key and c.status in ('charged', 'refused'))), '[]'::jsonb);
end $$;

create or replace function public._tw4rc_service_state(p_studio_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a record;
  v_now_month date := date_trunc('month', timezone('UTC', now()))::date;
  v_month date;
  v_start_month date;
  v_state text := 'none';
  v_grace_from timestamptz;
begin
  for a in select * from public.studio_sms_recurring_authorizations x where x.studio_id = p_studio_id and x.status = 'active' and x.expires_at > now()
                and not exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = x.legal_entity_id) loop   -- a pilot business is governed by per-operation approvals, not by this state
    v_start_month := date_trunc('month', timezone('UTC', a.starts_at))::date;
    if v_state = 'none' then v_state := 'active'; end if;
    -- the current and the previous service month are the ones that can still be charged: an unpaid one that is still collectible keeps the service in its state
    for v_month in select m::date from generate_series((v_now_month - interval '1 month')::timestamp, v_now_month::timestamp, interval '1 month') m loop
      continue when v_month < v_start_month or (v_month::timestamp at time zone 'UTC') >= a.expires_at;
      -- paid under THIS or an earlier authorization of the same location and fee (revoke + authorize again must not make a paid month look overdue)
      continue when exists (select 1 from public.studio_sms_recurring_charges c where c.legal_entity_id = a.legal_entity_id and c.studio_id = a.studio_id and c.kind = a.kind and c.period_key = to_char(v_month, 'YYYY-MM') and c.status = 'charged');
      v_grace_from := greatest(v_month::timestamp at time zone 'UTC', a.starts_at);
      if now() > v_grace_from + interval '7 days' then
        return 'suspended';
      end if;
      v_state := 'past_due';
    end loop;
  end loop;
  return v_state;
end $$;

create or replace function public._tw4rc_service_issue(p_studio_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a record;
  c public.studio_sms_recurring_charges;
  v_now_month date := date_trunc('month', timezone('UTC', now()))::date;
  v_month date;
  v_start_month date;
begin
  for a in select * from public.studio_sms_recurring_authorizations x where x.studio_id = p_studio_id and x.status = 'active' and x.expires_at > now() and not exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = x.legal_entity_id) order by x.created_at loop
    v_start_month := date_trunc('month', timezone('UTC', a.starts_at))::date;
    for v_month in select m::date from generate_series((v_now_month - interval '1 month')::timestamp, v_now_month::timestamp, interval '1 month') m loop
      continue when v_month < v_start_month or (v_month::timestamp at time zone 'UTC') >= a.expires_at;
      continue when exists (select 1 from public.studio_sms_recurring_charges x where x.legal_entity_id = a.legal_entity_id and x.studio_id = a.studio_id and x.kind = a.kind and x.period_key = to_char(v_month, 'YYYY-MM') and x.status = 'charged');
      select * into c from public.studio_sms_recurring_charges x where x.authorization_id = a.id and x.period_key = to_char(v_month, 'YYYY-MM');
      if c.id is null then
        return 'waiting';
      end if;
      return case when c.status = 'unfunded' then 'unfunded' when c.status = 'held' and c.reason like '%spending cap%' then 'cap' when c.status = 'held' then 'held' when c.reason like '%limit%' then 'limit' when c.reason like 'price changed%' then 'price' else 'waiting' end;
    end loop;
  end loop;
  return null;
end $$;

create or replace function public._tw4rc_reconciliation_gaps()
returns bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select
    (select count(*) from public.studio_sms_recurring_charges c
      where c.status = 'charged' and not exists (
        select 1 from public.studio_sms_credit_reservations r
          join public.studio_sms_credit_ledger l on l.reservation_id = r.id and l.kind = 'capture' and l.idempotency_key = 'capture:' || r.reservation_key
         where r.id = c.reservation_id and r.status = 'captured' and r.funding = 'credit' and r.legal_entity_id = c.legal_entity_id and r.studio_id = c.studio_id
           and r.kind = c.kind and r.amount_cents = c.amount_cents and l.legal_entity_id = c.legal_entity_id and l.studio_id = c.studio_id and l.balance_delta_cents = -c.amount_cents))
  + (select count(*) from public.studio_sms_credit_reservations r
      where r.reservation_key like 'rec:%' and not exists (select 1 from public.studio_sms_recurring_charges c where c.reservation_id = r.id and c.status = 'charged'))
  + (select count(*) from public.studio_sms_credit_ledger l
      where l.kind = 'capture' and l.idempotency_key like 'capture:rec:%' and not exists (select 1 from public.studio_sms_recurring_charges c where c.reservation_id = l.reservation_id and c.status = 'charged'));
$$;

create or replace function public._tw4rc_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '% rows are never deleted', tg_table_name using errcode = '42501';
  end if;
  if tg_table_name = 'studio_sms_recurring_authorizations' then
    -- only active -> revoked (with who and when); every acknowledged term is final
    if old.status <> 'active' or new.status <> 'revoked' or new.id is distinct from old.id or new.legal_entity_id is distinct from old.legal_entity_id
       or new.studio_id is distinct from old.studio_id or new.kind is distinct from old.kind or new.price_cents is distinct from old.price_cents
       or new.term_months is distinct from old.term_months or new.total_limit_cents is distinct from old.total_limit_cents or new.starts_at is distinct from old.starts_at
       or new.expires_at is distinct from old.expires_at or new.authorized_by is distinct from old.authorized_by or new.statement is distinct from old.statement
       or new.terms_version is distinct from old.terms_version or new.created_at is distinct from old.created_at then
      raise exception 'an authorization is only ever revoked, never edited' using errcode = '42501';
    end if;
    return new;
  end if;
  -- charges: a charged period is final; an unfunded / held / refused one may be retried (and may become charged)
  if old.status = 'charged' or new.id is distinct from old.id or new.authorization_id is distinct from old.authorization_id or new.legal_entity_id is distinct from old.legal_entity_id
     or new.studio_id is distinct from old.studio_id or new.kind is distinct from old.kind or new.period_key is distinct from old.period_key
     or new.amount_cents is distinct from old.amount_cents or new.attempts < old.attempts then
    raise exception 'a recurring charge record is final once charged and never re-assigned' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public.tw4_credit_resolve_reservation(p_reservation_id uuid, p_outcome text, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
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
end $$;

drop function public._tw4rc_release_commitment(uuid), public._tw4ml_apply_timezone(uuid, uuid, uuid, text, text, text), public._tw4ml_apply_limit(uuid, uuid, uuid, text, int, text, text, boolean),
  public._tw4ml_require_room(uuid, bigint, bigint), public._tw4ml_month_spend(uuid, text), public._tw4ml_month_parts(uuid, text), public._tw4ml_effective_limit(uuid, text),
  public._tw4ml_ceiling_for(uuid), public._tw4ml_limit_for(uuid, text), public._tw4ml_ensure_tz(uuid), public._tw4ml_month_key(uuid, timestamptz), public._tw4ml_month_start(uuid, text),
  public._tw4ml_tz_for(uuid, text), public._tw4ml_default_tz(uuid), public._tw4ml_valid_tz(text), public._tw4ml_key_add(text, int);
alter table public.studio_sms_recurring_authorizations drop column commitment_reservation_id;
drop table public.studio_sms_limit_ceilings;
drop table public.studio_sms_monthly_limits;
drop table public.studio_sms_entity_timezones;
drop function public._tw4ml_guard();

alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action in (
  'access_enabled', 'access_disabled', 'draft_created', 'ein_stored', 'ein_purged', 'submitted', 'cancelled', 'state_changed',
  'runner_step', 'runner_ein_read', 'runner_lease', 'runner_window', 'runner_submission_confirmed', 'runner_evaluation',
  'entity_created', 'location_attested', 'location_decided', 'spend_cap_set', 'spend_authorized', 'spend_reserved',
  'subaccount_confirmed', 'runner_subaccount',
  'credit_topup', 'credit_reversal', 'credit_adjustment', 'credit_hold', 'credit_reserved', 'credit_captured', 'credit_released', 'price_set', 'credit_pilot_exception', 'spend_withdrawn',
  'recurring_authorized', 'recurring_revoked', 'recurring_charged', 'recurring_unfunded', 'recurring_held', 'recurring_refused'));

drop index if exists public.studio_sms_credit_ledger_entity_created, public.studio_sms_credit_reservations_entity_created;
revoke all on function public._tw4rc_promised(uuid) from public, anon, authenticated, service_role;

-- the previous due function was service-role only
revoke all on function public.tw4_recurring_due(text) from public, anon, authenticated;
grant execute on function public.tw4_recurring_due(text) to service_role;

commit;
