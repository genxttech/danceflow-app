alter table public.instructor_compensation_rules
  add column if not exists private_lesson_duration_rates_enabled boolean not null default false,
  add column if not exists private_lesson_30_min_flat_amount numeric not null default 0,
  add column if not exists private_lesson_45_min_flat_amount numeric not null default 0,
  add column if not exists private_lesson_60_min_flat_amount numeric not null default 0;

alter table public.instructor_earnings
  add column if not exists adjustment_type text,
  add column if not exists override_reason text;

alter table public.instructor_earnings
  drop constraint if exists instructor_earnings_adjustment_type_check;

alter table public.instructor_earnings
  add constraint instructor_earnings_adjustment_type_check
  check (
    adjustment_type is null
    or adjustment_type in ('bonus', 'deduction', 'reimbursement', 'correction', 'override')
  );

create index if not exists idx_instructor_earnings_studio_source_type
  on public.instructor_earnings (studio_id, source_type, earning_date desc);
