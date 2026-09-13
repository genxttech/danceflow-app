-- Rollback for 20260913090000_gc2a_group_class_finite_benefit_type.sql
--
-- DELIBERATE NO-OP if any membership_plan_benefits row now uses
-- 'included_group_classes' -- narrowing the constraint back would either
-- fail outright (existing rows would violate it) or, if forced, destroy a
-- real product configuration. Only safe to actually narrow the constraint
-- back if you have independently confirmed zero rows use the new value:
--
--   select count(*) from membership_plan_benefits where benefit_type = 'included_group_classes';
--
-- If and only if that returns 0, the original constraint may be restored:
--
--   alter table public.membership_plan_benefits drop constraint membership_plan_benefits_type_check;
--   alter table public.membership_plan_benefits add constraint membership_plan_benefits_type_check
--     check (benefit_type = any (array[
--       'unlimited_group_classes','unlimited_practice_parties','included_private_lessons',
--       'event_discount_percent','floor_rental_discount_percent'
--     ]::text[]));
--
-- Not executed automatically by this file, per this engagement's established
-- discipline (P6b/P6c/P6d/P6f precedent): a rollback must never silently
-- attempt a destructive narrowing on the caller's behalf.

begin;

do $$
begin
  raise notice 'GC-2a rollback is a deliberate no-op -- see file header. Verify zero included_group_classes rows exist before manually narrowing the constraint back.';
end $$;

commit;
