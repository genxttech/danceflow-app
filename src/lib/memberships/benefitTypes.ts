// Single source of truth for membership_plan_benefits.benefit_type/usage_period
// values, mirroring the live DB CHECK constraints exactly
// (membership_plan_benefits_type_check, membership_plan_benefits_usage_period_check,
// membership_plan_benefits_finite_usage_period_check). Both the Create and Edit
// plan forms and the server action's own validation allowlist import from here
// so the three can never drift out of sync again -- the root cause of a prior
// bug where unlimited_group_classes/unlimited_practice_parties/included_group_classes
// were offered in the UI but silently discarded on save.

export const MEMBERSHIP_BENEFIT_TYPES = [
  {
    value: "unlimited_group_classes",
    label: "Unlimited group classes",
    helper: "Clients can attend eligible group classes during the billing period.",
  },
  {
    value: "included_group_classes",
    label: "Included group classes",
    helper: "Adds a set number of group classes per billing period.",
  },
  {
    value: "unlimited_practice_parties",
    label: "Unlimited practice parties",
    helper: "Clients can attend eligible practice parties during the billing period.",
  },
  {
    value: "included_private_lessons",
    label: "Included private lessons",
    helper: "Adds a set number of private lessons per billing period.",
  },
  {
    value: "event_discount_percent",
    label: "Event discount",
    helper: "Applies a percentage or dollar discount to eligible events.",
  },
  {
    value: "floor_rental_discount_percent",
    label: "Floor rental discount",
    helper: "Applies a percentage or dollar discount to eligible floor rentals.",
  },
] as const;

export const MEMBERSHIP_USAGE_PERIODS = [
  { value: "billing_cycle", label: "Each billing cycle" },
  { value: "monthly", label: "Each month" },
  { value: "unlimited", label: "Unlimited" },
] as const;

export type MembershipBenefitTypeValue = (typeof MEMBERSHIP_BENEFIT_TYPES)[number]["value"];
export type MembershipUsagePeriodValue = (typeof MEMBERSHIP_USAGE_PERIODS)[number]["value"];
