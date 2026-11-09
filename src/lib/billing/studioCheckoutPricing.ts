import type { BillingPlan } from "./plans";
import { resolveRegularMonthlyCents } from "./regularPricing";

/**
 * PRICING-P1. Pure, fail-closed price selection for MONTHLY STUDIO plan
 * checkout. There is deliberately no fallback chain: the Price ID that is used
 * is the one the current offer calls for or none at all, and the Stripe Price
 * it resolves to must carry exactly the amount the plan configuration states.
 * (Previously a missing Founder env silently fell through to STANDARD and then
 * to the database price.)
 */

export const STUDIO_FOUNDER_PRICE_ENV: Record<string, string> = {
  starter: "STRIPE_PRICE_STUDIO_STARTER_FOUNDER",
  growth: "STRIPE_PRICE_STUDIO_GROWTH_FOUNDER",
  pro: "STRIPE_PRICE_STUDIO_PRO_FOUNDER",
};

export const STUDIO_STANDARD_PRICE_ENV: Record<string, string> = {
  starter: "STRIPE_PRICE_STUDIO_STARTER_STANDARD",
  growth: "STRIPE_PRICE_STUDIO_GROWTH_STANDARD",
  pro: "STRIPE_PRICE_STUDIO_PRO_STANDARD",
};

export type StudioPriceSelection =
  | {
      ok: true;
      stripePriceId: string;
      offerType: "founder" | "standard";
      expectedAmountCents: number;
    }
  | {
      ok: false;
      reason:
        | "unsupported_plan"
        | "price_id_missing"
        | "regular_pricing_not_activated";
    };

export function selectStudioMonthlyPrice(params: {
  plan: BillingPlan;
  founderActive: boolean;
  regularActivated: boolean;
  env: Record<string, string | undefined>;
}): StudioPriceSelection {
  const { plan, founderActive, regularActivated, env } = params;

  if (plan.audience !== "studio") return { ok: false, reason: "unsupported_plan" };

  const read = (name: string | undefined) => (name ? env[name]?.trim() || null : null);

  if (founderActive) {
    const stripePriceId = read(STUDIO_FOUNDER_PRICE_ENV[plan.code]);
    if (!stripePriceId) return { ok: false, reason: "price_id_missing" };
    return {
      ok: true,
      stripePriceId,
      offerType: "founder",
      expectedAmountCents: plan.amountMonthlyCents,
    };
  }

  const regularCents = resolveRegularMonthlyCents(plan, regularActivated);
  if (regularCents === undefined) {
    return { ok: false, reason: "regular_pricing_not_activated" };
  }
  const stripePriceId = read(STUDIO_STANDARD_PRICE_ENV[plan.code]);
  if (!stripePriceId) return { ok: false, reason: "price_id_missing" };
  return {
    ok: true,
    stripePriceId,
    offerType: "standard",
    expectedAmountCents: regularCents,
  };
}

type StripePriceLike = {
  active?: boolean | null;
  currency?: string | null;
  unit_amount?: number | null;
  recurring?: { interval?: string | null; interval_count?: number | null } | null;
};

/** True only for an active, USD, once-per-month recurring price of exactly the expected amount. */
export function stripePriceMatchesExpected(
  price: StripePriceLike | null | undefined,
  expectedAmountCents: number,
): boolean {
  if (!price) return false;
  return (
    price.active === true &&
    price.currency === "usd" &&
    price.unit_amount === expectedAmountCents &&
    price.recurring?.interval === "month" &&
    (price.recurring?.interval_count ?? 1) === 1
  );
}
