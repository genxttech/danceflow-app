import { formatPlanMoney, type BillingPlan } from "./plans";
import { resolveRegularMonthlyCents } from "./regularPricing";

/**
 * Server-only. Single shared source for whether Founder promotional
 * pricing is currently active -- checkout price selection and every
 * customer-facing display surface must resolve this the same way, so they
 * can never disagree about which price is currently being offered.
 *
 * Do not call this from client-side code: `FOUNDER_PRICING_ACTIVE` (no
 * `NEXT_PUBLIC_` prefix) is intentionally not inlined into the browser
 * bundle, so evaluating this in a client component would silently read it
 * as `undefined` (which still satisfies `!== "false"`) rather than fail
 * loudly -- every current caller is a server component or API route.
 */
export function isFounderPricingActive(): boolean {
  // Literal process.env reads stay here so Next.js can still inline the NEXT_PUBLIC_ value.
  return isFounderPricingActiveIn({
    NEXT_PUBLIC_FOUNDER_PRICING_ACTIVE: process.env.NEXT_PUBLIC_FOUNDER_PRICING_ACTIVE,
    FOUNDER_PRICING_ACTIVE: process.env.FOUNDER_PRICING_ACTIVE,
  });
}

/** The same determination against an explicit env (BILLING-QA price verifier). */
export function isFounderPricingActiveIn(
  env: Record<string, string | undefined>,
): boolean {
  return (
    env.NEXT_PUBLIC_FOUNDER_PRICING_ACTIVE !== "false" &&
    env.FOUNDER_PRICING_ACTIVE !== "false"
  );
}

/**
 * The monthly price (in cents) that should currently be shown for a plan --
 * the Founder price while Founder pricing is active, the regular price once
 * it is not. Falls back to the Founder amount if a plan has no regular
 * price configured. This does not change what Stripe actually charges; it
 * only keeps display in sync with the same Founder-active determination
 * checkout already uses.
 */
export function resolveDisplayedMonthlyPriceCents(plan: BillingPlan): number {
  if (isFounderPricingActive()) return plan.amountMonthlyCents;
  return resolveRegularMonthlyCents(plan) ?? plan.amountMonthlyCents;
}

/**
 * The regular price to reference next to a Founder price ("regularly $X/mo"),
 * or undefined when none is publishable. Studio plans return undefined until
 * regular pricing is activated (PRICING-P1).
 */
export function resolveReferenceRegularPriceCents(
  plan: BillingPlan,
): number | undefined {
  return resolveRegularMonthlyCents(plan);
}

/**
 * The full transparent-pricing sentence for a plan's fee structure, with the
 * price clause resolved against the same Founder-active determination as
 * `resolveDisplayedMonthlyPriceCents` -- so this note can never advertise a
 * Founder price that checkout and the headline price have already stopped
 * offering. Returns undefined for a plan with no fee-structure copy to show.
 */
export function resolveTransparentPricingNote(
  plan: BillingPlan,
): string | undefined {
  if (!plan.feeStructureNote) return undefined;

  const regularCents = resolveRegularMonthlyCents(plan);
  const regularPrice = formatPlanMoney(regularCents ?? plan.amountMonthlyCents);

  if (isFounderPricingActive() && regularCents) {
    const founderPrice = formatPlanMoney(plan.amountMonthlyCents);
    return `Transparent pricing: founder pricing is ${founderPrice}/month, regularly ${regularPrice}/month, ${plan.feeStructureNote}`;
  }

  return `Transparent pricing: ${regularPrice}/month, ${plan.feeStructureNote}`;
}
