-- Rollback for 20260911120000_p1_membership_finite_usage_period_integrity.sql

begin;

alter table public.membership_plan_benefits
  drop constraint if exists membership_plan_benefits_finite_usage_period_check;

commit;
