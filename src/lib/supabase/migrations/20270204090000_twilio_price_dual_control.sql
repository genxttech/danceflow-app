-- D4-1: SMS price changes are DUAL CONTROLLED (two different platform administrators). NOT APPLIED anywhere; Git only.
--
-- Defect closed: public.tw4_price_set (20261122090000) let ONE platform administrator retire the active price and publish a new one at once, with no second person and
-- no approval record (WP-D4 cell PRICE-00; TW-4F Completion Tracker U-2 / A-13). Nothing in the application calls it yet, so this changes no live behaviour.
--
-- What this migration does
--   * studio_sms_price_change_requests  an append-only request table: the proposed prices, the active price they were made against (id and a snapshot of its amounts), the
--                                       requester, a 24 h expiry, the decision (pending / approved / rejected / expired / invalidated / applied), the decider, the written
--                                       note, and the published price the request produced. No API-role privilege, RLS on, rows are never deleted, a decided row is final.
--   * tw4_price_propose / tw4_price_approve / tw4_price_reject / tw4_price_requests_list   service-role functions. The actor is always a parameter the application derives
--                                       from the AAL2 session; the database checks it again (platform_role, not banned).
--   * tw4_price_set                     KEEPS its signature and grants for compatibility but now refuses EVERY caller (TW042). There is no single-administrator path.
--   * studio_sms_price_list trigger     (ENABLE ALWAYS, so it also fires when session_replication_role = replica) refuses to INSERT a price unless an APPROVED request for
--                                       exactly those amounts, by two distinct administrators, is being applied in the same transaction; refuses to re-activate a retired price
--                                       and refuses any in-place edit. Retiring a price (active -> false) stays allowed, as before.
--   Approval rules (all enforced under row locks): the approver is an active platform administrator other than the requester; the requester still holds the role; the
--   request is unexpired; the active price is still the one the proposal was made against (otherwise the request is invalidated and nothing is published); an applied
--   request replays idempotently for its own approver and is refused (TW041) for anyone else; a decided request is final. Two concurrent approvals publish exactly one price.
--   The requester may withdraw a pending request (recorded as 'rejected' by the requester); only 'approved' / 'applied' require decided_by <> requested_by.
--
-- What it cannot close: a database OWNER / superuser can always disable or drop a trigger, or forge an 'approved' row with triggers disabled. That is the same limit as every
-- other TW-4F guard and is not something a migration can remove.
-- Rollback: rollback/20270204090000_twilio_price_dual_control_rollback.sql (refuses once any request row exists).
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_price_list') is null or to_regprocedure('public.tw4_price_set(text,integer,integer,text,uuid)') is null
     or to_regprocedure('public._tw4c_admin(uuid)') is null or to_regprocedure('public._tw4_r1_is_platform_admin(uuid)') is null
     or to_regprocedure('public._tw4c_truncate_guard()') is null or to_regclass('auth.users') is null then
    raise exception 'price dual control precondition failed: 20261122090000 (prepaid credits) is not applied';
  end if;
  if to_regclass('public.studio_sms_price_change_requests') is not null then
    raise exception 'price dual control precondition failed: already applied';
  end if;
  -- tw4_price_set is replaced below: it must still be EXACTLY the 20261122090000 body (line endings ignored) so no other slice is clobbered silently
  if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = 'public.tw4_price_set(text,integer,integer,text,uuid)'::regprocedure) is distinct from '36b3548cfa94cce34e7df10c2a74981f' then
    raise exception 'price dual control precondition failed: tw4_price_set differs from 20261122090000';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- the request table (the audit trail)
-- ---------------------------------------------------------------------------------------------------------------
create table public.studio_sms_price_change_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (char_length(kind) between 1 and 40),     -- the allowed kinds are the price list's own constraint (read by the functions; enforced again by the price insert)
  customer_price_cents int not null check (customer_price_cents > 0),
  provider_cost_cents int not null check (provider_cost_cents >= 0),
  description text not null check (char_length(btrim(description)) between 3 and 200),
  reason text not null check (char_length(btrim(reason)) between 10 and 500),
  base_price_id uuid null references public.studio_sms_price_list(id) on delete restrict,   -- the active price when the proposal was made (null: no price was active)
  base_customer_price_cents int null,
  base_provider_cost_cents int null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired', 'invalidated', 'applied')),
  requested_by uuid not null,
  requested_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  decided_by uuid null,
  decided_at timestamptz null,
  decision_note text null check (decision_note is null or char_length(decision_note) between 10 and 500),
  applied_price_id uuid null unique references public.studio_sms_price_list(id) on delete restrict,
  applied_at timestamptz null,
  constraint studio_sms_price_change_requests_window check (expires_at > requested_at and expires_at <= requested_at + interval '48 hours'),
  constraint studio_sms_price_change_requests_base check ((base_price_id is null) = (base_customer_price_cents is null) and (base_price_id is null) = (base_provider_cost_cents is null)),
  -- two DISTINCT platform administrators, enforced by the table itself: an approved or applied request names a decider who is not the requester. (A requester may WITHDRAW
  -- their own pending request: that is recorded as 'rejected' by the requester and is the only decision a requester can make.)
  constraint studio_sms_price_change_requests_distinct check (decided_by is null or decided_by <> requested_by or status = 'rejected'),
  constraint studio_sms_price_change_requests_shape check (
    case status
      when 'pending' then decided_by is null and decided_at is null and decision_note is null and applied_price_id is null and applied_at is null
      when 'approved' then decided_by is not null and decided_at is not null and decision_note is not null and applied_price_id is null and applied_at is null
      when 'applied' then decided_by is not null and decided_at is not null and decision_note is not null and applied_price_id is not null and applied_at is not null
      when 'rejected' then decided_by is not null and decided_at is not null and decision_note is not null and applied_price_id is null and applied_at is null
      else decided_by is null and decided_at is not null and decision_note is not null and applied_price_id is null and applied_at is null   -- expired, invalidated: the system decided
    end)
);
-- one OPEN request per price kind
create unique index studio_sms_price_change_requests_one_open on public.studio_sms_price_change_requests (kind) where status in ('pending', 'approved');
create index studio_sms_price_change_requests_recent on public.studio_sms_price_change_requests (requested_at desc);

revoke all on public.studio_sms_price_change_requests from public, anon, authenticated, service_role;
alter table public.studio_sms_price_change_requests enable row level security;

-- ---------------------------------------------------------------------------------------------------------------
-- helpers (callable by nobody)
-- ---------------------------------------------------------------------------------------------------------------
-- an ACTIVE platform administrator: holds the role, and the auth user exists and is not banned (a deleted user takes the profile with it)
create or replace function public._tw4price_admin_active(p_user uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select p_user is not null
    and public._tw4_r1_is_platform_admin(p_user)
    and exists (select 1 from auth.users u where u.id = p_user and (u.banned_until is null or u.banned_until <= now()));
$$;

-- the price kinds the price list accepts, read from its own check constraint (so a later kind is never refused or accepted here by a stale copy of the list)
create or replace function public._tw4price_kinds()
returns text[] language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_def text;
  v_kinds text[];
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.studio_sms_price_list'::regclass and c.conname = 'studio_sms_price_list_kind_check';
  if v_def is null then
    raise exception 'the price list kind constraint is missing' using errcode = 'XX000';
  end if;
  select array_agg(distinct m[1] order by m[1]) into v_kinds from regexp_matches(substring(v_def from 'ANY \((.*)\)'), '([a-z][a-z0-9_]*)', 'g') m where m[1] <> 'text';
  if v_kinds is null or cardinality(v_kinds) < 2 then
    raise exception 'could not read the price kinds from %', v_def using errcode = 'XX000';
  end if;
  return v_kinds;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- guards on the request table
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4pricedual_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare p public.studio_sms_price_list;
begin
  if tg_op = 'DELETE' then
    raise exception 'studio_sms_price_change_requests: rows are never deleted' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    -- a request is always BORN pending and undecided, whatever an owner-level insert supplies, and only the dual-control function creates one
    if coalesce(current_setting('tw4.pricedual_write', true), '') <> 'on' then
      raise exception 'studio_sms_price_change_requests: a request is created only by tw4_price_propose' using errcode = '42501';
    end if;
    new.status := 'pending';
    new.decided_by := null;
    new.decided_at := null;
    new.decision_note := null;
    new.applied_price_id := null;
    new.applied_at := null;
    return new;
  end if;
  if new.id is distinct from old.id or new.kind is distinct from old.kind or new.customer_price_cents is distinct from old.customer_price_cents
     or new.provider_cost_cents is distinct from old.provider_cost_cents or new.description is distinct from old.description or new.reason is distinct from old.reason
     or new.base_price_id is distinct from old.base_price_id or new.base_customer_price_cents is distinct from old.base_customer_price_cents
     or new.base_provider_cost_cents is distinct from old.base_provider_cost_cents or new.requested_by is distinct from old.requested_by
     or new.requested_at is distinct from old.requested_at or new.expires_at is distinct from old.expires_at then
    raise exception 'studio_sms_price_change_requests: the binding of a proposal is fixed' using errcode = '42501';
  end if;
  if coalesce(current_setting('tw4.pricedual_write', true), '') <> 'on' then
    raise exception 'studio_sms_price_change_requests: status moves only through the dual-control functions' using errcode = '42501';
  end if;
  if not ((old.status = 'pending' and new.status in ('approved', 'rejected', 'expired', 'invalidated')) or (old.status = 'approved' and new.status = 'applied')) then
    raise exception 'studio_sms_price_change_requests: % -> % is not a legal transition (a decided proposal is final)', old.status, new.status using errcode = '42501';
  end if;
  if new.status = 'applied' then
    -- the evidence names a published price with exactly the approved amounts
    select * into p from public.studio_sms_price_list x where x.id = new.applied_price_id;
    if p.id is null or p.kind <> new.kind or p.customer_price_cents <> new.customer_price_cents or p.provider_cost_cents <> new.provider_cost_cents or p.description <> new.description
       or p.created_by is distinct from new.decided_by then
      raise exception 'studio_sms_price_change_requests: the applied price is not the approved price' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger studio_sms_price_change_requests_guard before insert or update or delete on public.studio_sms_price_change_requests for each row execute function public._tw4pricedual_guard();
create trigger studio_sms_price_change_requests_truncate before truncate on public.studio_sms_price_change_requests for each statement execute function public._tw4c_truncate_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- guard on the price list: no price is published, re-activated or edited except through an approved request
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4price_activation_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare q public.studio_sms_price_change_requests;
begin
  if tg_op = 'INSERT' then
    select * into q from public.studio_sms_price_change_requests x
     where x.status = 'approved' and x.kind = new.kind and x.customer_price_cents = new.customer_price_cents and x.provider_cost_cents = new.provider_cost_cents
       and x.description = new.description and x.decided_by = new.created_by and x.applied_price_id is null;
    if q.id is null or not new.active or q.decided_by = q.requested_by or not public._tw4price_admin_active(q.decided_by) or not public._tw4_r1_is_platform_admin(q.requested_by) then
      raise exception 'a price is published only by an approved dual-control price change (two different platform administrators): none is being applied for these amounts' using errcode = '42501';
    end if;
    return new;
  end if;
  -- UPDATE: a published price is immutable, whatever the session mode; the only change that remains is retiring it (active -> false)
  if new.id is distinct from old.id or new.kind is distinct from old.kind or new.customer_price_cents is distinct from old.customer_price_cents
     or new.provider_cost_cents is distinct from old.provider_cost_cents or new.description is distinct from old.description or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'a published price is never edited: retire it and publish a new one through a price change request' using errcode = '42501';
  end if;
  if old.active = false and new.active = true then
    raise exception 'a retired price is never re-activated: publish a new price through a price change request' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger studio_sms_price_list_00_activation before insert or update on public.studio_sms_price_list for each row execute function public._tw4price_activation_guard();
-- fires even when session_replication_role = replica (a session that switches ordinary triggers off)
alter table public.studio_sms_price_list enable always trigger studio_sms_price_list_00_activation;

-- ---------------------------------------------------------------------------------------------------------------
-- propose
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_price_propose(p_kind text, p_customer_cents int, p_provider_cents int, p_description text, p_reason text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  q public.studio_sms_price_change_requests;
  b public.studio_sms_price_list;
  v_id uuid;
begin
  perform 1 from public.profiles pr where pr.id = p_actor for share;
  perform public._tw4c_admin(p_actor);
  if not public._tw4price_admin_active(p_actor) then
    raise exception 'actor must be an active platform admin' using errcode = '42501';
  end if;
  if p_kind is null or p_customer_cents is null or p_customer_cents <= 0 or p_provider_cents is null or p_provider_cents < 0
     or p_description is null or char_length(btrim(p_description)) not between 3 and 200 or p_reason is null or char_length(btrim(p_reason)) not between 10 and 500 then
    raise exception 'a price proposal needs a known kind, a positive customer price, a non-negative provider cost, a description (3 to 200) and a written reason (10 to 500)' using errcode = '22023';
  end if;
  if not (p_kind = any (public._tw4price_kinds())) then
    raise exception 'unknown price kind' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_price_set:' || p_kind));
  select * into b from public.studio_sms_price_list x where x.kind = p_kind and x.active;
  if b.id is not null and b.customer_price_cents = p_customer_cents and b.provider_cost_cents = p_provider_cents then
    raise exception 'the proposed prices equal the active prices: nothing to change' using errcode = '22023';
  end if;
  select * into q from public.studio_sms_price_change_requests x where x.kind = p_kind and x.status in ('pending', 'approved') for update;
  if q.id is not null then
    if q.expires_at <= clock_timestamp() then
      perform set_config('tw4.pricedual_write', 'on', true);
      update public.studio_sms_price_change_requests set status = 'expired', decided_at = clock_timestamp(), decision_note = 'expired: not approved within the allowed time' where id = q.id;
      perform set_config('tw4.pricedual_write', 'off', true);
    elsif q.requested_by = p_actor and q.customer_price_cents = p_customer_cents and q.provider_cost_cents = p_provider_cents and q.description = btrim(p_description)
          and q.reason = btrim(p_reason) and q.base_price_id is not distinct from b.id then
      return jsonb_build_object('request_id', q.id, 'status', q.status, 'expires_at', q.expires_at, 'replayed', true);
    else
      raise exception 'an open price proposal already exists for this kind: it must be approved, rejected or withdrawn, or expire, first' using errcode = 'TW041';
    end if;
  end if;
  perform set_config('tw4.pricedual_write', 'on', true);
  insert into public.studio_sms_price_change_requests (kind, customer_price_cents, provider_cost_cents, description, reason, base_price_id, base_customer_price_cents, base_provider_cost_cents, requested_by, expires_at)
  values (p_kind, p_customer_cents, p_provider_cents, btrim(p_description), btrim(p_reason), b.id, b.customer_price_cents, b.provider_cost_cents, p_actor, clock_timestamp() + interval '24 hours')
  returning id into v_id;
  perform set_config('tw4.pricedual_write', 'off', true);
  return jsonb_build_object('request_id', v_id, 'status', 'pending', 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- approve (the only function that publishes a price)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_price_approve(p_request_id uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  q public.studio_sms_price_change_requests;
  v_cur uuid;
  v_new uuid;
begin
  -- an unlocked read learns the parties; their profile rows are share-locked FIRST (in id order) and the standing of both is checked after the lock, so a demotion either
  -- committed before (this refuses or invalidates) or waits until this transaction ends
  select * into q from public.studio_sms_price_change_requests x where x.id = p_request_id;
  perform 1 from public.profiles pr where pr.id in (coalesce(q.requested_by, p_actor), p_actor) order by pr.id for share;
  perform public._tw4c_admin(p_actor);
  if not public._tw4price_admin_active(p_actor) then
    raise exception 'actor must be an active platform admin' using errcode = '42501';
  end if;
  if p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'an approval needs a written note of 10 to 500 characters' using errcode = '22023';
  end if;
  if q.id is null then
    raise exception 'unknown price proposal' using errcode = '22023';
  end if;
  if q.requested_by = p_actor then
    raise exception 'the requester cannot approve their own price proposal: a second platform administrator must' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_price_set:' || q.kind));
  select * into q from public.studio_sms_price_change_requests x where x.id = p_request_id for update;
  if q.status = 'applied' and q.decided_by = p_actor then
    return jsonb_build_object('status', 'applied', 'replayed', true, 'price_id', q.applied_price_id);
  end if;
  if q.status in ('expired', 'invalidated') then
    return jsonb_build_object('status', q.status, 'replayed', true);
  end if;
  if q.status <> 'pending' then
    raise exception 'this price proposal is already % and cannot be approved', q.status using errcode = 'TW041';
  end if;
  if q.expires_at <= clock_timestamp() then
    perform set_config('tw4.pricedual_write', 'on', true);
    update public.studio_sms_price_change_requests set status = 'expired', decided_at = clock_timestamp(), decision_note = 'expired: not approved within the allowed time' where id = q.id;
    perform set_config('tw4.pricedual_write', 'off', true);
    return jsonb_build_object('status', 'expired', 'replayed', false);
  end if;
  select x.id into v_cur from public.studio_sms_price_list x where x.kind = q.kind and x.active for update;
  if v_cur is distinct from q.base_price_id then
    perform set_config('tw4.pricedual_write', 'on', true);
    update public.studio_sms_price_change_requests set status = 'invalidated', decided_at = clock_timestamp(), decision_note = 'invalidated: the active price changed after the proposal was made' where id = q.id;
    perform set_config('tw4.pricedual_write', 'off', true);
    return jsonb_build_object('status', 'invalidated', 'replayed', false);
  end if;
  if not public._tw4price_admin_active(q.requested_by) then
    perform set_config('tw4.pricedual_write', 'on', true);
    update public.studio_sms_price_change_requests set status = 'invalidated', decided_at = clock_timestamp(), decision_note = 'invalidated: the requester is no longer an active platform administrator' where id = q.id;
    perform set_config('tw4.pricedual_write', 'off', true);
    return jsonb_build_object('status', 'invalidated', 'replayed', false);
  end if;
  perform set_config('tw4.pricedual_write', 'on', true);
  update public.studio_sms_price_change_requests set status = 'approved', decided_by = p_actor, decided_at = clock_timestamp(), decision_note = btrim(p_note) where id = q.id;
  update public.studio_sms_price_list set active = false where kind = q.kind and active;
  insert into public.studio_sms_price_list (kind, customer_price_cents, provider_cost_cents, description, created_by)
  values (q.kind, q.customer_price_cents, q.provider_cost_cents, q.description, p_actor) returning id into v_new;
  update public.studio_sms_price_change_requests set status = 'applied', applied_price_id = v_new, applied_at = clock_timestamp() where id = q.id;
  perform set_config('tw4.pricedual_write', 'off', true);
  return jsonb_build_object('status', 'applied', 'replayed', false, 'price_id', v_new);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- reject / withdraw
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_price_reject(p_request_id uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare q public.studio_sms_price_change_requests;
begin
  perform 1 from public.profiles pr where pr.id = p_actor for share;
  perform public._tw4c_admin(p_actor);
  if not public._tw4price_admin_active(p_actor) then
    raise exception 'actor must be an active platform admin' using errcode = '42501';
  end if;
  if p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'a rejection needs a written note of 10 to 500 characters' using errcode = '22023';
  end if;
  select * into q from public.studio_sms_price_change_requests x where x.id = p_request_id;
  if q.id is null then
    raise exception 'unknown price proposal' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_price_set:' || q.kind));
  select * into q from public.studio_sms_price_change_requests x where x.id = p_request_id for update;
  if q.status = 'rejected' then
    return jsonb_build_object('status', 'rejected', 'replayed', true);
  end if;
  if q.status <> 'pending' then
    raise exception 'this price proposal is already % and cannot be rejected', q.status using errcode = 'TW041';
  end if;
  perform set_config('tw4.pricedual_write', 'on', true);
  update public.studio_sms_price_change_requests set status = 'rejected', decided_by = p_actor, decided_at = clock_timestamp(), decision_note = btrim(p_note) where id = q.id;
  perform set_config('tw4.pricedual_write', 'off', true);
  return jsonb_build_object('status', 'rejected', 'replayed', false, 'withdrawn', q.requested_by = p_actor);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- list (read only): the active prices and the latest requests, with the status a reader should act on (a pending request past its expiry reads 'expired')
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_price_requests_list(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_active jsonb;
  v_requests jsonb;
begin
  perform public._tw4c_admin(p_actor);
  select coalesce(jsonb_agg(jsonb_build_object('price_id', x.id, 'kind', x.kind, 'customer_price_cents', x.customer_price_cents, 'provider_cost_cents', x.provider_cost_cents,
           'description', x.description, 'created_at', x.created_at) order by x.kind), '[]'::jsonb) into v_active from public.studio_sms_price_list x where x.active;
  select coalesce(jsonb_agg(t order by t.requested_at desc, t.request_id), '[]'::jsonb) into v_requests from (
    select r.id as request_id, r.kind, r.customer_price_cents, r.provider_cost_cents, r.description, r.reason, r.base_price_id, r.base_customer_price_cents, r.base_provider_cost_cents,
           case when r.status = 'pending' and r.expires_at <= clock_timestamp() then 'expired' else r.status end as status,
           r.requested_by, r.requested_at, r.expires_at, r.decided_by, r.decided_at, r.decision_note, r.applied_price_id,
           ((select a.id from public.studio_sms_price_list a where a.kind = r.kind and a.active) is distinct from r.base_price_id) as base_changed
      from public.studio_sms_price_change_requests r order by r.requested_at desc, r.id limit 100) t;
  return jsonb_build_object('active', v_active, 'requests', v_requests);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- the single-administrator path is CLOSED: same signature and grants, refuses every caller
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_price_set(p_kind text, p_customer_cents int, p_provider_cents int, p_description text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception 'a price change needs a proposal and a second platform administrator: use tw4_price_propose and tw4_price_approve' using errcode = 'TW042';
end $$;

revoke all on function public._tw4price_admin_active(uuid), public._tw4price_kinds(), public._tw4pricedual_guard(), public._tw4price_activation_guard() from public, anon, authenticated, service_role;
revoke all on function public.tw4_price_propose(text, int, int, text, text, uuid), public.tw4_price_approve(uuid, uuid, text), public.tw4_price_reject(uuid, uuid, text),
  public.tw4_price_requests_list(uuid) from public, anon, authenticated;
grant execute on function public.tw4_price_propose(text, int, int, text, text, uuid), public.tw4_price_approve(uuid, uuid, text), public.tw4_price_reject(uuid, uuid, text),
  public.tw4_price_requests_list(uuid) to service_role;

-- postcondition: exactly the grants intended
do $$
begin
  if has_function_privilege('anon', 'public.tw4_price_approve(uuid,uuid,text)', 'execute') or has_function_privilege('authenticated', 'public.tw4_price_approve(uuid,uuid,text)', 'execute')
     or not has_function_privilege('service_role', 'public.tw4_price_approve(uuid,uuid,text)', 'execute')
     or not has_function_privilege('service_role', 'public.tw4_price_set(text,integer,integer,text,uuid)', 'execute')
     or has_function_privilege('service_role', 'public._tw4price_activation_guard()', 'execute') then
    raise exception 'price dual control postcondition failed: unexpected function privileges';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.studio_sms_price_change_requests'::regclass)
     or (select tgenabled from pg_trigger where tgname = 'studio_sms_price_list_00_activation') is distinct from 'A' then
    raise exception 'price dual control postcondition failed: RLS or the always-on price trigger is missing';
  end if;
end $$;

commit;
