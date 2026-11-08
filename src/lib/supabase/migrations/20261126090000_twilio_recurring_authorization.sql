-- 20261126090000_twilio_recurring_authorization.sql
-- TW-4F recurring SMS service-charge authorization (phone-number rent and campaign monthly fee).
--   * An OWNER of a location authorizes a recurring charge for one fee kind (number | monthly) at the published price, monthly, for a term (1-12 months) and
--     with a total spending limit. The authorization records exactly what the owner acknowledged (price, term, limit, the statement shown, who, when).
--   * A charge is taken ONLY from the legal business's settled prepaid credit, once per period, atomically (reserve + capture under the account lock),
--     attributed to the authorizing location. Never a card, never an automatic top-up, never the ConfiDance pilot ceiling (credit-funded only, no fallback).
--   * A charge is refused outside the authorization (revoked, expired, price changed, limit reached), while the account is on hold, and when settled credit is
--     insufficient: each outcome is recorded; an unfunded period can be retried after credit arrives. Suspension is a STATE (tw4_recurring_service_state);
--     nothing here releases or deletes a phone number.
--   * Final retail prices and legal terms are pending approval: the authorization stores a terms_version placeholder and the owner-visible statement.
-- Authorizing and revoking are SERVICE-ROLE functions called by the application's routes with the signed-in user's id (the database re-checks that user is an OWNER of
-- the location, builds the acknowledgement text itself, and the routes carry the feature flag): no studio user can call them directly through the API.
-- Requires 20261122090000 (prepaid credits) and 20261125090000 (hold enforcement). Rollback: rollback/20261126090000_twilio_recurring_authorization_rollback.sql
-- (refuses once any authorization exists). NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public._tw4c_post(uuid,uuid,text,bigint,bigint,text,uuid,text,uuid,text)') is null or to_regclass('public.studio_sms_credit_disputes') is null then
    raise exception 'recurring-authorization precondition failed: TW-4F-3b-0 / pay-integrity hardening is not applied';
  end if;
  if to_regclass('public.studio_sms_recurring_authorizations') is not null then
    raise exception 'recurring-authorization precondition failed: already applied';
  end if;
end $$;

alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action in (
  'access_enabled', 'access_disabled', 'draft_created', 'ein_stored', 'ein_purged', 'submitted', 'cancelled', 'state_changed',
  'runner_step', 'runner_ein_read', 'runner_lease', 'runner_window', 'runner_submission_confirmed', 'runner_evaluation',
  'entity_created', 'location_attested', 'location_decided', 'spend_cap_set', 'spend_authorized', 'spend_reserved',
  'subaccount_confirmed', 'runner_subaccount',
  'credit_topup', 'credit_reversal', 'credit_adjustment', 'credit_hold', 'credit_reserved', 'credit_captured', 'credit_released', 'price_set', 'credit_pilot_exception', 'spend_withdrawn',
  'recurring_authorized', 'recurring_revoked', 'recurring_charged', 'recurring_unfunded', 'recurring_held', 'recurring_refused'));

-- ---------------------------------------------------------------------------------------------------------------
-- tables (no API-role privileges; everything goes through the functions below)
-- ---------------------------------------------------------------------------------------------------------------
create table public.studio_sms_recurring_authorizations (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id) on delete restrict,
  studio_id uuid not null,   -- the LOCATION the charge is attributed to
  kind text not null check (kind in ('number', 'monthly')),
  price_cents int not null check (price_cents > 0),   -- the published price the owner acknowledged; a charge at any other price is refused
  period text not null default 'month' check (period = 'month'),
  term_months int not null check (term_months between 1 and 12),
  total_limit_cents int not null,
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  authorized_by uuid not null,
  statement text not null check (char_length(btrim(statement)) between 20 and 1000),   -- exactly what the owner was shown and agreed to
  terms_version text not null default 'terms-pending-approval' check (char_length(terms_version) between 3 and 80),
  revoked_at timestamptz null,
  revoked_by uuid null,
  created_at timestamptz not null default now(),
  constraint studio_sms_recurring_auth_limit check (total_limit_cents >= price_cents and total_limit_cents <= price_cents * term_months),
  constraint studio_sms_recurring_auth_revoked check ((status = 'revoked') = (revoked_at is not null and revoked_by is not null)),
  constraint studio_sms_recurring_auth_location foreign key (studio_id, legal_entity_id) references public.studio_sms_entity_studios (studio_id, legal_entity_id)
);
create unique index studio_sms_recurring_auth_one_active on public.studio_sms_recurring_authorizations (legal_entity_id, studio_id, kind) where status = 'active';

create table public.studio_sms_recurring_charges (
  id uuid primary key default gen_random_uuid(),
  authorization_id uuid not null references public.studio_sms_recurring_authorizations(id) on delete restrict,
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id) on delete restrict,
  studio_id uuid not null,
  kind text not null check (kind in ('number', 'monthly')),
  period_key text not null check (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  amount_cents int not null check (amount_cents > 0),
  status text not null check (status in ('charged', 'unfunded', 'held', 'refused')),
  reason text null check (reason is null or char_length(reason) <= 120),
  reservation_id uuid null references public.studio_sms_credit_reservations(id),
  attempts int not null default 1 check (attempts >= 1),
  attempted_at timestamptz not null default now(),
  charged_at timestamptz null,
  constraint studio_sms_recurring_charges_period unique (authorization_id, period_key),
  constraint studio_sms_recurring_charges_charged check ((status = 'charged') = (charged_at is not null and reservation_id is not null)),
  constraint studio_sms_recurring_charges_location foreign key (studio_id, legal_entity_id) references public.studio_sms_entity_studios (studio_id, legal_entity_id)
);
-- the backstop against charging one location for the same service period twice, even across a revoke + new authorization
create unique index studio_sms_recurring_charges_once on public.studio_sms_recurring_charges (legal_entity_id, studio_id, kind, period_key) where status = 'charged';

revoke all on public.studio_sms_recurring_authorizations, public.studio_sms_recurring_charges from public, anon, authenticated, service_role;
alter table public.studio_sms_recurring_authorizations enable row level security;
alter table public.studio_sms_recurring_charges enable row level security;

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
create trigger studio_sms_recurring_authorizations_guard before update or delete on public.studio_sms_recurring_authorizations for each row execute function public._tw4rc_guard();
create trigger studio_sms_recurring_charges_guard before update or delete on public.studio_sms_recurring_charges for each row execute function public._tw4rc_guard();
create trigger studio_sms_recurring_authorizations_truncate before truncate on public.studio_sms_recurring_authorizations for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_recurring_charges_truncate before truncate on public.studio_sms_recurring_charges for each statement execute function public._tw4c_truncate_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- owner actions (service role, on behalf of the signed-in user the route has authenticated; the database decides who is an owner)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4rc_usd(p_cents bigint)
returns text language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$ select '$' || to_char(p_cents / 100.0, 'FM999990.00'); $$;

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

-- ---------------------------------------------------------------------------------------------------------------
-- service state: a STATE the sender can consult; it never releases or deletes a phone number. A period not charged within the grace window suspends SENDING only.
-- ---------------------------------------------------------------------------------------------------------------
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

-- why an unpaid period is unpaid, for the owner's message: unfunded | held | limit | price | waiting (no attempt recorded yet) | null (nothing unpaid)
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

create or replace function public.tw4_recurring_service_state(p_studio_id uuid)
returns text language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select public._tw4rc_service_state(p_studio_id); $$;

-- owners and administrators of a location see the business's recurring authorizations, what has been charged, and whether credit covers what is coming
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

-- ---------------------------------------------------------------------------------------------------------------
-- the charge (service role: the scheduler, never a studio): authorization, hold, limits and funding are all decided here, under the account lock
-- ---------------------------------------------------------------------------------------------------------------
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
       and not exists (select 1 from public.studio_sms_recurring_charges c where c.authorization_id = a.id and c.period_key = p_period_key and c.status in ('charged', 'refused'))), '[]'::jsonb);   -- a refused period is decided (limit, price, term, another authorization): retrying adds nothing
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

-- ---------------------------------------------------------------------------------------------------------------
-- platform administrators: read-only view of what recurring charging needs attention
-- ---------------------------------------------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------------------------------------------
-- privileges: owner functions and read views for signed-in users (each checks the caller); the charge functions for the service role only
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4rc_guard(), public._tw4rc_service_state(uuid), public._tw4rc_service_issue(uuid), public._tw4rc_usd(bigint) from public, anon, authenticated, service_role;
revoke all on function public.sms_recurring_overview(uuid), public.sms_recurring_admin_overview() from public, anon;
grant execute on function public.sms_recurring_overview(uuid), public.sms_recurring_admin_overview() to authenticated;
revoke all on function public.tw4_recurring_authorize(uuid, uuid, text, int, int, int), public.tw4_recurring_revoke(uuid, uuid), public.tw4_recurring_charge(uuid, text),
  public.tw4_recurring_due(text), public.tw4_recurring_service_state(uuid) from public, anon, authenticated;
grant execute on function public.tw4_recurring_authorize(uuid, uuid, text, int, int, int), public.tw4_recurring_revoke(uuid, uuid), public.tw4_recurring_charge(uuid, text),
  public.tw4_recurring_due(text), public.tw4_recurring_service_state(uuid) to service_role;

commit;
