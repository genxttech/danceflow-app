-- 20270208090000_d24_m3a_intent_ledger.sql
-- D24 M3-A: SQL foundation for trusted hosted-invoice creation + registration. NOT APPLIED to any shared environment by this file. Dark: nothing calls it.
--   1. d24_register_invoice hardened (M2-A release blockers): invoice-id-alone advisory lock, refusal of an invoice id registered under any other account scope,
--      and the Stripe account resolved INSIDE the function from studios.stripe_connected_account_id (NULL / malformed / platform refused; a supplied account is only an assertion).
--      The signature is unchanged so existing grants and callers still bind.
--   2. Durable creation-intent ledger written BEFORE any provider call: hosted_invoice_creation_intents (+ append-only hosted_invoice_creation_intent_events).
--   3. hosted_invoice_business_object_types: per-type ownership functions, EMPTY by default; begin/register fail closed for unregistered types.
--   4. Service-role-only SECURITY DEFINER functions: d24_intent_begin / _mark_provider_created / _register / _fail / _abandon / _list_recoverable.
-- Creation and registration never infer settlement: nothing here writes payments, credit notes, transitions or any paid state.
-- Contract: docs/billing/D24-M3A-FOUNDATION.md. Requires 20270203110000 (M1) and public.studios(stripe_connected_account_id).
-- Rollback: rollback/20270208090000_d24_m3a_intent_ledger_rollback.sql (restores the M1 d24_register_invoice verbatim).

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.d24_register_invoice(uuid,text,text,boolean,text,text,uuid)') is null then
    raise exception 'd24 m3a precondition failed: 20270203110000 (M1) must be applied first';
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

create table public.hosted_invoice_creation_intents (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  business_object_type text not null,
  business_object_id text not null,
  idempotency_key text not null,
  status text not null default 'pending',
  stripe_account_id text not null,              -- resolved from the studio at begin, never supplied
  stripe_invoice_id text,
  livemode boolean,
  registry_id uuid references public.hosted_invoice_registry(id) on delete restrict,
  created_by uuid,
  attempt_count integer not null default 1,
  failure_count integer not null default 0,
  last_error_code text,
  last_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  provider_created_at timestamptz,
  registered_at timestamptz,
  settled_at timestamptz,                       -- set when the intent reaches a terminal status
  constraint hosted_invoice_intents_status_chk check (status in ('pending', 'provider_created', 'registered', 'failed', 'abandoned')),
  constraint hosted_invoice_intents_type_chk check (business_object_type ~ '^[a-z][a-z0-9_]{0,62}$' and business_object_type !~* 'subscription'),
  constraint hosted_invoice_intents_object_chk check (business_object_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  constraint hosted_invoice_intents_key_chk check (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,200}$'),
  constraint hosted_invoice_intents_account_chk check (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  constraint hosted_invoice_intents_invoice_chk check (stripe_invoice_id is null or stripe_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  constraint hosted_invoice_intents_error_chk check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
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
create unique index hosted_invoice_intents_live_object_uq on public.hosted_invoice_creation_intents (studio_id, business_object_type, business_object_id)
  where status in ('pending', 'provider_created', 'registered');
create index hosted_invoice_registry_invoice_idx on public.hosted_invoice_registry (stripe_invoice_id);   -- invoice-id-alone scope check in d24_register_invoice
create index hosted_invoice_intents_recover_idx on public.hosted_invoice_creation_intents (updated_at, id) where status in ('pending', 'provider_created');

create table public.hosted_invoice_creation_intent_events (
  id bigint generated always as identity primary key,
  intent_id uuid not null,
  studio_id uuid not null,
  event_kind text not null,
  from_status text,
  to_status text not null,
  error_code text,
  created_at timestamptz not null default now(),
  constraint hosted_invoice_intent_events_fk foreign key (intent_id, studio_id) references public.hosted_invoice_creation_intents (id, studio_id) on delete restrict,
  constraint hosted_invoice_intent_events_kind_chk check (event_kind in ('created', 'provider_created', 'registered', 'failure_recorded', 'failed', 'abandoned')),
  constraint hosted_invoice_intent_events_error_chk check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,63}$')
);
create index hosted_invoice_intent_events_intent_idx on public.hosted_invoice_creation_intent_events (intent_id, id);

do $$
declare t text;
begin
  foreach t in array array['hosted_invoice_business_object_types', 'hosted_invoice_creation_intents', 'hosted_invoice_creation_intent_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to service_role', t);
  end loop;
end $$;

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
     or new.idempotency_key is distinct from old.idempotency_key or new.stripe_account_id is distinct from old.stripe_account_id
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'd24: intent identity columns are immutable' using errcode = '42501';
  end if;
  if old.stripe_invoice_id is not null and (new.stripe_invoice_id is distinct from old.stripe_invoice_id or new.livemode is distinct from old.livemode) then
    raise exception 'd24: a recorded provider invoice cannot change' using errcode = '42501';
  end if;
  if new.attempt_count < old.attempt_count or new.failure_count < old.failure_count then
    raise exception 'd24: intent counters cannot decrease' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    if not ((old.status = 'pending' and new.status in ('provider_created', 'failed', 'abandoned'))
         or (old.status = 'provider_created' and new.status in ('registered', 'failed'))) then
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

-- Owner-only helper (no grant to any API role): register the ownership function of a business-object type.
create or replace function public.d24_register_business_object_type(p_type text, p_owner_function regprocedure)
returns void language sql
set search_path = pg_catalog, public, pg_temp
as $$ insert into public.hosted_invoice_business_object_types (business_object_type, owner_function) values (p_type, p_owner_function) $$;

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
returns jsonb language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object('intent_id', r.id, 'studio_id', r.studio_id, 'status', r.status, 'business_object_type', r.business_object_type,
    'business_object_id', r.business_object_id, 'idempotency_key', r.idempotency_key, 'stripe_account_id', r.stripe_account_id,
    'stripe_invoice_id', r.stripe_invoice_id, 'livemode', r.livemode, 'registry_id', r.registry_id, 'attempt_count', r.attempt_count,
    'failure_count', r.failure_count, 'last_error_code', r.last_error_code, 'created_at', r.created_at, 'updated_at', r.updated_at)
$$;

create or replace function public._d24_intent_event(p_intent_id uuid, p_studio_id uuid, p_kind text, p_from text, p_to text, p_code text)
returns void language sql
set search_path = pg_catalog, public, pg_temp
as $$
  insert into public.hosted_invoice_creation_intent_events (intent_id, studio_id, event_kind, from_status, to_status, error_code)
  values (p_intent_id, p_studio_id, p_kind, p_from, p_to, p_code)
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
-- (2) Intent functions
-- ---------------------------------------------------------------------------------------------------------------------

create or replace function public.d24_intent_begin(
  p_studio_id uuid, p_business_object_type text, p_business_object_id text, p_idempotency_key text, p_created_by uuid default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v public.hosted_invoice_creation_intents%rowtype;
  v_account text;
begin
  if p_studio_id is null or p_business_object_type is null or p_business_object_id is null or p_idempotency_key is null then
    raise exception 'd24_intent_begin: studio, business object and idempotency key are required' using errcode = '22023';
  end if;
  if p_business_object_type !~ '^[a-z][a-z0-9_]{0,62}$' or p_business_object_type ~* 'subscription'
     or p_business_object_id !~ '^[A-Za-z0-9_.:-]{1,128}$' or p_idempotency_key !~ '^[A-Za-z0-9_.:-]{8,200}$' then
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
    if v.status in ('registered', 'failed', 'abandoned') then
      return jsonb_build_object('outcome', 'existing_terminal') || public._d24_intent_json(v);
    end if;
    -- Stripe forgets idempotency keys after ~24h: a reused key could then create a SECOND invoice. Reconcile with Stripe first.
    if v.status = 'pending' and v.created_at < now() - interval '23 hours' then
      return jsonb_build_object('outcome', 'stale_key') || public._d24_intent_json(v);
    end if;
    if v.status in ('pending', 'provider_created') then
      if public._d24_studio_account(p_studio_id) <> v.stripe_account_id then
        raise exception 'd24_account_changed' using errcode = '42501';
      end if;
      update public.hosted_invoice_creation_intents
      set attempt_count = attempt_count + 1, last_attempt_at = now(), updated_at = now() where id = v.id returning * into v;
    end if;
    return jsonb_build_object('outcome', 'existing') || public._d24_intent_json(v);
  end if;

  v_account := public._d24_studio_account(p_studio_id);
  perform public._d24_check_owner(p_studio_id, p_business_object_type, p_business_object_id);
  if exists (select 1 from public.hosted_invoice_creation_intents
             where studio_id = p_studio_id and business_object_type = p_business_object_type and business_object_id = p_business_object_id
               and status in ('pending', 'provider_created', 'registered')) then
    raise exception 'd24_object_has_live_intent' using errcode = '23505';
  end if;
  insert into public.hosted_invoice_creation_intents (studio_id, business_object_type, business_object_id, idempotency_key, stripe_account_id, created_by)
  values (p_studio_id, p_business_object_type, p_business_object_id, p_idempotency_key, v_account, p_created_by)
  returning * into v;
  perform public._d24_intent_event(v.id, v.studio_id, 'created', null, 'pending', null);
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
  if v.status <> 'pending' then
    raise exception 'd24_intent_state' using errcode = '55000';
  end if;
  -- No studio-account re-check here on purpose: the invoice already exists at Stripe under the intent's own account. Refusing to record it after a
  -- reconnect would orphan it. d24_intent_register re-checks the binding and refuses until an operator resolves it.
  update public.hosted_invoice_creation_intents
  set status = 'provider_created', stripe_invoice_id = p_stripe_invoice_id, livemode = p_livemode, provider_created_at = now(), updated_at = now()
  where id = v.id returning * into v;
  perform public._d24_intent_event(v.id, v.studio_id, 'provider_created', 'pending', 'provider_created', null);
  return jsonb_build_object('outcome', 'provider_created') || public._d24_intent_json(v);
end $$;

create or replace function public.d24_intent_register(p_intent_id uuid, p_studio_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v public.hosted_invoice_creation_intents%rowtype;
  v_res jsonb;
begin
  perform set_config('d24.writer', 'on', true);
  v := public._d24_intent_lock(p_intent_id, p_studio_id);
  if v.status = 'registered' then
    return jsonb_build_object('outcome', 'already_registered') || public._d24_intent_json(v);
  end if;
  if v.status <> 'provider_created' then
    raise exception 'd24_intent_state' using errcode = '55000';
  end if;
  if public._d24_studio_account(v.studio_id) <> v.stripe_account_id then
    raise exception 'd24_account_changed' using errcode = '42501';
  end if;
  perform public._d24_check_owner(v.studio_id, v.business_object_type, v.business_object_id);
  v_res := public.d24_register_invoice(v.studio_id, v.stripe_account_id, v.stripe_invoice_id, v.livemode,
                                       v.business_object_type, v.business_object_id, v.created_by);
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
  v_from := v.status;
  if coalesce(p_permanent, false) then
    -- failing a provider_created intent whose invoice is already registered would free the live-object slot for a duplicate invoice
    if v.stripe_invoice_id is not null and exists (select 1 from public.hosted_invoice_registry where stripe_account_id = v.stripe_account_id and stripe_invoice_id = v.stripe_invoice_id) then
      raise exception 'd24_intent_registered_elsewhere' using errcode = '55000';
    end if;
    update public.hosted_invoice_creation_intents
    set status = 'failed', failure_count = failure_count + 1, last_error_code = v_code, last_attempt_at = now(), updated_at = now(), settled_at = now()
    where id = v.id returning * into v;
    perform public._d24_intent_event(v.id, v.studio_id, 'failed', v_from, 'failed', v_code);
    return jsonb_build_object('outcome', 'failed') || public._d24_intent_json(v);
  end if;
  update public.hosted_invoice_creation_intents
  set failure_count = failure_count + 1, last_error_code = v_code, last_attempt_at = now(), updated_at = now()
  where id = v.id returning * into v;
  perform public._d24_intent_event(v.id, v.studio_id, 'failure_recorded', v_from, v_from, v_code);
  return jsonb_build_object('outcome', 'recorded') || public._d24_intent_json(v);
end $$;

create or replace function public.d24_intent_abandon(
  p_intent_id uuid, p_studio_id uuid, p_error_code text default 'abandoned', p_min_age_minutes integer default 1500)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v public.hosted_invoice_creation_intents%rowtype;
  v_code text := public._d24_clean_code(p_error_code);
begin
  perform set_config('d24.writer', 'on', true);
  v := public._d24_intent_lock(p_intent_id, p_studio_id);
  if v.status <> 'pending' then
    raise exception 'd24_intent_state' using errcode = '55000';
  end if;
  -- A pending intent may hide a Stripe invoice (call succeeded, mark never ran). Within Stripe's idempotency window a same-key retry still finds it, so
  -- abandoning (which frees the object for a NEW invoice) is only allowed once that window has passed (floor 25h); older needs out-of-band reconciliation.
  if v.updated_at > now() - make_interval(mins => greatest(coalesce(p_min_age_minutes, 1500), 1500)) then
    raise exception 'd24_intent_too_recent' using errcode = '55000';
  end if;
  update public.hosted_invoice_creation_intents
  set status = 'abandoned', last_error_code = v_code, updated_at = now(), settled_at = now()
  where id = v.id returning * into v;
  perform public._d24_intent_event(v.id, v.studio_id, 'abandoned', 'pending', 'abandoned', v_code);
  return jsonb_build_object('outcome', 'abandoned') || public._d24_intent_json(v);
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
-- Grants: service_role only; helpers and the type registrar are not callable by any API role.
-- ---------------------------------------------------------------------------------------------------------------------

revoke all on function public._d24_intent_guard() from public, anon, authenticated, service_role;
revoke all on function public._d24_bot_guard() from public, anon, authenticated, service_role;
revoke all on function public.d24_register_business_object_type(text, regprocedure) from public, anon, authenticated, service_role;
revoke all on function public._d24_studio_account(uuid) from public, anon, authenticated, service_role;
revoke all on function public._d24_check_owner(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public._d24_intent_json(public.hosted_invoice_creation_intents) from public, anon, authenticated, service_role;
revoke all on function public._d24_intent_event(uuid, uuid, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public._d24_clean_code(text) from public, anon, authenticated, service_role;
revoke all on function public._d24_intent_lock(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.d24_intent_begin(uuid, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.d24_intent_mark_provider_created(uuid, uuid, text, boolean, boolean, text) from public, anon, authenticated;
revoke all on function public.d24_intent_register(uuid, uuid) from public, anon, authenticated;
revoke all on function public.d24_intent_fail(uuid, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.d24_intent_abandon(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.d24_intent_list_recoverable(integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.d24_intent_begin(uuid, text, text, text, uuid) to service_role;
grant execute on function public.d24_intent_mark_provider_created(uuid, uuid, text, boolean, boolean, text) to service_role;
grant execute on function public.d24_intent_register(uuid, uuid) to service_role;
grant execute on function public.d24_intent_fail(uuid, uuid, text, boolean) to service_role;
grant execute on function public.d24_intent_abandon(uuid, uuid, text, integer) to service_role;
grant execute on function public.d24_intent_list_recoverable(integer, integer, uuid) to service_role;

commit;
