-- 20270203090000_organizer_suite_entitlement_integrity.sql
-- D7 (Organizer Suite complimentary grants): integrity, audit and dated expiry for public.usage_addon_entitlements.
--   Owner policy: a complimentary grant (source 'manual_grant') ends on its period_end. After that, access needs a separately
--   purchased paid add-on (a source 'stripe_subscription_item' row). History is preserved: expiry changes status only, nothing
--   is deleted. Nothing here purchases, charges, extends or creates an entitlement. A price grandfather and a complimentary
--   entitlement stay independent records (this migration does not read or write protected_subscriptions).
--
--   1. Coexistence: at most ONE active manual_grant per (studio_id, feature_key) and per (organizer_id, feature_key), enforced by
--      partial unique indexes. A manual grant and Stripe-sourced rows for the same studio and feature may coexist.
--      Deliberately NO plain unique index on (studio_id, feature_key): Stripe rows are keyed by stripe_subscription_item_id.
--      Note: an upsert with onConflict 'studio_id,feature_key' (no predicate) still cannot infer these partial indexes and keeps
--      failing; the app must upsert Stripe rows on stripe_subscription_item_id.
--   2. Append-only audit table public.usage_addon_entitlement_events (service role select + insert only; UPDATE, DELETE and
--      TRUNCATE blocked for every role by guard triggers).
--      Evidence survival: entitlement_id, studio_id and organizer_id are SNAPSHOT columns WITHOUT foreign keys. The entitlement
--      row itself cascades from studios/organizers (on delete cascade, pre-existing); an FK from the audit table would either
--      cascade (destroying evidence) or, with restrict/no action, make every studio with an entitlement undeletable and break
--      existing fixture teardown. Without an FK the events always survive, and a deletion of an entitlement row (cascade or
--      direct) is itself recorded as a 'delete' event.
--   3. AFTER INSERT/UPDATE/DELETE trigger on usage_addon_entitlements writing one event per real change (status, period,
--      source, stripe item, quantity). Reason/actor come from the transaction-local settings app.entitlement_reason and
--      app.entitlement_actor; actor defaults to current_user. A no-op update writes nothing.
--      The trigger function is SECURITY INVOKER: every role that can write entitlement rows (service_role, owner) can insert
--      events; authenticated/anon cannot write entitlement rows (RLS has no write policy), so no definer rights are needed,
--      current_user stays the real writer for the actor default, and a role without event INSERT fails closed.
--   4. public.usage_addon_entitlement_end_instant(): the ONE place that defines when a dated grant stops (OPEN owner decision).
--      Default: access ends at the START of period_end's calendar day in the studio's timezone (period_end is EXCLUSIVE);
--      a NULL or unknown timezone falls back to UTC. period_start (if set) is inclusive from the start of its day.
--      public.usage_addon_entitlement_is_current() applies it.
--   5. public.expire_due_usage_addon_entitlements(): service-role-only, retry- and concurrency-safe expiry of due manual grants.
-- Rollback: rollback/20270203090000_organizer_suite_entitlement_integrity_rollback.sql (refuses while audit events exist).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.usage_addon_entitlements') is null then
    raise exception 'entitlement-integrity precondition failed: public.usage_addon_entitlements is missing';
  end if;
  if to_regclass('public.studios') is null or to_regclass('public.organizers') is null then
    raise exception 'entitlement-integrity precondition failed: public.studios or public.organizers is missing';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'studios' and column_name = 'timezone') then
    raise exception 'entitlement-integrity precondition failed: public.studios.timezone is missing';
  end if;
end $$;

-- Block concurrent writers while the uniqueness precondition is checked and the indexes are built.
lock table public.usage_addon_entitlements in share row exclusive mode;

do $$
declare
  v_dupes integer;
begin
  select count(*) into v_dupes from (
    select studio_id, feature_key from public.usage_addon_entitlements
    where source = 'manual_grant' and status = 'active' and studio_id is not null
    group by studio_id, feature_key having count(*) > 1
    union all
    select organizer_id, feature_key from public.usage_addon_entitlements
    where source = 'manual_grant' and status = 'active' and organizer_id is not null
    group by organizer_id, feature_key having count(*) > 1
  ) d;
  if v_dupes > 0 then
    raise exception 'entitlement-integrity precondition failed: % workspace/feature pair(s) hold more than one active manual_grant; resolve them (change status, never delete) before applying', v_dupes;
  end if;
end $$;

-- ---------- 1. coexistence ----------
create unique index if not exists usage_addon_entitlements_one_active_manual_grant_studio
  on public.usage_addon_entitlements (studio_id, feature_key)
  where source = 'manual_grant' and status = 'active' and studio_id is not null;

create unique index if not exists usage_addon_entitlements_one_active_manual_grant_organizer
  on public.usage_addon_entitlements (organizer_id, feature_key)
  where source = 'manual_grant' and status = 'active' and organizer_id is not null;

-- ---------- 2. audit table ----------
create table if not exists public.usage_addon_entitlement_events (
  id uuid primary key default gen_random_uuid(),
  entitlement_id uuid not null,            -- snapshot, deliberately no FK (see header)
  studio_id uuid,                          -- snapshot, no FK
  organizer_id uuid,                       -- snapshot, no FK
  feature_key text not null,
  event_type text not null,
  from_status text,
  to_status text,
  from_period_start date,
  to_period_start date,
  from_period_end date,
  to_period_end date,
  from_source text,
  to_source text,
  from_stripe_subscription_item_id text,
  to_stripe_subscription_item_id text,
  from_quantity_included integer,
  to_quantity_included integer,
  reason text,
  actor text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint usage_addon_entitlement_events_type_check check (event_type in
    ('insert', 'status_change', 'period_change', 'source_change', 'stripe_item_change', 'quantity_change', 'delete'))
);

create index if not exists usage_addon_entitlement_events_entitlement_idx
  on public.usage_addon_entitlement_events (entitlement_id, created_at);
create index if not exists usage_addon_entitlement_events_studio_idx
  on public.usage_addon_entitlement_events (studio_id, feature_key, created_at) where studio_id is not null;

alter table public.usage_addon_entitlement_events enable row level security;
revoke all on public.usage_addon_entitlement_events from public, anon, authenticated, service_role;
grant select, insert on public.usage_addon_entitlement_events to service_role;

create or replace function public.usage_addon_entitlement_events_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception 'usage_addon_entitlement_events is append-only; % is not allowed', lower(tg_op) using errcode = '42501';
end $$;

drop trigger if exists usage_addon_entitlement_events_guard_trg on public.usage_addon_entitlement_events;
create trigger usage_addon_entitlement_events_guard_trg
  before update or delete on public.usage_addon_entitlement_events
  for each row execute function public.usage_addon_entitlement_events_guard();

drop trigger if exists usage_addon_entitlement_events_no_truncate_trg on public.usage_addon_entitlement_events;
create trigger usage_addon_entitlement_events_no_truncate_trg
  before truncate on public.usage_addon_entitlement_events
  for each statement execute function public.usage_addon_entitlement_events_guard();

revoke all on function public.usage_addon_entitlement_events_guard() from public, anon, authenticated, service_role;

-- ---------- 3. audit trigger on entitlements ----------
create or replace function public.usage_addon_entitlements_audit()
returns trigger language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_reason text := nullif(btrim(current_setting('app.entitlement_reason', true)), '');
  v_actor text := coalesce(nullif(btrim(current_setting('app.entitlement_actor', true)), ''), current_user::text);
begin
  if tg_op = 'INSERT' then
    insert into public.usage_addon_entitlement_events (entitlement_id, studio_id, organizer_id, feature_key, event_type,
      to_status, to_period_start, to_period_end, to_source, to_stripe_subscription_item_id, to_quantity_included, reason, actor)
    values (new.id, new.studio_id, new.organizer_id, new.feature_key, 'insert',
      new.status, new.period_start, new.period_end, new.source, new.stripe_subscription_item_id, new.quantity_included, v_reason, v_actor);
    return null;
  end if;

  if tg_op = 'DELETE' then
    insert into public.usage_addon_entitlement_events (entitlement_id, studio_id, organizer_id, feature_key, event_type,
      from_status, from_period_start, from_period_end, from_source, from_stripe_subscription_item_id, from_quantity_included, reason, actor)
    values (old.id, old.studio_id, old.organizer_id, old.feature_key, 'delete',
      old.status, old.period_start, old.period_end, old.source, old.stripe_subscription_item_id, old.quantity_included, v_reason, v_actor);
    return null;
  end if;

  -- UPDATE: one event per real change; nothing when no audited column changed.
  if new.status is distinct from old.status then
    insert into public.usage_addon_entitlement_events (entitlement_id, studio_id, organizer_id, feature_key, event_type, from_status, to_status, reason, actor)
    values (new.id, new.studio_id, new.organizer_id, new.feature_key, 'status_change', old.status, new.status, v_reason, v_actor);
  end if;
  if new.period_start is distinct from old.period_start or new.period_end is distinct from old.period_end then
    insert into public.usage_addon_entitlement_events (entitlement_id, studio_id, organizer_id, feature_key, event_type,
      from_period_start, to_period_start, from_period_end, to_period_end, reason, actor)
    values (new.id, new.studio_id, new.organizer_id, new.feature_key, 'period_change',
      old.period_start, new.period_start, old.period_end, new.period_end, v_reason, v_actor);
  end if;
  if new.source is distinct from old.source then
    insert into public.usage_addon_entitlement_events (entitlement_id, studio_id, organizer_id, feature_key, event_type, from_source, to_source, reason, actor)
    values (new.id, new.studio_id, new.organizer_id, new.feature_key, 'source_change', old.source, new.source, v_reason, v_actor);
  end if;
  if new.stripe_subscription_item_id is distinct from old.stripe_subscription_item_id then
    insert into public.usage_addon_entitlement_events (entitlement_id, studio_id, organizer_id, feature_key, event_type,
      from_stripe_subscription_item_id, to_stripe_subscription_item_id, reason, actor)
    values (new.id, new.studio_id, new.organizer_id, new.feature_key, 'stripe_item_change',
      old.stripe_subscription_item_id, new.stripe_subscription_item_id, v_reason, v_actor);
  end if;
  if new.quantity_included is distinct from old.quantity_included then
    insert into public.usage_addon_entitlement_events (entitlement_id, studio_id, organizer_id, feature_key, event_type,
      from_quantity_included, to_quantity_included, reason, actor)
    values (new.id, new.studio_id, new.organizer_id, new.feature_key, 'quantity_change',
      old.quantity_included, new.quantity_included, v_reason, v_actor);
  end if;
  return null;
end $$;

revoke all on function public.usage_addon_entitlements_audit() from public, anon, authenticated, service_role;

drop trigger if exists usage_addon_entitlements_audit_trg on public.usage_addon_entitlements;
create trigger usage_addon_entitlements_audit_trg
  after insert or update or delete on public.usage_addon_entitlements
  for each row execute function public.usage_addon_entitlements_audit();

-- ---------- 4. boundary rule (the ONE place to change the end-instant policy) ----------
-- Resolves a timezone name to a canonical IANA name, or UTC when NULL/blank/unknown. Only names listed in
-- pg_timezone_names are accepted (POSIX offset strings such as '+05' are rejected because their sign is inverted).
create or replace function public.usage_addon_entitlement_safe_timezone(p_timezone text)
returns text language sql stable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    (select n.name from pg_catalog.pg_timezone_names n
      where lower(n.name) = lower(btrim(p_timezone)) order by (n.name = btrim(p_timezone)) desc, n.name limit 1),
    'UTC');
$$;

-- OPEN OWNER DECISION lives here. Default: a dated grant stops at the START (00:00 local) of period_end's calendar day in the
-- studio's timezone, i.e. period_end is an EXCLUSIVE end date. To make period_end the last included day instead, use
-- (p_period_end + 1) below. Nothing else needs to change.
create or replace function public.usage_addon_entitlement_end_instant(p_period_end date, p_timezone text)
returns timestamptz language sql stable
set search_path = pg_catalog, public, pg_temp
as $$
  select case when p_period_end is null then null
              else (p_period_end::timestamp) at time zone public.usage_addon_entitlement_safe_timezone(p_timezone) end;
$$;

-- period_start (when set) is inclusive from the start of its calendar day in the same timezone.
create or replace function public.usage_addon_entitlement_start_instant(p_period_start date, p_timezone text)
returns timestamptz language sql stable
set search_path = pg_catalog, public, pg_temp
as $$
  select case when p_period_start is null then null
              else (p_period_start::timestamp) at time zone public.usage_addon_entitlement_safe_timezone(p_timezone) end;
$$;

create or replace function public.usage_addon_entitlement_is_current(
  p_status text, p_period_start date, p_period_end date, p_timezone text, p_at timestamptz)
returns boolean language sql stable
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(p_status = 'active', false)
     and p_at is not null
     and (p_period_start is null or p_at >= public.usage_addon_entitlement_start_instant(p_period_start, p_timezone))
     and (p_period_end is null or p_at < public.usage_addon_entitlement_end_instant(p_period_end, p_timezone));
$$;

-- Pure helpers (they read no table data): EXECUTE for authenticated and service_role only, not anon.
revoke all on function public.usage_addon_entitlement_safe_timezone(text) from public, anon, authenticated, service_role;
revoke all on function public.usage_addon_entitlement_end_instant(date, text) from public, anon, authenticated, service_role;
revoke all on function public.usage_addon_entitlement_start_instant(date, text) from public, anon, authenticated, service_role;
revoke all on function public.usage_addon_entitlement_is_current(text, date, date, text, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.usage_addon_entitlement_safe_timezone(text) to authenticated, service_role;
grant execute on function public.usage_addon_entitlement_end_instant(date, text) to authenticated, service_role;
grant execute on function public.usage_addon_entitlement_start_instant(date, text) to authenticated, service_role;
grant execute on function public.usage_addon_entitlement_is_current(text, date, date, text, timestamptz) to authenticated, service_role;

-- ---------- 5. expiry ----------
-- Expires due complimentary grants only: source='manual_grant', status='active', period_end not null, end instant <= p_as_of.
-- Never deletes, never touches Stripe-sourced rows, never creates or extends anything. Returns the rows it expired.
-- Retry-safe: a second call finds no due active row. Concurrency-safe: rows are claimed with FOR UPDATE SKIP LOCKED and the
-- update re-checks status='active', so concurrent calls never expire (or audit) the same row twice.
create or replace function public.expire_due_usage_addon_entitlements(
  p_as_of timestamptz default now(), p_feature_key text default 'organizer_suite')
returns setof public.usage_addon_entitlements
language plpgsql volatile
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_prev_reason text := current_setting('app.entitlement_reason', true);
  v_prev_actor text := current_setting('app.entitlement_actor', true);
begin
  if p_as_of is null or p_feature_key is null or length(btrim(p_feature_key)) = 0 then
    raise exception 'expire_due_usage_addon_entitlements: p_as_of and p_feature_key are required' using errcode = '22004';
  end if;

  perform set_config('app.entitlement_reason',
    'complimentary grant reached period_end (expire_due_usage_addon_entitlements, as_of ' || p_as_of::text || ')', true);
  perform set_config('app.entitlement_actor', 'system:expire_due_usage_addon_entitlements', true);

  return query
  with due as (
    select e.id
    from public.usage_addon_entitlements e
    left join public.organizers o on o.id = e.organizer_id
    left join public.studios s on s.id = coalesce(e.studio_id, o.studio_id)
    where e.source = 'manual_grant'
      and e.status = 'active'
      and e.feature_key = p_feature_key
      and e.period_end is not null
      and public.usage_addon_entitlement_end_instant(e.period_end, s.timezone) <= p_as_of
    for update of e skip locked
  )
  update public.usage_addon_entitlements u
     set status = 'expired', updated_at = now()
    from due
   where u.id = due.id and u.status = 'active' and u.source = 'manual_grant'
  returning u.*;

  perform set_config('app.entitlement_reason', coalesce(v_prev_reason, ''), true);
  perform set_config('app.entitlement_actor', coalesce(v_prev_actor, ''), true);
end $$;

revoke all on function public.expire_due_usage_addon_entitlements(timestamptz, text) from public, anon, authenticated, service_role;
grant execute on function public.expire_due_usage_addon_entitlements(timestamptz, text) to service_role;

commit;
