-- D4-1: SMS price changes are DUAL CONTROLLED (two different, REGISTERED platform administrators, each acting through their OWN authenticated AAL2 session).
-- NOT APPLIED anywhere; Git only.
--
-- Defect closed: public.tw4_price_set (20261122090000) let ONE platform administrator retire the active price and publish a new one at once, with no second person and
-- no approval record (WP-D4 cell PRICE-00; TW-4F Completion Tracker U-2 / A-13). Nothing in the application calls it, so this changes no live behaviour.
--
-- What this migration does
--   * studio_sms_price_change_requests   append-only request table (proposed prices, the active price they were made against, requester, 24 h expiry, decision, decider,
--                                        note, applied price). No API-role privilege, RLS on, rows never deleted, a decided row is final. Triggers are ENABLE ALWAYS.
--   * studio_sms_price_approvers         PROTECTED APPROVER REGISTRY. A user may propose, approve or reject only if registered here AND holds platform_role AND is not
--                                        banned or soft-deleted. The table has no grants (service_role cannot write it); it changes only by an owner-level runbook step
--                                        (docs/twilio/TW-4F_Price_Dual_Control.md). It starts EMPTY: until the owner registers approvers nobody can change a price (fail closed).
--   * studio_sms_price_limits            per-kind ceilings and step limits as DATA. A row constrains proposals only when approved = true. Shipped rows are PROPOSALS
--                                        (approved = false, not enforced); the owner approves values (docs/twilio/TW-4F_Price_Limits_Proposal.md).
--   * tw4_price_propose / approve / reject / requests_list   the ONLY public entry points. They are executable by the authenticated role ONLY (service_role has no EXECUTE),
--                                        take the identity from auth.uid() (there is no actor parameter), and require the caller's verified JWT to be aal2 with a TOTP
--                                        authentication in the last 15 minutes (propose, approve) or aal2 with TOTP (reject, list). The work is done by internal _tw4price_do_*
--                                        functions that nobody can execute. This is a documented exception to the repo's "no authenticated grants" convention: security
--                                        definer, pinned search_path, no table grants, a four-function surface.
--   * tw4_price_verify()                 read-only detector: every published price must have a matching applied request by two distinct registered administrators; also
--                                        flags request-table anomalies. service_role and owner only. Scheduled use: see the impersonation design doc.
--   * tw4_price_set                      KEEPS its signature and grants but refuses EVERY caller (TW042). No single-administrator path.
--   * studio_sms_price_list triggers     ENABLE ALWAYS (they also fire under session_replication_role = replica): an INSERT needs an approved request for exactly those
--                                        amounts by two distinct registered administrators in flight in the same transaction; no re-activation, no edit, no DELETE, no
--                                        TRUNCATE. Retiring a price (active -> false) stays allowed. The request-table guard and truncate triggers are ENABLE ALWAYS too.
--   Approval rules (under row locks): approver is another active registered administrator; requester still active; request unexpired; the active price is still the one the
--   proposal was made against (else invalidated, nothing published); applied requests replay idempotently for their approver and are refused (TW041) for anyone else;
--   decided requests are final; two concurrent approvals publish exactly one price. A requester may withdraw a pending request (recorded as 'rejected' by the requester).
--
-- NO MIGRATION, SEED OR RESTORE MAY INSERT PRICE ROWS FROM NOW ON: the price-list insert guard refuses them (also under replica mode, so data-only restores and logical
-- replication apply are refused too). New prices are published only through propose + approve. A restore needs an owner-level "alter table ... disable trigger" step.
--
-- ROLLBACK (fail closed; see the rollback file): it never restores single-administrator price publication. tw4_price_set stays a refusing stub whose EXECUTE is revoked from
-- every role; the price-list insert guard stays and is rewritten to refuse ALL inserts. If any request or registry row exists the three tables are RETAINED (audit evidence
-- and authorization data are never destroyed); otherwise they are dropped. Recovery after a rollback is to re-apply this migration, which is idempotent over retained tables.
--
-- OPEN OWNER DECISION (release-blocking): even with the controls above, approval is only as strong as the ability to obtain an authenticated aal2 session as a registered
-- administrator. Remaining impersonation paths: the GoTrue admin API / ability to mint sessions or reset MFA factors for a registered administrator, and owner-level DDL.
-- See docs/twilio/TW-4F_Price_Dual_Control_Impersonation_Design.md. Nothing here is "accepted"; only the owner may accept a residual risk.
--
-- Operational notes: (1) lock order: the functions share-lock the parties' profile rows FIRST (id order), then the per-kind advisory lock and the request row; tooling that changes
-- several platform roles in one statement should update profiles in id order or it can deadlock with an approval (fails safe). (2) Price kinds are read from the price list
-- check constraint with a lowercase [a-z][a-z0-9_]* token rule; the UI list (PRICE_KIND_TEXT) must gain every new kind (a test compares it to the database).
-- (3) tw4_price_requests_list returns the latest 100 requests. (4) Amounts are capped at 10,000,000 cents by CHECK (the UI can enter at most 9,999,999); the per-kind limits
-- table is the place for tighter values once the owner approves them.
begin;

set local lock_timeout = '5s';

do $$
declare v_md5 text;
begin
  if to_regclass('public.studio_sms_price_list') is null or to_regprocedure('public.tw4_price_set(text,integer,integer,text,uuid)') is null
     or to_regprocedure('public._tw4c_admin(uuid)') is null or to_regprocedure('public._tw4_r1_is_platform_admin(uuid)') is null
     or to_regprocedure('public._tw4c_truncate_guard()') is null or to_regclass('auth.users') is null or to_regprocedure('auth.jwt()') is null or to_regprocedure('auth.uid()') is null then
    raise exception 'price dual control precondition failed: 20261122090000 (prepaid credits) is not applied';
  end if;
  if to_regprocedure('public.tw4_price_propose(text,integer,integer,text,text)') is not null then
    raise exception 'price dual control precondition failed: already applied';
  end if;
  -- tw4_price_set is replaced below: it must still be the 20261122090000 body, or the refusing body this migration (or its rollback) left; line endings ignored
  select md5(replace(p.prosrc, chr(13), '')) into v_md5 from pg_proc p where p.oid = 'public.tw4_price_set(text,integer,integer,text,uuid)'::regprocedure;
  if v_md5 is distinct from '36b3548cfa94cce34e7df10c2a74981f' and v_md5 is distinct from '0821967b21143cd9820a12a00da1d745' then
    raise exception 'price dual control precondition failed: tw4_price_set differs from 20261122090000';
  end if;
  -- a retained request table (left by a rollback with evidence) must be this migration's own table
  if to_regclass('public.studio_sms_price_change_requests') is not null and to_regclass('public.studio_sms_price_approvers') is null then
    raise exception 'price dual control precondition failed: a request table exists without the approver registry';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- the request table (the audit trail)
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.studio_sms_price_change_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (char_length(kind) between 1 and 40),     -- the allowed kinds are the price list's own constraint (read by the functions; enforced again by the price insert)
  customer_price_cents int not null check (customer_price_cents > 0 and customer_price_cents <= 10000000),
  provider_cost_cents int not null check (provider_cost_cents >= 0 and provider_cost_cents <= 10000000),
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
create unique index if not exists studio_sms_price_change_requests_one_open on public.studio_sms_price_change_requests (kind) where status in ('pending', 'approved');
create index if not exists studio_sms_price_change_requests_recent on public.studio_sms_price_change_requests (requested_at desc);

revoke all on public.studio_sms_price_change_requests from public, anon, authenticated, service_role;
alter table public.studio_sms_price_change_requests enable row level security;

-- the PROTECTED APPROVER REGISTRY: written only by the database owner (runbook), never by an API role, never by a function of this migration
create table if not exists public.studio_sms_price_approvers (
  user_id uuid primary key,
  added_at timestamptz not null default clock_timestamp(),
  added_note text not null check (char_length(btrim(added_note)) between 10 and 300),
  revoked_at timestamptz null,
  revoked_note text null check (revoked_note is null or char_length(btrim(revoked_note)) between 10 and 300),
  constraint studio_sms_price_approvers_revoked check ((revoked_at is null) = (revoked_note is null))
);
revoke all on public.studio_sms_price_approvers from public, anon, authenticated, service_role;
alter table public.studio_sms_price_approvers enable row level security;

-- per-kind limits as DATA: a row constrains proposals only when approved = true (the owner approves values; shipped rows are unapproved proposals)
create table if not exists public.studio_sms_price_limits (
  kind text primary key check (char_length(kind) between 1 and 40),
  max_customer_cents int not null check (max_customer_cents between 1 and 10000000),
  max_provider_cents int not null check (max_provider_cents between 0 and 10000000),
  max_provider_pct_of_customer int null check (max_provider_pct_of_customer is null or max_provider_pct_of_customer between 1 and 10000),
  max_step_pct int null check (max_step_pct is null or max_step_pct between 1 and 1000),
  approved boolean not null default false,
  approved_by_note text null check (approved_by_note is null or char_length(btrim(approved_by_note)) between 10 and 300),
  approved_at timestamptz null,
  constraint studio_sms_price_limits_approval check (not approved or (approved_by_note is not null and approved_at is not null))
);
revoke all on public.studio_sms_price_limits from public, anon, authenticated, service_role;
alter table public.studio_sms_price_limits enable row level security;

create or replace function public._tw4price_registry_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'studio_sms_price_approvers: rows are never deleted (revoke instead)' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    new.revoked_at := null;
    new.revoked_note := null;
    return new;
  end if;
  if new.user_id is distinct from old.user_id or new.added_at is distinct from old.added_at or new.added_note is distinct from old.added_note or old.revoked_at is not null
     or new.revoked_at is null then
    raise exception 'studio_sms_price_approvers: a registration can only be revoked, once' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists studio_sms_price_approvers_guard on public.studio_sms_price_approvers;
create trigger studio_sms_price_approvers_guard before insert or update or delete on public.studio_sms_price_approvers for each row execute function public._tw4price_registry_guard();
drop trigger if exists studio_sms_price_approvers_truncate on public.studio_sms_price_approvers;
create trigger studio_sms_price_approvers_truncate before truncate on public.studio_sms_price_approvers for each statement execute function public._tw4c_truncate_guard();
alter table public.studio_sms_price_approvers enable always trigger studio_sms_price_approvers_guard;
alter table public.studio_sms_price_approvers enable always trigger studio_sms_price_approvers_truncate;

-- ---------------------------------------------------------------------------------------------------------------
-- helpers (callable by nobody)
-- ---------------------------------------------------------------------------------------------------------------
-- an ACTIVE platform administrator for price control: REGISTERED (protected registry), holds the role, and the auth user exists, is not banned and is not soft-deleted
create or replace function public._tw4price_admin_active(p_user uuid)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_ok boolean;
begin
  -- plpgsql (not sql): the auth schema is resolved when the function runs, never when the migration is applied
  if p_user is null or not public._tw4_r1_is_platform_admin(p_user)
     or not exists (select 1 from public.studio_sms_price_approvers a where a.user_id = p_user and a.revoked_at is null) then
    return false;
  end if;
  -- hosted auth.users has deleted_at (soft delete); a local stand-in without the column is judged on the ban alone
  if exists (select 1 from pg_attribute where attrelid = 'auth.users'::regclass and attname = 'deleted_at' and not attisdropped) then
    execute 'select exists (select 1 from auth.users u where u.id = $1 and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now()))' into v_ok using p_user;
  else
    execute 'select exists (select 1 from auth.users u where u.id = $1 and (u.banned_until is null or u.banned_until <= now()))' into v_ok using p_user;
  end if;
  return coalesce(v_ok, false);
end $$;

-- was this user registered at that moment? (history for the verifier: added before, not revoked before)
create or replace function public._tw4price_registered_at(p_user uuid, p_at timestamptz)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (select 1 from public.studio_sms_price_approvers a where a.user_id = p_user and a.added_at <= p_at and (a.revoked_at is null or a.revoked_at > p_at));
$$;

-- the identity of the CALLER, from the caller's own verified JWT. tier 'recent': aal2 and a TOTP authentication within 15 minutes (mirrors requirePlatformStepUp);
-- tier 'aal2': aal2 with a TOTP authentication. A service-role or anon token has another role claim and is refused. There is no way to name another actor.
create or replace function public._tw4price_session_actor(p_tier text)
returns uuid language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_claims jsonb := auth.jwt();
  v_amr jsonb;
  e jsonb;
  v_has_totp boolean := false;
  v_newest numeric := null;
  v_now numeric := extract(epoch from clock_timestamp());
begin
  if v_uid is null or v_claims is null or coalesce(v_claims ->> 'role', '') <> 'authenticated' then
    raise exception 'sign in as a platform administrator' using errcode = '42501';
  end if;
  if coalesce(v_claims ->> 'aal', '') <> 'aal2' then
    raise exception 'a second-factor (aal2) session is required' using errcode = '42501';
  end if;
  v_amr := v_claims -> 'amr';
  if v_amr is not null and jsonb_typeof(v_amr) = 'array' then
    for e in select * from jsonb_array_elements(v_amr) loop
      if jsonb_typeof(e) = 'string' and e #>> '{}' = 'totp' then
        v_has_totp := true;
      elsif jsonb_typeof(e) = 'object' and e ->> 'method' = 'totp' then
        v_has_totp := true;
        if jsonb_typeof(e -> 'timestamp') = 'number' and (v_newest is null or (e ->> 'timestamp')::numeric > v_newest) then
          v_newest := (e ->> 'timestamp')::numeric;
        end if;
      end if;
    end loop;
  end if;
  if not v_has_totp then
    raise exception 'an authenticator (TOTP) sign-in is required' using errcode = '42501';
  end if;
  if p_tier = 'recent' and (v_newest is null or v_newest > v_now + 60 or v_now - v_newest > 900) then
    raise exception 'the authenticator code is older than 15 minutes: confirm it again' using errcode = '42501';
  end if;
  return v_uid;
end $$;

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
drop trigger if exists studio_sms_price_change_requests_guard on public.studio_sms_price_change_requests;
create trigger studio_sms_price_change_requests_guard before insert or update or delete on public.studio_sms_price_change_requests for each row execute function public._tw4pricedual_guard();
drop trigger if exists studio_sms_price_change_requests_truncate on public.studio_sms_price_change_requests;
create trigger studio_sms_price_change_requests_truncate before truncate on public.studio_sms_price_change_requests for each statement execute function public._tw4c_truncate_guard();

alter table public.studio_sms_price_change_requests enable always trigger studio_sms_price_change_requests_guard;
alter table public.studio_sms_price_change_requests enable always trigger studio_sms_price_change_requests_truncate;

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
    if q.id is null or not new.active or q.decided_by = q.requested_by or not public._tw4price_admin_active(q.decided_by) or not public._tw4price_admin_active(q.requested_by) then
      raise exception 'a price is published only by an approved dual-control price change (two different platform administrators): none is being applied for these amounts' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'a published price is never deleted (a retired price stays as history)' using errcode = '42501';
  end if;
  -- UPDATE: a published price is immutable, whatever the session mode; the only change that remains is retiring it (active -> false)
  if new.id is distinct from old.id or new.kind is distinct from old.kind or new.customer_price_cents is distinct from old.customer_price_cents
     or new.provider_cost_cents is distinct from old.provider_cost_cents or new.description is distinct from old.description or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'a published price is never edited: retire it and publish a new one through a price change request' using errcode = '42501';
  end if;
  if old.active = false and new.active = true then
    raise exception 'a published price is never edited: a retired price is never re-activated; publish a new price through a price change request' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists studio_sms_price_list_00_activation on public.studio_sms_price_list;
create trigger studio_sms_price_list_00_activation before insert or update or delete on public.studio_sms_price_list for each row execute function public._tw4price_activation_guard();
create or replace function public._tw4price_truncate_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$ begin raise exception 'the price list is never truncated' using errcode = '42501'; end $$;
drop trigger if exists studio_sms_price_list_00_truncate on public.studio_sms_price_list;
create trigger studio_sms_price_list_00_truncate before truncate on public.studio_sms_price_list for each statement execute function public._tw4price_truncate_guard();
alter table public.studio_sms_price_list enable always trigger studio_sms_price_list_00_truncate;
-- fires even when session_replication_role = replica (a session that switches ordinary triggers off)
alter table public.studio_sms_price_list enable always trigger studio_sms_price_list_00_activation;

-- ---------------------------------------------------------------------------------------------------------------
-- propose
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4price_do_propose(p_kind text, p_customer_cents int, p_provider_cents int, p_description text, p_reason text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  q public.studio_sms_price_change_requests;
  b public.studio_sms_price_list;
  lim public.studio_sms_price_limits;
  v_id uuid;
begin
  perform 1 from public.profiles pr where pr.id = p_actor for share;
  perform public._tw4c_admin(p_actor);
  if not public._tw4price_admin_active(p_actor) then
    raise exception 'actor must be an active platform admin' using errcode = '42501';
  end if;
  if p_kind is null or p_customer_cents is null or p_customer_cents <= 0 or p_customer_cents > 10000000 or p_provider_cents is null or p_provider_cents < 0 or p_provider_cents > 10000000
     or p_description is null or char_length(btrim(p_description)) not between 3 and 200 or p_reason is null or char_length(btrim(p_reason)) not between 10 and 500 then
    raise exception 'a price proposal needs a known kind, a positive customer price and a non-negative provider cost (each at most 10,000,000 cents), a description (3 to 200) and a written reason (10 to 500)' using errcode = '22023';
  end if;
  if not (p_kind = any (public._tw4price_kinds())) then
    raise exception 'unknown price kind' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_price_set:' || p_kind));
  select * into b from public.studio_sms_price_list x where x.kind = p_kind and x.active;
  -- OWNER-APPROVED limits only (data; unapproved proposals in the limits table are not enforced)
  select * into lim from public.studio_sms_price_limits l where l.kind = p_kind and l.approved;
  if lim.kind is not null then
    if p_customer_cents > lim.max_customer_cents or p_provider_cents > lim.max_provider_cents
       or (lim.max_provider_pct_of_customer is not null and p_provider_cents::bigint * 100 > p_customer_cents::bigint * lim.max_provider_pct_of_customer)
       or (lim.max_step_pct is not null and b.id is not null and abs(p_customer_cents::bigint - b.customer_price_cents) * 100 > b.customer_price_cents::bigint * lim.max_step_pct) then
      raise exception 'the proposed prices exceed the owner-approved limits for this kind' using errcode = '22023';
    end if;
  end if;
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
create or replace function public._tw4price_do_approve(p_request_id uuid, p_actor uuid, p_note text)
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
create or replace function public._tw4price_do_reject(p_request_id uuid, p_actor uuid, p_note text)
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
create or replace function public._tw4price_do_list(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_active jsonb;
  v_requests jsonb;
begin
  if not public._tw4price_admin_active(p_actor) then
    raise exception 'actor must be an active platform admin' using errcode = '42501';
  end if;
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
-- the PUBLIC surface: identity from the caller's own aal2 JWT, no actor parameter
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_price_propose(p_kind text, p_customer_cents int, p_provider_cents int, p_description text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return public._tw4price_do_propose(p_kind, p_customer_cents, p_provider_cents, p_description, p_reason, public._tw4price_session_actor('recent'));
end $$;

create or replace function public.tw4_price_approve(p_request_id uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return public._tw4price_do_approve(p_request_id, public._tw4price_session_actor('recent'), p_note);
end $$;

create or replace function public.tw4_price_reject(p_request_id uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return public._tw4price_do_reject(p_request_id, public._tw4price_session_actor('aal2'), p_note);
end $$;

create or replace function public.tw4_price_requests_list()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return public._tw4price_do_list(public._tw4price_session_actor('aal2'));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- verifier (read only): every published price needs a matching applied request by two distinct administrators who were registered at the time
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_price_verify(p_since timestamptz default null)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v jsonb := '[]'::jsonb;
  r record;
begin
  -- a published price with no attesting applied request (prices published before this migration are listed too: pass p_since to look only at newer ones)
  for r in select p.id, p.kind, p.created_at from public.studio_sms_price_list p
            where (p_since is null or p.created_at >= p_since)
              and not exists (select 1 from public.studio_sms_price_change_requests q
                               where q.status = 'applied' and q.applied_price_id = p.id and q.kind = p.kind and q.customer_price_cents = p.customer_price_cents
                                 and q.provider_cost_cents = p.provider_cost_cents and q.description = p.description and q.decided_by = p.created_by
                                 and q.decided_by <> q.requested_by and public._tw4price_registered_at(q.requested_by, q.requested_at)
                                 and public._tw4price_registered_at(q.decided_by, q.decided_at)) loop
    v := v || jsonb_build_object('code', 'price_unattested', 'price_id', r.id, 'kind', r.kind, 'created_at', r.created_at);
  end loop;
  for r in select q.id, q.status, q.kind from public.studio_sms_price_change_requests q
            where (q.status in ('approved', 'applied') and (q.decided_by is null or q.decided_by = q.requested_by))
               or (q.status = 'applied' and not exists (select 1 from public.studio_sms_price_list p where p.id = q.applied_price_id))
               or (q.status = 'approved' and q.decided_at < clock_timestamp() - interval '1 minute')
               or (q.status = 'pending' and q.expires_at < clock_timestamp() - interval '48 hours')
               or (q.status in ('approved', 'applied') and not (public._tw4price_registered_at(q.requested_by, q.requested_at) and public._tw4price_registered_at(q.decided_by, q.decided_at))) loop
    v := v || jsonb_build_object('code', 'request_anomaly', 'request_id', r.id, 'status', r.status, 'kind', r.kind);
  end loop;
  for r in select x.kind, count(*) as n from public.studio_sms_price_list x where x.active group by x.kind having count(*) > 1 loop
    v := v || jsonb_build_object('code', 'several_active_prices', 'kind', r.kind, 'count', r.n);
  end loop;
  return jsonb_build_object('ok', jsonb_array_length(v) = 0, 'anomalies', v, 'checked_at', clock_timestamp());
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

revoke all on function public._tw4price_admin_active(uuid), public._tw4price_registered_at(uuid, timestamptz), public._tw4price_session_actor(text), public._tw4price_kinds(),
  public._tw4pricedual_guard(), public._tw4price_activation_guard(), public._tw4price_truncate_guard(), public._tw4price_registry_guard(),
  public._tw4price_do_propose(text, int, int, text, text, uuid), public._tw4price_do_approve(uuid, uuid, text), public._tw4price_do_reject(uuid, uuid, text),
  public._tw4price_do_list(uuid) from public, anon, authenticated, service_role;
revoke all on function public.tw4_price_propose(text, int, int, text, text), public.tw4_price_approve(uuid, text), public.tw4_price_reject(uuid, text), public.tw4_price_requests_list(),
  public.tw4_price_verify(timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.tw4_price_propose(text, int, int, text, text), public.tw4_price_approve(uuid, text), public.tw4_price_reject(uuid, text), public.tw4_price_requests_list() to authenticated;
grant execute on function public.tw4_price_verify(timestamptz) to service_role;
revoke all on function public.tw4_price_set(text, int, int, text, uuid) from public, anon, authenticated;
grant execute on function public.tw4_price_set(text, int, int, text, uuid) to service_role;

-- postcondition: exactly the grants and guards intended
do $$
begin
  if has_function_privilege('anon', 'public.tw4_price_approve(uuid,text)', 'execute') or not has_function_privilege('authenticated', 'public.tw4_price_approve(uuid,text)', 'execute')
     or has_function_privilege('service_role', 'public.tw4_price_approve(uuid,text)', 'execute') or has_function_privilege('service_role', 'public.tw4_price_propose(text,integer,integer,text,text)', 'execute')
     or has_function_privilege('service_role', 'public._tw4price_do_approve(uuid,uuid,text)', 'execute') or has_function_privilege('authenticated', 'public._tw4price_do_approve(uuid,uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'public.tw4_price_verify(timestamptz)', 'execute') or not has_function_privilege('service_role', 'public.tw4_price_set(text,integer,integer,text,uuid)', 'execute')
     or has_function_privilege('service_role', 'public._tw4price_activation_guard()', 'execute') then
    raise exception 'price dual control postcondition failed: unexpected function privileges';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.studio_sms_price_change_requests'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.studio_sms_price_approvers'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.studio_sms_price_limits'::regclass)
     or (select count(*) from pg_trigger where tgname in ('studio_sms_price_list_00_activation', 'studio_sms_price_list_00_truncate', 'studio_sms_price_change_requests_guard',
          'studio_sms_price_change_requests_truncate', 'studio_sms_price_approvers_guard', 'studio_sms_price_approvers_truncate') and tgenabled = 'A') <> 6 then
    raise exception 'price dual control postcondition failed: RLS or an always-on trigger is missing';
  end if;
end $$;

commit;
