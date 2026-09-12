-- Membership Usage-Period Alignment -- P1: finite usage_period integrity.
--
-- Canonical plan: C:\Users\mcurt\.claude\plans\we-are-starting-a-functional-liskov.md, section C.
--
-- Today `membership_plan_benefits_usage_period_check` allows
-- usage_period IN ('billing_cycle','monthly','unlimited') for every
-- benefit_type, with no restriction tying 'unlimited' to any particular
-- benefit_type. Read-only DEV/PROD audit (plan section B) found zero rows
-- anywhere using 'unlimited' paired with a finite quantity, for either
-- included_private_lessons (live today) or included_group_classes (not yet a
-- valid benefit_type). This migration is purely additive -- it does not
-- touch the existing constraint -- and only forbids 'unlimited' for the two
-- benefit types that carry a finite, countable quantity.
--
-- Zero-risk, confirmed: no existing row anywhere in DEV or PROD violates
-- this constraint (re-verify via the read-only query in plan section B
-- immediately before this migration is applied to any environment).

begin;

alter table public.membership_plan_benefits
  add constraint membership_plan_benefits_finite_usage_period_check
  check (
    benefit_type not in ('included_private_lessons', 'included_group_classes')
    or usage_period in ('billing_cycle', 'monthly')
  );

commit;
