-- 20270208090000_d24_m3a_intent_ledger.sql
-- D24 M3-A: SQL foundation for trusted hosted-invoice creation + registration. NOT APPLIED to any shared environment by this file. Dark: nothing calls it.
--   1. d24_register_invoice hardened (M2-A release blockers): invoice-id-alone advisory lock, refusal of an invoice id registered under any other account scope,
--      and the Stripe account resolved INSIDE the function from studios.stripe_connected_account_id (NULL / malformed / platform refused; a supplied account is only an assertion).
--      The signature is unchanged so existing grants and callers still bind.
--   2. Durable creation-intent ledger written BEFORE any provider call: hosted_invoice_creation_intents with an IMMUTABLE request fingerprint, append-only
--      state-change events and an append-only attempt history.
--   3. Stripe idempotency keys are NOT retained forever (>= 24h). A private config row holds a fail-closed SAFE-RETRY WINDOW (default 12h, hard cap 23h; a safety control,
--      NOT proof of retention). A pending intent older than the window, a fingerprint/account/ownership ambiguity, or an operator decision moves the intent to
--      needs_review. The database never generates a replacement key and never permits a second invoice for an uncertain first creation.
--   4. Service-role-only SECURITY DEFINER functions: d24_intent_begin / _mark_provider_created / _register / _fail / _record_outcome / _claim_recovery / _flag_review /
--      _list_recoverable. Verified-operator functions (M2-B pattern: auth.uid(), platform_admin, AAL2, mandatory reason, DB switch, audit): d24_op_flag_creation_review /
--      d24_op_attach_creation_invoice / d24_op_abandon_creation / d24_op_list_creation_reviews.
--   5. hosted_invoice_business_object_types: per-type ownership functions, EMPTY by default; begin/register fail closed for unregistered types.
-- Creation and registration never infer settlement: nothing here writes payments, credit notes, transitions or any paid state, and nothing finalizes, sends or collects.
-- Contract: docs/billing/D24-M3A-FOUNDATION.md. Requires 20270203110000 (M1), 20270207090000 (M2-B operator helpers) and public.studios(stripe_connected_account_id).
-- Rollback: rollback/20270208090000_d24_m3a_intent_ledger_rollback.sql (restores the M1 d24_register_invoice verbatim).

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.d24_register_invoice(uuid,text,text,boolean,text,text,uuid)') is null then
    raise exception 'd24 m3a precondition failed: 20270203110000 (M1) must be applied first';
  end if;
  if to_regprocedure('public._d24_op_caller()') is null or to_regprocedure('public._d24_op_is_platform_admin(uuid)') is null or to_regprocedure('public._d24_op_reason(text)') is null then
    raise exception 'd24 m3a precondition failed: 20270207090000 (M2-B operator helpers) must be applied first';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'studios' and column_name = 'stripe_connected_account_id') then
    raise exception 'd24 m3a precondition failed: public.studios.stripe_connected_account_id is missing';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------------------

create table public.hosted_invoice_business_object_types (
  business_object_type text primary key,
  owner_function regprocedure not null,        -- public.fn(uuid studio, text object id) returns boolean, STABLE/IMMUTABLE: true only when the object exists and belongs to that studio
  created_at timestamptz not null default now(),
  constraint hosted_invoice_bot_type_chk check (business_object_type ~ '^[a-z][a-z0-9_]{0,62}$' and business_object_type !~* 'subscription')
);

-- private config: the safe-retry window. Not writable by any API role; changed only by the owner-only d24_intent_set_window.
create table public.hosted_invoice_creation_config (
  singleton boolean primary key default true check (singleton),
  safe_retry_minutes integer not null default 720,   -- 12h; strictly below Stripe's 24h minimum retention
  updated_at timestamptz not null default now(),
  constraint hosted_invoice_creation_config_window_chk check (safe_retry_minutes between 1 and 1380)
);
insert into public.hosted_invoice_creation_config (singleton) values (true);

create table public.hosted_invoice_creation_intents (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  business_object_type text not null,
  business_object_id text not null,
  idempotency_key text not null,
  request_fingerprint text not null,            -- sha256 hex of the canonical request (studio, account, customer ref, lines, currency, object ref); computed by the app, immutable here
  status text not null default 'pending',
  stripe_account_id text not null,              -- resolved from the studio at begin, never supplied
  stripe_invoice_id text,
  livemode boolean,
  registry_id uuid references public.hosted_invoice_registry(id) on delete restrict,
  created_by uuid,
  attempt_count integer not null default 1,
  failure_count integer not null default 0,
  last_error_code text,
  outcome_unknown boolean not null default false,   -- a Stripe call ended ambiguously (timeout, dropped connection): the invoice may exist
  review_reason text,                               -- why the intent entered needs_review (code)
  recovery_lease_id uuid,
  recovery_lease_expires_at timestamptz,
  last_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  provider_created_at timestamptz,
  registered_at timestamptz,
  settled_at timestamptz,                       -- set when the intent reaches a terminal status (registered/failed/abandoned); NOT payment settlement
  constraint hosted_invoice_intents_status_chk check (status in ('pending', 'provider_created', 'registered', 'needs_review', 'failed', 'abandoned')),
  constraint hosted_invoice_intents_type_chk check (business_object_type ~ '^[a-z][a-z0-9_]{0,62}$' and business_object_type !~* 'subscription'),
  constraint hosted_invoice_intents_object_chk check (business_object_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  constraint hosted_invoice_intents_key_chk check (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,200}$'),
  constraint hosted_invoice_intents_fp_chk check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint hosted_invoice_intents_account_chk check (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  constraint hosted_invoice_intents_invoice_chk check (stripe_invoice_id is null or stripe_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  constraint hosted_invoice_intents_error_chk check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint hosted_invoice_intents_review_chk check (review_reason is null or review_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint hosted_invoice_intents_review_set_chk check (status <> 'needs_review' or review_reason is not null),
  constraint hosted_invoice_intents_counts_chk check (attempt_count >= 1 and failure_count >= 0),
  constraint hosted_invoice_intents_provider_chk check ((status in ('provider_created', 'registered')) <= (stripe_invoice_id is not null and livemode is not null and provider_created_at is not null)),
  constraint hosted_invoice_intents_pending_chk check (status <> 'pending' or (stripe_invoice_id is null and livemode is null)),
  constraint hosted_invoice_intents_registered_chk check ((status = 'registered') = (registry_id is not null and registered_at is not null)),
  constraint hosted_invoice_intents_settled_chk check ((status in ('registered', 'failed', 'abandoned')) = (settled_at is not null)),
  constraint hosted_invoice_intents_invoice_pair_chk check ((stripe_invoice_id is null) = (livemode is null))
);
create unique index hosted_invoice_intents_key_uq on public.hosted_invoice_creation_intents (studio_id, idempotency_key);
create unique index hosted_invoice_intents_fk_uq on public.hosted_invoice_creation_intents (id, studio_id);
create unique index hosted_invoice_intents_invoice_uq on public.hosted_invoice_creation_intents (stripe_account_id, stripe_invoice_id) where stripe_invoice_id is not null;
-- needs_review HOLDS the object: an uncertain first creation must never be followed by a second invoice
create unique index hosted_invoice_intents_live_object_uq on public.hosted_invoice_creation_intents (studio_id, business_object_type, business_object_id)
  where status in ('pending', 'provider_created', 'registered', 'needs_review');
create index hosted_invoice_registry_invoice_idx on public.hosted_invoice_registry (stripe_invoice_id);   -- invoice-id-alone scope check in d24_register_invoice
create index hosted_invoice_intents_recover_idx on public.hosted_invoice_creation_intents (updated_at, id) where status in ('pending', 'provider_created');
create index hosted_invoice_intents_review_idx on public.hosted_invoice_creation_intents (updated_at, id) where status = 'needs_review';

create table public.hosted_invoice_creation_intent_events (
  id bigint generated always as identity primary key,
  intent_id uuid not null,
  studio_id uuid not null,
  event_kind text not null,
  from_status text,
  to_status text not null,
  error_code text,
  actor_user_id uuid,                           -- set for verified-operator actions only
  reason text,                                  -- operator reason (mandatory for operator kinds)
  created_at timestamptz not null default now(),
  constraint hosted_invoice_intent_events_fk foreign key (intent_id, studio_id) references public.hosted_invoice_creation_intents (id, studio_id) on delete restrict,
  constraint hosted_invoice_intent_events_kind_chk check (event_kind in ('created', 'provider_created', 'registered', 'failure_recorded', 'failed', 'abandoned', 'needs_review',
    'operator_flagged', 'operator_attached', 'operator_abandoned')),
  constraint hosted_invoice_intent_events_error_chk check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint hosted_invoice_intent_events_operator_chk check (event_kind not like 'operator\_%' or (actor_user_id is not null and reason is not null and length(btrim(reason)) >= 10))
);
create index hosted_invoice_intent_events_intent_idx on public.hosted_invoice_creation_intent_events (intent_id, id);

-- append-only retry history: every begin / replay / recorded outcome / recovery claim, with an outcome code and timestamp
create table public.hosted_invoice_creation_attempts (
  id bigint generated always as identity primary key,
  intent_id uuid not null,
  studio_id uuid not null,
  attempt_kind text not null,
  outcome_code text,
  outcome_unknown boolean not null default false,
  created_at timestamptz not null default now(),
  constraint hosted_invoice_creation_attempts_fk foreign key (intent_id, studio_id) references public.hosted_invoice_creation_intents (id, studio_id) on delete restrict,
  constraint hosted_invoice_creation_attempts_kind_chk check (attempt_kind in ('begin', 'begin_replay', 'recovery_replay', 'outcome', 'failure')),
  constraint hosted_invoice_creation_attempts_code_chk check (outcome_code is null or outcome_code ~ '^[a-z][a-z0-9_]{0,63}$')
);
create index hosted_invoice_creation_attempts_intent_idx on public.hosted_invoice_creation_attempts (intent_id, id);

do $$
declare t text;
begin
  foreach t in array array['hosted_invoice_business_object_types', 'hosted_invoice_creation_config', 'hosted_invoice_creation_intents',
                           'hosted_invoice_creation_intent_events', 'hosted_invoice_creation_attempts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to service_role', t);
  end loop;
end $$;
revoke all on sequence public.hosted_invoice_creation_intent_events_id_seq from public, anon, authenticated, service_role;
revoke all on sequence public.hosted_invoice_creation_attempts_id_seq from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- Write guards
-- ---------------------------------------------------------------------------------------------------------------------

create or replace function public._d24_intent_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if coalesce(current_setting('d24.writer', true), '') <> 'on' then
    raise exception 'd24: % on % is only allowed through the d24 functions', tg_op, tg_table_name using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'd24: creation intents are permanent evidence and cannot be deleted' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'd24: an intent is created pending' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.studio_id is distinct from old.studio_id
     or new.business_object_type is distinct from old.business_object_type or new.business_object_id is distinct from old.business_object_id
     or new.idempotency_key is distinct from old.idempotency_key or new.request_fingerprint is distinct from old.request_fingerprint
     or new.stripe_account_id is distinct from old.stripe_account_id
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'd24: intent identity columns are immutable' using errcode = '42501';
  end if;
  if old.stripe_invoice_id is not null and (new.stripe_invoice_id is distinct from old.stripe_invoice_id or new.livemode is distinct from old.livemode) then
    raise exception 'd24: a recorded provider invoice cannot change' using errcode = '42501';
  end if;
  -- an intent that records a Stripe invoice can never be released: failed/abandoned would free the object for a SECOND invoice while this one lives at Stripe
  if new.status in ('failed', 'abandoned') and new.stripe_invoice_id is not null then
    raise exception 'd24: an intent that records a provider invoice cannot be failed or abandoned (register or attach it)' using errcode = '42501';
  end if;
  if new.attempt_count < old.attempt_count or new.failure_count < old.failure_count then
    raise exception 'd24: intent counters cannot decrease' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    if not ((old.status = 'pending' and new.status in ('provider_created', 'failed', 'needs_review'))
         or (old.status = 'provider_created' and new.status in ('registered', 'failed', 'needs_review'))
         or (old.status = 'needs_review' and new.status in ('registered', 'abandoned', 'failed'))) then
      raise exception 'd24: illegal intent transition % -> %', old.status, new.status using errcode = '42501';
    end if;
  elsif old.status in ('registered', 'failed', 'abandoned') then
    raise exception 'd24: a terminal intent cannot change' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger hosted_invoice_intents_guard_trg before insert or update or delete on public.hosted_invoice_creation_intents
  for each row execute function public._d24_intent_guard();
create trigger hosted_invoice_intents_trunc_trg before truncate on public.hosted_invoice_creation_intents
  for each statement execute function public._d24_append_only();
create trigger hosted_invoice_intent_events_writer_trg before insert on public.hosted_invoice_creation_intent_events
  for each row execute function public._d24_require_writer();
create trigger hosted_invoice_intent_events_append_trg before update or delete on public.hosted_invoice_creation_intent_events
  for each row execute function public._d24_append_only();
create trigger hosted_invoice_intent_events_trunc_trg before truncate on public.hosted_invoice_creation_intent_events
  for each statement execute function public._d24_append_only();
create trigger hosted_invoice_creation_attempts_writer_trg before insert on public.hosted_invoice_creation_attempts
  for each row execute function public._d24_require_writer();
create trigger hosted_invoice_creation_attempts_append_trg before update or delete on public.hosted_invoice_creation_attempts
  for each row execute function public._d24_append_only();
create trigger hosted_invoice_creation_attempts_trunc_trg before truncate on public.hosted_invoice_creation_attempts
  for each statement execute function public._d24_append_only();

create or replace function public._d24_creation_config_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') or coalesce(current_setting('d24.writer', true), '') <> 'on' then
    raise exception 'd24: the creation config can only be changed through d24_intent_set_window' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger hosted_invoice_creation_config_guard_trg before insert or update or delete on public.hosted_invoice_creation_config
  for each row execute function public._d24_creation_config_guard();
create trigger hosted_invoice_creation_config_trunc_trg before truncate on public.hosted_invoice_creation_config
  for each statement execute function public._d24_creation_config_guard();

-- the ownership-function registry validates its rows itself (fail closed); only the migration owner can write it
create or replace function public._d24_bot_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare p pg_proc%rowtype;
begin
  select * into p from pg_proc where oid = new.owner_function::oid;
  if not found
     or p.pronamespace <> 'public'::regnamespace
     or p.proargtypes::text <> format('%s %s', 'uuid'::regtype::oid, 'text'::regtype::oid)
     or p.prorettype <> 'boolean'::regtype
     or p.provolatile not in ('s', 'i')
     or p.proretset then
    raise exception 'd24: an ownership function must be public.fn(uuid, text) returns boolean and STABLE or IMMUTABLE' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger hosted_invoice_bot_guard_trg before insert or update on public.hosted_invoice_business_object_types
  for each row execute function public._d24_bot_guard();
create trigger hosted_invoice_bot_trunc_trg before truncate on public.hosted_invoice_business_object_types
  for each statement execute function public._d24_append_only();

-- Owner-only helpers (no grant to any API role).
create or replace function public.d24_register_business_object_type(p_type text, p_owner_function regprocedure)
returns void language sql
set search_path = pg_catalog, public, pg_temp
as $$ insert into public.hosted_invoice_business_object_types (business_object_type, owner_function) values (p_type, p_owner_function) $$;

create or replace function public.d24_intent_set_window(p_minutes integer)
returns void language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform set_config('d24.writer', 'on', true);
  update public.hosted_invoice_creation_config set safe_retry_minutes = p_minutes, updated_at = now() where singleton;   -- the CHECK refuses anything outside 1..1380
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------------------------------------------------

-- The studio's connected account, locked FOR SHARE until the CALLING TRANSACTION commits: within one function call a reconnect cannot slip in between check and use.
-- It does not span separate calls (begin, mark, register are separate transactions); each re-checks, and mark deliberately does not (see there).
create or replace function public._d24_studio_account(p_studio_id uuid)
returns text language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare v text;
begin
  select stripe_connected_account_id into v from public.studios where id = p_studio_id for share;
  if not found or v is null or v !~ '^acct_[A-Za-z0-9]+$' then
    raise exception 'd24_studio_account_unavailable' using errcode = '42501';
  end if;
  return v;
end $$;

-- The safe-retry window. FAIL CLOSED: a missing row or an out-of-range value is a zero window (every pending intent counts as expired).
create or replace function public._d24_safe_window()
returns interval language sql stable
set search_path = pg_catalog, public, pg_temp
as $$ select make_interval(mins => coalesce((select least(greatest(c.safe_retry_minutes, 0), 1380) from public.hosted_invoice_creation_config c where c.singleton), 0)) $$;

-- Ownership by the registered per-type function; fails closed for an unregistered type or a missing function.
create or replace function public._d24_check_owner(p_studio_id uuid, p_type text, p_object_id text)
returns void language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_oid oid;
  v_nsp text;
  v_name text;
  v_ok boolean;
begin
  select t.owner_function::oid into v_oid from public.hosted_invoice_business_object_types t where t.business_object_type = p_type;
  if v_oid is not null then
    select n.nspname, p.proname into v_nsp, v_name from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.oid = v_oid;
  end if;
  if v_name is null then
    raise exception 'd24_business_object_type_unsupported' using errcode = '22023';
  end if;
  execute format('select %I.%I($1, $2)', v_nsp, v_name) into v_ok using p_studio_id, p_object_id;
  if v_ok is distinct from true then
    raise exception 'd24_business_object_not_owned' using errcode = '42501';
  end if;
end $$;

create or replace function public._d24_intent_json(r public.hosted_invoice_creation_intents)
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object('intent_id', r.id, 'studio_id', r.studio_id, 'status', r.status, 'business_object_type', r.business_object_type,
    'business_object_id', r.business_object_id, 'idempotency_key', r.idempotency_key, 'request_fingerprint', r.request_fingerprint,
    'stripe_account_id', r.stripe_account_id, 'stripe_invoice_id', r.stripe_invoice_id, 'livemode', r.livemode, 'registry_id', r.registry_id,
    'attempt_count', r.attempt_count, 'failure_count', r.failure_count, 'last_error_code', r.last_error_code, 'outcome_unknown', r.outcome_unknown,
    'review_reason', r.review_reason, 'replay_deadline', r.created_at + public._d24_safe_window(), 'created_at', r.created_at, 'updated_at', r.updated_at)
$$;

create or replace function public._d24_intent_event(p_intent_id uuid, p_studio_id uuid, p_kind text, p_from text, p_to text, p_code text,
                                                    p_actor uuid default null, p_reason text default null)
returns void language sql
set search_path = pg_catalog, public, pg_temp
as $$
  insert into public.hosted_invoice_creation_intent_events (intent_id, studio_id, event_kind, from_status, to_status, error_code, actor_user_id, reason)
  values (p_intent_id, p_studio_id, p_kind, p_from, p_to, p_code, p_actor, p_reason)
$$;

create or replace function public._d24_attempt(p_intent_id uuid, p_studio_id uuid, p_kind text, p_code text, p_unknown boolean)
returns void language sql
set search_path = pg_catalog, public, pg_temp
as $$
  insert into public.hosted_invoice_creation_attempts (intent_id, studio_id, attempt_kind, outcome_code, outcome_unknown)
  values (p_intent_id, p_studio_id, p_kind, p_code, coalesce(p_unknown, false))
$$;

create or replace function public._d24_clean_code(p_code text)
returns text language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$ select case when p_code ~ '^[a-z][a-z0-9_]{0,63}$' then p_code else 'unsanitized_error_code' end $$;

-- lock + fetch an intent scoped to its studio; another studio's intent is indistinguishable from a missing one
create or replace function public._d24_intent_lock(p_intent_id uuid, p_studio_id uuid)
returns public.hosted_invoice_creation_intents language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare v public.hosted_invoice_creation_intents%rowtype;
begin
  if p_intent_id is null or p_studio_id is null then
    raise exception 'd24: intent id and studio are required' using errcode = '22023';
  end if;
  select * into v from public.hosted_invoice_creation_intents where id = p_intent_id and studio_id = p_studio_id for update;
  if not found then
    raise exception 'd24_intent_not_found' using errcode = '42501';
  end if;
  return v;
end $$;

-- Move a non-terminal intent to needs_review (fail closed). Caller holds the row lock and the writer flag. Idempotent for an intent already in review.
create or replace function public._d24_intent_to_review(v public.hosted_invoice_creation_intents, p_code text, p_actor uuid default null, p_reason text default null)
returns public.hosted_invoice_creation_intents language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare r public.hosted_invoice_creation_intents%rowtype;
begin
  if v.status not in ('pending', 'provider_created') then
    return v;
  end if;
  update public.hosted_invoice_creation_intents
  set status = 'needs_review', review_reason = public._d24_clean_code(p_code), recovery_lease_id = null, recovery_lease_expires_at = null, updated_at = now()
  where id = v.id returning * into r;
  perform public._d24_intent_event(r.id, r.studio_id, case when p_actor is null then 'needs_review' else 'operator_flagged' end, v.status, 'needs_review', r.review_reason, p_actor, p_reason);
  return r;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- (1) d24_register_invoice, hardened. Same signature as M1.
-- ---------------------------------------------------------------------------------------------------------------------

create or replace function public.d24_register_invoice(
  p_studio_id uuid, p_stripe_account_id text, p_stripe_invoice_id text, p_livemode boolean,
  p_business_object_type text, p_business_object_id text, p_created_by uuid default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_account text;
  v_reg uuid;
  v_row uuid;
  v_adopted boolean := false;
  v_other uuid;
  v_other_acct text;
begin
  if p_studio_id is null or p_stripe_invoice_id is null or p_livemode is null then
    raise exception 'd24_register_invoice: studio, invoice id and livemode are required' using errcode = '22023';
  end if;
  if p_stripe_invoice_id !~ '^in_[A-Za-z0-9]+$' then
    raise exception 'd24_register_invoice: malformed invoice id' using errcode = '22023';
  end if;
  perform set_config('d24.writer', 'on', true);
  -- the invoice id ALONE serializes every registration of it, whichever account scope or studio asks
  perform pg_advisory_xact_lock(hashtextextended('d24inv:' || p_stripe_invoice_id, 0));
  v_account := public._d24_studio_account(p_studio_id);
  if p_stripe_account_id is not null and p_stripe_account_id is distinct from v_account then
    raise exception 'd24_account_mismatch' using errcode = '42501';
  end if;
  if exists (select 1 from public.hosted_invoice_registry where stripe_invoice_id = p_stripe_invoice_id and account_key <> v_account) then
    raise exception 'd24_invoice_id_scope_conflict' using errcode = '23505';
  end if;
  perform public._d24_key_lock(v_account, p_stripe_invoice_id);

  insert into public.hosted_invoice_registry (studio_id, stripe_account_id, stripe_invoice_id, livemode, business_object_type, business_object_id, created_by)
  values (p_studio_id, v_account, p_stripe_invoice_id, p_livemode, p_business_object_type, p_business_object_id, p_created_by)
  on conflict (coalesce(stripe_account_id, ''), stripe_invoice_id) do nothing
  returning id into v_reg;

  if v_reg is null then
    -- already registered: idempotent only when identical; a different owner is refused, never overwritten
    select id into v_reg from public.hosted_invoice_registry
    where coalesce(stripe_account_id, '') = v_account and stripe_invoice_id = p_stripe_invoice_id
      and studio_id = p_studio_id and business_object_type = p_business_object_type and business_object_id = p_business_object_id
      and livemode = p_livemode;
    if v_reg is null then
      raise exception 'd24_registration_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object('outcome', 'already_registered', 'registry_id', v_reg);
  end if;

  -- the same invoice id seen under another account scope was never ours: flag it, never attribute it
  for v_other_acct in select distinct account_key from public.hosted_invoices
      where stripe_invoice_id = p_stripe_invoice_id and account_key <> v_account order by account_key loop
    perform public._d24_key_lock(nullif(v_other_acct, ''), p_stripe_invoice_id);
  end loop;
  for v_other in select id from public.hosted_invoices
      where stripe_invoice_id = p_stripe_invoice_id and coalesce(stripe_account_id, '') <> v_account and studio_id is null
      order by id for update loop
    perform public._d24_flag(v_other, 'account_scope_mismatch', true);
    perform public._d24_refresh_state(v_other, 'registration', null);
  end loop;
  select id into v_row from public.hosted_invoices
  where coalesce(stripe_account_id, '') = v_account and stripe_invoice_id = p_stripe_invoice_id
  for update;
  if v_row is not null then
    v_adopted := public._d24_try_adopt(v_row);
    perform public._d24_classify(v_row);
    perform public._d24_refresh_state(v_row, 'registration', null);
  end if;
  return jsonb_build_object('outcome', 'registered', 'registry_id', v_reg, 'adopted_existing_facts', v_adopted and v_row is not null);
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- (2) Intent functions (service role)
-- ---------------------------------------------------------------------------------------------------------------------

-- Idempotent on (studio, key). A replay is ONLY permitted while the intent is pending AND younger than the safe-retry window AND the fingerprint matches.
-- Outcomes: created | existing (pending/provider_created, inside the window: replay with the SAME key) | existing_terminal (do NOT call Stripe)
--           | needs_review (do NOT call Stripe: window expired, or already in review).
create or replace function public.d24_intent_begin(
  p_studio_id uuid, p_business_object_type text, p_business_object_id text, p_idempotency_key text, p_request_fingerprint text, p_created_by uuid default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v public.hosted_invoice_creation_intents%rowtype;
  v_account text;
begin
  if p_studio_id is null or p_business_object_type is null or p_business_object_id is null or p_idempotency_key is null or p_request_fingerprint is null then
    raise exception 'd24_intent_begin: studio, business object, idempotency key and request fingerprint are required' using errcode = '22023';
  end if;
  if p_business_object_type !~ '^[a-z][a-z0-9_]{0,62}$' or p_business_object_type ~* 'subscription'
     or p_business_object_id !~ '^[A-Za-z0-9_.:-]{1,128}$' or p_idempotency_key !~ '^[A-Za-z0-9_.:-]{8,200}$'
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'd24_intent_begin: malformed input' using errcode = '22023';
  end if;
  perform set_config('d24.writer', 'on', true);
  perform pg_advisory_xact_lock(hashtextextended('d24intent:' || p_studio_id::text || ':' || p_idempotency_key, 0));
  perform pg_advisory_xact_lock(hashtextextended('d24intobj:' || p_studio_id::text || ':' || p_business_object_type || ':' || p_business_object_id, 0));

  select * into v from public.hosted_invoice_creation_intents where studio_id = p_studio_id and idempotency_key = p_idempotency_key for update;
  if found then
    if v.business_object_type <> p_business_object_type or v.business_object_id <> p_business_object_id then
      raise exception 'd24_idempotency_key_conflict' using errcode = '23505';
    end if;
    if v.request_fingerprint <> p_request_fingerprint then
      -- same key, different request: never a new intent, never a replay
      raise exception 'd24_request_fingerprint_mismatch' using errcode = '23505';
    end if;
    if v.status in ('registered', 'failed', 'abandoned') then
      return jsonb_build_object('outcome', 'existing_terminal') || public._d24_intent_json(v);
    end if;
    if v.status = 'needs_review' then
      return jsonb_build_object('outcome', 'needs_review') || public._d24_intent_json(v);
    end if;
    if v.status = 'provider_created' then
      -- the invoice id is recorded: never replay Stripe, only register
      return jsonb_build_object('outcome', 'register_only') || public._d24_intent_json(v);
    end if;
    -- Stripe forgets idempotency keys eventually: past the safe window a replay could create a SECOND invoice.
    if v.status = 'pending' and now() - v.created_at >= public._d24_safe_window() then
      v := public._d24_intent_to_review(v, 'window_expired');
      return jsonb_build_object('outcome', 'needs_review') || public._d24_intent_json(v);
    end if;
    if public._d24_studio_account(p_studio_id) <> v.stripe_account_id then
      raise exception 'd24_account_changed' using errcode = '42501';
    end if;
    update public.hosted_invoice_creation_intents
    set attempt_count = attempt_count + 1, last_attempt_at = now(), updated_at = now() where id = v.id returning * into v;
    perform public._d24_attempt(v.id, v.studio_id, 'begin_replay', null, false);
    return jsonb_build_object('outcome', 'existing') || public._d24_intent_json(v);
  end if;

  v_account := public._d24_studio_account(p_studio_id);
  perform public._d24_check_owner(p_studio_id, p_business_object_type, p_business_object_id);
  if exists (select 1 from public.hosted_invoice_creation_intents
             where studio_id = p_studio_id and business_object_type = p_business_object_type and business_object_id = p_business_object_id
               and status in ('pending', 'provider_created', 'registered', 'needs_review')) then
    raise exception 'd24_object_has_live_intent' using errcode = '23505';
  end if;
  insert into public.hosted_invoice_creation_intents (studio_id, business_object_type, business_object_id, idempotency_key, request_fingerprint, stripe_account_id, created_by)
  values (p_studio_id, p_business_object_type, p_business_object_id, p_idempotency_key, p_request_fingerprint, v_account, p_created_by)
  returning * into v;
  perform public._d24_intent_event(v.id, v.studio_id, 'created', null, 'pending', null);
  perform public._d24_attempt(v.id, v.studio_id, 'begin', null, false);
  return jsonb_build_object('outcome', 'created') || public._d24_intent_json(v);
end $$;

create or replace function public.d24_intent_mark_provider_created(
  p_intent_id uuid, p_studio_id uuid, p_stripe_invoice_id text, p_livemode boolean, p_key_livemode boolean, p_stripe_account_id text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v public.hosted_invoice_creation_intents%rowtype;
begin
  if p_stripe_invoice_id is null or p_livemode is null or p_key_livemode is null then
    raise exception 'd24_intent_mark_provider_created: invoice id, livemode and the key mode are required' using errcode = '22023';
  end if;
  if p_stripe_invoice_id !~ '^in_[A-Za-z0-9]+$' then
    raise exception 'd24_intent_mark_provider_created: malformed invoice id' using errcode = '22023';
  end if;
  perform set_config('d24.writer', 'on', true);
  v := public._d24_intent_lock(p_intent_id, p_studio_id);
  if p_livemode <> p_key_livemode then
    raise exception 'd24_livemode_mismatch' using errcode = '42501';
  end if;
  if p_stripe_account_id is not null and p_stripe_account_id is distinct from v.stripe_account_id then
    raise exception 'd24_account_mismatch' using errcode = '42501';
  end if;
  if v.status in ('provider_created', 'registered') then
    if v.stripe_invoice_id = p_stripe_invoice_id and v.livemode = p_livemode then
      return jsonb_build_object('outcome', 'already_recorded') || public._d24_intent_json(v);
    end if;
    raise exception 'd24_intent_invoice_conflict' using errcode = '23505';
  end if;
  if v.status = 'needs_review' then
    -- a late response (the intent was flagged / expired while the call was in flight): RECORD the invoice id so an operator is forced to attach it
    -- (abandon is refused once an invoice id is recorded); the intent stays in needs_review.
    if v.stripe_invoice_id is not null then
      raise exception 'd24_intent_invoice_conflict' using errcode = '23505';
    end if;
    update public.hosted_invoice_creation_intents
    set stripe_invoice_id = p_stripe_invoice_id, livemode = p_livemode, provider_created_at = now(), outcome_unknown = false, updated_at = now()
    where id = v.id returning * into v;
    perform public._d24_intent_event(v.id, v.studio_id, 'provider_created', 'needs_review', 'needs_review', null);
    return jsonb_build_object('outcome', 'recorded_in_review') || public._d24_intent_json(v);
  end if;
  if v.status <> 'pending' then
    raise exception 'd24_intent_state' using errcode = '55000';
  end if;
  if now() - v.created_at >= public._d24_safe_window() then
    -- a replay past the safe window may have produced a DUPLICATE: record the id as evidence but fail closed
    update public.hosted_invoice_creation_intents
    set status = 'needs_review', review_reason = 'window_expired_provider', stripe_invoice_id = p_stripe_invoice_id, livemode = p_livemode,
        provider_created_at = now(), outcome_unknown = false, recovery_lease_id = null, recovery_lease_expires_at = null, updated_at = now()
    where id = v.id returning * into v;
    perform public._d24_intent_event(v.id, v.studio_id, 'needs_review', 'pending', 'needs_review', 'window_expired_provider');
    return jsonb_build_object('outcome', 'needs_review') || public._d24_intent_json(v);
  end if;
  -- No studio-account re-check here on purpose: the invoice already exists at Stripe under the intent's own account. Refusing to record it after a
  -- reconnect would orphan it. d24_intent_register re-checks the binding and moves the intent to needs_review if it no longer holds.
  update public.hosted_invoice_creation_intents
  set status = 'provider_created', stripe_invoice_id = p_stripe_invoice_id, livemode = p_livemode, provider_created_at = now(), outcome_unknown = false,
      recovery_lease_id = null, recovery_lease_expires_at = null, updated_at = now()
  where id = v.id returning * into v;
  perform public._d24_intent_event(v.id, v.studio_id, 'provider_created', 'pending', 'provider_created', null);
  return jsonb_build_object('outcome', 'provider_created') || public._d24_intent_json(v);
end $$;

-- Registers the recorded provider invoice in the same transaction. An ownership / account / scope MISMATCH moves the intent to needs_review (never registered) and
-- returns outcome 'needs_review'. A transient or unexpected failure raises and rolls back: the intent stays provider_created and recoverable.
create or replace function public.d24_intent_register(p_intent_id uuid, p_studio_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v public.hosted_invoice_creation_intents%rowtype;
  v_res jsonb;
  v_code text;
begin
  perform set_config('d24.writer', 'on', true);
  v := public._d24_intent_lock(p_intent_id, p_studio_id);
  if v.status = 'registered' then
    return jsonb_build_object('outcome', 'already_registered') || public._d24_intent_json(v);
  end if;
  if v.status <> 'provider_created' then
    raise exception 'd24_intent_state' using errcode = '55000';
  end if;
  begin
    if public._d24_studio_account(v.studio_id) <> v.stripe_account_id then
      raise exception 'd24_account_changed' using errcode = '42501';
    end if;
    perform public._d24_check_owner(v.studio_id, v.business_object_type, v.business_object_id);
    v_res := public.d24_register_invoice(v.studio_id, v.stripe_account_id, v.stripe_invoice_id, v.livemode,
                                         v.business_object_type, v.business_object_id, v.created_by);
  exception when sqlstate '42501' or sqlstate '23505' or sqlstate '22023' then
    -- ONLY the deliberate d24_* refusals are mismatches; a trigger/permission/other error is a real bug: re-raise so the intent stays provider_created and retryable
    if sqlerrm !~ '^d24_[a-z0-9_]{1,60}$' then
      raise;
    end if;
    -- mismatch / refusal: fail closed. The subtransaction's writes are gone; record the review state.
    v_code := case when sqlerrm ~ '^d24_[a-z0-9_]{1,60}$' then substr(sqlerrm, 5) else 'registration_refused' end;
    perform set_config('d24.writer', 'on', true);
    v := public._d24_intent_to_review(v, v_code);
    return jsonb_build_object('outcome', 'needs_review') || public._d24_intent_json(v);
  end;
  update public.hosted_invoice_creation_intents
  set status = 'registered', registry_id = (v_res->>'registry_id')::uuid, registered_at = now(), settled_at = now(), updated_at = now()
  where id = v.id returning * into v;
  perform public._d24_intent_event(v.id, v.studio_id, 'registered', 'provider_created', 'registered', null);
  return jsonb_build_object('outcome', 'registered', 'adopted_existing_facts', coalesce((v_res->>'adopted_existing_facts')::boolean, false)) || public._d24_intent_json(v);
end $$;

create or replace function public.d24_intent_fail(p_intent_id uuid, p_studio_id uuid, p_error_code text, p_permanent boolean default false)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v public.hosted_invoice_creation_intents%rowtype;
  v_code text := public._d24_clean_code(p_error_code);
  v_from text;
begin
  perform set_config('d24.writer', 'on', true);
  v := public._d24_intent_lock(p_intent_id, p_studio_id);
  if v.status in ('registered', 'failed', 'abandoned') then
    return jsonb_build_object('outcome', 'noop_terminal') || public._d24_intent_json(v);
  end if;
  if v.status = 'needs_review' then
    return jsonb_build_object('outcome', 'needs_review') || public._d24_intent_json(v);
  end if;
  v_from := v.status;
  if coalesce(p_permanent, false) then
    -- failing an intent frees its object for another invoice: never when an invoice may exist
    if v.outcome_unknown then
      raise exception 'd24_intent_outcome_unknown' using errcode = '55000';
    end if;
    if v.stripe_invoice_id is not null then
      raise exception 'd24_intent_has_invoice' using errcode = '55000';
    end if;
    update public.hosted_invoice_creation_intents
    set status = 'failed', failure_count = failure_count + 1, last_error_code = v_code, last_attempt_at = now(), updated_at = now(), settled_at = now(),
        recovery_lease_id = null, recovery_lease_expires_at = null
    where id = v.id returning * into v;
    perform public._d24_attempt(v.id, v.studio_id, 'failure', v_code, false);
    perform public._d24_intent_event(v.id, v.studio_id, 'failed', v_from, 'failed', v_code);
    return jsonb_build_object('outcome', 'failed') || public._d24_intent_json(v);
  end if;
  update public.hosted_invoice_creation_intents
  set failure_count = failure_count + 1, last_error_code = v_code, last_attempt_at = now(), updated_at = now()
  where id = v.id returning * into v;
  perform public._d24_attempt(v.id, v.studio_id, 'failure', v_code, false);
  perform public._d24_intent_event(v.id, v.studio_id, 'failure_recorded', v_from, v_from, v_code);
  return jsonb_build_object('outcome', 'recorded') || public._d24_intent_json(v);
end $$;

-- Record how a Stripe call ended. p_outcome_unknown = TRUE for a timeout / dropped connection / any ambiguous end: the invoice MAY exist.
-- The flag is sticky until the invoice id is recorded. It blocks a permanent fail; recovery stays inside the safe-retry window with the SAME key only.
create or replace function public.d24_intent_record_outcome(p_intent_id uuid, p_studio_id uuid, p_outcome_code text, p_outcome_unknown boolean default false)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v public.hosted_invoice_creation_intents%rowtype;
  v_code text := public._d24_clean_code(p_outcome_code);
begin
  perform set_config('d24.writer', 'on', true);
  v := public._d24_intent_lock(p_intent_id, p_studio_id);
  if v.status not in ('pending', 'provider_created') then
    return jsonb_build_object('outcome', 'noop_' || v.status) || public._d24_intent_json(v);
  end if;
  update public.hosted_invoice_creation_intents
  set outcome_unknown = outcome_unknown or coalesce(p_outcome_unknown, false), last_error_code = v_code, last_attempt_at = now(), updated_at = now(),
      recovery_lease_id = null, recovery_lease_expires_at = null
  where id = v.id returning * into v;
  perform public._d24_attempt(v.id, v.studio_id, 'outcome', v_code, p_outcome_unknown);
  return jsonb_build_object('outcome', 'recorded') || public._d24_intent_json(v);
end $$;

-- Recovery worker entry point: row lock + short LEASE so two workers cannot both replay the same intent.
-- Returns replay_permitted = TRUE only for a pending intent that is inside the safe-retry window, whose fingerprint matches, whose studio account is unchanged and that
-- holds no other worker's live lease. Everything ambiguous moves the intent to needs_review. NEVER creates a new key or intent; never finalizes, sends or collects.
create or replace function public.d24_intent_claim_recovery(p_intent_id uuid, p_studio_id uuid, p_request_fingerprint text, p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v public.hosted_invoice_creation_intents%rowtype;
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 120), 10), 900);
  v_account text;
begin
  if p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'd24_intent_claim_recovery: a request fingerprint is required' using errcode = '22023';
  end if;
  perform set_config('d24.writer', 'on', true);
  v := public._d24_intent_lock(p_intent_id, p_studio_id);
  if v.status in ('registered', 'failed', 'abandoned') then
    return jsonb_build_object('outcome', 'terminal', 'replay_permitted', false) || public._d24_intent_json(v);
  end if;
  if v.status = 'needs_review' then
    return jsonb_build_object('outcome', 'needs_review', 'replay_permitted', false) || public._d24_intent_json(v);
  end if;
  if v.status = 'provider_created' then
    -- the invoice is recorded: no Stripe replay at all, just d24_intent_register
    return jsonb_build_object('outcome', 'register_only', 'replay_permitted', false) || public._d24_intent_json(v);
  end if;
  if v.request_fingerprint <> p_request_fingerprint then
    v := public._d24_intent_to_review(v, 'fingerprint_mismatch');
    return jsonb_build_object('outcome', 'needs_review', 'replay_permitted', false) || public._d24_intent_json(v);
  end if;
  if now() - v.created_at >= public._d24_safe_window() then
    v := public._d24_intent_to_review(v, 'window_expired');
    return jsonb_build_object('outcome', 'needs_review', 'replay_permitted', false) || public._d24_intent_json(v);
  end if;
  begin
    v_account := public._d24_studio_account(v.studio_id);
  exception when sqlstate '42501' then
    v_account := null;
  end;
  if v_account is distinct from v.stripe_account_id then
    v := public._d24_intent_to_review(v, 'account_changed');
    return jsonb_build_object('outcome', 'needs_review', 'replay_permitted', false) || public._d24_intent_json(v);
  end if;
  if v.recovery_lease_expires_at is not null and v.recovery_lease_expires_at > now() then
    return jsonb_build_object('outcome', 'lease_held', 'replay_permitted', false) || public._d24_intent_json(v);
  end if;
  update public.hosted_invoice_creation_intents
  set recovery_lease_id = gen_random_uuid(), recovery_lease_expires_at = now() + make_interval(secs => v_lease),
      attempt_count = attempt_count + 1, last_attempt_at = now(), updated_at = now()
  where id = v.id returning * into v;
  perform public._d24_attempt(v.id, v.studio_id, 'recovery_replay', null, v.outcome_unknown);
  return jsonb_build_object('outcome', 'replay_permitted', 'replay_permitted', true, 'lease_id', v.recovery_lease_id, 'lease_expires_at', v.recovery_lease_expires_at)
         || public._d24_intent_json(v);
end $$;

-- Any ambiguity found by the application moves a pending / provider_created intent to needs_review. Idempotent.
create or replace function public.d24_intent_flag_review(p_intent_id uuid, p_studio_id uuid, p_reason_code text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v public.hosted_invoice_creation_intents%rowtype;
begin
  perform set_config('d24.writer', 'on', true);
  v := public._d24_intent_lock(p_intent_id, p_studio_id);
  if v.status in ('registered', 'failed', 'abandoned') then
    return jsonb_build_object('outcome', 'noop_terminal') || public._d24_intent_json(v);
  end if;
  v := public._d24_intent_to_review(v, coalesce(p_reason_code, 'ambiguous'));
  return jsonb_build_object('outcome', 'needs_review') || public._d24_intent_json(v);
end $$;

create or replace function public.d24_intent_list_recoverable(p_older_than_minutes integer default 15, p_limit integer default 50, p_studio_id uuid default null)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(jsonb_agg(public._d24_intent_json(r) order by r.created_at, r.id), '[]'::jsonb)
  from (
    select * from public.hosted_invoice_creation_intents
    where status in ('pending', 'provider_created')
      and updated_at <= now() - make_interval(mins => greatest(coalesce(p_older_than_minutes, 15), 1))
      and (p_studio_id is null or studio_id = p_studio_id)
    order by created_at, id
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
  ) r
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- (3) Verified-operator reconciliation (M2-B pattern: auth.uid(), platform_admin at AAL2, DB switch, mandatory reason, audit)
-- ---------------------------------------------------------------------------------------------------------------------

create or replace function public.d24_op_flag_creation_review(p_intent_id uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := public._d24_op_caller();
  v_reason text := public._d24_op_reason(p_reason);
  v public.hosted_invoice_creation_intents%rowtype;
begin
  if not public._d24_op_is_platform_admin(v_uid) then
    raise exception 'd24_op_platform_admin_required' using errcode = '42501';
  end if;
  if p_intent_id is null then raise exception 'd24_op_flag_creation_review: intent is required' using errcode = '22023'; end if;
  perform set_config('d24.writer', 'on', true);
  select * into v from public.hosted_invoice_creation_intents where id = p_intent_id for update;
  if not found then raise exception 'd24_intent_not_found' using errcode = 'P0002'; end if;
  if v.status = 'needs_review' then
    return jsonb_build_object('outcome', 'already_in_review') || public._d24_intent_json(v);
  end if;
  if v.status not in ('pending', 'provider_created') then
    raise exception 'd24_intent_state' using errcode = '55000';
  end if;
  v := public._d24_intent_to_review(v, 'operator_flagged', v_uid, v_reason);
  return jsonb_build_object('outcome', 'needs_review') || public._d24_intent_json(v);
end $$;

-- Attach TRUSTWORTHY Stripe evidence: the operator found this invoice in the studio's connected account. The database validates the account scope, livemode, studio
-- binding, id format, that the invoice is not registered elsewhere, and the business-object ownership; then registers it and moves needs_review -> registered.
-- Metadata alone never establishes ownership (this function never reads Stripe metadata). Any failed validation leaves the intent in needs_review.
create or replace function public.d24_op_attach_creation_invoice(p_intent_id uuid, p_stripe_invoice_id text, p_livemode boolean, p_stripe_account_id text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := public._d24_op_caller();
  v_reason text := public._d24_op_reason(p_reason);
  v public.hosted_invoice_creation_intents%rowtype;
  v_res jsonb;
begin
  if not public._d24_op_is_platform_admin(v_uid) then
    raise exception 'd24_op_platform_admin_required' using errcode = '42501';
  end if;
  if p_intent_id is null or p_stripe_invoice_id is null or p_livemode is null or p_stripe_account_id is null then
    raise exception 'd24_op_attach_creation_invoice: intent, invoice id, livemode and account are required' using errcode = '22023';
  end if;
  if p_stripe_invoice_id !~ '^in_[A-Za-z0-9]+$' or p_stripe_account_id !~ '^acct_[A-Za-z0-9]+$' then
    raise exception 'd24_op_attach_creation_invoice: malformed invoice or account id' using errcode = '22023';
  end if;
  perform set_config('d24.writer', 'on', true);
  select * into v from public.hosted_invoice_creation_intents where id = p_intent_id for update;
  if not found then raise exception 'd24_intent_not_found' using errcode = 'P0002'; end if;
  if v.status <> 'needs_review' then
    raise exception 'd24_intent_state' using errcode = '55000';
  end if;
  if p_stripe_account_id <> v.stripe_account_id then
    raise exception 'd24_account_mismatch' using errcode = '42501';
  end if;
  if v.stripe_invoice_id is not null and v.stripe_invoice_id <> p_stripe_invoice_id then
    raise exception 'd24_intent_invoice_conflict' using errcode = '23505';
  end if;
  if public._d24_studio_account(v.studio_id) <> v.stripe_account_id then
    raise exception 'd24_account_changed' using errcode = '42501';
  end if;
  -- webhook facts already recorded for this invoice must agree on livemode and must not belong to another studio
  if exists (select 1 from public.hosted_invoices h where h.account_key = p_stripe_account_id and h.stripe_invoice_id = p_stripe_invoice_id
             and (h.livemode <> p_livemode or (h.studio_id is not null and h.studio_id <> v.studio_id))) then
    raise exception 'd24_livemode_mismatch' using errcode = '42501';
  end if;
  perform public._d24_check_owner(v.studio_id, v.business_object_type, v.business_object_id);
  v_res := public.d24_register_invoice(v.studio_id, v.stripe_account_id, p_stripe_invoice_id, p_livemode, v.business_object_type, v.business_object_id, v.created_by);
  update public.hosted_invoice_creation_intents
  set status = 'registered', stripe_invoice_id = p_stripe_invoice_id, livemode = p_livemode, provider_created_at = coalesce(provider_created_at, now()),
      registry_id = (v_res->>'registry_id')::uuid, registered_at = now(), settled_at = now(), outcome_unknown = false, updated_at = now()
  where id = v.id returning * into v;
  perform public._d24_intent_event(v.id, v.studio_id, 'operator_attached', 'needs_review', 'registered', null, v_uid, v_reason);
  return jsonb_build_object('outcome', 'registered', 'adopted_existing_facts', coalesce((v_res->>'adopted_existing_facts')::boolean, false)) || public._d24_intent_json(v);
end $$;

-- The operator has established that NO invoice exists (or voided it out of band): release the object. Refused while an invoice id is recorded.
create or replace function public.d24_op_abandon_creation(p_intent_id uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := public._d24_op_caller();
  v_reason text := public._d24_op_reason(p_reason);
  v public.hosted_invoice_creation_intents%rowtype;
begin
  if not public._d24_op_is_platform_admin(v_uid) then
    raise exception 'd24_op_platform_admin_required' using errcode = '42501';
  end if;
  if p_intent_id is null then raise exception 'd24_op_abandon_creation: intent is required' using errcode = '22023'; end if;
  perform set_config('d24.writer', 'on', true);
  select * into v from public.hosted_invoice_creation_intents where id = p_intent_id for update;
  if not found then raise exception 'd24_intent_not_found' using errcode = 'P0002'; end if;
  if v.status <> 'needs_review' then
    raise exception 'd24_intent_state' using errcode = '55000';
  end if;
  if v.stripe_invoice_id is not null then
    raise exception 'd24_intent_has_invoice: attach the recorded invoice instead' using errcode = '55000';
  end if;
  update public.hosted_invoice_creation_intents
  set status = 'abandoned', last_error_code = 'operator_abandoned', updated_at = now(), settled_at = now(), recovery_lease_id = null, recovery_lease_expires_at = null
  where id = v.id returning * into v;
  perform public._d24_intent_event(v.id, v.studio_id, 'operator_abandoned', 'needs_review', 'abandoned', 'operator_abandoned', v_uid, v_reason);
  return jsonb_build_object('outcome', 'abandoned') || public._d24_intent_json(v);
end $$;

create or replace function public.d24_op_list_creation_reviews(p_limit integer default 50)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := public._d24_op_caller();
begin
  if not public._d24_op_is_platform_admin(v_uid) then
    raise exception 'd24_op_platform_admin_required' using errcode = '42501';
  end if;
  return (select coalesce(jsonb_agg(public._d24_intent_json(r) order by r.updated_at, r.id), '[]'::jsonb)
          from (select * from public.hosted_invoice_creation_intents where status = 'needs_review'
                order by updated_at, id limit least(greatest(coalesce(p_limit, 50), 1), 200)) r);
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Grants: service_role only for the intent functions; authenticated (verified-operator checks inside) for d24_op_*; helpers are not callable by any API role.
-- ---------------------------------------------------------------------------------------------------------------------

revoke all on function public._d24_intent_guard() from public, anon, authenticated, service_role;
revoke all on function public._d24_creation_config_guard() from public, anon, authenticated, service_role;
revoke all on function public._d24_bot_guard() from public, anon, authenticated, service_role;
revoke all on function public.d24_register_business_object_type(text, regprocedure) from public, anon, authenticated, service_role;
revoke all on function public.d24_intent_set_window(integer) from public, anon, authenticated, service_role;
revoke all on function public._d24_studio_account(uuid) from public, anon, authenticated, service_role;
revoke all on function public._d24_safe_window() from public, anon, authenticated, service_role;
revoke all on function public._d24_check_owner(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public._d24_intent_json(public.hosted_invoice_creation_intents) from public, anon, authenticated, service_role;
revoke all on function public._d24_intent_event(uuid, uuid, text, text, text, text, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public._d24_attempt(uuid, uuid, text, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public._d24_clean_code(text) from public, anon, authenticated, service_role;
revoke all on function public._d24_intent_lock(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public._d24_intent_to_review(public.hosted_invoice_creation_intents, text, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.d24_intent_begin(uuid, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.d24_intent_mark_provider_created(uuid, uuid, text, boolean, boolean, text) from public, anon, authenticated;
revoke all on function public.d24_intent_register(uuid, uuid) from public, anon, authenticated;
revoke all on function public.d24_intent_fail(uuid, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.d24_intent_record_outcome(uuid, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.d24_intent_claim_recovery(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.d24_intent_flag_review(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.d24_intent_list_recoverable(integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.d24_intent_begin(uuid, text, text, text, text, uuid) to service_role;
grant execute on function public.d24_intent_mark_provider_created(uuid, uuid, text, boolean, boolean, text) to service_role;
grant execute on function public.d24_intent_register(uuid, uuid) to service_role;
grant execute on function public.d24_intent_fail(uuid, uuid, text, boolean) to service_role;
grant execute on function public.d24_intent_record_outcome(uuid, uuid, text, boolean) to service_role;
grant execute on function public.d24_intent_claim_recovery(uuid, uuid, text, integer) to service_role;
grant execute on function public.d24_intent_flag_review(uuid, uuid, text) to service_role;
grant execute on function public.d24_intent_list_recoverable(integer, integer, uuid) to service_role;
revoke all on function public.d24_op_flag_creation_review(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.d24_op_attach_creation_invoice(uuid, text, boolean, text, text) from public, anon, authenticated, service_role;
revoke all on function public.d24_op_abandon_creation(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.d24_op_list_creation_reviews(integer) from public, anon, authenticated, service_role;
grant execute on function public.d24_op_flag_creation_review(uuid, text) to authenticated;
grant execute on function public.d24_op_attach_creation_invoice(uuid, text, boolean, text, text) to authenticated;
grant execute on function public.d24_op_abandon_creation(uuid, text) to authenticated;
grant execute on function public.d24_op_list_creation_reviews(integer) to authenticated;

commit;
