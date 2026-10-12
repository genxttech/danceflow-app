-- DanceFlow LOCAL QA reference data -- isolated local Supabase QA stack ONLY. Idempotent.
--
-- Refuses to run unless the session explicitly declares the local QA stack AND the database contains only synthetic
-- test accounts (see the guard below):
--   docker exec -i -e PGOPTIONS="-c danceflow.qa_stack=local" supabase_db_<qa-project> --     psql -U postgres -v ON_ERROR_STOP=1 -1 < e2e/setup/qa-reference-data.sql
-- DEV and PROD already hold this data and must never receive this file (an accidental paste into a SQL editor
-- aborts at the guard below and changes nothing).
--
-- Why: a schema-only QA stack has no reference rows and no storage buckets, so real payment settlement fails with
-- "Unknown accounting category" (event_payments accounting trigger) and document-size limits are absent.
-- The accounting_categories statements below are extracted verbatim, in migration order, from every migration that
-- seeds that table (generated; re-generate when a migration adds categories).

-- Two independent guards. (1) An explicit opt-in marker. (2) A data fingerprint no real environment can satisfy:
-- an isolated QA database holds only synthetic accounts on reserved test domains and a handful of fixture studios.
-- DEV and PROD contain real accounts, so the seed aborts there even if someone sets the marker.
do $$
declare
  non_test_accounts bigint;
  studio_count bigint;
begin
  if coalesce(current_setting('danceflow.qa_stack', true), '') <> 'local' then
    raise exception 'refusing: qa-reference-data.sql runs only on the local QA stack (danceflow.qa_stack=local not set)';
  end if;
  select count(*) into non_test_accounts
  from auth.users
  where email is null
     or lower(split_part(email, '@', 2)) not in ('e2e.test', 'example.com', 'example.org', 'example.net', 'example.invalid');
  if non_test_accounts > 0 then
    raise exception 'refusing: % account(s) outside reserved test domains -- this is not an isolated QA database', non_test_accounts;
  end if;
  select count(*) into studio_count from public.studios;
  if studio_count > 50 then
    raise exception 'refusing: % studios -- this is not an isolated QA database', studio_count;
  end if;
end
$$;


-- from 20260715_accounting_foundation_hardening_v1_production_ready.sql (line 174)
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

-- from 20260715_accounting_foundation_hardening_v1_production_ready.sql (line 234)
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

-- from 20260720223000_sync_retail_accounting.sql (line 7)
insert into public.accounting_categories (
  key,
  label,
  entry_type,
  normal_balance,
  active,
  sort_order,
  entry_class,
  statement_section,
  normal_direction,
  allowed_external_account_types,
  blocks_auto_post_when_unmapped
)
values
  (
    'retail_revenue',
    'Retail Product Revenue',
    'revenue',
    'credit',
    true,
    145,
    'revenue',
    'income',
    'credit',
    array['INCOME', 'REVENUE']::text[],
    true
  ),
  (
    'retail_cogs',
    'Retail Cost of Goods Sold',
    'expense',
    'debit',
    true,
    445,
    'expense',
    'cost_of_sales',
    'debit',
    array['EXPENSE', 'COST_OF_GOODS_SOLD']::text[],
    true
  ),
  (
    'retail_refund',
    'Retail Product Refund',
    'refund',
    'debit',
    true,
    245,
    'refund',
    'contra_income',
    'debit',
    array['INCOME', 'REVENUE', 'EXPENSE']::text[],
    true
  )
on conflict (key) do update
set
  label = excluded.label,
  entry_type = excluded.entry_type,
  normal_balance = excluded.normal_balance,
  active = excluded.active,
  sort_order = excluded.sort_order,
  entry_class = excluded.entry_class,
  statement_section = excluded.statement_section,
  normal_direction = excluded.normal_direction,
  allowed_external_account_types = excluded.allowed_external_account_types,
  blocks_auto_post_when_unmapped = excluded.blocks_auto_post_when_unmapped;

-- from 20260722114500_commerce_reporting_accuracy.sql (line 7)
insert into public.accounting_categories (
  key,
  label,
  entry_type,
  normal_balance,
  active,
  sort_order,
  entry_class,
  statement_section,
  normal_direction,
  allowed_external_account_types,
  blocks_auto_post_when_unmapped
)
values
  (
    'digital_content_revenue',
    'Digital Content Revenue',
    'revenue',
    'credit',
    true,
    146,
    'revenue',
    'income',
    'credit',
    array['INCOME', 'REVENUE']::text[],
    true
  ),
  (
    'digital_content_refund',
    'Digital Content Refund',
    'refund',
    'debit',
    true,
    246,
    'refund',
    'contra_income',
    'debit',
    array['INCOME', 'REVENUE', 'EXPENSE']::text[],
    true
  )
on conflict (key) do update
set
  label = excluded.label,
  entry_type = excluded.entry_type,
  normal_balance = excluded.normal_balance,
  active = excluded.active,
  sort_order = excluded.sort_order,
  entry_class = excluded.entry_class,
  statement_section = excluded.statement_section,
  normal_direction = excluded.normal_direction,
  allowed_external_account_types = excluded.allowed_external_account_types,
  blocks_auto_post_when_unmapped = excluded.blocks_auto_post_when_unmapped;

-- from 20261109090000_phase10c_competitor_registration.sql (line 140)
insert into public.accounting_categories (
  key, label, entry_class, statement_section, normal_direction,
  allowed_external_account_types, blocks_auto_post_when_unmapped
) values (
  'competition_entry_revenue', 'Competition Entry Revenue', 'revenue', 'income', 'credit',
  array['INCOME', 'REVENUE', 'LIABILITY'], true
)
on conflict (key) do nothing;

-- document-files storage bucket as configured in DEV/PROD (private, 15 MB). Not created by any repo migration.
insert into storage.buckets (id, name, public, file_size_limit)
values ('document-files', 'document-files', false, 15728640)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;
