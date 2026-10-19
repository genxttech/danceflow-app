-- Rollback of 20261127090000 (recurring execution): restores the 20261126090000 / 20261122090000 function bodies. Refuses once scheduler runs or switch changes exist
-- (operational evidence). Roll the application back first (it relies on the run functions and the sender gate).
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_recurring_runs') is null then
    raise exception 'recurring-execution rollback: not applied';
  end if;
  if exists (select 1 from public.studio_sms_recurring_runs) or exists (select 1 from public.studio_sms_recurring_switch_log) or exists (select 1 from public.studio_sms_recurring_charges where run_id is not null) then
    raise exception 'recurring-execution rollback refused: scheduler runs, switch changes or run-stamped charges exist' using errcode = '55000';
  end if;
end $$;

drop function public.tw4_recurring_charge(uuid, text, uuid);
alter table public.studio_sms_recurring_charges drop column run_id;
drop function public.tw4_recurring_set_switch(boolean, uuid, text), public.tw4_recurring_run_begin(text, int), public.tw4_recurring_run_finish(uuid, text, jsonb, text),
  public._tw4rc_reconciliation_gaps(), public._tw4rc_promised(uuid);
drop table public.studio_sms_recurring_switch_log;
drop table public.studio_sms_recurring_runs;
drop function public._tw4rc_run_guard();

create or replace function public._tw4f3a_committed(p_entity uuid)
returns bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select coalesce(sum(amount_cents), 0) from public.studio_sms_spend_events where legal_entity_id = p_entity and status in ('authorized', 'reserved'); $$;

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
  perform public._tw4c_lock(v_entity);   -- one decision at a time per legal business
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
  if exists (select 1 from public.studio_sms_recurring_authorizations a where a.legal_entity_id = v_entity and a.studio_id = p_studio_id and a.kind = p_kind and a.status = 'active') then
    raise exception 'this charge is already authorized for this location' using errcode = '23505';
  end if;
  -- the acknowledgement is built HERE from the validated numbers (never taken from a caller); the application shows the identical text before the owner agrees
  v_statement := 'I authorize DanceFlow to deduct ' || public._tw4rc_usd(v_price.customer_price_cents) || ' per month for '
    || case p_kind when 'number' then 'texting phone number rent' else 'monthly texting service' end
    || ' from my legal business''s prepaid texting credit, for up to ' || p_term_months || ' month' || case when p_term_months = 1 then '' else 's' end
    || ' and no more than ' || public._tw4rc_usd(v_limit) || ' in total, whichever comes first. '
    || 'The charge is taken only if enough settled credit is available. No card is charged, no credit is added automatically, and I can revoke this at any time. '
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

create or replace function public.tw4_recurring_charge(p_authorization_id uuid, p_period_key text)
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
  acct := public._tw4c_lock(a.legal_entity_id);   -- the one lock every credit mutation takes: charges, top-ups, holds and revocations are serialized
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
  elsif exists (select 1 from public.studio_sms_recurring_charges x where x.legal_entity_id = a.legal_entity_id and x.studio_id = a.studio_id and x.kind = a.kind and x.period_key = p_period_key and x.status = 'charged' and x.authorization_id <> a.id) then
    v_status := 'refused'; v_reason := 'this period was already charged under another authorization';   -- revoke + authorize again never charges one period twice
  elsif v_spent + a.price_cents > a.total_limit_cents then
    v_status := 'refused'; v_reason := 'authorized spending limit reached';
  elsif acct.hold then
    v_status := 'held'; v_reason := 'the credit account is on hold';
  elsif acct.balance_cents < 0 or (acct.balance_cents - acct.reserved_cents) < a.price_cents then
    v_status := 'unfunded'; v_reason := 'insufficient settled credit';   -- settled credit only: there is no fallback funding of any kind
  end if;

  if v_status is not null then
    if c.id is null then
      insert into public.studio_sms_recurring_charges (authorization_id, legal_entity_id, studio_id, kind, period_key, amount_cents, status, reason)
      values (a.id, a.legal_entity_id, a.studio_id, a.kind, p_period_key, a.price_cents, v_status, v_reason);
    else
      update public.studio_sms_recurring_charges set status = v_status, reason = v_reason, attempts = attempts + 1, attempted_at = clock_timestamp() where id = c.id;
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
    insert into public.studio_sms_recurring_charges (authorization_id, legal_entity_id, studio_id, kind, period_key, amount_cents, status, reservation_id, charged_at)
    values (a.id, a.legal_entity_id, a.studio_id, a.kind, p_period_key, a.price_cents, 'charged', v_res, clock_timestamp());
  else
    update public.studio_sms_recurring_charges set status = 'charged', reason = null, reservation_id = v_res, charged_at = clock_timestamp(), attempts = attempts + 1, attempted_at = clock_timestamp() where id = c.id;
  end if;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (a.studio_id, null, 'system', null, 'recurring_charged', left('authorization=' || a.id || ';period=' || p_period_key || ';cents=' || a.price_cents, 300));
  return jsonb_build_object('outcome', 'charged', 'replayed', false, 'amount_cents', a.price_cents);
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
  for a in select * from public.studio_sms_recurring_authorizations x where x.studio_id = p_studio_id and x.status = 'active' and x.expires_at > now() loop
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
  for a in select * from public.studio_sms_recurring_authorizations x where x.studio_id = p_studio_id and x.status = 'active' and x.expires_at > now() order by x.created_at loop
    v_start_month := date_trunc('month', timezone('UTC', a.starts_at))::date;
    for v_month in select m::date from generate_series((v_now_month - interval '1 month')::timestamp, v_now_month::timestamp, interval '1 month') m loop
      continue when v_month < v_start_month or (v_month::timestamp at time zone 'UTC') >= a.expires_at;
      continue when exists (select 1 from public.studio_sms_recurring_charges x where x.legal_entity_id = a.legal_entity_id and x.studio_id = a.studio_id and x.kind = a.kind and x.period_key = to_char(v_month, 'YYYY-MM') and x.status = 'charged');
      select * into c from public.studio_sms_recurring_charges x where x.authorization_id = a.id and x.period_key = to_char(v_month, 'YYYY-MM');
      if c.id is null then
        return 'waiting';
      end if;
      return case when c.status = 'unfunded' then 'unfunded' when c.status = 'held' then 'held' when c.reason like '%limit%' then 'limit' when c.reason like 'price changed%' then 'price' else 'waiting' end;
    end loop;
  end loop;
  return null;
end $$;

create or replace function public.sms_recurring_overview(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_expected bigint;
  v_available bigint;
begin
  if auth.uid() is null or coalesce(public._sms_onb_studio_role(p_studio_id), '') not in ('studio_owner', 'studio_admin') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    return jsonb_build_object('legal_business', false);
  end if;
  select coalesce(sum(a.price_cents), 0) into v_expected from public.studio_sms_recurring_authorizations a
   where a.legal_entity_id = v_entity and a.status = 'active' and a.expires_at > now()
     and coalesce((select sum(c.amount_cents) from public.studio_sms_recurring_charges c where c.authorization_id = a.id and c.status = 'charged'), 0) + a.price_cents <= a.total_limit_cents;   -- one that has reached its limit will not charge again
  select greatest(coalesce(c.balance_cents, 0) - coalesce(c.reserved_cents, 0), 0) into v_available from public.studio_sms_credit_accounts c where c.legal_entity_id = v_entity;
  return jsonb_build_object(
    'legal_business', true,
    'expected_monthly_cents', v_expected,
    'available_cents', coalesce(v_available, 0),
    'months_covered', case when v_expected > 0 then coalesce(v_available, 0) / v_expected else null end,
    'low_for_recurring', v_expected > 0 and coalesce(v_available, 0) < v_expected,
    'on_hold', coalesce((select c.hold from public.studio_sms_credit_accounts c where c.legal_entity_id = v_entity), false),
    'service_state', public._tw4rc_service_state(p_studio_id),
    'service_issue', public._tw4rc_service_issue(p_studio_id),
    'authorizations', coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc) from (
        select a.id, a.kind, a.price_cents, a.term_months, a.total_limit_cents, a.starts_at, a.expires_at, a.status, a.created_at,
               (a.studio_id = p_studio_id) as this_location,
               coalesce((select sum(c.amount_cents) from public.studio_sms_recurring_charges c where c.authorization_id = a.id and c.status = 'charged'), 0) as spent_cents,
               (select c.status from public.studio_sms_recurring_charges c where c.authorization_id = a.id order by c.period_key desc limit 1) as last_status,
               (select c.period_key from public.studio_sms_recurring_charges c where c.authorization_id = a.id order by c.period_key desc limit 1) as last_period
          from public.studio_sms_recurring_authorizations a where a.legal_entity_id = v_entity order by a.created_at desc limit 20) r), '[]'::jsonb));
end $$;

create or replace function public.sms_recurring_admin_overview()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if not public._sms_onb_is_platform_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'active_authorizations', (select count(*) from public.studio_sms_recurring_authorizations a where a.status = 'active' and a.expires_at > now()),
    'needs_attention', coalesce((select jsonb_agg(to_jsonb(r) order by r.attempted_at desc) from (
        select e.legal_name, c.kind, c.period_key, c.amount_cents, c.status, c.reason, c.attempts, c.attempted_at
          from public.studio_sms_recurring_charges c join public.studio_sms_legal_entities e on e.id = c.legal_entity_id
         where c.status <> 'charged' order by c.attempted_at desc limit 50) r), '[]'::jsonb));
end $$;

revoke all on function public.tw4_recurring_charge(uuid, text) from public, anon, authenticated;
grant execute on function public.tw4_recurring_charge(uuid, text) to service_role;

commit;
