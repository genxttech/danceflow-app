-- 20270203090000_d24_hosted_invoice_facts.sql
-- D24 M1: durable, order-safe persistence and ownership foundation for Stripe-hosted invoice facts.
--   * hosted_invoice_registry     trusted DanceFlow mapping: (Stripe account scope, invoice id) -> studio + business object. Metadata is never authoritative.
--   * hosted_invoices             one row per (account scope, invoice id) observed. Unmatched invoices are preserved as unmatched facts, never attributed by guesswork.
--   * hosted_invoice_payments     invoice_payment facts keyed by the Stripe invoice-payment id (D-B). No settlement side effects.
--   * hosted_credit_notes         credit-note facts and their invoice relationship (D-D). No credits, refunds or adjustments are created.
--   * hosted_invoice_status_transitions  every void / uncollectible Stripe reported; origin is 'unverified' (D-C); authorization_ref is a nullable
--                                 placeholder for a later authorization workflow that this migration does not create.
--   * hosted_invoice_source_events immutable per-event evidence (sanitized snapshot, never a raw payload).
--   * hosted_invoice_recon_audit  append-only log of every reconciliation-state change and acknowledgement.
--   * hosted_invoice_deferred_events  sanitized events recorded while the app runs in 'defer' mode, applied later and idempotently by d24_drain_deferred.
-- Classification (trusted evidence only): registered (registry match) | subscription (Stripe subscription markers on the invoice, only; tenant-writable tables such as studio_invoices are NOT evidence)
-- | unresolved. Subscription invoices are preserved but leave the attention queue (state out_of_scope). Nothing is ever attributed to a studio except through the registry.
-- Tenant ownership is enforced by the database itself: composite foreign keys tie an invoice to its registry row (id, studio, account scope, invoice id), child rows to their invoice
-- (id, account scope, invoice id), and deferred constraint triggers require child and invoice studio ids to agree at commit, whoever writes.
-- All writes go through SECURITY DEFINER functions that first require the caller to still own the PAY-WH-1 event claim.
-- Service role only: RLS on, no tenant policies, no grants to anon or authenticated. service_role may SELECT; it cannot write the tables directly.
-- Dark: nothing calls these functions until the app flag D24_HOSTED_INVOICE_EVENTS is on. NOT APPLIED to any shared environment by this file.
-- Requires 20261116090000_paywh1_webhook_event_claims.sql (_paywh1_require_event_claim). Rollback: rollback/20270203090000_d24_hosted_invoice_facts_rollback.sql

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studios') is null then
    raise exception 'd24 precondition failed: public.studios is missing';
  end if;
  if to_regprocedure('public._paywh1_require_event_claim(text,uuid)') is null then
    raise exception 'd24 precondition failed: PAY-WH-1 claim functions are missing';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------------------

create table public.hosted_invoice_registry (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  stripe_account_id text,                       -- NULL = platform scope; otherwise the connected account that owns the invoice
  stripe_invoice_id text not null,
  livemode boolean not null,
  business_object_type text not null,
  business_object_id text not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  account_key text generated always as (coalesce(stripe_account_id, '')) stored,
  constraint hosted_invoice_registry_account_fmt check (stripe_account_id is null or stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  constraint hosted_invoice_registry_invoice_fmt check (stripe_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  constraint hosted_invoice_registry_object_type check (length(btrim(business_object_type)) > 0),
  constraint hosted_invoice_registry_object_id check (length(btrim(business_object_id)) > 0)
);
create unique index hosted_invoice_registry_key_uq
  on public.hosted_invoice_registry (coalesce(stripe_account_id, ''), stripe_invoice_id);
create index hosted_invoice_registry_studio_idx on public.hosted_invoice_registry (studio_id);
create unique index hosted_invoice_registry_fk_uq on public.hosted_invoice_registry (id, studio_id, account_key, stripe_invoice_id);

create table public.hosted_invoices (
  id uuid primary key default gen_random_uuid(),
  stripe_account_id text,
  stripe_invoice_id text not null,
  livemode boolean not null,
  studio_id uuid references public.studios(id) on delete restrict,
  registry_id uuid unique references public.hosted_invoice_registry(id) on delete restrict,
  status text,                                  -- NULL = invoice itself not observed yet (a payment or credit note arrived first)
  total bigint,
  amount_due bigint,
  amount_paid bigint,
  amount_remaining bigint,
  currency text,
  last_event_created bigint,
  seen_statuses text[] not null default '{}',
  metadata_ref text,
  metadata_studio text,
  anomaly_codes text[] not null default '{}',
  acknowledged_codes text[] not null default '{}',
  reconciliation_state text not null,
  first_seen_event_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  account_key text generated always as (coalesce(stripe_account_id, '')) stored,
  classification text not null default 'unresolved',
  subscription_evidence boolean not null default false,
  constraint hosted_invoices_account_fmt check (stripe_account_id is null or stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  constraint hosted_invoices_invoice_fmt check (stripe_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  constraint hosted_invoices_status_chk check (status is null or status in ('draft', 'open', 'paid', 'void', 'uncollectible')),
  constraint hosted_invoices_amounts_chk check (
    (status is null) = (total is null and amount_due is null and amount_paid is null and amount_remaining is null and currency is null and last_event_created is null)
    and (total is null or (amount_due >= 0 and amount_paid >= 0 and amount_remaining >= 0))),
  constraint hosted_invoices_currency_fmt check (currency is null or currency ~ '^[a-z]{3}$'),
  constraint hosted_invoices_state_chk check (reconciliation_state in ('unmatched', 'anomalous', 'resolved', 'clear', 'out_of_scope')),
  constraint hosted_invoices_class_chk check (classification in ('registered', 'subscription', 'unresolved')),
  constraint hosted_invoices_class_match check ((classification = 'registered') = (studio_id is not null)),
  constraint hosted_invoices_registry_fk foreign key (registry_id, studio_id, account_key, stripe_invoice_id)
    references public.hosted_invoice_registry (id, studio_id, account_key, stripe_invoice_id) on delete restrict,
  constraint hosted_invoices_match_pair check ((studio_id is null) = (registry_id is null)),
  constraint hosted_invoices_ack_subset check (acknowledged_codes <@ anomaly_codes)
);
create unique index hosted_invoices_key_uq on public.hosted_invoices (coalesce(stripe_account_id, ''), stripe_invoice_id);
create unique index hosted_invoices_child_fk_uq on public.hosted_invoices (id, account_key, stripe_invoice_id);
create index hosted_invoices_studio_idx on public.hosted_invoices (studio_id) where studio_id is not null;
create index hosted_invoices_attention_idx on public.hosted_invoices (reconciliation_state) where reconciliation_state in ('unmatched', 'anomalous');

create table public.hosted_invoice_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_row_id uuid not null references public.hosted_invoices(id) on delete restrict,
  studio_id uuid references public.studios(id) on delete restrict,
  stripe_account_id text,
  stripe_invoice_payment_id text not null,
  stripe_invoice_id text not null,
  status text not null,
  amount_requested bigint not null,
  amount_paid bigint not null,
  currency text not null,
  first_event_id text not null,
  last_event_id text not null,
  account_key text generated always as (coalesce(stripe_account_id, '')) stored,
  conflict boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hosted_invoice_payments_id_fmt check (stripe_invoice_payment_id ~ '^inpay_[A-Za-z0-9]+$'),
  constraint hosted_invoice_payments_status_chk check (status in ('open', 'canceled', 'paid')),
  constraint hosted_invoice_payments_amounts_chk check (amount_requested >= 0 and amount_paid >= 0),
  constraint hosted_invoice_payments_currency_fmt check (currency ~ '^[a-z]{3}$')
);
create unique index hosted_invoice_payments_key_uq on public.hosted_invoice_payments (coalesce(stripe_account_id, ''), stripe_invoice_payment_id);
create index hosted_invoice_payments_invoice_idx on public.hosted_invoice_payments (invoice_row_id);

create table public.hosted_credit_notes (
  id uuid primary key default gen_random_uuid(),
  invoice_row_id uuid not null references public.hosted_invoices(id) on delete restrict,
  studio_id uuid references public.studios(id) on delete restrict,
  stripe_account_id text,
  stripe_credit_note_id text not null,
  stripe_invoice_id text not null,
  status text not null,
  credit_note_type text,
  amount bigint not null,
  currency text not null,
  first_event_id text not null,
  last_event_id text not null,
  account_key text generated always as (coalesce(stripe_account_id, '')) stored,
  conflict boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hosted_credit_notes_id_fmt check (stripe_credit_note_id ~ '^cn_[A-Za-z0-9]+$'),
  constraint hosted_credit_notes_status_chk check (status in ('issued', 'void')),
  constraint hosted_credit_notes_type_chk check (credit_note_type is null or credit_note_type in ('pre_payment', 'post_payment')),
  constraint hosted_credit_notes_amount_chk check (amount >= 0),
  constraint hosted_credit_notes_currency_fmt check (currency ~ '^[a-z]{3}$')
);
create unique index hosted_credit_notes_key_uq on public.hosted_credit_notes (coalesce(stripe_account_id, ''), stripe_credit_note_id);
create index hosted_credit_notes_invoice_idx on public.hosted_credit_notes (invoice_row_id);

alter table public.hosted_invoice_payments add constraint hosted_invoice_payments_invoice_fk
  foreign key (invoice_row_id, account_key, stripe_invoice_id) references public.hosted_invoices (id, account_key, stripe_invoice_id) on delete restrict;
alter table public.hosted_credit_notes add constraint hosted_credit_notes_invoice_fk
  foreign key (invoice_row_id, account_key, stripe_invoice_id) references public.hosted_invoices (id, account_key, stripe_invoice_id) on delete restrict;

create table public.hosted_invoice_status_transitions (
  id uuid primary key default gen_random_uuid(),
  invoice_row_id uuid not null references public.hosted_invoices(id) on delete restrict,
  studio_id uuid references public.studios(id) on delete restrict,
  source_event_id text not null unique,
  status text not null,
  event_created bigint not null,
  origin_state text not null default 'unverified',
  authorization_ref uuid,                       -- placeholder for a later authorization workflow; no table, no FK, never set in M1
  created_at timestamptz not null default now(),
  constraint hosted_invoice_transitions_status_chk check (status in ('void', 'uncollectible')),
  constraint hosted_invoice_transitions_origin_chk check (origin_state in ('unverified', 'verified')),
  constraint hosted_invoice_transitions_verified_ref check (origin_state = 'unverified' or authorization_ref is not null)
);
create index hosted_invoice_transitions_invoice_idx on public.hosted_invoice_status_transitions (invoice_row_id);

create table public.hosted_invoice_source_events (
  provider_event_id text primary key,
  event_type text not null,
  stripe_account_id text,
  livemode boolean not null,
  event_created bigint not null,
  payload_hash text not null,
  object_kind text not null,
  object_id text not null,
  invoice_row_id uuid not null references public.hosted_invoices(id) on delete restrict,
  object_snapshot jsonb not null,
  stripe_invoice_id text not null,
  account_key text generated always as (coalesce(stripe_account_id, '')) stored,
  recorded_at timestamptz not null default now(),
  constraint hosted_invoice_source_events_kind_chk check (object_kind in ('invoice', 'invoice_payment', 'credit_note')),
  constraint hosted_invoice_source_events_snapshot_size check (pg_column_size(object_snapshot) <= 4096)
);
create index hosted_invoice_source_events_invoice_idx on public.hosted_invoice_source_events (invoice_row_id);
alter table public.hosted_invoice_source_events add constraint hosted_invoice_source_events_invoice_fk
  foreign key (invoice_row_id, account_key, stripe_invoice_id) references public.hosted_invoices (id, account_key, stripe_invoice_id) on delete restrict;

create table public.hosted_invoice_recon_audit (
  id bigint generated always as identity primary key,
  invoice_row_id uuid not null references public.hosted_invoices(id) on delete restrict,
  studio_id uuid,
  occurred_at timestamptz not null default now(),
  trigger_kind text not null,
  from_state text,
  to_state text not null,
  anomaly_codes text[] not null default '{}',
  source_event_id text,
  actor_user_id uuid,
  reason text,
  constraint hosted_invoice_recon_audit_trigger_chk check (trigger_kind in ('event', 'registration', 'acknowledgement')),
  constraint hosted_invoice_recon_audit_ack_chk check (trigger_kind <> 'acknowledgement' or (actor_user_id is not null and reason is not null and length(btrim(reason)) > 0))
);
create index hosted_invoice_recon_audit_invoice_idx on public.hosted_invoice_recon_audit (invoice_row_id);

create table public.hosted_invoice_deferred_events (
  provider_event_id text primary key,
  event_type text not null,
  stripe_account_id text,
  livemode boolean not null,
  event_created bigint not null,
  payload_hash text not null,
  object_kind text not null,
  object_snapshot jsonb not null,
  state text not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  payload_mismatch boolean not null default false,
  received_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint hosted_invoice_deferred_kind_chk check (object_kind in ('invoice', 'invoice_payment', 'credit_note')),
  constraint hosted_invoice_deferred_state_chk check (state in ('pending', 'applied', 'rejected')),
  constraint hosted_invoice_deferred_settled_chk check ((state = 'pending') = (settled_at is null)),
  constraint hosted_invoice_deferred_size_chk check (pg_column_size(object_snapshot) <= 4096)
);
create index hosted_invoice_deferred_pending_idx on public.hosted_invoice_deferred_events (event_created, provider_event_id) where state = 'pending';

-- ---------------------------------------------------------------------------------------------------------------------
-- Privileges and RLS: service role reads; every write goes through the definer functions below.
-- ---------------------------------------------------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['hosted_invoice_registry', 'hosted_invoices', 'hosted_invoice_payments', 'hosted_credit_notes',
                           'hosted_invoice_status_transitions', 'hosted_invoice_source_events', 'hosted_invoice_recon_audit', 'hosted_invoice_deferred_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to service_role', t);
  end loop;
end $$;
-- service_role bypasses RLS in Supabase; with no policies, anon and authenticated can read and write nothing.

-- ---------------------------------------------------------------------------------------------------------------------
-- Write guards: direct writes are refused unless a D24 definer function is on the stack; evidence tables are append-only;
-- attribution (studio / registry) can only be set once and never changed.
-- ---------------------------------------------------------------------------------------------------------------------

create or replace function public._d24_require_writer()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if coalesce(current_setting('d24.writer', true), '') <> 'on' then
    raise exception 'd24: % on % is only allowed through the d24 functions', tg_op, tg_table_name using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'd24: % rows are permanent evidence and cannot be deleted', tg_table_name using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public._d24_append_only()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception 'd24: % is append-only (% refused)', tg_table_name, tg_op using errcode = '42501';
end $$;

create or replace function public._d24_identity_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.id is distinct from old.id
     or new.stripe_account_id is distinct from old.stripe_account_id
     or new.created_at is distinct from old.created_at then
    raise exception 'd24: % identity columns are immutable', tg_table_name using errcode = '42501';
  end if;
  if tg_table_name = 'hosted_invoices' then
    if new.stripe_invoice_id is distinct from old.stripe_invoice_id
       or new.livemode is distinct from old.livemode
       or new.first_seen_event_id is distinct from old.first_seen_event_id then
      raise exception 'd24: hosted_invoices identity columns are immutable' using errcode = '42501';
    end if;
    if old.studio_id is not null and (new.studio_id is distinct from old.studio_id or new.registry_id is distinct from old.registry_id) then
      raise exception 'd24: invoice attribution is permanent once set' using errcode = '42501';
    end if;
  elsif tg_table_name = 'hosted_invoice_payments' then
    if new.stripe_invoice_payment_id is distinct from old.stripe_invoice_payment_id
       or new.stripe_invoice_id is distinct from old.stripe_invoice_id
       or new.invoice_row_id is distinct from old.invoice_row_id
       or new.first_event_id is distinct from old.first_event_id then
      raise exception 'd24: payment identity columns are immutable' using errcode = '42501';
    end if;
    if old.studio_id is not null and new.studio_id is distinct from old.studio_id then
      raise exception 'd24: payment attribution is permanent once set' using errcode = '42501';
    end if;
  elsif tg_table_name = 'hosted_credit_notes' then
    if new.stripe_credit_note_id is distinct from old.stripe_credit_note_id
       or new.stripe_invoice_id is distinct from old.stripe_invoice_id
       or new.invoice_row_id is distinct from old.invoice_row_id
       or new.first_event_id is distinct from old.first_event_id then
      raise exception 'd24: credit note identity columns are immutable' using errcode = '42501';
    end if;
    if old.studio_id is not null and new.studio_id is distinct from old.studio_id then
      raise exception 'd24: credit note attribution is permanent once set' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  -- mutable fact tables: writer flag required, identity guarded, no delete, no truncate
  foreach t in array array['hosted_invoices', 'hosted_invoice_payments', 'hosted_credit_notes'] loop
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public._d24_require_writer()', t || '_writer_trg', t);
    execute format('create trigger %I before update on public.%I for each row execute function public._d24_identity_guard()', t || '_identity_trg', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public._d24_append_only()', t || '_trunc_trg', t);
  end loop;
  -- evidence tables: insert through the functions only; never updated or deleted
  foreach t in array array['hosted_invoice_registry', 'hosted_invoice_status_transitions', 'hosted_invoice_source_events', 'hosted_invoice_recon_audit'] loop
    execute format('create trigger %I before insert on public.%I for each row execute function public._d24_require_writer()', t || '_writer_trg', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public._d24_append_only()', t || '_append_trg', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public._d24_append_only()', t || '_trunc_trg', t);
  end loop;
end $$;

create or replace function public._d24_deferred_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'd24: deferred events are permanent evidence' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if coalesce(current_setting('d24.writer', true), '') <> 'on' then
      raise exception 'd24: INSERT on % is only allowed through the d24 functions', tg_table_name using errcode = '42501';
    end if;
    return new;
  end if;
  if coalesce(current_setting('d24.writer', true), '') <> 'on' then
    raise exception 'd24: UPDATE on % is only allowed through the d24 functions', tg_table_name using errcode = '42501';
  end if;
  if new.provider_event_id is distinct from old.provider_event_id or new.event_type is distinct from old.event_type
     or new.stripe_account_id is distinct from old.stripe_account_id or new.livemode is distinct from old.livemode
     or new.event_created is distinct from old.event_created or new.payload_hash is distinct from old.payload_hash
     or new.object_kind is distinct from old.object_kind or new.object_snapshot is distinct from old.object_snapshot
     or new.received_at is distinct from old.received_at then
    raise exception 'd24: deferred event evidence is immutable' using errcode = '42501';
  end if;
  if old.state <> 'pending' and (new.state is distinct from old.state or new.settled_at is distinct from old.settled_at) then
    raise exception 'd24: a settled deferred event cannot change state' using errcode = '42501';
  end if;
  if new.attempts < old.attempts then
    raise exception 'd24: attempts cannot decrease' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger hosted_invoice_deferred_guard_trg before insert or update or delete on public.hosted_invoice_deferred_events
  for each row execute function public._d24_deferred_guard();
create trigger hosted_invoice_deferred_trunc_trg before truncate on public.hosted_invoice_deferred_events
  for each statement execute function public._d24_append_only();

-- Tenant ownership at commit, whoever wrote: a child row carries exactly its invoice's studio, and an invoice's studio never disagrees with a child.
create or replace function public._d24_child_studio_check()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_parent uuid;
  v_child uuid;
  v_found boolean := false;
begin
  -- judge the row as it is at commit (a stale version from an earlier statement of the same transaction is not the truth)
  execute format('select studio_id, true from public.%I where id = $1', tg_table_name) into v_child, v_found using new.id;
  if not coalesce(v_found, false) then return null; end if;
  select studio_id into v_parent from public.hosted_invoices where id = new.invoice_row_id;
  if v_child is distinct from v_parent then
    raise exception 'd24: % studio does not match its invoice', tg_table_name using errcode = '42501';
  end if;
  return null;
end $$;

create or replace function public._d24_parent_studio_check()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if exists (select 1 from public.hosted_invoice_payments where invoice_row_id = new.id and studio_id is distinct from new.studio_id)
     or exists (select 1 from public.hosted_credit_notes where invoice_row_id = new.id and studio_id is distinct from new.studio_id)
     or exists (select 1 from public.hosted_invoice_status_transitions where invoice_row_id = new.id and studio_id is not null and studio_id is distinct from new.studio_id) then
    raise exception 'd24: invoice studio disagrees with its payments, credit notes or transitions' using errcode = '42501';
  end if;
  return null;
end $$;

create constraint trigger hosted_invoice_payments_studio_ct after insert or update of studio_id, invoice_row_id on public.hosted_invoice_payments
  deferrable initially deferred for each row execute function public._d24_child_studio_check();
create constraint trigger hosted_credit_notes_studio_ct after insert or update of studio_id, invoice_row_id on public.hosted_credit_notes
  deferrable initially deferred for each row execute function public._d24_child_studio_check();
create constraint trigger hosted_invoice_transitions_studio_ct after insert on public.hosted_invoice_status_transitions
  deferrable initially deferred for each row execute function public._d24_child_studio_check();
create or replace function public._d24_audit_studio_check()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_parent uuid;
begin
  select studio_id into v_parent from public.hosted_invoices where id = new.invoice_row_id;
  if new.studio_id is not null and new.studio_id is distinct from v_parent then
    raise exception 'd24: audit studio does not match its invoice' using errcode = '42501';
  end if;
  return null;
end $$;
create constraint trigger hosted_invoice_recon_audit_studio_ct after insert on public.hosted_invoice_recon_audit
  deferrable initially deferred for each row execute function public._d24_audit_studio_check();

create constraint trigger hosted_invoices_studio_ct after update of studio_id on public.hosted_invoices
  deferrable initially deferred for each row execute function public._d24_parent_studio_check();

-- ---------------------------------------------------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------------------------------------------------

create or replace function public._d24_derive_state(p_studio_id uuid, p_class text, p_codes text[], p_ack text[])
returns text language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select case
    when p_studio_id is null and p_class = 'subscription'
         and not exists (select 1 from unnest(coalesce(p_codes, '{}')) c where c not in ('unverified_void_origin', 'unverified_uncollectible_origin')) then 'out_of_scope'
    when p_studio_id is null then 'unmatched'
    when exists (select 1 from unnest(coalesce(p_codes, '{}')) c where c <> all (coalesce(p_ack, '{}'))) then 'anomalous'
    when coalesce(array_length(p_codes, 1), 0) > 0 then 'resolved'
    else 'clear'
  end
$$;

create or replace function public._d24_add_code(p_codes text[], p_code text)
returns text[] language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select case when p_code = any (coalesce(p_codes, '{}')) then p_codes
              else (select array_agg(c order by c) from unnest(coalesce(p_codes, '{}') || p_code) c) end
$$;

-- Recompute the derived state of one invoice row (caller holds its row lock) and audit a change.
create or replace function public._d24_refresh_state(p_row_id uuid, p_trigger text, p_event_id text)
returns text language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v public.hosted_invoices%rowtype;
  v_new text;
begin
  select * into v from public.hosted_invoices where id = p_row_id;
  v_new := public._d24_derive_state(v.studio_id, v.classification, v.anomaly_codes, v.acknowledged_codes);
  if v_new is distinct from v.reconciliation_state then
    update public.hosted_invoices set reconciliation_state = v_new, updated_at = now() where id = p_row_id;
    insert into public.hosted_invoice_recon_audit (invoice_row_id, studio_id, trigger_kind, from_state, to_state, anomaly_codes, source_event_id)
    values (p_row_id, v.studio_id, p_trigger, v.reconciliation_state, v_new, v.anomaly_codes, p_event_id);
  end if;
  return v_new;
end $$;

-- Add an anomaly code. p_reopen = a NEW occurrence of an already-known code: it removes the code from acknowledged_codes so a prior review does not hide it.
create or replace function public._d24_flag(p_row_id uuid, p_code text, p_reopen boolean default false)
returns void language sql
set search_path = pg_catalog, public, pg_temp
as $$
  update public.hosted_invoices
  set anomaly_codes = public._d24_add_code(anomaly_codes, p_code),
      acknowledged_codes = case when p_reopen then array_remove(acknowledged_codes, p_code) else acknowledged_codes end,
      updated_at = now()
  where id = p_row_id and (not (p_code = any (anomaly_codes)) or (p_reopen and p_code = any (acknowledged_codes)));
$$;

-- Attribute an unmatched invoice (and its children) from the trusted registry. Caller holds the invoice row lock and the key lock.
create or replace function public._d24_try_adopt(p_row_id uuid)
returns boolean language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v public.hosted_invoices%rowtype;
  r public.hosted_invoice_registry%rowtype;
begin
  select * into v from public.hosted_invoices where id = p_row_id;
  if v.studio_id is not null then return true; end if;
  select * into r from public.hosted_invoice_registry
  where coalesce(stripe_account_id, '') = coalesce(v.stripe_account_id, '') and stripe_invoice_id = v.stripe_invoice_id;
  if not found then
    if exists (select 1 from public.hosted_invoice_registry where stripe_invoice_id = v.stripe_invoice_id) then
      perform public._d24_flag(p_row_id, 'account_scope_mismatch');
    end if;
    return false;
  end if;
  update public.hosted_invoices set studio_id = r.studio_id, registry_id = r.id, classification = 'registered', updated_at = now() where id = p_row_id;
  update public.hosted_invoice_payments set studio_id = r.studio_id, updated_at = now() where invoice_row_id = p_row_id and studio_id is null;
  update public.hosted_credit_notes set studio_id = r.studio_id, updated_at = now() where invoice_row_id = p_row_id and studio_id is null;
  if r.livemode is distinct from v.livemode then perform public._d24_flag(p_row_id, 'livemode_mismatch'); end if;
  if v.metadata_ref is not null and v.metadata_ref <> r.id::text then perform public._d24_flag(p_row_id, 'metadata_mismatch'); end if;
  if v.metadata_studio is not null and v.metadata_studio <> r.studio_id::text then perform public._d24_flag(p_row_id, 'metadata_mismatch'); end if;
  return true;
end $$;

-- Classify from Stripe's own invoice markers only (subscription_evidence, set from the verified event). A registry match is the only way to a studio.
-- Subscription evidence moves an unattributed invoice out of the attention queue ONLY while it carries nothing but the unverified-origin flags (see _d24_derive_state);
-- it never assigns a studio. Tenant-writable tables (studio_invoices) are deliberately not consulted.
create or replace function public._d24_classify(p_row_id uuid)
returns text language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v public.hosted_invoices%rowtype;
  v_class text;
begin
  select * into v from public.hosted_invoices where id = p_row_id;
  v_class := case when v.studio_id is not null then 'registered' when v.subscription_evidence then 'subscription' else 'unresolved' end;
  if v.studio_id is not null and v.subscription_evidence then
    perform public._d24_flag(p_row_id, 'subscription_registry_conflict');
  end if;
  if v_class is distinct from v.classification then
    update public.hosted_invoices set classification = v_class, updated_at = now() where id = p_row_id;
  end if;
  return v_class;
end $$;

create or replace function public._d24_key_lock(p_account text, p_invoice_id text)
returns void language sql
set search_path = pg_catalog, public, pg_temp
as $$ select pg_advisory_xact_lock(hashtextextended('d24:' || coalesce(p_account, '') || ':' || p_invoice_id, 0)) $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Public (service-role) functions
-- ---------------------------------------------------------------------------------------------------------------------

-- Record a DanceFlow-issued invoice in the trusted registry and adopt any facts that arrived before it.
create or replace function public.d24_register_invoice(
  p_studio_id uuid, p_stripe_account_id text, p_stripe_invoice_id text, p_livemode boolean,
  p_business_object_type text, p_business_object_id text, p_created_by uuid default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_reg uuid;
  v_row uuid;
  v_adopted boolean := false;
  v_other uuid;
  v_other_acct text;
begin
  if p_studio_id is null or p_stripe_invoice_id is null or p_livemode is null then
    raise exception 'd24_register_invoice: studio, invoice id and livemode are required' using errcode = '22023';
  end if;
  perform set_config('d24.writer', 'on', true);
  perform public._d24_key_lock(p_stripe_account_id, p_stripe_invoice_id);

  insert into public.hosted_invoice_registry (studio_id, stripe_account_id, stripe_invoice_id, livemode, business_object_type, business_object_id, created_by)
  values (p_studio_id, p_stripe_account_id, p_stripe_invoice_id, p_livemode, p_business_object_type, p_business_object_id, p_created_by)
  on conflict (coalesce(stripe_account_id, ''), stripe_invoice_id) do nothing
  returning id into v_reg;

  if v_reg is null then
    -- already registered: idempotent only when identical; a different owner is refused, never overwritten
    select id into v_reg from public.hosted_invoice_registry
    where coalesce(stripe_account_id, '') = coalesce(p_stripe_account_id, '') and stripe_invoice_id = p_stripe_invoice_id
      and studio_id = p_studio_id and business_object_type = p_business_object_type and business_object_id = p_business_object_id
      and livemode = p_livemode;
    if v_reg is null then
      raise exception 'd24_registration_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object('outcome', 'already_registered', 'registry_id', v_reg);
  end if;

  -- the same invoice id seen under another account scope was never ours: flag it, never attribute it
  for v_other_acct in select distinct account_key from public.hosted_invoices
      where stripe_invoice_id = p_stripe_invoice_id and account_key <> coalesce(p_stripe_account_id, '') order by account_key loop
    perform public._d24_key_lock(nullif(v_other_acct, ''), p_stripe_invoice_id);
  end loop;
  for v_other in select id from public.hosted_invoices
      where stripe_invoice_id = p_stripe_invoice_id and coalesce(stripe_account_id, '') <> coalesce(p_stripe_account_id, '') and studio_id is null
      order by id for update loop
    perform public._d24_flag(v_other, 'account_scope_mismatch', true);
    perform public._d24_refresh_state(v_other, 'registration', null);
  end loop;
  select id into v_row from public.hosted_invoices
  where coalesce(stripe_account_id, '') = coalesce(p_stripe_account_id, '') and stripe_invoice_id = p_stripe_invoice_id
  for update;
  if v_row is not null then
    v_adopted := public._d24_try_adopt(v_row);
    perform public._d24_classify(v_row);
    perform public._d24_refresh_state(v_row, 'registration', null);
  end if;
  return jsonb_build_object('outcome', 'registered', 'registry_id', v_reg, 'adopted_existing_facts', v_adopted and v_row is not null);
end $$;

create or replace function public._d24_validate_event(
  p_provider_event_id text, p_event_type text, p_event_created bigint, p_account text, p_livemode boolean, p_payload_hash text, p_kind text, p_object jsonb)
returns void language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare k text;
begin
  if p_provider_event_id is null or length(p_provider_event_id) = 0 or p_event_created is null or p_livemode is null
     or p_payload_hash is null or p_object is null or (p_object->>'invoice_id') is null then
    raise exception 'd24: event id, created, livemode, hash and invoice id are required' using errcode = '22023';
  end if;
  if p_account is not null and p_account !~ '^acct_[A-Za-z0-9]+$' then
    raise exception 'd24: malformed account id' using errcode = '22023';
  end if;
  if (p_object->>'invoice_id') !~ '^in_[A-Za-z0-9]+$' then
    raise exception 'd24: malformed invoice id' using errcode = '22023';
  end if;
  if not ((p_kind = 'invoice' and p_event_type in ('invoice.voided', 'invoice.marked_uncollectible'))
       or (p_kind = 'invoice_payment' and p_event_type = 'invoice_payment.paid')
       or (p_kind = 'credit_note' and p_event_type in ('credit_note.created', 'credit_note.updated', 'credit_note.voided'))) then
    raise exception 'd24: event type % does not match kind %', p_event_type, p_kind using errcode = '22023';
  end if;
  if p_kind <> 'invoice' and (p_object->>'object_id') is null then
    raise exception 'd24: object id required' using errcode = '22023';
  end if;
  if p_kind = 'invoice' and (p_object->>'status') not in ('void', 'uncollectible') then
    raise exception 'd24: invoice event with unsupported status %', p_object->>'status' using errcode = '22023';
  end if;
  -- full shape check, so bad input is a permanent 22023 here and never a retry loop or a stuck queue later
  if coalesce(p_object->>'currency', '') !~ '^[a-z]{3}$' then
    raise exception 'd24: malformed currency' using errcode = '22023';
  end if;
  if p_kind = 'invoice' then
    if jsonb_typeof(p_object->'total') is distinct from 'number' or (p_object->>'total') !~ '^-?[0-9]{1,15}$' then
      raise exception 'd24: malformed invoice total' using errcode = '22023';
    end if;
    foreach k in array array['amount_due', 'amount_paid', 'amount_remaining'] loop
      if jsonb_typeof(p_object->k) is distinct from 'number' or (p_object->>k) !~ '^[0-9]{1,15}$' then
        raise exception 'd24: malformed invoice amount %', k using errcode = '22023';
      end if;
    end loop;
    if p_object ? 'subscription_evidence' and jsonb_typeof(p_object->'subscription_evidence') not in ('boolean', 'null') then
      raise exception 'd24: malformed subscription_evidence' using errcode = '22023';
    end if;
  elsif p_kind = 'invoice_payment' then
    if (p_object->>'object_id') !~ '^inpay_[A-Za-z0-9]+$' or (p_object->>'status') not in ('open', 'canceled', 'paid') then
      raise exception 'd24: malformed invoice payment' using errcode = '22023';
    end if;
    foreach k in array array['amount_requested', 'amount_paid'] loop
      if jsonb_typeof(p_object->k) is distinct from 'number' or (p_object->>k) !~ '^[0-9]{1,15}$' then
        raise exception 'd24: malformed payment amount %', k using errcode = '22023';
      end if;
    end loop;
  else
    if (p_object->>'object_id') !~ '^cn_[A-Za-z0-9]+$' or (p_object->>'status') not in ('issued', 'void')
       or coalesce(p_object->>'credit_note_type', 'pre_payment') not in ('pre_payment', 'post_payment') then
      raise exception 'd24: malformed credit note' using errcode = '22023';
    end if;
    if jsonb_typeof(p_object->'amount') is distinct from 'number' or (p_object->>'amount') !~ '^[0-9]{1,15}$' then
      raise exception 'd24: malformed credit note amount' using errcode = '22023';
    end if;
  end if;
end $$;

-- Core: apply one sanitized event. No claim check here (callers: d24_apply_event after verifying the claim, and d24_drain_deferred). Fully idempotent.
create or replace function public._d24_apply_core(
  p_provider_event_id text, p_event_type text, p_event_created bigint,
  p_account text, p_livemode boolean, p_payload_hash text, p_kind text, p_object jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_invoice_id text := p_object->>'invoice_id';
  v_object_id text;
  v_row_id uuid;
  v_created boolean := false;
  v_inv public.hosted_invoices%rowtype;
  v_existing_evt public.hosted_invoice_source_events%rowtype;
  v_state text;
  v_status text := p_object->>'status';
  v_pay public.hosted_invoice_payments%rowtype;
  v_cn public.hosted_credit_notes%rowtype;
  v_new_rank int;
  v_cur_rank int;
  v_paid_sum bigint;
  v_new_payment boolean := false;
begin
  perform public._d24_validate_event(p_provider_event_id, p_event_type, p_event_created, p_account, p_livemode, p_payload_hash, p_kind, p_object);
  v_object_id := case p_kind when 'invoice' then v_invoice_id else p_object->>'object_id' end;
  perform set_config('d24.writer', 'on', true);
  -- serialize everything about this invoice key (events, registration, adoption, drain) BEFORE the replay check
  perform public._d24_key_lock(p_account, v_invoice_id);

  -- replay of an event this function already applied: evidence exists, nothing to redo
  select * into v_existing_evt from public.hosted_invoice_source_events where provider_event_id = p_provider_event_id;
  if found then
    if v_existing_evt.payload_hash <> p_payload_hash then
      -- never a retry storm: keep the original evidence and surface the disagreement for review
      perform public._d24_flag(v_existing_evt.invoice_row_id, 'replay_payload_mismatch', true);
      perform public._d24_refresh_state(v_existing_evt.invoice_row_id, 'event', p_provider_event_id);
      return jsonb_build_object('outcome', 'replayed', 'invoice_row_id', v_existing_evt.invoice_row_id, 'payload_mismatch', true);
    end if;
    return jsonb_build_object('outcome', 'replayed', 'invoice_row_id', v_existing_evt.invoice_row_id);
  end if;

  insert into public.hosted_invoices (stripe_account_id, stripe_invoice_id, livemode, reconciliation_state, first_seen_event_id)
  values (p_account, v_invoice_id, p_livemode, 'unmatched', p_provider_event_id)
  on conflict (coalesce(stripe_account_id, ''), stripe_invoice_id) do nothing
  returning id into v_row_id;
  v_created := v_row_id is not null;

  select * into v_inv from public.hosted_invoices
  where coalesce(stripe_account_id, '') = coalesce(p_account, '') and stripe_invoice_id = v_invoice_id
  for update;
  v_row_id := v_inv.id;

  if v_created then
    insert into public.hosted_invoice_recon_audit (invoice_row_id, studio_id, trigger_kind, from_state, to_state, anomaly_codes, source_event_id)
    values (v_row_id, null, 'event', null, 'unmatched', '{}', p_provider_event_id);
  end if;
  if v_inv.livemode is distinct from p_livemode then
    perform public._d24_flag(v_row_id, 'livemode_conflict');
  end if;

  -- 4. immutable evidence
  insert into public.hosted_invoice_source_events
    (provider_event_id, event_type, stripe_account_id, livemode, event_created, payload_hash, object_kind, object_id, invoice_row_id, object_snapshot, stripe_invoice_id)
  values (p_provider_event_id, p_event_type, p_account, p_livemode, p_event_created, p_payload_hash, p_kind, v_object_id, v_row_id, p_object, v_invoice_id);

  -- 5. attribute from the trusted registry only
  perform public._d24_try_adopt(v_row_id);
  if p_kind = 'invoice' and coalesce((p_object->>'subscription_evidence')::boolean, false) then
    update public.hosted_invoices set subscription_evidence = true, updated_at = now() where id = v_row_id and not subscription_evidence;
  end if;
  perform public._d24_classify(v_row_id);
  select * into v_inv from public.hosted_invoices where id = v_row_id;

  -- 6. apply the fact
  if p_kind = 'invoice' then
    if v_status not in ('void', 'uncollectible') then
      raise exception 'd24_apply_event: invoice event with unsupported status %', v_status using errcode = '22023';
    end if;
    v_new_rank := case v_status when 'void' then 3 when 'uncollectible' then 2 end;
    v_cur_rank := case v_inv.status when 'draft' then 0 when 'open' then 1 when 'uncollectible' then 2 when 'paid' then 3 when 'void' then 3 else -1 end;
    if v_inv.status is null or
       (v_new_rank, p_event_created, (p_object->>'amount_paid')::bigint, -(p_object->>'amount_remaining')::bigint, -(p_object->>'amount_due')::bigint, (p_object->>'total')::bigint, v_status)
       > (v_cur_rank, v_inv.last_event_created, v_inv.amount_paid, -v_inv.amount_remaining, -v_inv.amount_due, v_inv.total, v_inv.status) then
      update public.hosted_invoices
      set status = v_status, total = (p_object->>'total')::bigint, amount_due = (p_object->>'amount_due')::bigint,
          amount_paid = (p_object->>'amount_paid')::bigint, amount_remaining = (p_object->>'amount_remaining')::bigint,
          currency = p_object->>'currency', last_event_created = p_event_created, updated_at = now()
      where id = v_row_id;
    end if;
    update public.hosted_invoices
    set seen_statuses = (select array_agg(distinct x order by x) from unnest(seen_statuses || v_status) x),
        metadata_ref = coalesce(metadata_ref, p_object->>'metadata_ref'),
        metadata_studio = coalesce(metadata_studio, p_object->>'metadata_studio'),
        updated_at = now()
    where id = v_row_id;
    select * into v_inv from public.hosted_invoices where id = v_row_id;
    insert into public.hosted_invoice_status_transitions (invoice_row_id, studio_id, source_event_id, status, event_created)
    values (v_row_id, v_inv.studio_id, p_provider_event_id, v_status, p_event_created);
    perform public._d24_flag(v_row_id, case v_status when 'void' then 'unverified_void_origin' else 'unverified_uncollectible_origin' end);
    if 'paid' = any (v_inv.seen_statuses) and 'void' = any (v_inv.seen_statuses) then perform public._d24_flag(v_row_id, 'paid_and_void_observed'); end if;
    if v_inv.studio_id is not null then
      if v_inv.metadata_ref is not null and v_inv.metadata_ref <> v_inv.registry_id::text then perform public._d24_flag(v_row_id, 'metadata_mismatch', true); end if;
      if v_inv.metadata_studio is not null and v_inv.metadata_studio <> v_inv.studio_id::text then perform public._d24_flag(v_row_id, 'metadata_mismatch', true); end if;
    end if;

  elsif p_kind = 'invoice_payment' then
    insert into public.hosted_invoice_payments
      (invoice_row_id, studio_id, stripe_account_id, stripe_invoice_payment_id, stripe_invoice_id, status, amount_requested, amount_paid, currency, first_event_id, last_event_id)
    values (v_row_id, v_inv.studio_id, p_account, v_object_id, v_invoice_id, p_object->>'status', (p_object->>'amount_requested')::bigint,
            (p_object->>'amount_paid')::bigint, p_object->>'currency', p_provider_event_id, p_provider_event_id)
    on conflict (coalesce(stripe_account_id, ''), stripe_invoice_payment_id) do nothing;
    v_new_payment := found;
    if not found then
      select * into v_pay from public.hosted_invoice_payments
      where coalesce(stripe_account_id, '') = coalesce(p_account, '') and stripe_invoice_payment_id = v_object_id for update;
      if v_pay.stripe_invoice_id <> v_invoice_id or v_pay.amount_requested <> (p_object->>'amount_requested')::bigint
         or v_pay.currency <> (p_object->>'currency') then
        update public.hosted_invoice_payments set conflict = true, last_event_id = p_provider_event_id, updated_at = now() where id = v_pay.id;
        perform public._d24_flag(v_row_id, 'invoice_payment_conflict', true);
      else
        v_new_rank := case p_object->>'status' when 'open' then 0 when 'canceled' then 1 else 2 end;
        v_cur_rank := case v_pay.status when 'open' then 0 when 'canceled' then 1 else 2 end;
        if v_new_rank > v_cur_rank then
          update public.hosted_invoice_payments
          set status = p_object->>'status', amount_paid = (p_object->>'amount_paid')::bigint, last_event_id = p_provider_event_id, updated_at = now()
          where id = v_pay.id;
        elsif v_new_rank = v_cur_rank and v_pay.amount_paid <> (p_object->>'amount_paid')::bigint then
          update public.hosted_invoice_payments set conflict = true, last_event_id = p_provider_event_id, updated_at = now() where id = v_pay.id;
          perform public._d24_flag(v_row_id, 'invoice_payment_conflict', true);
        end if;
      end if;
    end if;

  else -- credit_note
    insert into public.hosted_credit_notes
      (invoice_row_id, studio_id, stripe_account_id, stripe_credit_note_id, stripe_invoice_id, status, credit_note_type, amount, currency, first_event_id, last_event_id)
    values (v_row_id, v_inv.studio_id, p_account, v_object_id, v_invoice_id, p_object->>'status', p_object->>'credit_note_type',
            (p_object->>'amount')::bigint, p_object->>'currency', p_provider_event_id, p_provider_event_id)
    on conflict (coalesce(stripe_account_id, ''), stripe_credit_note_id) do nothing;
    if not found then
      select * into v_cn from public.hosted_credit_notes
      where coalesce(stripe_account_id, '') = coalesce(p_account, '') and stripe_credit_note_id = v_object_id for update;
      if v_cn.stripe_invoice_id <> v_invoice_id or v_cn.amount <> (p_object->>'amount')::bigint or v_cn.currency <> (p_object->>'currency') then
        update public.hosted_credit_notes set conflict = true, last_event_id = p_provider_event_id, updated_at = now() where id = v_cn.id;
        perform public._d24_flag(v_row_id, 'credit_note_conflict', true);
      elsif v_cn.status = 'issued' and p_object->>'status' = 'void' then
        update public.hosted_credit_notes set status = 'void', last_event_id = p_provider_event_id, updated_at = now() where id = v_cn.id;
      end if;
    end if;
  end if;

  -- order-independent consistency checks over the final state, for every kind of event
  select * into v_inv from public.hosted_invoices where id = v_row_id;
  select coalesce(sum(amount_paid), 0) into v_paid_sum from public.hosted_invoice_payments where invoice_row_id = v_row_id and status = 'paid';
  if v_inv.status = 'void' and v_paid_sum > 0 then perform public._d24_flag(v_row_id, 'void_invoice_has_payments', v_new_payment); end if;
  if v_inv.total is not null and v_paid_sum > v_inv.total then perform public._d24_flag(v_row_id, 'payments_exceed_invoice_total', v_new_payment); end if;

  v_state := public._d24_refresh_state(v_row_id, 'event', p_provider_event_id);
  select * into v_inv from public.hosted_invoices where id = v_row_id;
  return jsonb_build_object('outcome', 'applied', 'invoice_row_id', v_row_id, 'matched', v_inv.studio_id is not null,
                            'reconciliation_state', v_state, 'anomaly_codes', to_jsonb(v_inv.anomaly_codes));
end $$;

-- Apply one verified, claimed Stripe event (route entry point).
create or replace function public.d24_apply_event(
  p_provider_event_id text, p_owner uuid, p_event_type text, p_event_created bigint,
  p_account text, p_livemode boolean, p_payload_hash text, p_kind text, p_object jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v jsonb;
begin
  if p_owner is null then
    raise exception 'd24_apply_event: owner is required' using errcode = '22023';
  end if;
  -- the caller must still own the PAY-WH-1 claim (a worker whose lease was taken over can never commit)
  perform public._paywh1_require_event_claim(p_provider_event_id, p_owner);
  v := public._d24_apply_core(p_provider_event_id, p_event_type, p_event_created, p_account, p_livemode, p_payload_hash, p_kind, p_object);
  perform set_config('d24.writer', 'on', true);
  -- a deferred copy of the same event is now settled; skip it if a drain holds it (the drain will see 'replayed')
  update public.hosted_invoice_deferred_events
  set state = 'applied', settled_at = now(), last_error = null
  where provider_event_id in (select provider_event_id from public.hosted_invoice_deferred_events
                              where provider_event_id = p_provider_event_id and state = 'pending' for update skip locked);
  return v;
end $$;

-- Defer mode: durably record the sanitized event so enabling the feature later applies it (idempotently) without any Stripe resend.
create or replace function public.d24_defer_event(
  p_provider_event_id text, p_owner uuid, p_event_type text, p_event_created bigint,
  p_account text, p_livemode boolean, p_payload_hash text, p_kind text, p_object jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_existing public.hosted_invoice_deferred_events%rowtype;
begin
  if p_owner is null then
    raise exception 'd24_defer_event: owner is required' using errcode = '22023';
  end if;
  perform public._paywh1_require_event_claim(p_provider_event_id, p_owner);
  perform public._d24_validate_event(p_provider_event_id, p_event_type, p_event_created, p_account, p_livemode, p_payload_hash, p_kind, p_object);
  perform set_config('d24.writer', 'on', true);
  if exists (select 1 from public.hosted_invoice_source_events where provider_event_id = p_provider_event_id) then
    return jsonb_build_object('outcome', 'already_applied');
  end if;
  insert into public.hosted_invoice_deferred_events
    (provider_event_id, event_type, stripe_account_id, livemode, event_created, payload_hash, object_kind, object_snapshot)
  values (p_provider_event_id, p_event_type, p_account, p_livemode, p_event_created, p_payload_hash, p_kind, p_object)
  on conflict (provider_event_id) do nothing;
  if not found then
    select * into v_existing from public.hosted_invoice_deferred_events where provider_event_id = p_provider_event_id;
    if v_existing.payload_hash <> p_payload_hash and not v_existing.payload_mismatch then
      update public.hosted_invoice_deferred_events set payload_mismatch = true where provider_event_id = p_provider_event_id;
    end if;
    return jsonb_build_object('outcome', 'deferred', 'duplicate', true, 'payload_mismatch', v_existing.payload_hash <> p_payload_hash, 'state', v_existing.state);
  end if;
  return jsonb_build_object('outcome', 'deferred', 'duplicate', false, 'state', 'pending');
end $$;

-- Apply pending deferred events (oldest first). Each event is its own savepoint; reducers are order independent and keyed, so draining twice, draining while the
-- live route applies the same events, or draining after the feature is on can never double-record a payment, credit note or transition.
-- A validation failure (22023) or the fifth failed attempt rejects an event (kept as evidence with its error, never deleted); other failures leave it pending, and
-- candidates are ordered by attempts first so a stuck event can never starve newer ones. Batches stay small (max 100) because locks are held until commit.
create or replace function public.d24_drain_deferred(p_limit integer default 25)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.hosted_invoice_deferred_events%rowtype;
  v_applied integer := 0;
  v_rejected integer := 0;
  v_failed integer := 0;
begin
  perform set_config('d24.writer', 'on', true);
  for r in select * from public.hosted_invoice_deferred_events where state = 'pending'
           order by attempts, event_created, provider_event_id limit least(greatest(coalesce(p_limit, 25), 1), 100) for update skip locked loop
    begin
      perform public._d24_apply_core(r.provider_event_id, r.event_type, r.event_created, r.stripe_account_id, r.livemode, r.payload_hash, r.object_kind, r.object_snapshot);
      update public.hosted_invoice_deferred_events set state = 'applied', settled_at = now(), attempts = attempts + 1, last_error = null
      where provider_event_id = r.provider_event_id;
      v_applied := v_applied + 1;
    exception when others then
      perform set_config('d24.writer', 'on', true);
      if sqlstate = '22023' or r.attempts + 1 >= 5 then
        update public.hosted_invoice_deferred_events set state = 'rejected', settled_at = now(), attempts = attempts + 1, last_error = left(sqlerrm, 500)
        where provider_event_id = r.provider_event_id;
        v_rejected := v_rejected + 1;
      else
        update public.hosted_invoice_deferred_events set attempts = attempts + 1, last_error = left(sqlerrm, 500) where provider_event_id = r.provider_event_id;
        v_failed := v_failed + 1;
      end if;
    end;
  end loop;
  return jsonb_build_object('applied', v_applied, 'rejected', v_rejected, 'failed', v_failed);
end $$;

-- Acknowledge (review) anomalies. The only manual state change: it can never attribute an unmatched invoice or erase a code.
create or replace function public.d24_acknowledge_anomalies(p_invoice_row_id uuid, p_codes text[], p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v public.hosted_invoices%rowtype;
  v_state text;
begin
  if p_invoice_row_id is null or p_actor is null or p_reason is null or length(btrim(p_reason)) = 0
     or p_codes is null or coalesce(array_length(p_codes, 1), 0) = 0 then
    raise exception 'd24_acknowledge_anomalies: invoice, codes, actor and a reason are required' using errcode = '22023';
  end if;
  perform set_config('d24.writer', 'on', true);
  select * into v from public.hosted_invoices where id = p_invoice_row_id for update;
  if not found then raise exception 'd24_invoice_not_found' using errcode = 'P0002'; end if;
  if v.studio_id is null then
    raise exception 'd24_unmatched_invoice_cannot_be_acknowledged: attribute it through the registry first' using errcode = '55000';
  end if;
  if not (p_codes <@ v.anomaly_codes) then
    raise exception 'd24_unknown_anomaly_code' using errcode = '22023';
  end if;
  update public.hosted_invoices
  set acknowledged_codes = (select array_agg(distinct c order by c) from unnest(acknowledged_codes || p_codes) c), updated_at = now()
  where id = p_invoice_row_id;
  v_state := public._d24_derive_state(v.studio_id, v.classification, v.anomaly_codes, (select array_agg(distinct c) from unnest(v.acknowledged_codes || p_codes) c));
  update public.hosted_invoices set reconciliation_state = v_state where id = p_invoice_row_id;
  insert into public.hosted_invoice_recon_audit (invoice_row_id, studio_id, trigger_kind, from_state, to_state, anomaly_codes, actor_user_id, reason)
  values (p_invoice_row_id, v.studio_id, 'acknowledgement', v.reconciliation_state, v_state, p_codes, p_actor, p_reason);
  return jsonb_build_object('outcome', 'acknowledged', 'reconciliation_state', v_state);
end $$;

revoke all on function public._d24_require_writer() from public, anon, authenticated, service_role;
revoke all on function public._d24_append_only() from public, anon, authenticated, service_role;
revoke all on function public._d24_identity_guard() from public, anon, authenticated, service_role;
revoke all on function public._d24_derive_state(uuid, text, text[], text[]) from public, anon, authenticated, service_role;
revoke all on function public._d24_add_code(text[], text) from public, anon, authenticated, service_role;
revoke all on function public._d24_refresh_state(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public._d24_flag(uuid, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public._d24_try_adopt(uuid) from public, anon, authenticated, service_role;
revoke all on function public._d24_key_lock(text, text) from public, anon, authenticated, service_role;
revoke all on function public._d24_classify(uuid) from public, anon, authenticated, service_role;
revoke all on function public._d24_validate_event(text, text, bigint, text, boolean, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public._d24_apply_core(text, text, bigint, text, boolean, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public._d24_deferred_guard() from public, anon, authenticated, service_role;
revoke all on function public._d24_child_studio_check() from public, anon, authenticated, service_role;
revoke all on function public._d24_parent_studio_check() from public, anon, authenticated, service_role;
revoke all on function public._d24_audit_studio_check() from public, anon, authenticated, service_role;
revoke all on function public.d24_defer_event(text, uuid, text, bigint, text, boolean, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.d24_drain_deferred(integer) from public, anon, authenticated;
grant execute on function public.d24_defer_event(text, uuid, text, bigint, text, boolean, text, text, jsonb) to service_role;
grant execute on function public.d24_drain_deferred(integer) to service_role;
revoke all on function public.d24_register_invoice(uuid, text, text, boolean, text, text, uuid) from public, anon, authenticated;
revoke all on function public.d24_apply_event(text, uuid, text, bigint, text, boolean, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.d24_acknowledge_anomalies(uuid, text[], uuid, text) from public, anon, authenticated;
grant execute on function public.d24_register_invoice(uuid, text, text, boolean, text, text, uuid) to service_role;
grant execute on function public.d24_apply_event(text, uuid, text, bigint, text, boolean, text, text, jsonb) to service_role;
grant execute on function public.d24_acknowledge_anomalies(uuid, text[], uuid, text) to service_role;

notify pgrst, 'reload schema';

commit;
