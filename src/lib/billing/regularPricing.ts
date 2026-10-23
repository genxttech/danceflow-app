import type { BillingPlan } from "./plans";

/**
 * PRICING-P1. Server-only. The provisional regular studio prices
 * (`provisionalRegularAmountMonthlyCents`) are commercial targets that the
 * owner has not yet approved for customers. They are invisible to display and
 * checkout unless `REGULAR_PRICING_ACTIVATED` is exactly "true" -- the opposite
 * polarity of the Founder switch on purpose: absent or misspelled means OFF.
 *
 * Turning this on is a launch decision that also requires the matching Stripe
 * STANDARD Price objects to exist (see docs/billing/PRICING-P1.md).
 */
export function isRegularPricingActivated(): boolean {
  return process.env.REGULAR_PRICING_ACTIVATED === "true";
}

/**
 * The regular monthly price (cents) that may be shown or charged for a plan,
 * or undefined when none is currently publishable. Studio plans only expose
 * their provisional regular price once regular pricing is activated; the
 * organizer plan keeps its existing regular price.
 */
export function resolveRegularMonthlyCents(
  plan: BillingPlan,
  activated: boolean = isRegularPricingActivated(),
): number | undefined {
  if (plan.audience === "organizer") return plan.regularAmountMonthlyCents;
  return activated ? plan.provisionalRegularAmountMonthlyCents : undefined;
}
