-- 20270223091000_twilio_test_credit_grant.sql
-- TW-4F financial safety, slice A: a CONTROLLED TEST CREDIT for the pilot business (Git only; dark; NOT APPLIED anywhere by this file's authoring).
--
-- Problem: the ConfiDance pilot ceiling never pays for texting (20261122 decision 10), so a billed test send needs credit. The only way to create credit without a payment
-- is tw4_credit_adjust (20261122): one platform administrator, any amount, no budget, no evidence, and nothing in the application calls it (tracker A-13).
-- This migration adds a bounded, audited, separately-switched path for exactly that purpose. tw4_credit_adjust is NOT changed.
--
--   studio_sms_test_credit_switch_log     KILL SWITCH (append-only log; the latest row is the state; NO ROW = OFF). While OFF no test credit can be granted.
--                                         Reversing unused test credit and every other credit path keep working whatever the switch says.
--   studio_sms_test_credit_budgets        ONE row per legal business: the TEST BUDGET (default 0 = nothing can be granted) and the running test-credit counters
--                                         (granted, consumed by texting, restored by usage refunds, reversed). Written only by the functions below.
--   studio_sms_test_credit_budget_changes append-only history of every budget change WITH the owner's dated written authorization (U-4 evidence shape: date, role,
--                                         scope test_credit_budget, amount = the new budget, period, document reference, sha256; never the text).
--   studio_sms_test_credit_grants         append-only, one row per grant WITH its U-4 evidence (scope test_credit_grant, amount = the grant, period = the business's
--                                         current billing month). One approval reference = one grant (shared permanent registry studio_sms_approval_refs, TW019);
--                                         one retained document (sha256) = one grant.
--   studio_sms_test_credit_movements      append-only per-ledger-entry record of how test credit moved (grant / consume / restore / reverse / forfeit).
--
-- Rules
--   * Platform administrator only (42501); service_role EXECUTE only; tables have no API privileges and RLS on.
--   * Only for the legal business that holds the pilot exception (studio_sms_pilot_exceptions; TW072 otherwise). The pilot ceiling is NOT touched: a grant creates no
--     reservation, no spend event and no pilot-funded anything.
--   * A grant needs the switch ON (TW070), a budget with room for it (TW071: granted so far + this grant <= budget; reversals do NOT free budget), an account that is
--     not on hold and not negative (TW007: test credit never pays an existing debt), and complete evidence (TW052).
--   * The budget is set by tw4_credit_test_budget_set (evidence required; never below what was already granted; at most 50000 cents, the existing $500 balance ceiling).
--     No amount is encoded here: the budget starts at 0.
--   * Ledger kinds 'test_grant' (+) and 'test_grant_reversed' (-) are DISTINCT from every purchased or adjusted kind and can be posted only by these functions (a ledger
--     trigger refuses them otherwise, also in replica mode). There is no top-up, refund, dispute or Stripe path for them: not purchasable, not refundable.
--   * Texting only: a ledger trigger (ENABLE ALWAYS) refuses any NON-texting reservation (setup fees, recurring fees, recurring set-asides; anything whose reservation is
--     not kind 'sms_usage') that would need the unused test credit: such a reservation must fit in balance - reserved - (unused test credit not already held for a text in flight) (TW007). Texting charges
--     (usage_charge, inbound included, and a captured sms_usage reservation) consume test credit FIRST; a usage refund of a charge that consumed test credit gives it
--     back as test credit (never as purchased credit). STOP / START / HELP are never charged and never touch this code; nothing here can block them.
--   * Never absorbs a non-texting debit: when a refund or dispute of a purchase, a negative adjustment or a captured fee takes the business's own money
--     (balance - fee holds - unused test credit) below zero, ALL unused test credit is FORFEITED in the same transaction (a test_grant_reversed entry, movement
--     'forfeit'), so the balance ends exactly where it would be without test credit and the negative-balance rules apply.
--   * tw4_credit_test_reverse takes back unused test credit (idempotent by key, never more than the unused test credit and never money held by an open reservation).
--   * tw4_credit_test_status is the read-only verifier (counters = movement sums = ledger sums, plus tw4_credit_verify).
--   Refusal codes: 22023 invalid input; 42501 not a platform admin / direct write; TW007 hold, negative balance, fee would use test credit, or money held; TW019 reference
--   reused; TW052 evidence; TW070 switch off; TW071 over the test budget or over the unused test credit; TW072 not the pilot business.
--
-- Requires 20261122 (credits), 20261128 (months), 20261202 (approval registry), 20261209 (_tw4rfl_lock, audit vocabulary pattern), 20261229/20261230 (U-4 evidence).
-- Rollback: rollback/20270223091000_twilio_test_credit_grant_rollback.sql (refuses while any row of this migration exists; never destroys evidence).
-- Also redefines sms_credit_overview (adds test_credit_cents / fee_available_cents) and tw4_credit_topup_pending (the $500 ceiling ignores test credit); both md5-pinned.
-- Release gates: docs/twilio/TW-4F_Financial_Safety_Gates_2026-11-23.md (on main), row "Controlled test credit funded". OPERATOR PROCEDURE: docs/twilio/TW-4F_Test_Credit_Runbook.md. Nothing in this file grants credit, sets a budget or turns the switch on.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public._tw4c_post(uuid,uuid,text,bigint,bigint,text,uuid,text,uuid,text)') is null or to_regprocedure('public._tw4rfl_lock(uuid)') is null
     or to_regprocedure('public._tw4c_admin(uuid)') is null or to_regprocedure('public._tw4c_any_location(uuid)') is null
     or to_regprocedure('public._tw4fi_register(text,text,uuid,uuid,uuid,text,integer,text,uuid)') is null or to_regprocedure('public._tw4fi_ref_norm(text)') is null
     or to_regprocedure('public._tw4ml_month_key(uuid,timestamp with time zone)') is null or to_regprocedure('public._tw4c_truncate_guard()') is null
     or to_regprocedure('public.tw4_credit_verify(uuid)') is null or to_regclass('public.studio_sms_pilot_exceptions') is null
     or to_regclass('public.studio_sms_pilot_spend_evidence') is null then
    raise exception 'test-credit precondition failed: 20261122, 20261128, 20261202, 20261209 and 20261230 are not all applied';
  end if;
  if to_regclass('public.studio_sms_test_credit_budgets') is not null or to_regprocedure('public.tw4_credit_test_grant(uuid,integer,text,uuid,date,text,text,integer,text,text,text)') is not null then
    raise exception 'test-credit precondition failed: already applied';
  end if;
  if not exists (select 1 from pg_constraint c where c.conrelid = 'public.studio_sms_credit_ledger'::regclass and c.conname = 'studio_sms_credit_ledger_kind_check')
     or not exists (select 1 from pg_constraint c where c.conrelid = 'public.studio_sms_credit_ledger'::regclass and c.conname = 'studio_sms_credit_ledger_shape') then
    raise exception 'test-credit precondition failed: the credit ledger constraints are not the 20261122 ones';
  end if;
  if exists (select 1 from pg_constraint c where c.conrelid = 'public.studio_sms_credit_ledger'::regclass and pg_get_constraintdef(c.oid) like '%test_grant%') then
    raise exception 'test-credit precondition failed: the ledger already knows a test_grant kind';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. two distinct ledger kinds (the existing kinds and shapes are unchanged; the new checks are supersets)
-- ---------------------------------------------------------------------------------------------------------------
alter table public.studio_sms_credit_ledger drop constraint studio_sms_credit_ledger_kind_check;
alter table public.studio_sms_credit_ledger add constraint studio_sms_credit_ledger_kind_check
  check (kind in ('topup_settled', 'topup_reversed', 'reserve', 'release', 'capture', 'usage_charge', 'usage_refund', 'adjustment', 'test_grant', 'test_grant_reversed'));
alter table public.studio_sms_credit_ledger drop constraint studio_sms_credit_ledger_shape;
alter table public.studio_sms_credit_ledger add constraint studio_sms_credit_ledger_shape check (
  case kind
    when 'topup_settled' then balance_delta_cents > 0 and reserved_delta_cents = 0
    when 'topup_reversed' then balance_delta_cents < 0 and reserved_delta_cents = 0
    when 'reserve' then balance_delta_cents = 0 and reserved_delta_cents > 0
    when 'release' then balance_delta_cents = 0 and reserved_delta_cents < 0
    when 'capture' then balance_delta_cents < 0 and reserved_delta_cents = balance_delta_cents
    when 'usage_charge' then balance_delta_cents < 0 and reserved_delta_cents = 0
    when 'usage_refund' then balance_delta_cents > 0 and reserved_delta_cents = 0
    when 'test_grant' then balance_delta_cents > 0 and reserved_delta_cents = 0 and studio_id is null and reservation_id is null
    when 'test_grant_reversed' then balance_delta_cents < 0 and reserved_delta_cents = 0 and studio_id is null and reservation_id is null
    else balance_delta_cents <> 0 and reserved_delta_cents = 0
  end);

-- ---------------------------------------------------------------------------------------------------------------
-- 2. the permanent approval-reference registry learns two sources (the live list is extended, never replaced)
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare
  v_src text;
  v_shape text;
  v_sources text[];
begin
  select pg_get_constraintdef(c.oid) into v_src from pg_constraint c where c.conrelid = 'public.studio_sms_approval_refs'::regclass and c.conname = 'studio_sms_approval_refs_source_check';
  select pg_get_constraintdef(c.oid) into v_shape from pg_constraint c where c.conrelid = 'public.studio_sms_approval_refs'::regclass and c.conname = 'studio_sms_approval_refs_shape';
  if v_src is null or v_shape is null then
    raise exception 'test-credit precondition failed: the approval-reference constraints are missing';
  end if;
  if position('test_credit' in v_src) > 0 or position('test_credit' in v_shape) > 0 then
    raise exception 'test-credit precondition failed: the approval-reference registry already knows a test_credit source';
  end if;
  select array_agg(distinct m[1] order by m[1]) into v_sources from regexp_matches(substring(v_src from 'ANY ((.*))'), '([a-z_]+)', 'g') m where m[1] not in ('text', 'array');
  if v_sources is null or cardinality(v_sources) < 2 then
    raise exception 'could not read the approval-reference sources from %', v_src;
  end if;
  v_sources := (select array_agg(distinct x order by x) from unnest(v_sources || array['test_credit_budget', 'test_credit_grant']) x);
  alter table public.studio_sms_approval_refs drop constraint studio_sms_approval_refs_source_check;
  execute format('alter table public.studio_sms_approval_refs add constraint studio_sms_approval_refs_source_check check (source = any (%L::text[]))', v_sources);
  alter table public.studio_sms_approval_refs drop constraint studio_sms_approval_refs_shape;
  execute 'alter table public.studio_sms_approval_refs add constraint studio_sms_approval_refs_shape ' || left(v_shape, length(v_shape) - 1)
    || ' OR (source = ''test_credit_budget''::text AND spend_event_id IS NULL AND kind IS NULL AND funding IS NULL AND studio_id IS NULL AND amount_cents IS NOT NULL)'
    || ' OR (source = ''test_credit_grant''::text AND spend_event_id IS NULL AND kind IS NULL AND funding IS NULL AND studio_id IS NULL AND amount_cents IS NOT NULL))';
end $$;

-- audit vocabulary: the live list plus this migration's actions (extended, not replaced)
do $$
declare
  v_def text;
  v_actions text[];
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.studio_sms_onboarding_audit'::regclass and c.conname = 'studio_sms_onboarding_audit_action_check';
  select array_agg(distinct m[1] order by m[1]) into v_actions from regexp_matches(substring(v_def from 'ANY \((.*)\)'), '([a-z][a-z0-9_]*)', 'g') m where m[1] <> 'text';
  if v_actions is null or cardinality(v_actions) < 10 then
    raise exception 'could not read the audit actions from %', v_def;
  end if;
  v_actions := (select array_agg(distinct x order by x) from unnest(v_actions || array['credit_test_budget_set', 'credit_test_grant', 'credit_test_reversal']) x);
  alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
  execute format('alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action = any (%L::text[]))', v_actions);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. tables (no API-role privileges, RLS on; everything goes through the functions below)
-- ---------------------------------------------------------------------------------------------------------------
create table public.studio_sms_test_credit_switch_log (
  id uuid primary key default gen_random_uuid(),
  enabled boolean not null,
  changed_by uuid not null,
  reason text not null check (char_length(btrim(reason)) between 10 and 300),
  changed_at timestamptz not null default clock_timestamp()
);

create table public.studio_sms_test_credit_budgets (
  legal_entity_id uuid primary key references public.studio_sms_legal_entities(id) on delete restrict,
  budget_cents bigint not null default 0 check (budget_cents between 0 and 50000),
  granted_cents bigint not null default 0 check (granted_cents >= 0),
  consumed_cents bigint not null default 0 check (consumed_cents >= 0),
  restored_cents bigint not null default 0 check (restored_cents >= 0),
  reversed_cents bigint not null default 0 check (reversed_cents >= 0),
  forfeited_cents bigint not null default 0 check (forfeited_cents >= 0),   -- taken out because a non-texting debit (refund, dispute, adjustment, fee) would otherwise have used it
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint studio_sms_test_credit_budgets_within check (granted_cents <= budget_cents),
  constraint studio_sms_test_credit_budgets_unused check (granted_cents + restored_cents - consumed_cents - reversed_cents - forfeited_cents >= 0),
  constraint studio_sms_test_credit_budgets_restore check (restored_cents <= consumed_cents)
);

create table public.studio_sms_test_credit_budget_changes (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id) on delete restrict,
  previous_cents bigint not null check (previous_cents >= 0),
  budget_cents bigint not null check (budget_cents between 0 and 50000),
  approval_ref text not null check (char_length(btrim(approval_ref)) between 10 and 200),
  ref_norm text not null unique,
  authorized_on date not null,
  authorized_by_role text not null check (authorized_by_role in ('founder_written', 'owner_written')),
  scope text not null check (scope = 'test_credit_budget'),
  amount_cents bigint not null,
  period_key text not null check (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  document_ref text not null check (char_length(document_ref) between 6 and 500 and (document_ref ~ '^[A-Za-z0-9][A-Za-z0-9._/#+-]{5,119}$' or document_ref ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~!$''()*+,:@/-]*)?$')),
  document_sha256 text not null unique check (document_sha256 ~ '^[0-9a-f]{64}$'),
  changed_by uuid not null,
  changed_at timestamptz not null default clock_timestamp(),
  constraint studio_sms_test_credit_budget_changes_amount check (amount_cents = budget_cents)
);
create index studio_sms_test_credit_budget_changes_entity on public.studio_sms_test_credit_budget_changes (legal_entity_id, changed_at);

create table public.studio_sms_test_credit_grants (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id) on delete restrict,
  amount_cents int not null check (amount_cents > 0 and amount_cents <= 50000),
  approval_ref text not null check (char_length(btrim(approval_ref)) between 10 and 200),
  ref_norm text not null unique,
  authorized_on date not null,
  authorized_by_role text not null check (authorized_by_role in ('founder_written', 'owner_written')),
  scope text not null check (scope = 'test_credit_grant'),
  evidence_amount_cents int not null,
  period_key text not null check (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  document_ref text not null check (char_length(document_ref) between 6 and 500 and (document_ref ~ '^[A-Za-z0-9][A-Za-z0-9._/#+-]{5,119}$' or document_ref ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~!$''()*+,:@/-]*)?$')),
  document_sha256 text not null unique check (document_sha256 ~ '^[0-9a-f]{64}$'),
  ledger_entry_id uuid not null unique,   -- the test_grant ledger entry (no foreign key to the ledger: see the note above the movements table)
  granted_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint studio_sms_test_credit_grants_amount check (evidence_amount_cents = amount_cents)
);
create index studio_sms_test_credit_grants_entity on public.studio_sms_test_credit_grants (legal_entity_id, created_at);

-- No foreign key points at studio_sms_credit_ledger: a referencing table would change how the ledger refuses TRUNCATE (Postgres reports the foreign key before the
-- ledger's own "never truncated" guard runs) and would tie the ledger's DDL to these tables. The ledger is append-only (no update, delete or truncate), and every
-- ledger_entry_id / source_entry_id below is written in the same transaction as, and from, the ledger row it names; tw4_credit_test_status cross-checks the sums.
create table public.studio_sms_test_credit_movements (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id) on delete restrict,
  ledger_entry_id uuid not null unique,
  kind text not null check (kind in ('grant', 'consume', 'restore', 'reverse', 'forfeit')),
  cents bigint not null check (cents > 0),
  source_entry_id uuid null,   -- restore: the usage charge whose consumption is given back; forfeit: the non-texting debit that forced it
  grant_id uuid null references public.studio_sms_test_credit_grants(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint studio_sms_test_credit_movements_shape check ((kind in ('restore', 'forfeit')) = (source_entry_id is not null) and (kind = 'grant') = (grant_id is not null))
);
create index studio_sms_test_credit_movements_entity on public.studio_sms_test_credit_movements (legal_entity_id, kind);
create index studio_sms_test_credit_movements_source on public.studio_sms_test_credit_movements (source_entry_id) where source_entry_id is not null;

revoke all on public.studio_sms_test_credit_switch_log, public.studio_sms_test_credit_budgets, public.studio_sms_test_credit_budget_changes,
  public.studio_sms_test_credit_grants, public.studio_sms_test_credit_movements from public, anon, authenticated, service_role;
alter table public.studio_sms_test_credit_switch_log enable row level security;
alter table public.studio_sms_test_credit_budgets enable row level security;
alter table public.studio_sms_test_credit_budget_changes enable row level security;
alter table public.studio_sms_test_credit_grants enable row level security;
alter table public.studio_sms_test_credit_movements enable row level security;

-- one guard for all five tables: rows are written only while a function below holds the flag; history never changes; a budget row keeps its identity
create or replace function public._tw4tc_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '% rows are permanent', tg_table_name using errcode = '42501';
  end if;
  if coalesce(current_setting('tw4.testcredit_write', true), '') <> 'on' then
    raise exception '% is written only by the tw4_credit_test_* functions', tg_table_name using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if tg_table_name <> 'studio_sms_test_credit_budgets' then
      raise exception '% rows are append-only', tg_table_name using errcode = '42501';
    end if;
    if new.legal_entity_id is distinct from old.legal_entity_id or new.created_at is distinct from old.created_at
       or new.granted_cents < old.granted_cents or new.consumed_cents < old.consumed_cents or new.restored_cents < old.restored_cents or new.reversed_cents < old.reversed_cents or new.forfeited_cents < old.forfeited_cents then
      raise exception 'test-credit counters only grow and a budget row is never re-assigned' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public._tw4tc_guard() from public, anon, authenticated, service_role;
create trigger studio_sms_test_credit_switch_guard before insert or update or delete on public.studio_sms_test_credit_switch_log for each row execute function public._tw4tc_guard();
create trigger studio_sms_test_credit_budgets_guard before insert or update or delete on public.studio_sms_test_credit_budgets for each row execute function public._tw4tc_guard();
create trigger studio_sms_test_credit_budget_changes_guard before insert or update or delete on public.studio_sms_test_credit_budget_changes for each row execute function public._tw4tc_guard();
create trigger studio_sms_test_credit_grants_guard before insert or update or delete on public.studio_sms_test_credit_grants for each row execute function public._tw4tc_guard();
create trigger studio_sms_test_credit_movements_guard before insert or update or delete on public.studio_sms_test_credit_movements for each row execute function public._tw4tc_guard();
alter table public.studio_sms_test_credit_switch_log enable always trigger studio_sms_test_credit_switch_guard;
alter table public.studio_sms_test_credit_budgets enable always trigger studio_sms_test_credit_budgets_guard;
alter table public.studio_sms_test_credit_budget_changes enable always trigger studio_sms_test_credit_budget_changes_guard;
alter table public.studio_sms_test_credit_grants enable always trigger studio_sms_test_credit_grants_guard;
alter table public.studio_sms_test_credit_movements enable always trigger studio_sms_test_credit_movements_guard;
create trigger studio_sms_test_credit_switch_truncate before truncate on public.studio_sms_test_credit_switch_log for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_test_credit_budgets_truncate before truncate on public.studio_sms_test_credit_budgets for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_test_credit_budget_changes_truncate before truncate on public.studio_sms_test_credit_budget_changes for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_test_credit_grants_truncate before truncate on public.studio_sms_test_credit_grants for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_test_credit_movements_truncate before truncate on public.studio_sms_test_credit_movements for each statement execute function public._tw4c_truncate_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- 4. the ledger trigger: test kinds only from these functions; texting consumes test credit first; a non-texting reservation can never use it
--    (runs AFTER the ledger row is inserted and BEFORE _tw4c_post updates the account, so the account row read here is the state before this entry;
--     the caller of _tw4c_post holds the account row lock)
-- ---------------------------------------------------------------------------------------------------------------

-- open texting reservations of a business (money held for texts in flight; test credit backs them first)
create or replace function public._tw4tc_open_sms(p_entity uuid)
returns bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select coalesce(sum(r.amount_cents), 0)::bigint from public.studio_sms_credit_reservations r
       where r.legal_entity_id = p_entity and r.status = 'reserved' and r.funding = 'credit' and r.kind = 'sms_usage'; $$;

create or replace function public._tw4tc_on_ledger(n public.studio_sms_credit_ledger, p_caller_flag text)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  b public.studio_sms_test_credit_budgets;
  a public.studio_sms_credit_accounts;
  v_unused bigint;
  v_open_sms bigint;
  v_rkind text;
  v_take bigint;
  v_orig uuid;
  v_consumed bigint;
  v_restored bigint;
  v_pool bigint;
  r jsonb;
begin
  if n.kind in ('test_grant', 'test_grant_reversed') then
    if p_caller_flag <> 'on' then
      raise exception 'test credit is posted only by tw4_credit_test_grant / tw4_credit_test_reverse' using errcode = '42501';
    end if;
    return;   -- the posting function records the movement itself
  end if;
  select * into b from public.studio_sms_test_credit_budgets x where x.legal_entity_id = n.legal_entity_id for update;
  if b.legal_entity_id is null then
    return;   -- this business never had a test budget: nothing to do (every other business is unaffected)
  end if;
  v_unused := b.granted_cents + b.restored_cents - b.consumed_cents - b.reversed_cents - b.forfeited_cents;
  if n.reservation_id is not null then
    select r0.kind into v_rkind from public.studio_sms_credit_reservations r0 where r0.id = n.reservation_id;
  end if;
  if n.kind = 'reserve' then
    -- a fee, a recurring charge or a set-aside (anything that is not a text) must fit in the credit that is NOT test credit. Test credit already held by an open
    -- texting reservation is inside reserved_cents once: only the part of the unused test credit NOT held for a text is subtracted again.
    if v_unused > 0 and v_rkind is distinct from 'sms_usage' then
      select * into a from public.studio_sms_credit_accounts x where x.legal_entity_id = n.legal_entity_id;
      v_open_sms := public._tw4tc_open_sms(n.legal_entity_id);
      if a.balance_cents - a.reserved_cents - n.reserved_delta_cents - greatest(v_unused - v_open_sms, 0) < 0 then
        raise exception 'test credit pays for texting only: this charge needs purchased credit' using errcode = 'TW007';
      end if;
    end if;
  elsif n.kind = 'usage_charge' or (n.kind = 'capture' and v_rkind = 'sms_usage') then
    v_take := least(v_unused, -n.balance_delta_cents);
    if v_take > 0 then
      insert into public.studio_sms_test_credit_movements (legal_entity_id, ledger_entry_id, kind, cents) values (n.legal_entity_id, n.id, 'consume', v_take);
      update public.studio_sms_test_credit_budgets set consumed_cents = consumed_cents + v_take, updated_at = clock_timestamp() where legal_entity_id = n.legal_entity_id;
    end if;
  elsif n.kind = 'usage_refund' and n.ref ~ '^refund_of:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_orig := substr(n.ref, 11)::uuid;
    select coalesce(sum(m.cents), 0) into v_consumed from public.studio_sms_test_credit_movements m where m.ledger_entry_id = v_orig and m.kind = 'consume';
    select coalesce(sum(m.cents), 0) into v_restored from public.studio_sms_test_credit_movements m where m.source_entry_id = v_orig and m.kind = 'restore';
    v_take := least(n.balance_delta_cents, v_consumed - v_restored);
    if v_take > 0 then
      insert into public.studio_sms_test_credit_movements (legal_entity_id, ledger_entry_id, kind, cents, source_entry_id) values (n.legal_entity_id, n.id, 'restore', v_take, v_orig);
      update public.studio_sms_test_credit_budgets set restored_cents = restored_cents + v_take, updated_at = clock_timestamp() where legal_entity_id = n.legal_entity_id;
    end if;
  elsif n.balance_delta_cents < 0 and v_unused > 0 then
    -- any OTHER debit (a refund or dispute of a purchase, a negative adjustment, a captured fee): test credit never absorbs it. The business's OWN money after this
    -- entry is (balance - fee holds) - unused test credit (texting holds are backed by test credit first, so they are not fee holds). If that goes below zero the
    -- debit would otherwise be paid, now or later through texting, with DanceFlow's test credit: ALL unused test credit is FORFEITED (posted out of the balance as
    -- test_grant_reversed), so the balance ends exactly where it would be without any test credit and the usual negative-balance and hold rules apply.
    select * into a from public.studio_sms_credit_accounts x where x.legal_entity_id = n.legal_entity_id;
    v_pool := (a.balance_cents + n.balance_delta_cents) - (a.reserved_cents + n.reserved_delta_cents) + public._tw4tc_open_sms(n.legal_entity_id);
    v_take := case when v_pool - v_unused < 0 then v_unused else 0 end;
    if v_take > 0 then
      perform set_config('tw4.testcredit_write', 'on', true);
      r := public._tw4c_post(n.legal_entity_id, null, 'test_grant_reversed', -v_take, 0, 'test_forfeit:' || n.id, null, 'test_forfeit', null,
                             left('unused test credit forfeited by a non-texting debit (' || n.kind || ')', 300));
      insert into public.studio_sms_test_credit_movements (legal_entity_id, ledger_entry_id, kind, cents, source_entry_id)
      values (n.legal_entity_id, (r ->> 'entry_id')::uuid, 'forfeit', v_take, n.id);
      update public.studio_sms_test_credit_budgets set forfeited_cents = forfeited_cents + v_take, updated_at = clock_timestamp() where legal_entity_id = n.legal_entity_id;
    end if;
  end if;
end $$;

create or replace function public._tw4tc_ledger_trigger()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_prev text := coalesce(current_setting('tw4.testcredit_write', true), '');
begin
  if new.kind in ('test_grant', 'test_grant_reversed') then
    perform public._tw4tc_on_ledger(new, v_prev);
    return null;
  end if;
  -- no write flag is needed (and none is set) for a business without a test budget: the common path is one primary-key probe
  if not exists (select 1 from public.studio_sms_test_credit_budgets x where x.legal_entity_id = new.legal_entity_id) then
    return null;
  end if;
  perform set_config('tw4.testcredit_write', 'on', true);
  perform public._tw4tc_on_ledger(new, v_prev);
  perform set_config('tw4.testcredit_write', v_prev, true);
  return null;
end $$;
revoke all on function public._tw4tc_on_ledger(public.studio_sms_credit_ledger, text), public._tw4tc_ledger_trigger(), public._tw4tc_open_sms(uuid) from public, anon, authenticated, service_role;
create trigger studio_sms_credit_ledger_40_test_credit after insert on public.studio_sms_credit_ledger for each row execute function public._tw4tc_ledger_trigger();
alter table public.studio_sms_credit_ledger enable always trigger studio_sms_credit_ledger_40_test_credit;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. helpers
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4tc_switch_on()
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select coalesce((select l.enabled from public.studio_sms_test_credit_switch_log l order by l.changed_at desc, l.id desc limit 1), false); $$;

-- the U-4 evidence of one test-credit decision. Fresh: dated within the last 31 days (UTC), naming the business's CURRENT billing month and exactly this amount.
create or replace function public._tw4tc_check_evidence(p_entity uuid, p_scope text, p_amount bigint, p_authorized_on date, p_role text, p_ev_scope text, p_ev_amount bigint,
  p_ev_period text, p_doc text, p_sha text)
returns void language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_today date := (now() at time zone 'UTC')::date;
begin
  if p_authorized_on is null then
    raise exception 'test credit evidence: the date of the owner''s written authorization is required' using errcode = 'TW052';
  end if;
  if p_authorized_on > v_today then
    raise exception 'test credit evidence: the authorization date is in the future' using errcode = 'TW052';
  end if;
  if p_authorized_on < v_today - 31 then
    raise exception 'test credit evidence: the authorization is older than 31 days; obtain a fresh one' using errcode = 'TW052';
  end if;
  if p_role is null or p_role not in ('founder_written', 'owner_written') then
    raise exception 'test credit evidence: the authorizing role must be founder_written or owner_written' using errcode = 'TW052';
  end if;
  if p_ev_scope is null or p_ev_scope <> p_scope then
    raise exception 'test credit evidence: the scope must be %', p_scope using errcode = 'TW052';
  end if;
  if p_ev_amount is null or p_ev_amount <> p_amount then
    raise exception 'test credit evidence: the authorized amount must equal the amount being recorded' using errcode = 'TW052';
  end if;
  if p_ev_period is null or p_ev_period <> public._tw4ml_month_key(p_entity, now()) then
    raise exception 'test credit evidence: the authorization must name the business''s current billing month (YYYY-MM)' using errcode = 'TW052';
  end if;
  if p_doc is null or char_length(p_doc) not between 6 and 500
     or not (p_doc ~ '^[A-Za-z0-9][A-Za-z0-9._/#+-]{5,119}$' or p_doc ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~!$''()*+,:@/-]*)?$') then
    raise exception 'test credit evidence: the retained document needs an opaque id or a plain https link (no query string, fragment, credentials, percent-escapes, semicolons, ampersands or equals signs)' using errcode = 'TW052';
  end if;
  if p_sha is null or p_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'test credit evidence: the sha256 of the retained text must be 64 lowercase hex characters' using errcode = 'TW052';
  end if;
end $$;

create or replace function public._tw4tc_require_pilot(p_entity uuid)
returns void language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_entity is null or not exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = p_entity) then
    raise exception 'test credit exists only for the pilot business' using errcode = 'TW072';
  end if;
end $$;

-- the budget row (created at 0 on first use), locked; the caller already holds the legal business row and the credit account (_tw4rfl_lock)
create or replace function public._tw4tc_budget(p_entity uuid)
returns public.studio_sms_test_credit_budgets language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare b public.studio_sms_test_credit_budgets;
begin
  perform set_config('tw4.testcredit_write', 'on', true);
  insert into public.studio_sms_test_credit_budgets (legal_entity_id) values (p_entity) on conflict (legal_entity_id) do nothing;
  perform set_config('tw4.testcredit_write', 'off', true);
  select * into b from public.studio_sms_test_credit_budgets x where x.legal_entity_id = p_entity for update;
  return b;
end $$;

revoke all on function public._tw4tc_switch_on(), public._tw4tc_check_evidence(uuid, text, bigint, date, text, text, bigint, text, text, text),
  public._tw4tc_require_pilot(uuid), public._tw4tc_budget(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. the five service-role entry points
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_credit_test_set_switch(p_enabled boolean, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  if p_enabled is null or p_reason is null or char_length(btrim(p_reason)) not between 10 and 300 then
    raise exception 'the switch needs a state and a written reason (10 to 300 characters)' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('tw4tc_switch', 0));
  perform set_config('tw4.testcredit_write', 'on', true);
  insert into public.studio_sms_test_credit_switch_log (enabled, changed_by, reason) values (p_enabled, p_actor, btrim(p_reason));
  perform set_config('tw4.testcredit_write', 'off', true);
  return jsonb_build_object('enabled', p_enabled);
end $$;

create or replace function public.tw4_credit_test_budget_set(p_entity_id uuid, p_budget_cents int, p_approval_ref text, p_actor uuid,
  p_evidence_authorized_on date, p_evidence_role text, p_evidence_scope text, p_evidence_amount_cents int, p_evidence_period_key text, p_evidence_document_ref text, p_evidence_sha256 text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  b public.studio_sms_test_credit_budgets;
  c public.studio_sms_test_credit_budget_changes;
  v_norm text;
begin
  perform public._tw4c_admin(p_actor);
  if p_entity_id is null or p_budget_cents is null or p_budget_cents < 0 or p_budget_cents > 50000 then
    raise exception 'the test budget is 0 to 50000 cents' using errcode = '22023';
  end if;
  if p_approval_ref is null or char_length(btrim(p_approval_ref)) not between 10 and 200 then
    raise exception 'the written approval reference must be 10 to 200 characters' using errcode = '22023';
  end if;
  perform public._tw4tc_require_pilot(p_entity_id);
  perform public._tw4rfl_lock(p_entity_id);
  b := public._tw4tc_budget(p_entity_id);
  v_norm := public._tw4fi_ref_norm(p_approval_ref);
  -- a replay must be the SAME decision with the SAME evidence; anything else that reuses the reference is refused by the registry (TW019)
  select * into c from public.studio_sms_test_credit_budget_changes x where x.ref_norm = v_norm;
  if c.id is not null then
    if c.legal_entity_id = p_entity_id and c.budget_cents = p_budget_cents and c.changed_by = p_actor and c.authorized_on = p_evidence_authorized_on and c.authorized_by_role = p_evidence_role
       and c.period_key = p_evidence_period_key and c.document_ref = p_evidence_document_ref and c.document_sha256 = p_evidence_sha256 then
      return jsonb_build_object('budget_cents', c.budget_cents, 'change_id', c.id, 'replayed', true);
    end if;
    raise exception 'this approval reference was already recorded with a different decision or evidence' using errcode = 'TW019';
  end if;
  -- the evidence is checked AFTER replay detection: an identical retry of a recorded decision always returns it (replayed), even once its evidence is no longer fresh
  perform public._tw4tc_check_evidence(p_entity_id, 'test_credit_budget', p_budget_cents, p_evidence_authorized_on, p_evidence_role, p_evidence_scope, p_evidence_amount_cents,
    p_evidence_period_key, p_evidence_document_ref, p_evidence_sha256);
  if p_budget_cents < b.granted_cents then
    raise exception 'the test budget cannot be set below the % cents already granted', b.granted_cents using errcode = 'TW071';
  end if;
  if exists (select 1 from public.studio_sms_test_credit_budget_changes x where x.document_sha256 = p_evidence_sha256) then
    raise exception 'this retained document already authorized another test budget: one document, one decision' using errcode = 'TW019';
  end if;
  perform public._tw4fi_register(p_approval_ref, 'test_credit_budget', p_entity_id, null, null, null, p_budget_cents, null, p_actor);
  perform set_config('tw4.testcredit_write', 'on', true);
  insert into public.studio_sms_test_credit_budget_changes (legal_entity_id, previous_cents, budget_cents, approval_ref, ref_norm, authorized_on, authorized_by_role, scope, amount_cents,
    period_key, document_ref, document_sha256, changed_by)
  values (p_entity_id, b.budget_cents, p_budget_cents, btrim(p_approval_ref), v_norm, p_evidence_authorized_on, p_evidence_role, p_evidence_scope, p_evidence_amount_cents,
    p_evidence_period_key, p_evidence_document_ref, p_evidence_sha256, p_actor) returning * into c;
  update public.studio_sms_test_credit_budgets set budget_cents = p_budget_cents, updated_at = clock_timestamp() where legal_entity_id = p_entity_id;
  perform set_config('tw4.testcredit_write', 'off', true);
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (public._tw4c_any_location(p_entity_id), null, 'platform_admin', p_actor, 'credit_test_budget_set',
          left('entity=' || p_entity_id || ';from=' || b.budget_cents || ';to=' || p_budget_cents || ';change=' || c.id || ';role=' || p_evidence_role || ';doc_sha=' || left(p_evidence_sha256, 12), 300));
  return jsonb_build_object('budget_cents', p_budget_cents, 'previous_cents', b.budget_cents, 'change_id', c.id, 'replayed', false);
end $$;

create or replace function public.tw4_credit_test_grant(p_entity_id uuid, p_cents int, p_approval_ref text, p_actor uuid,
  p_evidence_authorized_on date, p_evidence_role text, p_evidence_scope text, p_evidence_amount_cents int, p_evidence_period_key text, p_evidence_document_ref text, p_evidence_sha256 text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  b public.studio_sms_test_credit_budgets;
  g public.studio_sms_test_credit_grants;
  v_norm text;
  v_id uuid := gen_random_uuid();
  r jsonb;
begin
  perform public._tw4c_admin(p_actor);
  if p_entity_id is null or p_cents is null or p_cents <= 0 or p_cents > 50000 then
    raise exception 'a test grant is a positive whole number of cents' using errcode = '22023';
  end if;
  if p_approval_ref is null or char_length(btrim(p_approval_ref)) not between 10 and 200 then
    raise exception 'the written approval reference must be 10 to 200 characters' using errcode = '22023';
  end if;
  perform public._tw4tc_require_pilot(p_entity_id);
  a := public._tw4rfl_lock(p_entity_id);
  b := public._tw4tc_budget(p_entity_id);
  v_norm := public._tw4fi_ref_norm(p_approval_ref);
  -- idempotent per approval reference: the same grant with the same evidence replays (and changes nothing, even if the switch has since been turned off)
  select * into g from public.studio_sms_test_credit_grants x where x.ref_norm = v_norm;
  if g.id is not null then
    if g.legal_entity_id = p_entity_id and g.amount_cents = p_cents and g.granted_by = p_actor and g.authorized_on = p_evidence_authorized_on and g.authorized_by_role = p_evidence_role
       and g.period_key = p_evidence_period_key and g.document_ref = p_evidence_document_ref and g.document_sha256 = p_evidence_sha256 then
      return jsonb_build_object('grant_id', g.id, 'entry_id', g.ledger_entry_id, 'amount_cents', g.amount_cents, 'replayed', true);
    end if;
    raise exception 'this approval reference was already recorded with a different grant or evidence' using errcode = 'TW019';
  end if;
  -- the evidence is checked AFTER replay detection: an identical retry of a recorded grant always returns it (replayed), even once its evidence is no longer fresh
  perform public._tw4tc_check_evidence(p_entity_id, 'test_credit_grant', p_cents, p_evidence_authorized_on, p_evidence_role, p_evidence_scope, p_evidence_amount_cents,
    p_evidence_period_key, p_evidence_document_ref, p_evidence_sha256);
  -- the switch is read under a shared lock that tw4_credit_test_set_switch takes exclusively: a grant never commits after a concurrent switch-off it did not see
  perform pg_advisory_xact_lock_shared(hashtextextended('tw4tc_switch', 0));
  if not public._tw4tc_switch_on() then
    raise exception 'test credit grants are switched off' using errcode = 'TW070';
  end if;
  if a.hold or a.balance_cents < 0 then
    raise exception 'no test credit while the account is on hold or negative (test credit never pays an existing debt)' using errcode = 'TW007';
  end if;
  if b.granted_cents + p_cents > b.budget_cents then
    raise exception 'this grant exceeds the remaining test budget (% of % cents left)', b.budget_cents - b.granted_cents, b.budget_cents using errcode = 'TW071';
  end if;
  if exists (select 1 from public.studio_sms_test_credit_grants x where x.document_sha256 = p_evidence_sha256) then
    raise exception 'this retained document already authorized another test grant: one document, one grant' using errcode = 'TW019';
  end if;
  perform public._tw4fi_register(p_approval_ref, 'test_credit_grant', p_entity_id, null, null, null, p_cents, null, p_actor);
  perform set_config('tw4.testcredit_write', 'on', true);
  -- the ledger entry first (its key is the new grant id), then the grant that names it, then the movement that names both
  r := public._tw4c_post(p_entity_id, null, 'test_grant', p_cents, 0, 'test_grant:' || v_id, null, 'test_grant=' || v_id, p_actor, 'controlled test credit (texting only)');
  if (r ->> 'replayed')::boolean then
    raise exception 'test-credit ledger key collision' using errcode = '23505';
  end if;
  insert into public.studio_sms_test_credit_grants (id, legal_entity_id, amount_cents, approval_ref, ref_norm, authorized_on, authorized_by_role, scope, evidence_amount_cents, period_key,
    document_ref, document_sha256, ledger_entry_id, granted_by)
  values (v_id, p_entity_id, p_cents, btrim(p_approval_ref), v_norm, p_evidence_authorized_on, p_evidence_role, p_evidence_scope, p_evidence_amount_cents, p_evidence_period_key,
    p_evidence_document_ref, p_evidence_sha256, (r ->> 'entry_id')::uuid, p_actor);
  insert into public.studio_sms_test_credit_movements (legal_entity_id, ledger_entry_id, kind, cents, grant_id) values (p_entity_id, (r ->> 'entry_id')::uuid, 'grant', p_cents, v_id);
  update public.studio_sms_test_credit_budgets set granted_cents = granted_cents + p_cents, updated_at = clock_timestamp() where legal_entity_id = p_entity_id;
  perform set_config('tw4.testcredit_write', 'off', true);
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (public._tw4c_any_location(p_entity_id), null, 'platform_admin', p_actor, 'credit_test_grant',
          left('entity=' || p_entity_id || ';cents=' || p_cents || ';grant=' || v_id || ';role=' || p_evidence_role || ';doc_sha=' || left(p_evidence_sha256, 12), 300));
  return jsonb_build_object('grant_id', v_id, 'entry_id', r ->> 'entry_id', 'amount_cents', p_cents, 'replayed', false);
end $$;

create or replace function public.tw4_credit_test_reverse(p_entity_id uuid, p_cents int, p_key text, p_reason text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  b public.studio_sms_test_credit_budgets;
  o public.studio_sms_credit_ledger;
  v_unused bigint;
  r jsonb;
begin
  perform public._tw4c_admin(p_actor);
  if p_entity_id is null or p_cents is null or p_cents <= 0 then
    raise exception 'a reversal is a positive whole number of cents' using errcode = '22023';
  end if;
  if p_key is null or char_length(btrim(p_key)) not between 3 and 120 or p_reason is null or char_length(btrim(p_reason)) not between 10 and 280 then
    raise exception 'a reversal needs an operation key (3 to 120 characters) and a written reason (10 to 280 characters)' using errcode = '22023';
  end if;
  a := public._tw4rfl_lock(p_entity_id);
  -- a replay of the same reversal changes nothing; the same key with another amount is refused
  select * into o from public.studio_sms_credit_ledger l where l.legal_entity_id = p_entity_id and l.idempotency_key = 'test_reverse:' || btrim(p_key);
  if o.id is not null then
    if o.kind <> 'test_grant_reversed' or o.balance_delta_cents <> -p_cents then
      raise exception 'this reversal key was already used for another amount' using errcode = '23505';
    end if;
    return jsonb_build_object('entry_id', o.id, 'reversed_cents', p_cents, 'replayed', true);
  end if;
  select * into b from public.studio_sms_test_credit_budgets x where x.legal_entity_id = p_entity_id for update;
  v_unused := coalesce(b.granted_cents + b.restored_cents - b.consumed_cents - b.reversed_cents - b.forfeited_cents, 0);
  if p_cents > v_unused then
    raise exception 'only % cents of test credit are unused', v_unused using errcode = 'TW071';
  end if;
  if a.balance_cents - a.reserved_cents < p_cents then
    raise exception 'part of the unused test credit is held by an open reservation; wait for it to settle' using errcode = 'TW007';
  end if;
  perform set_config('tw4.testcredit_write', 'on', true);
  r := public._tw4c_post(p_entity_id, null, 'test_grant_reversed', -p_cents, 0, 'test_reverse:' || btrim(p_key), null, 'test_reverse', p_actor, btrim(p_reason));
  insert into public.studio_sms_test_credit_movements (legal_entity_id, ledger_entry_id, kind, cents) values (p_entity_id, (r ->> 'entry_id')::uuid, 'reverse', p_cents);
  update public.studio_sms_test_credit_budgets set reversed_cents = reversed_cents + p_cents, updated_at = clock_timestamp() where legal_entity_id = p_entity_id;
  perform set_config('tw4.testcredit_write', 'off', true);
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (public._tw4c_any_location(p_entity_id), null, 'platform_admin', p_actor, 'credit_test_reversal', left('entity=' || p_entity_id || ';cents=' || p_cents || ';entry=' || (r ->> 'entry_id'), 300));
  return jsonb_build_object('entry_id', r ->> 'entry_id', 'reversed_cents', p_cents, 'replayed', false);
end $$;

-- read-only verifier: counters, movements and ledger agree; the credit account itself verifies
create or replace function public.tw4_credit_test_status(p_entity_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  b public.studio_sms_test_credit_budgets;
  a public.studio_sms_credit_accounts;
  v_m jsonb;
  v_lg bigint;
  v_lr bigint;
  v_cv jsonb;
  v_unused bigint;
begin
  select * into b from public.studio_sms_test_credit_budgets x where x.legal_entity_id = p_entity_id;
  select * into a from public.studio_sms_credit_accounts x where x.legal_entity_id = p_entity_id;
  select jsonb_build_object(
      'grant', coalesce(sum(m.cents) filter (where m.kind = 'grant'), 0), 'consume', coalesce(sum(m.cents) filter (where m.kind = 'consume'), 0),
      'restore', coalesce(sum(m.cents) filter (where m.kind = 'restore'), 0), 'reverse', coalesce(sum(m.cents) filter (where m.kind = 'reverse'), 0),
      'forfeit', coalesce(sum(m.cents) filter (where m.kind = 'forfeit'), 0))
    into v_m from public.studio_sms_test_credit_movements m where m.legal_entity_id = p_entity_id;
  select coalesce(sum(l.balance_delta_cents) filter (where l.kind = 'test_grant'), 0), coalesce(-sum(l.balance_delta_cents) filter (where l.kind = 'test_grant_reversed'), 0)
    into v_lg, v_lr from public.studio_sms_credit_ledger l where l.legal_entity_id = p_entity_id;
  v_cv := public.tw4_credit_verify(p_entity_id);
  v_unused := coalesce(b.granted_cents + b.restored_cents - b.consumed_cents - b.reversed_cents - b.forfeited_cents, 0);
  return jsonb_build_object(
    'switch_enabled', public._tw4tc_switch_on(),
    'is_pilot', exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = p_entity_id),
    'budget_cents', coalesce(b.budget_cents, 0), 'granted_cents', coalesce(b.granted_cents, 0), 'budget_left_cents', coalesce(b.budget_cents - b.granted_cents, 0),
    'consumed_cents', coalesce(b.consumed_cents, 0), 'restored_cents', coalesce(b.restored_cents, 0), 'reversed_cents', coalesce(b.reversed_cents, 0), 'forfeited_cents', coalesce(b.forfeited_cents, 0), 'unused_cents', v_unused,
    'balance_cents', coalesce(a.balance_cents, 0), 'reserved_cents', coalesce(a.reserved_cents, 0),
    -- what fees may still use: the account's available credit minus the unused test credit that is NOT already held for a text in flight
    'non_test_available_cents', coalesce(a.balance_cents - a.reserved_cents, 0) - greatest(v_unused - public._tw4tc_open_sms(p_entity_id), 0),
    'open_texting_holds_cents', public._tw4tc_open_sms(p_entity_id),
    -- texting paid with DanceFlow test credit is NOT revenue: its customer-price value, and DanceFlow's estimated provider cost for it (from the active per-text
    -- price: unit_cost/unit_price micros when published in micros, else provider_cost/customer_price cents; rounded up; null without a price)
    'test_paid_texting_cents', coalesce(b.consumed_cents - b.restored_cents, 0),
    'test_paid_texting_provider_cost_estimate_cents', (
      select ceil(coalesce(b.consumed_cents - b.restored_cents, 0)::numeric
                  * coalesce(p.unit_cost_micros::numeric / nullif(p.unit_price_micros, 0), p.provider_cost_cents::numeric / nullif(p.customer_price_cents, 0)))::bigint
        from public.studio_sms_price_list p where p.kind = 'sms_usage' and p.active),
    'grants', (select count(*) from public.studio_sms_test_credit_grants g where g.legal_entity_id = p_entity_id),
    'ok', (v_m ->> 'grant')::bigint = coalesce(b.granted_cents, 0) and (v_m ->> 'consume')::bigint = coalesce(b.consumed_cents, 0)
          and (v_m ->> 'restore')::bigint = coalesce(b.restored_cents, 0) and (v_m ->> 'reverse')::bigint = coalesce(b.reversed_cents, 0)
          and (v_m ->> 'forfeit')::bigint = coalesce(b.forfeited_cents, 0)
          and v_lg = coalesce(b.granted_cents, 0) and v_lr = coalesce(b.reversed_cents, 0) + coalesce(b.forfeited_cents, 0) and (v_cv ->> 'ok')::boolean
          -- the unused test credit is always still there: never more than the balance minus the fee holds (texting holds are backed by test credit first)
          and v_unused <= greatest(coalesce(a.balance_cents - a.reserved_cents, 0) + public._tw4tc_open_sms(p_entity_id), 0));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 7. the studio-facing view and the purchase ceiling see test credit for what it is
--    * sms_credit_overview (authenticated, owner/admin of the location; body of 20261123 plus three fields): test_credit_cents (unused test credit, texting only),
--      fee_available_cents (what setup and monthly fees may use) and texting_available_cents (= available_cents, kept unchanged for existing readers).
--    * tw4_credit_topup_pending (body of 20261125): the $500 balance ceiling counts the business's OWN credit only; DanceFlow's test credit never blocks a purchase.
--    Both predecessor bodies are md5-pinned above the change; the rollback restores them byte-exactly.
-- ---------------------------------------------------------------------------------------------------------------
do $$
begin
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.sms_credit_overview(uuid)'::regprocedure), chr(13), '')) is distinct from '9c24016b4360b4a2ec382a9db97e09cd' then
    raise exception 'test-credit precondition failed: public.sms_credit_overview(uuid) differs from its 20261123 definition';
  end if;
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_credit_topup_pending(uuid,uuid,text,integer,timestamp with time zone)'::regprocedure), chr(13), '')) is distinct from '2c7f609f3496572caf8c2e99ffc94831' then
    raise exception 'test-credit precondition failed: public.tw4_credit_topup_pending differs from its 20261125 definition';
  end if;
end $$;

-- unused test credit of a business (0 without a test budget)
create or replace function public._tw4tc_unused(p_entity uuid)
returns bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select coalesce((select b.granted_cents + b.restored_cents - b.consumed_cents - b.reversed_cents - b.forfeited_cents
                          from public.studio_sms_test_credit_budgets b where b.legal_entity_id = p_entity), 0)::bigint; $$;
revoke all on function public._tw4tc_unused(uuid) from public, anon, authenticated, service_role;

create or replace function public.sms_credit_overview(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  v_entity uuid;
  v_test bigint;
begin
  if auth.uid() is null or coalesce(public._sms_onb_studio_role(p_studio_id), '') not in ('studio_owner', 'studio_admin') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    return jsonb_build_object('legal_business', false, 'balance_cents', 0, 'reserved_cents', 0, 'available_cents', 0, 'on_hold', false, 'low_balance', false, 'pending_topups_cents', 0, 'this_location_net_charges_cents', 0,
      'test_credit_cents', 0, 'fee_available_cents', 0, 'texting_available_cents', 0);
  end if;
  select * into a from public.studio_sms_credit_accounts x where x.legal_entity_id = v_entity;
  v_test := greatest(public._tw4tc_unused(v_entity), 0);
  return jsonb_build_object(
    'legal_business', true,
    'balance_cents', coalesce(a.balance_cents, 0), 'reserved_cents', coalesce(a.reserved_cents, 0),
    'available_cents', greatest(coalesce(a.balance_cents, 0) - coalesce(a.reserved_cents, 0), 0),
    'texting_available_cents', greatest(coalesce(a.balance_cents, 0) - coalesce(a.reserved_cents, 0), 0),
    -- DanceFlow test credit (texting only; never purchasable or refundable) and what setup and monthly fees may use
    'test_credit_cents', v_test,
    'fee_available_cents', greatest(coalesce(a.balance_cents, 0) - coalesce(a.reserved_cents, 0) - greatest(v_test - public._tw4tc_open_sms(v_entity), 0), 0),
    'on_hold', coalesce(a.hold, false), 'low_balance', a.low_balance_flagged_at is not null, 'low_balance_threshold_cents', coalesce(a.low_balance_threshold_cents, 1000),
    'pending_topups_cents', coalesce((select sum(t.amount_cents) from public.studio_sms_credit_topups t where t.legal_entity_id = v_entity and t.status = 'pending' and (t.expires_at is null or t.expires_at > now())), 0),
    'this_location_net_charges_cents', coalesce((select -sum(l.balance_delta_cents) from public.studio_sms_credit_ledger l
        where l.legal_entity_id = v_entity and l.studio_id = p_studio_id and l.kind in ('capture', 'usage_charge', 'usage_refund')), 0),
    'pilot_ceiling_cents', (select x.ceiling_cents from public.studio_sms_pilot_exceptions x where x.legal_entity_id = v_entity),
    'pilot_used_cents', coalesce((select sum(r.amount_cents) from public.studio_sms_credit_reservations r where r.legal_entity_id = v_entity and r.funding = 'pilot' and r.status in ('reserved', 'captured')), 0));
end $$;

create or replace function public.tw4_credit_topup_pending(p_entity_id uuid, p_paid_by_studio_id uuid, p_provider_ref text, p_amount_cents int, p_expires_at timestamptz default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  t public.studio_sms_credit_topups;
  v_pending bigint;
begin
  if p_expires_at is not null and (p_expires_at <= now() or p_expires_at > now() + interval '24 hours') then
    raise exception 'a checkout must expire within the next 24 hours' using errcode = '22023';
  end if;
  a := public._tw4c_lock(p_entity_id);
  select * into t from public.studio_sms_credit_topups x where x.provider = 'stripe' and x.provider_ref = p_provider_ref;
  if t.id is not null then
    if t.legal_entity_id <> p_entity_id or t.amount_cents <> p_amount_cents then
      raise exception 'this payment belongs to another legal business or amount' using errcode = '23505';
    end if;
    return jsonb_build_object('topup_id', t.id, 'status', t.status);
  end if;
  if a.hold then
    raise exception 'the credit account is on hold' using errcode = 'TW007'; -- re-checked under the account lock: a hold placed after the checkout context was read still wins
  end if;
  if p_amount_cents not in (2500, 5000, 10000) then
    raise exception 'top-ups are $25, $50 or $100 packs' using errcode = '22023';
  end if;
  select coalesce(sum(x.amount_cents), 0) into v_pending from public.studio_sms_credit_topups x
   where x.legal_entity_id = p_entity_id and x.status = 'pending' and (x.expires_at is null or x.expires_at > now());
  -- 20270223091000: the ceiling counts the business's own credit; unused DanceFlow test credit never blocks a purchase
  if a.balance_cents - public._tw4tc_unused(p_entity_id) + v_pending + p_amount_cents > 50000 then
    raise exception 'this top-up would exceed the $500 balance ceiling' using errcode = 'TW009';
  end if;
  insert into public.studio_sms_credit_topups (legal_entity_id, paid_by_studio_id, provider, provider_ref, amount_cents, expires_at)
  values (p_entity_id, p_paid_by_studio_id, 'stripe', p_provider_ref, p_amount_cents, p_expires_at) returning * into t;
  return jsonb_build_object('topup_id', t.id, 'status', t.status);
end $$;

revoke all on function public.tw4_credit_test_set_switch(boolean, uuid, text),
  public.tw4_credit_test_budget_set(uuid, int, text, uuid, date, text, text, int, text, text, text),
  public.tw4_credit_test_grant(uuid, int, text, uuid, date, text, text, int, text, text, text),
  public.tw4_credit_test_reverse(uuid, int, text, text, uuid),
  public.tw4_credit_test_status(uuid) from public, anon, authenticated;
grant execute on function public.tw4_credit_test_set_switch(boolean, uuid, text),
  public.tw4_credit_test_budget_set(uuid, int, text, uuid, date, text, text, int, text, text, text),
  public.tw4_credit_test_grant(uuid, int, text, uuid, date, text, text, int, text, text, text),
  public.tw4_credit_test_reverse(uuid, int, text, text, uuid),
  public.tw4_credit_test_status(uuid) to service_role;

commit;
