import type { BillingPlan } from "./plans";

/**
 * PRICING-P1. Server-only. The provisional regular studio prices
 * (`provisionalRegularAmountMonthlyCents`) are commercial targets that the
 * owner has not yet approved for customers. They are invisible to display and
 * checkout unless `REGULAR_PRICING_ACTIVATED` is exactly "true" AND a non-empty
 * `REGULAR_PRICING_APPROVAL_REF` is set -- the opposite
 * polarity of the Founder switch on purpose: absent or misspelled means OFF.
 *
 * Turning this on is a launch decision that also requires the matching Stripe
 * STANDARD Price objects to exist (see docs/billing/PRICING-P1.md).
 */
export function isRegularPricingActivated(
  env: Record<string, string | undefined> = process.env,
): boolean {
  // Two independent settings must both be present, so one stray or copied
  // variable cannot switch regular pricing on: the flag AND a non-empty owner
  // approval reference (e.g. the approval date or ticket) for this release.
  return (
    env.REGULAR_PRICING_ACTIVATED === "true" &&
    (env.REGULAR_PRICING_APPROVAL_REF?.trim() ?? "") !== ""
  );
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
