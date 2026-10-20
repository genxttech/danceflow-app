-- 20261128090000_twilio_monthly_spending_limits.sql
-- Calendar-month spending limits for routine messaging costs (owner direction 2026-10-19), replacing the use of the cumulative spend cap for ongoing operations.
--   * One-time setup fees (registration, vetting, number purchase) keep the cumulative SETUP budget (legal_entities.spend_cap_cents) and per-operation authorization.
--     Recurring fees no longer count toward it (_tw4f3a_committed counts spend events only; this reverses PR 241's accounting).
--   * Routine costs (SMS usage, recurring number rent, recurring campaign / monthly fees) are bounded by an owner-approved MONTHLY limit, by calendar month in the legal
--     business's IANA timezone. The limit defaults to $0 (fail closed). A platform safety ceiling ($500 unless changed; a per-business higher ceiling needs a separate platform
--     approval) bounds every limit, and the effective limit is always the lesser of the two.
--   * A limit change is an audited owner (or platform admin) action; a lower limit applies at once; a higher one also applies at once but only with explicit confirmation, a
--     recent sign-in, no hold and a non-negative balance, and never above the ceiling. The month's spending at the time of the change is recorded with it.
--   * A timezone change is audited and takes effect from the NEXT calendar month, so month boundaries cannot be moved to dodge a limit.
--   * Recurring authorization sets aside the first month's charge from settled credit when the owner authorizes (a commitment reservation), so setup spending cannot consume it;
--     the first charge captures that reservation (no second reservation), a revocation or ended term releases it.
--   * Ledger history is untouched: this migration is additive (new tables, one new column) plus replaced functions. Month attribution uses the ledger's own created_at.
-- Requires 20261127090000. Rollback: rollback/20261128090000_twilio_monthly_spending_limits_rollback.sql (restores the previous function bodies; refuses once limits, timezone
-- changes, ceilings or commitment reservations exist). NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_recurring_runs') is null or to_regprocedure('public.tw4_recurring_charge(uuid,text,uuid)') is null then
    raise exception 'monthly-limits precondition failed: recurring execution (20261127090000) is not applied';
  end if;
  if to_regclass('public.studio_sms_monthly_limits') is not null then
    raise exception 'monthly-limits precondition failed: already applied';
  end if;
end $$;

alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action in (
  'access_enabled', 'access_disabled', 'draft_created', 'ein_stored', 'ein_purged', 'submitted', 'cancelled', 'state_changed',
  'runner_step', 'runner_ein_read', 'runner_lease', 'runner_window', 'runner_submission_confirmed', 'runner_evaluation',
  'entity_created', 'location_attested', 'location_decided', 'spend_cap_set', 'spend_authorized', 'spend_reserved',
  'subaccount_confirmed', 'runner_subaccount',
  'credit_topup', 'credit_reversal', 'credit_adjustment', 'credit_hold', 'credit_reserved', 'credit_captured', 'credit_released', 'price_set', 'credit_pilot_exception', 'spend_withdrawn',
  'recurring_authorized', 'recurring_revoked', 'recurring_charged', 'recurring_unfunded', 'recurring_held', 'recurring_refused',
  'monthly_limit_set', 'monthly_limit_ceiling', 'entity_timezone_set'));

-- ---------------------------------------------------------------------------------------------------------------
-- tables (no API-role privileges; append-only)
-- ---------------------------------------------------------------------------------------------------------------
create table public.studio_sms_entity_timezones (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id) on delete restrict,
  timezone text not null check (char_length(timezone) between 3 and 64),
  effective_month text not null check (effective_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),   -- the first calendar month this timezone governs
  set_by uuid null,
  set_by_role text not null check (set_by_role in ('system', 'owner', 'platform_admin')),
  reason text null check (reason is null or char_length(reason) <= 300),
  created_at timestamptz not null default clock_timestamp()
);
create index studio_sms_credit_ledger_entity_created on public.studio_sms_credit_ledger (legal_entity_id, created_at);
create index studio_sms_credit_reservations_entity_created on public.studio_sms_credit_reservations (legal_entity_id, created_at);
create index studio_sms_entity_timezones_lookup on public.studio_sms_entity_timezones (legal_entity_id, effective_month desc, created_at desc);

create table public.studio_sms_monthly_limits (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id) on delete restrict,
  effective_month text not null check (effective_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),   -- the first calendar month this limit governs (a change "now" uses the current month)
  limit_cents int not null check (limit_cents >= 0),
  previous_limit_cents int not null check (previous_limit_cents >= 0),
  spend_at_change_cents bigint not null check (spend_at_change_cents >= 0),   -- the month's spending when the owner confirmed the change
  changed_by uuid not null,
  changed_by_role text not null check (changed_by_role in ('owner', 'platform_admin')),
  reason text null check (reason is null or char_length(reason) <= 300),
  created_at timestamptz not null default clock_timestamp()
);
create index studio_sms_monthly_limits_lookup on public.studio_sms_monthly_limits (legal_entity_id, effective_month desc, created_at desc);

create table public.studio_sms_limit_ceilings (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('platform', 'entity')),
  legal_entity_id uuid null references public.studio_sms_legal_entities(id) on delete restrict,
  ceiling_cents int not null check (ceiling_cents >= 0),
  approved_by uuid not null,
  approval_ref text not null check (char_length(btrim(approval_ref)) between 10 and 200),
  created_at timestamptz not null default clock_timestamp(),
  constraint studio_sms_limit_ceilings_scope check ((scope = 'platform') = (legal_entity_id is null))
);
create index studio_sms_limit_ceilings_lookup on public.studio_sms_limit_ceilings (scope, legal_entity_id, created_at desc);

revoke all on public.studio_sms_entity_timezones, public.studio_sms_monthly_limits, public.studio_sms_limit_ceilings from public, anon, authenticated, service_role;
alter table public.studio_sms_entity_timezones enable row level security;
alter table public.studio_sms_monthly_limits enable row level security;
alter table public.studio_sms_limit_ceilings enable row level security;

create or replace function public._tw4ml_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception '% rows are append-only', tg_table_name using errcode = '42501';
end $$;
create trigger studio_sms_entity_timezones_guard before update or delete on public.studio_sms_entity_timezones for each row execute function public._tw4ml_guard();
create trigger studio_sms_monthly_limits_guard before update or delete on public.studio_sms_monthly_limits for each row execute function public._tw4ml_guard();
create trigger studio_sms_limit_ceilings_guard before update or delete on public.studio_sms_limit_ceilings for each row execute function public._tw4ml_guard();
create trigger studio_sms_entity_timezones_truncate before truncate on public.studio_sms_entity_timezones for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_monthly_limits_truncate before truncate on public.studio_sms_monthly_limits for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_limit_ceilings_truncate before truncate on public.studio_sms_limit_ceilings for each statement execute function public._tw4c_truncate_guard();

-- the first month's charge of a recurring authorization is set aside when the owner authorizes (a credit reservation); the column is final once written
alter table public.studio_sms_recurring_authorizations add column commitment_reservation_id uuid null references public.studio_sms_credit_reservations(id);

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
       or new.terms_version is distinct from old.terms_version or new.created_at is distinct from old.created_at
       or new.commitment_reservation_id is distinct from old.commitment_reservation_id then
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

-- ---------------------------------------------------------------------------------------------------------------
-- calendar months in the legal business's timezone
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4ml_key_add(p_key text, p_n int)
returns text language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$ select to_char((p_key || '-01')::date + make_interval(months => p_n), 'YYYY-MM'); $$;

create or replace function public._tw4ml_valid_tz(p_tz text)
returns boolean language sql stable
set search_path = pg_catalog, public, pg_temp
as $$ select p_tz is not null and exists (select 1 from pg_catalog.pg_timezone_names n where n.name = p_tz and n.name !~ '^(posix|right)/'); $$;

-- the founding location's timezone (the first linked location), or UTC if it is missing or not a real IANA zone
create or replace function public._tw4ml_default_tz(p_entity uuid)
returns text language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce((select s.timezone from public.studio_sms_entity_studios es join public.studios s on s.id = es.studio_id
                    where es.legal_entity_id = p_entity and public._tw4ml_valid_tz(s.timezone) order by es.linked_at limit 1), 'UTC');
$$;

create or replace function public._tw4ml_tz_for(p_entity uuid, p_key text)
returns text language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce((select t.timezone from public.studio_sms_entity_timezones t where t.legal_entity_id = p_entity and t.effective_month <= p_key
                    order by t.effective_month desc, t.created_at desc limit 1), public._tw4ml_default_tz(p_entity));
$$;

-- the instant a calendar month STARTS (local midnight on the 1st, in the timezone that governs that month)
create or replace function public._tw4ml_month_start(p_entity uuid, p_key text)
returns timestamptz language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select ((p_key || '-01')::timestamp) at time zone public._tw4ml_tz_for(p_entity, p_key); $$;

-- the calendar month an instant belongs to: the latest month whose start is not after it (months tile the timeline exactly, also across a timezone change)
create or replace function public._tw4ml_month_key(p_entity uuid, p_ts timestamptz)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_utc text := to_char(p_ts at time zone 'UTC', 'YYYY-MM');
  k text;
begin
  foreach k in array array[public._tw4ml_key_add(v_utc, 1), v_utc, public._tw4ml_key_add(v_utc, -1)] loop
    if public._tw4ml_month_start(p_entity, k) <= p_ts then
      return k;
    end if;
  end loop;
  return public._tw4ml_key_add(v_utc, -1);
end $$;

-- the legal business's timezone is recorded the first time it matters (inherited from the founding location), under the caller's account lock
create or replace function public._tw4ml_ensure_tz(p_entity uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if not exists (select 1 from public.studio_sms_entity_timezones t where t.legal_entity_id = p_entity) then
    insert into public.studio_sms_entity_timezones (legal_entity_id, timezone, effective_month, set_by_role, reason)
    values (p_entity, public._tw4ml_default_tz(p_entity), '1970-01', 'system', 'inherited from the founding location');
  end if;
end $$;

-- an admin's manual resolution must not capture a recurring set-aside (the first period would then be charged a second time)
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
  if r.reservation_key like 'commit:%' then
    raise exception 'a recurring set-aside is captured only by its charge and released by revoking the authorization' using errcode = '22023';
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
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- limits, ceilings and the month's spending
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4ml_limit_for(p_entity uuid, p_key text)
returns int language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce((select l.limit_cents from public.studio_sms_monthly_limits l where l.legal_entity_id = p_entity and l.effective_month <= p_key
                    order by l.effective_month desc, l.created_at desc limit 1), 0);   -- no limit configured: nothing may be spent
$$;

create or replace function public._tw4ml_ceiling_for(p_entity uuid)
returns int language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(
    (select c.ceiling_cents from public.studio_sms_limit_ceilings c where c.scope = 'entity' and c.legal_entity_id = p_entity order by c.created_at desc limit 1),
    (select c.ceiling_cents from public.studio_sms_limit_ceilings c where c.scope = 'platform' order by c.created_at desc limit 1),
    50000);   -- the initial platform safety ceiling: a bound, never an authorization
$$;

create or replace function public._tw4ml_effective_limit(p_entity uuid, p_key text)
returns int language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select least(public._tw4ml_limit_for(p_entity, p_key), public._tw4ml_ceiling_for(p_entity)); $$;

-- what the month has spent or set aside: SMS usage (net of refunds), recurring fees captured (including captured commitments), and recurring commitments still held.
-- One-time setup fees are not part of it. Rows are attributed by their own created_at.
create or replace function public._tw4ml_month_parts(p_entity uuid, p_key text)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s timestamptz := public._tw4ml_month_start(p_entity, p_key);
  e timestamptz := public._tw4ml_month_start(p_entity, public._tw4ml_key_add(p_key, 1));
  v_usage bigint;
  v_recurring bigint;
  v_reserved bigint;
begin
  select coalesce(sum(-l.balance_delta_cents), 0) into v_usage from public.studio_sms_credit_ledger l
   where l.legal_entity_id = p_entity and l.kind in ('usage_charge', 'usage_refund') and l.created_at >= s and l.created_at < e;
  -- a captured recurring fee belongs to the month its funds were reserved in (a set-aside captured by a later month's charge is NOT counted a second time there)
  select coalesce(sum(-l.balance_delta_cents), 0) into v_recurring from public.studio_sms_credit_ledger l
    left join public.studio_sms_credit_reservations r on r.id = l.reservation_id
   where l.legal_entity_id = p_entity and l.kind = 'capture' and (l.idempotency_key like 'capture:rec:%' or l.idempotency_key like 'capture:commit:%')
     and coalesce(r.created_at, l.created_at) >= s and coalesce(r.created_at, l.created_at) < e;
  select coalesce(sum(r.amount_cents), 0) into v_reserved from public.studio_sms_credit_reservations r
   where r.legal_entity_id = p_entity and r.status = 'reserved' and (r.reservation_key like 'rec:%' or r.reservation_key like 'commit:%') and r.created_at >= s and r.created_at < e;
  return jsonb_build_object('usage_cents', v_usage, 'recurring_cents', v_recurring, 'reserved_cents', v_reserved, 'total_cents', v_usage + v_recurring + v_reserved,
                            'starts_at', s, 'ends_at', e);
end $$;

create or replace function public._tw4ml_month_spend(p_entity uuid, p_key text)
returns bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select ((public._tw4ml_month_parts(p_entity, p_key))->>'total_cents')::bigint; $$;

-- the gate every routine charge passes (the caller holds the account lock): spending + this charge must fit the effective limit of the month the charge is recorded in
create or replace function public._tw4ml_require_room(p_entity uuid, p_cents bigint, p_already_counted bigint default 0)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_key text := public._tw4ml_month_key(p_entity, now());
begin
  if public._tw4ml_month_spend(p_entity, v_key) - coalesce(p_already_counted, 0) + p_cents > public._tw4ml_effective_limit(p_entity, v_key) then
    raise exception 'the monthly spending limit would be exceeded' using errcode = 'TW012';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- changing a limit / a timezone / a ceiling (service role: the routes pass the signed-in user's id; the database decides who may)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4ml_apply_limit(p_entity uuid, p_audit_studio uuid, p_actor uuid, p_role text, p_limit int, p_effective text, p_reason text, p_require_recent_signin boolean)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  v_cur text;
  v_eff text;
  v_prev int;
  v_spend bigint;
  v_ceiling int;
begin
  perform public._tw4ml_ensure_tz(p_entity);
  v_cur := public._tw4ml_month_key(p_entity, now());
  v_eff := coalesce(p_effective, v_cur);
  if v_eff !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or v_eff < v_cur or v_eff > public._tw4ml_key_add(v_cur, 12) then
    raise exception 'a limit can be set from the current month to twelve months ahead' using errcode = '22023';
  end if;
  v_ceiling := public._tw4ml_ceiling_for(p_entity);
  if p_limit is null or p_limit < 0 or p_limit > v_ceiling then
    raise exception 'the monthly limit must be between $0 and the platform safety ceiling' using errcode = 'TW013';
  end if;
  v_prev := public._tw4ml_limit_for(p_entity, v_eff);
  if p_limit > v_prev then
    -- an increase never bypasses a hold, a negative balance or a stale session
    select * into a from public.studio_sms_credit_accounts x where x.legal_entity_id = p_entity;
    if coalesce(a.hold, false) or coalesce(a.balance_cents, 0) < 0 then
      raise exception 'a limit cannot be raised while the credit account is on hold or negative' using errcode = 'TW007';
    end if;
    if p_require_recent_signin and not exists (select 1 from auth.users u where u.id = p_actor and u.last_sign_in_at is not null and u.last_sign_in_at > clock_timestamp() - interval '15 minutes') then
      raise exception 'sign in again to raise the monthly limit' using errcode = 'TW014';
    end if;
  end if;
  v_spend := public._tw4ml_month_spend(p_entity, v_cur);
  insert into public.studio_sms_monthly_limits (legal_entity_id, effective_month, limit_cents, previous_limit_cents, spend_at_change_cents, changed_by, changed_by_role, reason)
  values (p_entity, v_eff, p_limit, v_prev, v_spend, p_actor, p_role, left(btrim(p_reason), 300));
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (p_audit_studio, null, case when p_role = 'platform_admin' then 'platform_admin' else 'system' end, p_actor, 'monthly_limit_set',
          left('entity=' || p_entity || ';from=' || v_prev || ';to=' || p_limit || ';month=' || v_eff || ';spend=' || v_spend || ';role=' || p_role, 300));
  return jsonb_build_object('limit_cents', p_limit, 'previous_limit_cents', v_prev, 'effective_month', v_eff, 'spend_cents', v_spend, 'current_month', v_cur);
end $$;

create or replace function public.tw4_monthly_limit_set(p_studio_id uuid, p_user_id uuid, p_limit_cents int, p_effective_month text default null, p_confirmed boolean default false, p_reason text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_entity uuid;
begin
  if p_user_id is null or p_studio_id is null or not exists (
       select 1 from public.user_studio_roles r where r.user_id = p_user_id and r.studio_id = p_studio_id and r.active = true and r.role = 'studio_owner') then
    raise exception 'only the studio owner can change the monthly limit' using errcode = '42501';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    raise exception 'this studio has no verified legal business yet' using errcode = 'TW010';
  end if;
  if p_confirmed is not true then
    raise exception 'the change must be explicitly confirmed' using errcode = '22023';
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = v_entity for share;   -- entity first, then the account: the order every spending function uses
  perform public._tw4c_lock(v_entity);
  return public._tw4ml_apply_limit(v_entity, p_studio_id, p_user_id, 'owner', p_limit_cents, p_effective_month, p_reason, true);
end $$;

create or replace function public.tw4_monthly_limit_set_admin(p_entity_id uuid, p_actor uuid, p_limit_cents int, p_effective_month text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  if p_reason is null or char_length(btrim(p_reason)) < 10 then
    raise exception 'a platform change needs a written reason (10+ characters)' using errcode = '22023';
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = p_entity_id for share;
  perform public._tw4c_lock(p_entity_id);
  return public._tw4ml_apply_limit(p_entity_id, public._tw4c_any_location(p_entity_id), p_actor, 'platform_admin', p_limit_cents, p_effective_month, p_reason, false);
end $$;

create or replace function public._tw4ml_apply_timezone(p_entity uuid, p_audit_studio uuid, p_actor uuid, p_role text, p_timezone text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_cur text;
  v_next text;
  v_now_tz text;
begin
  if not public._tw4ml_valid_tz(p_timezone) then
    raise exception 'not a recognized IANA timezone' using errcode = '22023';
  end if;
  perform public._tw4ml_ensure_tz(p_entity);
  v_cur := public._tw4ml_month_key(p_entity, now());
  v_next := public._tw4ml_key_add(v_cur, 1);
  v_now_tz := public._tw4ml_tz_for(p_entity, v_next);
  -- if the new zone is far enough ahead that next month would already have begun there, the change starts the month after: the current month never moves
  if ((v_next || '-01')::timestamp at time zone p_timezone) <= now() then
    v_next := public._tw4ml_key_add(v_next, 1);
  end if;
  insert into public.studio_sms_entity_timezones (legal_entity_id, timezone, effective_month, set_by, set_by_role, reason)
  values (p_entity, p_timezone, v_next, p_actor, p_role, left(btrim(p_reason), 300));
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (p_audit_studio, null, case when p_role = 'platform_admin' then 'platform_admin' else 'system' end, p_actor, 'entity_timezone_set',
          left('entity=' || p_entity || ';from=' || v_now_tz || ';to=' || p_timezone || ';effective=' || v_next || ';role=' || p_role, 300));
  return jsonb_build_object('timezone', p_timezone, 'effective_month', v_next, 'previous_timezone', v_now_tz);
end $$;

create or replace function public.tw4_entity_timezone_set(p_studio_id uuid, p_user_id uuid, p_timezone text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_entity uuid;
begin
  if p_user_id is null or p_studio_id is null or not exists (
       select 1 from public.user_studio_roles r where r.user_id = p_user_id and r.studio_id = p_studio_id and r.active = true and r.role = 'studio_owner') then
    raise exception 'only the studio owner can change the timezone' using errcode = '42501';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    raise exception 'this studio has no verified legal business yet' using errcode = 'TW010';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'say why the timezone is changing' using errcode = '22023';
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = v_entity for share;
  perform public._tw4c_lock(v_entity);
  return public._tw4ml_apply_timezone(v_entity, p_studio_id, p_user_id, 'owner', p_timezone, p_reason);
end $$;

create or replace function public.tw4_entity_timezone_set_admin(p_entity_id uuid, p_actor uuid, p_timezone text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  if p_reason is null or char_length(btrim(p_reason)) < 10 then
    raise exception 'a platform change needs a written reason (10+ characters)' using errcode = '22023';
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = p_entity_id for share;
  perform public._tw4c_lock(p_entity_id);
  return public._tw4ml_apply_timezone(p_entity_id, public._tw4c_any_location(p_entity_id), p_actor, 'platform_admin', p_timezone, p_reason);
end $$;

create or replace function public.tw4_limit_ceiling_set_platform(p_actor uuid, p_cents int, p_approval_ref text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  if p_cents is null or p_cents < 0 or p_cents > 1000000 or p_approval_ref is null or char_length(btrim(p_approval_ref)) < 10 then
    raise exception 'a ceiling needs an amount and a written approval reference (10+ characters)' using errcode = '22023';
  end if;
  insert into public.studio_sms_limit_ceilings (scope, legal_entity_id, ceiling_cents, approved_by, approval_ref) values ('platform', null, p_cents, p_actor, btrim(p_approval_ref));
  return jsonb_build_object('scope', 'platform', 'ceiling_cents', p_cents);
end $$;

-- a higher (or lower) ceiling for ONE legal business: a separately authorized platform decision, never implied by an owner's request
create or replace function public.tw4_limit_ceiling_approve_entity(p_entity_id uuid, p_actor uuid, p_cents int, p_approval_ref text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  if p_cents is null or p_cents < 0 or p_cents > 1000000 or p_approval_ref is null or char_length(btrim(p_approval_ref)) < 10 then
    raise exception 'a ceiling needs an amount and a written approval reference (10+ characters)' using errcode = '22023';
  end if;
  if not exists (select 1 from public.studio_sms_legal_entities e where e.id = p_entity_id) then
    raise exception 'unknown legal entity' using errcode = '22023';
  end if;
  insert into public.studio_sms_limit_ceilings (scope, legal_entity_id, ceiling_cents, approved_by, approval_ref) values ('entity', p_entity_id, p_cents, p_actor, btrim(p_approval_ref));
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (public._tw4c_any_location(p_entity_id), null, 'platform_admin', p_actor, 'monthly_limit_ceiling', left('entity=' || p_entity_id || ';ceiling=' || p_cents, 300));
  return jsonb_build_object('scope', 'entity', 'ceiling_cents', p_cents);
end $$;

-- read side for owners and administrators of a location
create or replace function public.sms_monthly_limit_overview(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_key text;
  v_next text;
  a public.studio_sms_credit_accounts;
begin
  if auth.uid() is null or coalesce(public._sms_onb_studio_role(p_studio_id), '') not in ('studio_owner', 'studio_admin') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    return jsonb_build_object('legal_business', false);
  end if;
  v_key := public._tw4ml_month_key(v_entity, now());
  v_next := public._tw4ml_key_add(v_key, 1);
  select * into a from public.studio_sms_credit_accounts x where x.legal_entity_id = v_entity;
  return jsonb_build_object(
    'legal_business', true,
    'month', v_key,
    'timezone', public._tw4ml_tz_for(v_entity, v_key),
    'next_month_timezone', public._tw4ml_tz_for(v_entity, v_next),
    'limit_cents', public._tw4ml_limit_for(v_entity, v_key),
    'ceiling_cents', public._tw4ml_ceiling_for(v_entity),
    'effective_limit_cents', public._tw4ml_effective_limit(v_entity, v_key),
    'next_month_limit_cents', public._tw4ml_limit_for(v_entity, v_next),
    'parts', public._tw4ml_month_parts(v_entity, v_key),
    'on_hold', coalesce(a.hold, false),
    'available_cents', greatest(coalesce(a.balance_cents, 0) - coalesce(a.reserved_cents, 0), 0),
    'pilot_business', exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = v_entity),
    'recent_changes', coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc) from (
        select l.effective_month, l.limit_cents, l.previous_limit_cents, l.spend_at_change_cents, l.changed_by_role, l.created_at
          from public.studio_sms_monthly_limits l where l.legal_entity_id = v_entity order by l.created_at desc limit 8) r), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- the setup budget no longer counts recurring fees (reverses PR 241's accounting); SMS usage honours the monthly limit
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4f3a_committed(p_entity uuid)
returns bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(sum(amount_cents), 0) from public.studio_sms_spend_events where legal_entity_id = p_entity and status in ('authorized', 'reserved');
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
  -- a replay of a debit that already happened must succeed even if the account has since run low or the month's limit is used up
  if exists (select 1 from public.studio_sms_credit_ledger l where l.legal_entity_id = p_entity_id and l.idempotency_key = 'usage:' || p_key) then
    return public._tw4c_post(p_entity_id, p_studio_id, 'usage_charge', -p_cents, 0, 'usage:' || p_key, null, p_ref, null, null);
  end if;
  perform public._tw4ml_ensure_tz(p_entity_id);
  perform public._tw4c_require_funds(a, p_cents);
  perform public._tw4ml_require_room(p_entity_id, p_cents);   -- fail closed: funds AND the month's limit
  return public._tw4c_post(p_entity_id, p_studio_id, 'usage_charge', -p_cents, 0, 'usage:' || p_key, null, p_ref, null, null);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- recurring authorization, revocation, charge, due list, service state: months in the legal business's timezone, monthly limit, first-month commitment
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_recurring_authorize(p_studio_id uuid, p_user_id uuid, p_kind text, p_acknowledged_price_cents int, p_term_months int, p_total_limit_cents int)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_price public.studio_sms_price_list;
  v_limit int;
  v_id uuid := gen_random_uuid();
  v_statement text;
  v_cur text;
  v_res uuid;
  v_obligations bigint;
  acct public.studio_sms_credit_accounts;
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
  perform 1 from public.studio_sms_legal_entities le where le.id = v_entity for share;   -- serialized with pilot-exception creation (entity lock first, then the account lock)
  acct := public._tw4c_lock(v_entity);   -- one decision at a time per legal business
  perform public._tw4ml_ensure_tz(v_entity);
  -- the founder-authorized pilot business: every recurring fee-bearing operation needs its own explicit approval, so a standing authorization is refused outright
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
  -- an authorization whose term has ended can never charge again: close it (and release anything it set aside) so it neither blocks this renewal nor counts as active
  perform public._tw4rc_release_commitment(x.id) from public.studio_sms_recurring_authorizations x
   where x.legal_entity_id = v_entity and x.studio_id = p_studio_id and x.kind = p_kind and x.status = 'active' and x.expires_at <= now();
  with closed as (
    update public.studio_sms_recurring_authorizations x set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = p_user_id
     where x.legal_entity_id = v_entity and x.studio_id = p_studio_id and x.kind = p_kind and x.status = 'active' and x.expires_at <= now()
    returning x.id, x.studio_id, x.kind)
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  select c.studio_id, null, 'system', p_user_id, 'recurring_revoked', left('authorization=' || c.id || ';kind=' || c.kind || ';term ended', 300) from closed c;
  if exists (select 1 from public.studio_sms_recurring_authorizations a where a.legal_entity_id = v_entity and a.studio_id = p_studio_id and a.kind = p_kind and a.status = 'active') then
    raise exception 'this charge is already authorized for this location' using errcode = '23505';
  end if;
  v_cur := public._tw4ml_month_key(v_entity, now());
  -- the monthly limit must be configured and must leave room: this month's spending plus the first month's commitment has to fit (and so do the standing obligations)
  select coalesce(sum(a.price_cents), 0) into v_obligations from public.studio_sms_recurring_authorizations a
   where a.legal_entity_id = v_entity and a.status = 'active' and a.expires_at > now();
  if v_obligations + v_price.customer_price_cents > public._tw4ml_effective_limit(v_entity, v_cur) then
    raise exception 'set a monthly spending limit that covers your recurring charges first' using errcode = 'TW012';
  end if;
  perform public._tw4ml_require_room(v_entity, v_price.customer_price_cents);
  -- the first month's charge is set aside now from settled credit, so setup spending cannot consume it; the first charge captures this very reservation
  select * into acct from public.studio_sms_credit_accounts x where x.legal_entity_id = v_entity;   -- re-read: closing an ended term above may have released funds
  if acct.hold or acct.balance_cents < 0 or (acct.balance_cents - acct.reserved_cents) < v_price.customer_price_cents then
    raise exception 'not enough settled credit to set aside the first month' using errcode = 'TW007';
  end if;
  insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
  values (v_entity, p_studio_id, p_kind, v_price.customer_price_cents, 'credit', 'commit:' || v_id) returning id into v_res;
  perform public._tw4c_post(v_entity, p_studio_id, 'reserve', 0, v_price.customer_price_cents, 'reserve:commit:' || v_id, v_res, 'commitment=' || v_id, null, null);
  -- the acknowledgement is built HERE from the validated numbers (never taken from a caller); the application shows the identical text before the owner agrees
  v_statement := 'I authorize DanceFlow to deduct ' || public._tw4rc_usd(v_price.customer_price_cents) || ' per month for '
    || case p_kind when 'number' then 'texting phone number rent' else 'monthly texting service' end
    || ' from my legal business''s prepaid texting credit, for up to ' || p_term_months || ' month' || case when p_term_months = 1 then '' else 's' end
    || ' and no more than ' || public._tw4rc_usd(v_limit) || ' in total, whichever comes first. '
    || 'The first month''s charge is set aside from my prepaid credit now. '
    || 'The charge is taken only if enough settled credit is available and it fits within my business''s monthly spending limit. No card is charged, no credit is added automatically, and I can revoke this at any time. '
    || 'Final prices and terms are pending approval.';
  -- the term is N whole calendar months in the business's timezone, the month of authorization first: N charges fit exactly and the term ends on a month boundary
  insert into public.studio_sms_recurring_authorizations (id, legal_entity_id, studio_id, kind, price_cents, term_months, total_limit_cents, expires_at, authorized_by, statement, commitment_reservation_id)
  values (v_id, v_entity, p_studio_id, p_kind, v_price.customer_price_cents, p_term_months, v_limit,
          public._tw4ml_month_start(v_entity, public._tw4ml_key_add(v_cur, p_term_months)), p_user_id, v_statement, v_res);
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (p_studio_id, null, 'system', p_user_id, 'recurring_authorized', left('authorization=' || v_id || ';kind=' || p_kind || ';cents=' || v_price.customer_price_cents || ';months=' || p_term_months || ';limit=' || v_limit, 300));
  return jsonb_build_object('authorization_id', v_id, 'price_cents', v_price.customer_price_cents, 'total_limit_cents', v_limit);
end $$;

-- releases the first month's set-aside funds of an authorization that will not be charged (caller holds the account lock). Idempotent.
create or replace function public._tw4rc_release_commitment(p_authorization_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_recurring_authorizations;
  r public.studio_sms_credit_reservations;
begin
  select * into a from public.studio_sms_recurring_authorizations x where x.id = p_authorization_id;
  if a.id is null or a.commitment_reservation_id is null then
    return;
  end if;
  select * into r from public.studio_sms_credit_reservations x where x.id = a.commitment_reservation_id for update;
  if r.id is not null and r.status = 'reserved' then
    perform public._tw4c_post(r.legal_entity_id, r.studio_id, 'release', 0, -r.amount_cents, 'release:' || r.reservation_key, r.id, 'commitment released', null, null);
    update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where id = r.id;
  end if;
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
  perform public._tw4rc_release_commitment(a.id);   -- what was set aside for the first month goes back to the available balance
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (a.studio_id, null, 'system', p_user_id, 'recurring_revoked', left('authorization=' || a.id || ';kind=' || a.kind, 300));
  return jsonb_build_object('status', 'revoked', 'replayed', false);
end $$;

-- the scheduler's housekeeping: set-aside funds of authorizations that ended or were revoked (and never charged) go back to the available balance
create or replace function public.tw4_recurring_release_ended()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a record;
  v_released int := 0;
begin
  for a in select x.id, x.legal_entity_id from public.studio_sms_recurring_authorizations x
            join public.studio_sms_credit_reservations r on r.id = x.commitment_reservation_id and r.status = 'reserved'
           where x.status = 'revoked' or x.expires_at <= now() loop
    perform 1 from public.studio_sms_legal_entities le where le.id = a.legal_entity_id for no key update;
    perform public._tw4c_lock(a.legal_entity_id);
    perform public._tw4rc_release_commitment(a.id);
    v_released := v_released + 1;
  end loop;
  return jsonb_build_object('released', v_released);
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
  elsif cr.id is null and public._tw4ml_month_spend(a.legal_entity_id, v_cur) + a.price_cents > public._tw4ml_effective_limit(a.legal_entity_id, v_cur) then
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

-- the scheduler's work list: [{id, period_key}] for every active, unexpired, non-pilot authorization and each collectible month (the current and the previous one in the
-- business's timezone) that is not already charged or finally refused
drop function public.tw4_recurring_due(text);
create or replace function public.tw4_recurring_due_list()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a record;
  v_cur text;
  v_prev text;
  k text;
  v_out jsonb := '[]'::jsonb;
begin
  for a in select * from public.studio_sms_recurring_authorizations x where x.status = 'active' and x.expires_at > now()
              and not exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = x.legal_entity_id) order by x.created_at loop
    v_cur := public._tw4ml_month_key(a.legal_entity_id, now());
    v_prev := public._tw4ml_key_add(v_cur, -1);
    foreach k in array array[v_prev, v_cur] loop
      continue when k < public._tw4ml_month_key(a.legal_entity_id, a.starts_at) or public._tw4ml_month_start(a.legal_entity_id, k) >= a.expires_at;
      continue when exists (select 1 from public.studio_sms_recurring_charges c where c.authorization_id = a.id and c.period_key = k and c.status in ('charged', 'refused'));
      v_out := v_out || jsonb_build_array(jsonb_build_object('id', a.id, 'period_key', k));
    end loop;
  end loop;
  return v_out;
end $$;

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

create or replace function public._tw4rc_service_issue(p_studio_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a record;
  c public.studio_sms_recurring_charges;
  v_cur text;
  k text;
begin
  for a in select * from public.studio_sms_recurring_authorizations x where x.studio_id = p_studio_id and x.status = 'active' and x.expires_at > now() and not exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = x.legal_entity_id) order by x.created_at loop
    v_cur := public._tw4ml_month_key(a.legal_entity_id, now());
    foreach k in array array[public._tw4ml_key_add(v_cur, -1), v_cur] loop
      continue when k < public._tw4ml_month_key(a.legal_entity_id, a.starts_at) or public._tw4ml_month_start(a.legal_entity_id, k) >= a.expires_at;
      continue when exists (select 1 from public.studio_sms_recurring_charges x where x.legal_entity_id = a.legal_entity_id and x.studio_id = a.studio_id and x.kind = a.kind and x.period_key = k and x.status = 'charged');
      select * into c from public.studio_sms_recurring_charges x where x.authorization_id = a.id and x.period_key = k;
      if c.id is null then
        return 'waiting';
      end if;
      return case when c.status = 'unfunded' then 'unfunded' when c.status = 'held' and c.reason like '%spending limit%' then 'cap' when c.status = 'held' then 'held' when c.reason like '%limit%' then 'limit' when c.reason like 'price changed%' then 'price' else 'waiting' end;
    end loop;
  end loop;
  return null;
end $$;

-- reconciliation, both ways (commitment reservations that were captured count like recurring ones)
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
      where (r.reservation_key like 'rec:%' or (r.reservation_key like 'commit:%' and r.status = 'captured'))
        and not exists (select 1 from public.studio_sms_recurring_charges c where c.reservation_id = r.id and c.status = 'charged'))
  + (select count(*) from public.studio_sms_credit_ledger l
      where l.kind = 'capture' and (l.idempotency_key like 'capture:rec:%' or l.idempotency_key like 'capture:commit:%')
        and not exists (select 1 from public.studio_sms_recurring_charges c where c.reservation_id = l.reservation_id and c.status = 'charged'));
$$;

-- the previous accounting helper is gone: recurring terms no longer draw on the cumulative setup budget
drop function public._tw4rc_promised(uuid);

-- ---------------------------------------------------------------------------------------------------------------
-- privileges
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4ml_guard(), public._tw4ml_key_add(text, int), public._tw4ml_valid_tz(text), public._tw4ml_default_tz(uuid), public._tw4ml_tz_for(uuid, text),
  public._tw4ml_month_start(uuid, text), public._tw4ml_month_key(uuid, timestamptz), public._tw4ml_ensure_tz(uuid), public._tw4ml_limit_for(uuid, text),
  public._tw4ml_ceiling_for(uuid), public._tw4ml_effective_limit(uuid, text), public._tw4ml_month_parts(uuid, text), public._tw4ml_month_spend(uuid, text),
  public._tw4ml_require_room(uuid, bigint, bigint), public._tw4ml_apply_limit(uuid, uuid, uuid, text, int, text, text, boolean),
  public._tw4ml_apply_timezone(uuid, uuid, uuid, text, text, text), public._tw4rc_release_commitment(uuid) from public, anon, authenticated, service_role;
revoke all on function public.tw4_monthly_limit_set(uuid, uuid, int, text, boolean, text), public.tw4_monthly_limit_set_admin(uuid, uuid, int, text, text),
  public.tw4_entity_timezone_set(uuid, uuid, text, text), public.tw4_entity_timezone_set_admin(uuid, uuid, text, text), public.tw4_limit_ceiling_set_platform(uuid, int, text),
  public.tw4_limit_ceiling_approve_entity(uuid, uuid, int, text), public.tw4_recurring_release_ended(), public.tw4_recurring_due_list() from public, anon, authenticated;
grant execute on function public.tw4_monthly_limit_set(uuid, uuid, int, text, boolean, text), public.tw4_monthly_limit_set_admin(uuid, uuid, int, text, text),
  public.tw4_entity_timezone_set(uuid, uuid, text, text), public.tw4_entity_timezone_set_admin(uuid, uuid, text, text), public.tw4_limit_ceiling_set_platform(uuid, int, text),
  public.tw4_limit_ceiling_approve_entity(uuid, uuid, int, text), public.tw4_recurring_release_ended(), public.tw4_recurring_due_list() to service_role;
revoke all on function public.sms_monthly_limit_overview(uuid) from public, anon;
grant execute on function public.sms_monthly_limit_overview(uuid) to authenticated;

commit;
