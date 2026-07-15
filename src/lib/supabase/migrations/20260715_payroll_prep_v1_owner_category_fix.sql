begin;

update public.instructor_earnings
set
  accounting_category_snapshot = 'instructor_pay_expense',
  updated_at = now()
where worker_classification_snapshot = 'owner'
  and accounting_category_snapshot = 'contract_labor_expense'
  and status in ('pending', 'approved');

commit;
