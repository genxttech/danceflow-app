-- DanceFlow LOCAL QA reference data (isolated local Supabase QA stack ONLY).
--
-- NEVER run against DEV (epdrtzcydvnoidwrepqz) or PROD (hvsujyfbftfffxpfmlpb). DEV and PROD already hold this data.
--
-- A QA stack loaded schema-only (pg_dump --schema-only of DEV public) has no reference rows and no storage buckets.
-- Without them, real payment settlement and document signing fail in ways that are artifacts of the QA stack, not app
-- behaviour:
--   * accounting_categories: the event_payments accounting trigger (accounting_upsert_entry) raises
--     "Unknown accounting category: event_ticket_revenue", which rolls back the webhook's event_payments insert.
--   * storage bucket document-files: private, 15 MB file size limit (as configured in DEV/PROD; the bucket is not
--     created by any repo migration). e2e/tests/registration-failure-document-setup.spec.ts relies on the limit.
--
-- The category rows are copied verbatim from the repo migrations that seed DEV/PROD:
--   src/lib/supabase/migrations/20260715_accounting_foundation_hardening_v1_production_ready.sql
--   src/lib/supabase/migrations/20261109090000_phase10c_competitor_registration.sql
-- If a migration adds categories, add them here too. Idempotent: safe to re-run.

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
insert into public.accounting_categories (
  key, label, entry_class, statement_section, normal_direction,
  allowed_external_account_types, blocks_auto_post_when_unmapped
) values (
  'competition_entry_revenue', 'Competition Entry Revenue', 'revenue', 'income', 'credit',
  array['INCOME', 'REVENUE', 'LIABILITY'], true
)
on conflict (key) do nothing;

insert into storage.buckets (id, name, public, file_size_limit)
values ('document-files', 'document-files', false, 15728640)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;
