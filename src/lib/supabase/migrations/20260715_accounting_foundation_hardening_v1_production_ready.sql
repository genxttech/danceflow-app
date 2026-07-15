-- DanceFlow Accounting Foundation Hardening V1
-- Do not apply until the accompanying TypeScript/report/Wave changes are ready.
-- This migration is intentionally idempotent so it can canonicalize objects that
-- already exist in production but are missing from the repository.

begin;

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. Canonical accounting ledger
-- -----------------------------------------------------------------------------
create table if not exists public.accounting_entries (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid null,
  organizer_id uuid null,
  entry_date date not null,
  entry_type text not null,
  category text not null,
  direction text not null,
  gross_amount numeric not null default 0,
  fee_amount numeric not null default 0,
  refund_amount numeric not null default 0,
  net_amount numeric not null default 0,
  currency text not null default 'USD',
  payment_method text null,
  source_table text not null,
  source_id uuid not null,
  client_id uuid null,
  event_id uuid null,
  appointment_id uuid null,
  external_reference text null,
  stripe_payment_intent_id text null,
  stripe_charge_id text null,
  stripe_invoice_id text null,
  description text null,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid null,
  posted_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.accounting_entries
  add column if not exists entry_status text not null default 'active',
  add column if not exists voided_at timestamptz null,
  add column if not exists voided_by uuid null,
  add column if not exists void_reason text null,
  add column if not exists reverses_entry_id uuid null,
  add column if not exists locked_at timestamptz null,
  add column if not exists locked_by uuid null;

alter table public.accounting_entries
  drop constraint if exists accounting_entries_direction_check;
alter table public.accounting_entries
  add constraint accounting_entries_direction_check
  check (direction in ('debit', 'credit')) not valid;
alter table public.accounting_entries
  validate constraint accounting_entries_direction_check;

alter table public.accounting_entries
  drop constraint if exists accounting_entries_entry_status_check;
alter table public.accounting_entries
  add constraint accounting_entries_entry_status_check
  check (entry_status in ('active', 'voided', 'reversal')) not valid;
alter table public.accounting_entries
  validate constraint accounting_entries_entry_status_check;

alter table public.accounting_entries
  drop constraint if exists accounting_entries_workspace_check;
alter table public.accounting_entries
  add constraint accounting_entries_workspace_check
  check (studio_id is not null or organizer_id is not null) not valid;
alter table public.accounting_entries
  validate constraint accounting_entries_workspace_check;

create unique index if not exists accounting_entries_source_unique
  on public.accounting_entries (source_table, source_id, entry_type, category);
create index if not exists idx_accounting_entries_studio_date
  on public.accounting_entries (studio_id, entry_date desc);
create index if not exists idx_accounting_entries_organizer_date
  on public.accounting_entries (organizer_id, entry_date desc);
create index if not exists idx_accounting_entries_source
  on public.accounting_entries (source_table, source_id);
create index if not exists idx_accounting_entries_category
  on public.accounting_entries (category);
create index if not exists idx_accounting_entries_status_date
  on public.accounting_entries (entry_status, entry_date desc);

-- -----------------------------------------------------------------------------
-- 2. Provider-neutral category catalog
-- -----------------------------------------------------------------------------
-- This table already exists in some environments with the legacy columns:
-- key, label, entry_type, normal_balance, active, sort_order, created_at.
-- Upgrade it in place so existing code and data remain compatible.
create table if not exists public.accounting_categories (
  key text primary key,
  label text not null,
  entry_type text not null default 'adjustment',
  normal_balance text not null default 'debit',
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);

alter table public.accounting_categories
  alter column entry_type set default 'adjustment',
  alter column normal_balance set default 'debit';

alter table public.accounting_categories
  add column if not exists entry_class text null,
  add column if not exists statement_section text null,
  add column if not exists normal_direction text null,
  add column if not exists allowed_external_account_types text[] not null default '{}',
  add column if not exists blocks_auto_post_when_unmapped boolean not null default true,
  add column if not exists updated_at timestamptz not null default now();

-- Populate the new provider-neutral fields for legacy rows before constraints.
update public.accounting_categories
set
  entry_class = coalesce(
    entry_class,
    case
      when entry_type = 'revenue' then 'revenue'
      when entry_type = 'refund' then 'refund'
      when entry_type in ('processing_fee', 'platform_fee') then 'fee'
      when entry_type = 'expense' then 'expense'
      when entry_type = 'credit_applied' then 'liability'
      else 'adjustment'
    end
  ),
  statement_section = coalesce(
    statement_section,
    case
      when entry_type = 'revenue' then 'income'
      when entry_type = 'refund' then 'contra_income'
      when entry_type in ('processing_fee', 'platform_fee', 'expense') then 'expense'
      when entry_type = 'credit_applied' then 'liability'
      else 'equity'
    end
  ),
  normal_direction = coalesce(normal_direction, normal_balance),
  updated_at = coalesce(updated_at, now());

alter table public.accounting_categories
  alter column entry_class set not null,
  alter column statement_section set not null,
  alter column normal_direction set not null;

alter table public.accounting_categories
  drop constraint if exists accounting_categories_entry_class_check;
alter table public.accounting_categories
  add constraint accounting_categories_entry_class_check
  check (entry_class in ('revenue', 'refund', 'fee', 'expense', 'asset', 'liability', 'equity', 'adjustment')) not valid;
alter table public.accounting_categories
  validate constraint accounting_categories_entry_class_check;

alter table public.accounting_categories
  drop constraint if exists accounting_categories_statement_section_check;
alter table public.accounting_categories
  add constraint accounting_categories_statement_section_check
  check (statement_section in ('income', 'contra_income', 'cost_of_sales', 'expense', 'asset', 'liability', 'equity', 'clearing')) not valid;
alter table public.accounting_categories
  validate constraint accounting_categories_statement_section_check;

alter table public.accounting_categories
  drop constraint if exists accounting_categories_direction_check;
alter table public.accounting_categories
  add constraint accounting_categories_direction_check
  check (normal_direction in ('debit', 'credit')) not valid;
alter table public.accounting_categories
  validate constraint accounting_categories_direction_check;

insert into public.accounting_categories (
  key, label, entry_class, statement_section, normal_direction,
  allowed_external_account_types, blocks_auto_post_when_unmapped
)
values
  ('private_lesson_revenue', 'Private Lesson Revenue', 'revenue', 'income', 'credit', array['INCOME','REVENUE'], true),
  ('group_class_revenue', 'Group Class Revenue', 'revenue', 'income', 'credit', array['INCOME','REVENUE'], true),
  ('package_revenue', 'Package Revenue', 'revenue', 'income', 'credit', array['INCOME','REVENUE','LIABILITY'], true),
  ('membership_revenue', 'Membership Revenue', 'revenue', 'income', 'credit', array['INCOME','REVENUE','LIABILITY'], true),
  ('event_ticket_revenue', 'Event Ticket Revenue', 'revenue', 'income', 'credit', array['INCOME','REVENUE','LIABILITY'], true),
  ('coach_private_lesson_revenue', 'Coach Private Lesson Revenue', 'revenue', 'income', 'credit', array['INCOME','REVENUE'], true),
  ('floor_rental_revenue', 'Floor Rental Revenue', 'revenue', 'income', 'credit', array['INCOME','REVENUE'], true),
  ('practice_party_revenue', 'Practice Party Revenue', 'revenue', 'income', 'credit', array['INCOME','REVENUE'], true),
  ('other_revenue', 'Other Revenue', 'revenue', 'income', 'credit', array['INCOME','REVENUE'], true),
  ('unclassified_revenue', 'Unclassified Revenue', 'revenue', 'income', 'credit', array['INCOME','REVENUE'], true),
  ('client_payment_refund', 'Client Payment Refund', 'refund', 'contra_income', 'debit', array['INCOME','REVENUE','EXPENSE'], true),
  ('package_refund', 'Package Refund', 'refund', 'contra_income', 'debit', array['INCOME','REVENUE','EXPENSE'], true),
  ('membership_refund', 'Membership Refund', 'refund', 'contra_income', 'debit', array['INCOME','REVENUE','EXPENSE'], true),
  ('floor_rental_refund', 'Floor Rental Refund', 'refund', 'contra_income', 'debit', array['INCOME','REVENUE','EXPENSE'], true),
  ('event_ticket_refund', 'Event Ticket Refund', 'refund', 'contra_income', 'debit', array['INCOME','REVENUE','EXPENSE'], true),
  ('other_refund', 'Other Refund', 'refund', 'contra_income', 'debit', array['INCOME','REVENUE','EXPENSE'], true),
  ('stripe_processing_fee', 'Stripe Processing Fee', 'fee', 'expense', 'debit', array['EXPENSE'], true),
  ('danceflow_platform_fee', 'DanceFlow Platform Fee', 'fee', 'expense', 'debit', array['EXPENSE'], true),
  ('organizer_platform_fee', 'Organizer Platform Fee', 'fee', 'expense', 'debit', array['EXPENSE'], true),
  ('floor_fee_expense', 'Floor Fee Expense', 'expense', 'expense', 'debit', array['EXPENSE'], true),
  ('rent_expense', 'Rent Expense', 'expense', 'expense', 'debit', array['EXPENSE'], true),
  ('instructor_pay_expense', 'Instructor Pay Expense', 'expense', 'expense', 'debit', array['EXPENSE'], true),
  ('marketing_expense', 'Marketing Expense', 'expense', 'expense', 'debit', array['EXPENSE'], true),
  ('software_expense', 'Software Expense', 'expense', 'expense', 'debit', array['EXPENSE'], true),
  ('supplies_expense', 'Supplies Expense', 'expense', 'expense', 'debit', array['EXPENSE'], true),
  ('costumes_retail_inventory_expense', 'Costumes / Retail Inventory Expense', 'expense', 'expense', 'debit', array['EXPENSE','ASSET'], true),
  ('event_expense', 'Event Expense', 'expense', 'expense', 'debit', array['EXPENSE','COST_OF_GOODS_SOLD'], true),
  ('event_labor_expense', 'Event Labor Expense', 'expense', 'expense', 'debit', array['EXPENSE','COST_OF_GOODS_SOLD'], true),
  ('travel_expense', 'Travel Expense', 'expense', 'expense', 'debit', array['EXPENSE'], true),
  ('meals_expense', 'Meals Expense', 'expense', 'expense', 'debit', array['EXPENSE'], true),
  ('utilities_expense', 'Utilities Expense', 'expense', 'expense', 'debit', array['EXPENSE'], true),
  ('insurance_expense', 'Insurance Expense', 'expense', 'expense', 'debit', array['EXPENSE'], true),
  ('professional_services_expense', 'Professional Services Expense', 'expense', 'expense', 'debit', array['EXPENSE'], true),
  ('other_expense', 'Other Expense', 'expense', 'expense', 'debit', array['EXPENSE'], true),
  ('contract_labor_expense', 'Contract Labor Expense', 'expense', 'expense', 'debit', array['EXPENSE'], true),
  ('employee_wage_expense', 'Employee Wage Expense', 'expense', 'expense', 'debit', array['EXPENSE'], true),
  ('payroll_tax_expense', 'Payroll Tax Expense', 'expense', 'expense', 'debit', array['EXPENSE'], true),
  ('accrued_compensation_liability', 'Accrued Compensation Liability', 'liability', 'liability', 'credit', array['LIABILITY'], true),
  ('payroll_tax_liability', 'Payroll Tax Liability', 'liability', 'liability', 'credit', array['LIABILITY'], true),
  ('employee_withholding_liability', 'Employee Withholding Liability', 'liability', 'liability', 'credit', array['LIABILITY'], true),
  ('reimbursement_payable', 'Reimbursement Payable', 'liability', 'liability', 'credit', array['LIABILITY'], true),
  ('payroll_cash_clearing', 'Payroll Cash Clearing', 'asset', 'clearing', 'credit', array['ASSET','BANK'], true),
  ('account_credit', 'Account Credit', 'liability', 'liability', 'credit', array['LIABILITY'], true),
  ('manual_adjustment', 'Manual Adjustment', 'adjustment', 'equity', 'debit', array['ASSET','LIABILITY','EQUITY','INCOME','REVENUE','EXPENSE'], true)
on conflict (key) do update set
  label = excluded.label,
  entry_class = excluded.entry_class,
  statement_section = excluded.statement_section,
  normal_direction = excluded.normal_direction,
  allowed_external_account_types = excluded.allowed_external_account_types,
  blocks_auto_post_when_unmapped = excluded.blocks_auto_post_when_unmapped,
  active = true,
  updated_at = now();

-- Keep the legacy catalog fields accurate for existing readers.
update public.accounting_categories
set
  entry_type = case
    when key = 'stripe_processing_fee' then 'processing_fee'
    when key in ('danceflow_platform_fee', 'organizer_platform_fee') then 'platform_fee'
    when key = 'account_credit' then 'credit_applied'
    when entry_class = 'revenue' then 'revenue'
    when entry_class = 'refund' then 'refund'
    when entry_class = 'expense' then 'expense'
    else 'adjustment'
  end,
  normal_balance = normal_direction,
  sort_order = case
    when entry_class = 'revenue' then 100
    when entry_class = 'refund' then 200
    when entry_class = 'fee' then 300
    when entry_class = 'expense' then 400
    when entry_class in ('asset', 'liability', 'equity') then 500
    else 600
  end,
  updated_at = now();

-- -----------------------------------------------------------------------------
-- 3. Operational records carry a durable accounting category
-- -----------------------------------------------------------------------------
alter table public.payments
  add column if not exists accounting_category text null;
alter table public.expenses
  add column if not exists accounting_category text null,
  add column if not exists voided_at timestamptz null,
  add column if not exists voided_by uuid null,
  add column if not exists void_reason text null;

create index if not exists idx_payments_accounting_category
  on public.payments (studio_id, accounting_category);
create index if not exists idx_expenses_accounting_category
  on public.expenses (studio_id, accounting_category);

-- Historical classifications confirmed during the production audit.
-- These updates intentionally classify the payments only. They do not invent
-- client_membership_id relationships that were not persisted by the source flow.
update public.payments
set accounting_category = 'membership_revenue'
where id in (
  'dfd44091-508e-4c1b-8eee-1cba04b01ef8'::uuid,
  'b9f300be-d7f4-4d50-83d9-4b3b1ae5f396'::uuid,
  'b4f80b95-e19e-4468-a468-f153a7b0d670'::uuid,
  '6c12aaf1-74f6-40f5-b896-1b9206556cb8'::uuid,
  '965621a5-ef84-42a7-a4fd-e3f62c8125d5'::uuid
);

update public.payments set accounting_category = 'package_revenue'
where id in (
  'f51e9ff8-e3cc-409e-b539-2db490424d15'::uuid,
  'ea48b156-8988-460f-9de8-55f81073bbac'::uuid
);
update public.payments set accounting_category = 'private_lesson_revenue'
where id in (
  'fa3b6ba9-3d2e-420d-ab1a-941694e3563c'::uuid,
  'b7117d2b-2bff-4c8e-b5b8-2724f318842d'::uuid
);
update public.payments set accounting_category = 'coach_private_lesson_revenue'
where id = '9dbc2e60-c4ab-4621-a1dd-7ecec5a29873'::uuid;

update public.payments
set accounting_category = case
  when accounting_category is not null then accounting_category
  when payment_type::text = 'package_sale' or client_package_id is not null then 'package_revenue'
  when payment_type::text = 'membership' or client_membership_id is not null then 'membership_revenue'
  when payment_type::text in ('lesson_payment', 'private_lesson') then 'private_lesson_revenue'
  when payment_type::text = 'floor_rental' or source::text ilike '%floor%' then 'floor_rental_revenue'
  else 'unclassified_revenue'
end
where status::text in ('paid', 'refunded');

update public.expenses
set accounting_category = case lower(coalesce(category::text, 'other'))
  when 'floor_fee' then 'floor_fee_expense'
  when 'rent' then 'rent_expense'
  when 'instructor_pay' then 'instructor_pay_expense'
  when 'marketing' then 'marketing_expense'
  when 'software' then 'software_expense'
  when 'supplies' then 'supplies_expense'
  when 'costumes_retail_inventory' then 'costumes_retail_inventory_expense'
  when 'event_expense' then 'event_expense'
  when 'event_cost' then 'event_expense'
  when 'event' then 'event_expense'
  when 'event_costs' then 'event_expense'
  when 'travel' then 'travel_expense'
  when 'meals' then 'meals_expense'
  when 'utilities' then 'utilities_expense'
  when 'insurance' then 'insurance_expense'
  when 'professional_services' then 'professional_services_expense'
  else 'other_expense'
end
where accounting_category is null;

-- -----------------------------------------------------------------------------
-- 4. Ledger write helpers
-- -----------------------------------------------------------------------------
create or replace function public.accounting_assert_entry_mutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.locked_at is not null then
    raise exception 'Locked accounting entries cannot be updated or deleted.';
  end if;

  if old.posted_at is not null and tg_op = 'DELETE' then
    raise exception 'Posted accounting entries cannot be deleted. Create a reversal instead.';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_accounting_entries_mutability on public.accounting_entries;
create trigger trg_accounting_entries_mutability
before update or delete on public.accounting_entries
for each row execute function public.accounting_assert_entry_mutable();

create or replace function public.accounting_mark_source_voided(
  p_source_table text,
  p_source_id uuid,
  p_reason text default null
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.accounting_entries
  set entry_status = 'voided',
      voided_at = coalesce(voided_at, now()),
      void_reason = coalesce(p_reason, void_reason, 'Source record is no longer accounting-active.'),
      updated_at = now()
  where source_table = p_source_table
    and source_id = p_source_id
    and entry_status = 'active'
    and locked_at is null;
$$;

create or replace function public.accounting_upsert_entry(
  p_studio_id uuid,
  p_organizer_id uuid,
  p_entry_date date,
  p_entry_type text,
  p_category text,
  p_direction text,
  p_gross_amount numeric,
  p_fee_amount numeric,
  p_refund_amount numeric,
  p_net_amount numeric,
  p_currency text,
  p_payment_method text,
  p_source_table text,
  p_source_id uuid,
  p_client_id uuid default null,
  p_event_id uuid default null,
  p_appointment_id uuid default null,
  p_external_reference text default null,
  p_stripe_payment_intent_id text default null,
  p_stripe_charge_id text default null,
  p_stripe_invoice_id text default null,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_created_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry_id uuid;
begin
  if p_studio_id is null and p_organizer_id is null then
    raise exception 'Accounting entry requires a studio or organizer workspace.';
  end if;

  update public.accounting_entries
  set
    entry_status = 'voided',
    voided_at = coalesce(voided_at, now()),
    void_reason = coalesce(
      void_reason,
      format('Reclassified from %s to %s.', category, p_category)
    ),
    updated_at = now()
  where source_table = p_source_table
    and source_id = p_source_id
    and entry_type = p_entry_type
    and category <> p_category
    and entry_status = 'active'
    and locked_at is null;

  if not exists (
    select 1 from public.accounting_categories c
    where c.key = p_category and c.active = true
  ) then
    raise exception 'Unknown accounting category: %', p_category;
  end if;

  insert into public.accounting_entries (
    studio_id, organizer_id, entry_date, entry_type, category, direction,
    gross_amount, fee_amount, refund_amount, net_amount, currency,
    payment_method, source_table, source_id, client_id, event_id,
    appointment_id, external_reference, stripe_payment_intent_id,
    stripe_charge_id, stripe_invoice_id, description, metadata, created_by,
    entry_status, voided_at, voided_by, void_reason, updated_at
  ) values (
    p_studio_id, p_organizer_id, p_entry_date, p_entry_type, p_category, p_direction,
    abs(coalesce(p_gross_amount, 0)), abs(coalesce(p_fee_amount, 0)),
    abs(coalesce(p_refund_amount, 0)), abs(coalesce(p_net_amount, 0)),
    upper(coalesce(nullif(trim(p_currency), ''), 'USD')),
    p_payment_method, p_source_table, p_source_id, p_client_id, p_event_id,
    p_appointment_id, p_external_reference, p_stripe_payment_intent_id,
    p_stripe_charge_id, p_stripe_invoice_id, p_description,
    coalesce(p_metadata, '{}'::jsonb), p_created_by,
    'active', null, null, null, now()
  )
  on conflict (source_table, source_id, entry_type, category)
  do update set
    studio_id = excluded.studio_id,
    organizer_id = excluded.organizer_id,
    entry_date = excluded.entry_date,
    direction = excluded.direction,
    gross_amount = excluded.gross_amount,
    fee_amount = excluded.fee_amount,
    refund_amount = excluded.refund_amount,
    net_amount = excluded.net_amount,
    currency = excluded.currency,
    payment_method = excluded.payment_method,
    client_id = excluded.client_id,
    event_id = excluded.event_id,
    appointment_id = excluded.appointment_id,
    external_reference = excluded.external_reference,
    stripe_payment_intent_id = excluded.stripe_payment_intent_id,
    stripe_charge_id = excluded.stripe_charge_id,
    stripe_invoice_id = excluded.stripe_invoice_id,
    description = excluded.description,
    metadata = excluded.metadata,
    created_by = excluded.created_by,
    entry_status = 'active',
    voided_at = null,
    voided_by = null,
    void_reason = null,
    updated_at = now()
  where public.accounting_entries.locked_at is null
  returning id into v_entry_id;

  return v_entry_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Standard payment synchronization
-- -----------------------------------------------------------------------------
create or replace function public.sync_payment_accounting_entry_row(p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.payments%rowtype;
  v_category text;
  v_refund_category text;
  v_entry_date date;
  v_processing_fee numeric;
  v_platform_fee numeric;
begin
  select * into p from public.payments where id = p_payment_id;

  if not found then
    perform public.accounting_mark_source_voided('payments', p_payment_id, 'Payment source was deleted.');
    return;
  end if;

  if p.status::text not in ('paid', 'refunded') then
    perform public.accounting_mark_source_voided('payments', p.id, 'Payment is not paid or refunded.');
    return;
  end if;

  perform public.accounting_mark_source_voided('payments', p.id, 'Payment accounting entry refreshed.');

  v_category := coalesce(nullif(p.accounting_category, ''), 'unclassified_revenue');
  v_entry_date := coalesce(p.paid_at::date, p.created_at::date, current_date);
  v_processing_fee := greatest(coalesce(p.stripe_processing_fee_amount, 0), 0);
  v_platform_fee := greatest(
    case when coalesce(p.platform_fee_amount, 0) > 0
      then p.platform_fee_amount
      else coalesce(p.stripe_application_fee_amount, 0)
    end,
    0
  );

  perform public.accounting_upsert_entry(
    p.studio_id, null, v_entry_date, 'revenue', v_category, 'credit',
    p.amount, 0, 0, p.amount, p.currency::text, p.payment_method::text,
    'payments', p.id, p.client_id, null, p.appointment_id,
    coalesce(p.external_reference, p.external_payment_id),
    p.stripe_payment_intent_id, p.stripe_charge_id, p.stripe_invoice_id,
    coalesce(nullif(p.notes, ''), 'DanceFlow client payment'),
    jsonb_build_object(
      'payment_type', p.payment_type,
      'source', p.source,
      'client_package_id', p.client_package_id,
      'client_membership_id', p.client_membership_id,
      'stripe_balance_transaction_id', p.stripe_balance_transaction_id
    ),
    null
  );

  if coalesce(p.refund_amount, 0) > 0 then
    v_refund_category := case v_category
      when 'package_revenue' then 'package_refund'
      when 'membership_revenue' then 'membership_refund'
      when 'floor_rental_revenue' then 'floor_rental_refund'
      else 'client_payment_refund'
    end;

    perform public.accounting_upsert_entry(
      p.studio_id, null, coalesce(p.refunded_at::date, v_entry_date),
      'refund', v_refund_category, 'debit', 0, 0, p.refund_amount,
      p.refund_amount, p.currency::text, p.payment_method::text,
      'payments', p.id, p.client_id, null, p.appointment_id,
      coalesce(p.stripe_refund_id, p.external_reference, p.external_payment_id),
      p.stripe_payment_intent_id, p.stripe_charge_id, p.stripe_invoice_id,
      'Refund for DanceFlow client payment',
      jsonb_build_object('original_category', v_category, 'stripe_refund_id', p.stripe_refund_id),
      null
    );
  end if;

  if v_processing_fee > 0 then
    perform public.accounting_upsert_entry(
      p.studio_id, null, v_entry_date, 'processing_fee', 'stripe_processing_fee', 'debit',
      0, v_processing_fee, 0, v_processing_fee, p.currency::text, p.payment_method::text,
      'payments', p.id, p.client_id, null, p.appointment_id,
      p.stripe_balance_transaction_id, p.stripe_payment_intent_id,
      p.stripe_charge_id, p.stripe_invoice_id, 'Stripe processing fee',
      jsonb_build_object('revenue_category', v_category), null
    );
  end if;

  if v_platform_fee > 0 then
    perform public.accounting_upsert_entry(
      p.studio_id, null, v_entry_date, 'platform_fee', 'danceflow_platform_fee', 'debit',
      0, v_platform_fee, 0, v_platform_fee, p.currency::text, p.payment_method::text,
      'payments', p.id, p.client_id, null, p.appointment_id,
      coalesce(p.external_reference, p.external_payment_id), p.stripe_payment_intent_id,
      p.stripe_charge_id, p.stripe_invoice_id, 'DanceFlow platform fee',
      jsonb_build_object('revenue_category', v_category), null
    );
  end if;
end;
$$;

create or replace function public.sync_payment_accounting_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.accounting_mark_source_voided('payments', old.id, 'Payment source was deleted.');
    return old;
  end if;

  perform public.sync_payment_accounting_entry_row(new.id);
  return new;
end;
$$;

drop trigger if exists trg_sync_payment_accounting_entry on public.payments;
create trigger trg_sync_payment_accounting_entry
after insert or update of
  status, amount, currency, payment_method, payment_type, source, notes,
  paid_at, client_id, appointment_id, client_package_id, client_membership_id,
  accounting_category, external_payment_id, external_reference,
  stripe_payment_intent_id, stripe_charge_id, stripe_invoice_id,
  stripe_processing_fee_amount, stripe_application_fee_amount,
  platform_fee_amount, stripe_balance_transaction_id, refund_amount,
  refunded_at, stripe_refund_id
on public.payments
for each row execute function public.sync_payment_accounting_entry();

-- -----------------------------------------------------------------------------
-- 6. Expense synchronization
-- -----------------------------------------------------------------------------
create or replace function public.sync_expense_accounting_entry_row(p_expense_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.expenses%rowtype;
begin
  select * into e from public.expenses where id = p_expense_id;

  if not found then
    perform public.accounting_mark_source_voided('expenses', p_expense_id, 'Expense source was deleted.');
    return;
  end if;

  if e.voided_at is not null then
    perform public.accounting_mark_source_voided('expenses', e.id, coalesce(e.void_reason, 'Expense was voided.'));
    return;
  end if;

  perform public.accounting_upsert_entry(
    e.studio_id, null, e.expense_date, 'expense',
    coalesce(nullif(e.accounting_category, ''), 'other_expense'), 'debit',
    e.amount, 0, 0, e.amount, e.currency::text, e.payment_method::text,
    'expenses', e.id, e.related_client_id, e.related_event_id,
    e.related_appointment_id, null, null, null, null,
    concat_ws(' - ', nullif(e.vendor_name, ''), nullif(e.notes, '')),
    jsonb_build_object('expense_category', e.category), e.recorded_by
  );
end;
$$;

create or replace function public.sync_expense_accounting_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.accounting_mark_source_voided('expenses', old.id, 'Expense source was deleted.');
    return old;
  end if;

  perform public.sync_expense_accounting_entry_row(new.id);
  return new;
end;
$$;

drop trigger if exists trg_sync_expense_accounting_entry on public.expenses;
create trigger trg_sync_expense_accounting_entry
after insert or update of
  expense_date, vendor_name, category, accounting_category, amount, currency,
  payment_method, related_event_id, related_client_id,
  related_appointment_id, notes, voided_at, void_reason
on public.expenses
for each row execute function public.sync_expense_accounting_entry();

-- -----------------------------------------------------------------------------
-- 7. Canonicalize existing event synchronization without deleting history
-- -----------------------------------------------------------------------------
create or replace function public.sync_event_payment_accounting_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_studio_id uuid;
  v_organizer_id uuid;
  v_fee_amount numeric;
  v_refund_amount numeric;
  v_net_amount numeric;
begin
  if tg_op = 'DELETE' then
    perform public.accounting_mark_source_voided('event_payments', old.id, 'Event payment source was deleted.');
    return old;
  end if;

  if new.status::text is distinct from 'paid' then
    perform public.accounting_mark_source_voided('event_payments', new.id, 'Event payment is not paid.');
    return new;
  end if;

  v_event_id := new.event_id;

  if new.registration_id is not null then
    select er.event_id, er.studio_id
      into v_event_id, v_studio_id
    from public.event_registrations er
    where er.id = new.registration_id
    limit 1;
  end if;

  if v_studio_id is null and v_organizer_id is null then
    select eo.studio_id, eo.organizer_id, coalesce(v_event_id, eo.event_id)
      into v_studio_id, v_organizer_id, v_event_id
    from public.event_orders eo
    where (new.stripe_checkout_session_id is not null and eo.stripe_checkout_session_id = new.stripe_checkout_session_id)
       or (new.stripe_payment_intent_id is not null and eo.stripe_payment_intent_id = new.stripe_payment_intent_id)
    limit 1;
  end if;

  if v_event_id is not null and v_studio_id is null and v_organizer_id is null then
    select e.studio_id, e.organizer_id into v_studio_id, v_organizer_id
    from public.events e where e.id = v_event_id limit 1;
  end if;

  if v_studio_id is null and v_organizer_id is null then
    return new;
  end if;

  v_fee_amount := coalesce(new.stripe_processing_fee_amount, 0)
    + coalesce(new.stripe_application_fee_amount, 0)
    + coalesce(new.platform_fee_amount, 0);
  v_refund_amount := coalesce(new.refund_amount, 0);
  v_net_amount := coalesce(new.amount, 0) - v_fee_amount - v_refund_amount;

  perform public.accounting_upsert_entry(
    v_studio_id, v_organizer_id, coalesce(new.created_at::date, current_date),
    'revenue', 'event_ticket_revenue', 'credit', new.amount, v_fee_amount,
    v_refund_amount, v_net_amount, new.currency::text, new.payment_method::text,
    'event_payments', new.id, null, v_event_id, null,
    coalesce(new.stripe_payment_intent_id, new.processor_payment_intent_id,
      new.external_reference, new.processor_reference),
    coalesce(new.stripe_payment_intent_id, new.processor_payment_intent_id),
    coalesce(new.stripe_charge_id, new.processor_charge_id), new.stripe_invoice_id,
    'Event ticket revenue',
    jsonb_build_object(
      'event_payment_id', new.id,
      'registration_id', new.registration_id,
      'stripe_checkout_session_id', new.stripe_checkout_session_id,
      'stripe_balance_transaction_id', new.stripe_balance_transaction_id,
      'stripe_refund_id', new.stripe_refund_id,
      'stripe_processing_fee_amount', new.stripe_processing_fee_amount,
      'stripe_application_fee_amount', new.stripe_application_fee_amount,
      'platform_fee_amount', new.platform_fee_amount,
      'processor_reference', new.processor_reference,
      'source', new.source
    ), null
  );

  return new;
end;
$$;

drop trigger if exists trg_sync_event_payment_accounting_entry on public.event_payments;
create trigger trg_sync_event_payment_accounting_entry
after insert or update or delete on public.event_payments
for each row execute function public.sync_event_payment_accounting_entry();

create or replace function public.sync_event_labor_accounting_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_studio_id uuid;
  v_organizer_id uuid;
begin
  if tg_op = 'DELETE' then
    perform public.accounting_mark_source_voided('event_labor_costs', old.id, 'Event labor source was deleted.');
    return old;
  end if;

  if new.status = 'cancelled' then
    perform public.accounting_mark_source_voided('event_labor_costs', new.id, 'Event labor was cancelled.');
    return new;
  end if;

  v_studio_id := new.studio_id;
  v_organizer_id := new.organizer_id;

  if v_studio_id is null and v_organizer_id is null then
    select e.studio_id, e.organizer_id into v_studio_id, v_organizer_id
    from public.events e where e.id = new.event_id limit 1;
  end if;

  if v_studio_id is null and v_organizer_id is null then return new; end if;

  perform public.accounting_upsert_entry(
    v_studio_id, v_organizer_id, new.labor_date, 'expense',
    'event_labor_expense', 'debit', new.total_amount, 0, 0, new.total_amount,
    new.currency::text, 'manual', 'event_labor_costs', new.id, null,
    new.event_id, null, null, null, null, null,
    concat_ws(' - ', nullif(new.staff_name, ''), nullif(new.role, ''), nullif(new.notes, '')),
    jsonb_build_object(
      'event_labor_cost_id', new.id,
      'staff_user_id', new.staff_user_id,
      'instructor_id', new.instructor_id,
      'staff_name', new.staff_name,
      'role', new.role,
      'pay_type', new.pay_type,
      'rate_amount', new.rate_amount,
      'hours', new.hours,
      'quantity', new.quantity,
      'status', new.status
    ), new.created_by
  );

  return new;
end;
$$;

drop trigger if exists trg_sync_event_labor_accounting_entry on public.event_labor_costs;
create trigger trg_sync_event_labor_accounting_entry
after insert or update or delete on public.event_labor_costs
for each row execute function public.sync_event_labor_accounting_entry();

-- -----------------------------------------------------------------------------
-- 8. Idempotent historical backfill
-- -----------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select id from public.payments where status::text in ('paid', 'refunded') loop
    perform public.sync_payment_accounting_entry_row(r.id);
  end loop;

  for r in select id from public.expenses loop
    perform public.sync_expense_accounting_entry_row(r.id);
  end loop;

  update public.accounting_entries ae
  set
    entry_status = 'voided',
    voided_at = coalesce(ae.voided_at, now()),
    void_reason = coalesce(
      ae.void_reason,
      'Superseded by the current expense accounting classification.'
    ),
    updated_at = now()
  from public.expenses e
  where ae.source_table = 'expenses'
    and ae.source_id = e.id
    and ae.entry_type = 'expense'
    and ae.entry_status = 'active'
    and ae.category <> coalesce(nullif(e.accounting_category, ''), 'other_expense')
    and ae.locked_at is null;

  -- Existing event payment rows are already represented in accounting_entries.
  -- event_payments has no updated_at column, so V1 does not use synthetic updates
  -- to replay its trigger. Future inserts and updates are synchronized by the
  -- canonical trigger above. There are currently no event labor rows to backfill.
end $$;

-- -----------------------------------------------------------------------------
-- 9. RLS: authenticated users can read; ledger writes flow through controlled
--    server actions and SECURITY DEFINER synchronization functions.
-- -----------------------------------------------------------------------------
alter table public.accounting_entries enable row level security;
alter table public.accounting_categories enable row level security;

drop policy if exists "Studio owners and admins can manage studio accounting entries"
  on public.accounting_entries;
drop policy if exists "Studio users can read studio accounting entries"
  on public.accounting_entries;
create policy "Studio users can read studio accounting entries"
on public.accounting_entries
for select
to authenticated
using (
  studio_id is not null
  and exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = accounting_entries.studio_id
      and usr.user_id = auth.uid()
      and coalesce(usr.active, true) = true
  )
);

drop policy if exists "Authenticated users can read accounting categories"
  on public.accounting_categories;
create policy "Authenticated users can read accounting categories"
on public.accounting_categories
for select
to authenticated
using (active = true);

-- Prevent direct RPC use of SECURITY DEFINER ledger mutation helpers.
revoke all on function public.accounting_mark_source_voided(text, uuid, text) from public, anon, authenticated;
revoke all on function public.accounting_upsert_entry(uuid, uuid, date, text, text, text, numeric, numeric, numeric, numeric, text, text, text, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.sync_payment_accounting_entry_row(uuid) from public, anon, authenticated;
revoke all on function public.sync_expense_accounting_entry_row(uuid) from public, anon, authenticated;

grant execute on function public.accounting_mark_source_voided(text, uuid, text) to service_role;
grant execute on function public.accounting_upsert_entry(uuid, uuid, date, text, text, text, numeric, numeric, numeric, numeric, text, text, text, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb, uuid) to service_role;
grant execute on function public.sync_payment_accounting_entry_row(uuid) to service_role;
grant execute on function public.sync_expense_accounting_entry_row(uuid) to service_role;


-- -----------------------------------------------------------------------------
-- 10. Narrow security hardening
-- -----------------------------------------------------------------------------
-- Trigger functions continue to execute from their database triggers, but
-- cannot be invoked directly through the API by anonymous or authenticated users.
revoke execute
on function public.sync_event_payment_accounting_entry()
from public, anon, authenticated;

revoke execute
on function public.sync_event_labor_accounting_entry()
from public, anon, authenticated;

grant execute
on function public.sync_event_payment_accounting_entry()
to service_role;

grant execute
on function public.sync_event_labor_accounting_entry()
to service_role;

-- Expense history is now preserved through voiding. Direct deletion is no longer
-- part of the supported application workflow.
drop policy if exists
  "Studio owners and admins can delete expenses"
on public.expenses;


commit;
