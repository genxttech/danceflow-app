-- 20261127090000_twilio_recurring_execution.sql
-- Recurring-charge EXECUTION: the owner's direction that recurring fees count toward the legal business's spending limits, and the safe scheduler.
--   * _tw4f3a_committed now counts recurring charges taken: tw4_spend_authorize (setup fees) and every recurring charge see one shared spending cap. A recurring authorization needs
--     room for one charge, and each charge is held ('legal-business spending cap reached', retried if the cap is raised) once the cap is used.
--   * A PILOT business (the founder-authorized ConfiDance exception) cannot hold a standing recurring authorization (TW011) and a charge for one is refused: every recurring
--     fee-bearing operation there needs its own explicit approval (tw4_spend_authorize, funding 'pilot'); no schedule consumes the pilot ceiling; SMS usage stays outside it.
--   * Scheduler: a database kill switch (default OFF, platform-admin changes with a reason, append-only log), ONE run at a time by lease, a record of every run (counts,
--     errors) and run fencing (a charge carrying an expired or replaced run id is refused), run_id on every charge attempt, and a reconciliation count in the admin overview.
-- Requires 20261126090000. Rollback: rollback/20261127090000_twilio_recurring_execution_rollback.sql (restores the previous bodies; refuses once runs or switch changes exist).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_recurring_charges') is null then
    raise exception 'recurring-execution precondition failed: recurring authorization (20261126090000) is not applied';
  end if;
  if to_regclass('public.studio_sms_recurring_runs') is not null then
    raise exception 'recurring-execution precondition failed: already applied';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- scheduler: one run at a time (database lease), a database kill switch that defaults to OFF, and an auditable record of every run
-- ---------------------------------------------------------------------------------------------------------------
create table public.studio_sms_recurring_runs (
  id uuid primary key default gen_random_uuid(),
  runner text not null check (char_length(btrim(runner)) between 3 and 80),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default clock_timestamp(),
  lease_expires_at timestamptz not null,
  finished_at timestamptz null,
  summary jsonb null,
  error text null check (error is null or char_length(error) <= 300),
  constraint studio_sms_recurring_runs_finished check ((status = 'running') = (finished_at is null))
);
create unique index studio_sms_recurring_runs_one_running on public.studio_sms_recurring_runs ((true)) where status = 'running';

create table public.studio_sms_recurring_switch_log (
  id uuid primary key default gen_random_uuid(),
  enabled boolean not null,
  changed_by uuid not null,
  reason text not null check (char_length(btrim(reason)) between 10 and 300),
  changed_at timestamptz not null default clock_timestamp()
);

alter table public.studio_sms_recurring_charges add column run_id uuid null references public.studio_sms_recurring_runs(id) on delete restrict;

revoke all on public.studio_sms_recurring_runs, public.studio_sms_recurring_switch_log from public, anon, authenticated, service_role;
alter table public.studio_sms_recurring_runs enable row level security;
alter table public.studio_sms_recurring_switch_log enable row level security;

create or replace function public._tw4rc_run_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_table_name = 'studio_sms_recurring_runs' and tg_op = 'UPDATE' then
    -- a run only ever goes running -> completed | failed (once), and its identity never changes
    if old.status <> 'running' or new.status = 'running' or new.id is distinct from old.id or new.runner is distinct from old.runner or new.started_at is distinct from old.started_at then
      raise exception 'a finished scheduler run is final' using errcode = '42501';
    end if;
    return new;
  end if;
  raise exception '% rows are append-only', tg_table_name using errcode = '42501';
end $$;
create trigger studio_sms_recurring_runs_guard before update or delete on public.studio_sms_recurring_runs for each row execute function public._tw4rc_run_guard();
create trigger studio_sms_recurring_switch_guard before update or delete on public.studio_sms_recurring_switch_log for each row execute function public._tw4rc_run_guard();
create trigger studio_sms_recurring_runs_truncate before truncate on public.studio_sms_recurring_runs for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_recurring_switch_truncate before truncate on public.studio_sms_recurring_switch_log for each statement execute function public._tw4c_truncate_guard();

create or replace function public.tw4_recurring_set_switch(p_enabled boolean, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  if p_enabled is null or p_reason is null or char_length(btrim(p_reason)) < 10 then
    raise exception 'a switch change needs a written reason (10+ characters)' using errcode = '22023';
  end if;
  insert into public.studio_sms_recurring_switch_log (enabled, changed_by, reason) values (p_enabled, p_actor, btrim(p_reason));
  return jsonb_build_object('enabled', p_enabled);
end $$;

-- takes the single scheduler lease (a stale one is closed as failed first). Not acquired when the switch is off, when another run holds the lease, or the period is malformed.
create or replace function public.tw4_recurring_run_begin(p_runner text, p_lease_seconds int default 600)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_id uuid;
begin
  if p_runner is null or char_length(btrim(p_runner)) < 3 or p_lease_seconds is null or p_lease_seconds not between 60 and 3600 then
    raise exception 'invalid scheduler run' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_recurring_run'));
  if not coalesce((select l.enabled from public.studio_sms_recurring_switch_log l order by l.changed_at desc, l.id desc limit 1), false) then
    return jsonb_build_object('acquired', false, 'reason', 'disabled');
  end if;
  update public.studio_sms_recurring_runs set status = 'failed', finished_at = clock_timestamp(), error = 'lease expired before the run finished'
   where status = 'running' and lease_expires_at <= clock_timestamp();
  insert into public.studio_sms_recurring_runs (runner, lease_expires_at) values (btrim(p_runner), clock_timestamp() + make_interval(secs => p_lease_seconds))
  on conflict ((true)) where status = 'running' do nothing returning id into v_id;
  if v_id is null then
    return jsonb_build_object('acquired', false, 'reason', 'busy');
  end if;
  return jsonb_build_object('acquired', true, 'run_id', v_id);
end $$;

create or replace function public.tw4_recurring_run_finish(p_run_id uuid, p_status text, p_summary jsonb, p_error text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare r public.studio_sms_recurring_runs;
begin
  if p_status is null or p_status not in ('completed', 'failed') then
    raise exception 'invalid run outcome' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_recurring_runs x where x.id = p_run_id for update;
  if r.id is null then
    raise exception 'unknown scheduler run' using errcode = '22023';
  end if;
  if r.status <> 'running' then
    return jsonb_build_object('status', r.status, 'replayed', true);
  end if;
  update public.studio_sms_recurring_runs set status = p_status, finished_at = clock_timestamp(), summary = p_summary, error = left(p_error, 300) where id = r.id;
  return jsonb_build_object('status', p_status, 'replayed', false);
end $$;

-- reconciliation, both ways: every charged recurring row must have a captured credit reservation and a capture ledger entry of the same business, location, fee and amount, and
-- every captured recurring reservation / capture ledger entry must belong to a charged row
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

-- what the business's other ACTIVE, unexpired authorizations may still charge (their total limit minus what they have charged): a new authorization must fit beside them
create or replace function public._tw4rc_promised(p_entity uuid)
returns bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(sum(greatest(a.total_limit_cents - coalesce((select sum(c.amount_cents) from public.studio_sms_recurring_charges c where c.authorization_id = a.id and c.status = 'charged'), 0), 0)), 0)
    from public.studio_sms_recurring_authorizations a
   where a.legal_entity_id = p_entity and a.status = 'active' and a.expires_at > now();
$$;

-- the legal business's spending cap counts every fee it has committed to: authorized + reserved spend events AND recurring charges taken (a released or withdrawn authorization frees its share)
create or replace function public._tw4f3a_committed(p_entity uuid)
returns bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce((select sum(amount_cents) from public.studio_sms_spend_events where legal_entity_id = p_entity and status in ('authorized', 'reserved')), 0)
       + coalesce((select sum(amount_cents) from public.studio_sms_recurring_charges where legal_entity_id = p_entity and status = 'charged'), 0);
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
     and not exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = a.legal_entity_id)   -- a pilot business has no standing authorizations to look ahead to
     and coalesce((select sum(c.amount_cents) from public.studio_sms_recurring_charges c where c.authorization_id = a.id and c.status = 'charged'), 0) + a.price_cents <= a.total_limit_cents;   -- one that has reached its limit will not charge again
  select greatest(coalesce(c.balance_cents, 0) - coalesce(c.reserved_cents, 0), 0) into v_available from public.studio_sms_credit_accounts c where c.legal_entity_id = v_entity;
  return jsonb_build_object(
    'legal_business', true,
    'expected_monthly_cents', v_expected,
    'available_cents', coalesce(v_available, 0),
    'months_covered', case when v_expected > 0 then coalesce(v_available, 0) / v_expected else null end,
    'low_for_recurring', v_expected > 0 and coalesce(v_available, 0) < v_expected,
    'pilot_business', exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = v_entity),
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
    'recent_runs', coalesce((select jsonb_agg(to_jsonb(r) order by r.started_at desc) from (
        select x.id, x.runner, x.status, x.started_at, x.finished_at, x.summary, x.error from public.studio_sms_recurring_runs x order by x.started_at desc limit 10) r), '[]'::jsonb),
    'scheduler_enabled', coalesce((select l.enabled from public.studio_sms_recurring_switch_log l order by l.changed_at desc, l.id desc limit 1), false),
    'reconciliation_gaps', public._tw4rc_reconciliation_gaps(),
    'needs_attention', coalesce((select jsonb_agg(to_jsonb(r) order by r.attempted_at desc) from (
        select e.legal_name, c.kind, c.period_key, c.amount_cents, c.status, c.reason, c.attempts, c.attempted_at
          from public.studio_sms_recurring_charges c join public.studio_sms_legal_entities e on e.id = c.legal_entity_id
         where c.status <> 'charged' order by c.attempted_at desc limit 50) r), '[]'::jsonb));
end $$;

-- a pilot business keeps no standing recurring authorization: close any that exist (they could never be charged; they would only confuse the service state)
with closed as (
  update public.studio_sms_recurring_authorizations a set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = '00000000-0000-0000-0000-000000000000'
   where a.status = 'active' and exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = a.legal_entity_id)
  returning a.id, a.studio_id, a.kind)
insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
select c.studio_id, null, 'system', null, 'recurring_revoked', left('authorization=' || c.id || ';kind=' || c.kind || ';pilot business', 300) from closed c;

-- privileges: everything here is service-role only (the platform admin's switch is a service function taking the actor, like the other platform-admin operations)
revoke all on function public._tw4rc_run_guard(), public._tw4rc_reconciliation_gaps(), public._tw4rc_promised(uuid) from public, anon, authenticated, service_role;
drop function public.tw4_recurring_charge(uuid, text);
revoke all on function public.tw4_recurring_set_switch(boolean, uuid, text), public.tw4_recurring_run_begin(text, int), public.tw4_recurring_run_finish(uuid, text, jsonb, text),
  public.tw4_recurring_charge(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.tw4_recurring_set_switch(boolean, uuid, text), public.tw4_recurring_run_begin(text, int), public.tw4_recurring_run_finish(uuid, text, jsonb, text),
  public.tw4_recurring_charge(uuid, text, uuid) to service_role;

commit;
