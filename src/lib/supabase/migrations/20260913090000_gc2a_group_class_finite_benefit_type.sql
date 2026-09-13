-- Finite + Unlimited Group-Class Membership Entitlements -- GC-2a: finite
-- benefit type.
--
-- Canonical plan: C:\Users\mcurt\.claude\plans\we-are-starting-a-functional-liskov.md,
-- "Finite + Unlimited Group-Class Membership Entitlements" section.
--
-- Adds 'included_group_classes' to the live membership_plan_benefits_type_check
-- allow-list. Purely additive -- every existing row's benefit_type value
-- remains valid; nothing is removed from the allowed set. This value was
-- already anticipated by P1's own finite-usage-period constraint
-- (membership_plan_benefits_finite_usage_period_check, live today: "benefit_type
-- not in ('included_private_lessons','included_group_classes') or usage_period
-- in ('billing_cycle','monthly')") and referenced in application code
-- (src/lib/memberships/entitlements.ts's benefitTypesForAppointment,
-- AppointmentCreateForm.tsx's benefitTypeLabel) as the intended finite
-- group-class benefit name -- but until this migration it could never match
-- any real row, since the base type-check constraint never actually allowed
-- it. This migration closes that latent gap, confirmed live and unchanged
-- since GC-1.4A first documented it.
--
-- Zero-risk: no existing membership_plan_benefits row uses this value today
-- (it could not have -- the constraint has always rejected it), so widening
-- the allow-list cannot invalidate any existing row.

begin;

alter table public.membership_plan_benefits
  drop constraint membership_plan_benefits_type_check;

alter table public.membership_plan_benefits
  add constraint membership_plan_benefits_type_check
  check (benefit_type = any (array[
    'unlimited_group_classes',
    'unlimited_practice_parties',
    'included_private_lessons',
    'included_group_classes',
    'event_discount_percent',
    'floor_rental_discount_percent'
  ]::text[]));

commit;
