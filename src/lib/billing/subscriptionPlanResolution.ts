import {
  STUDIO_FOUNDER_PRICE_ENV,
  STUDIO_STANDARD_PRICE_ENV,
} from "./studioCheckoutPricing";

/**
 * PRICING-P1. Pure. Maps a Stripe Price ID to a DanceFlow plan code using the
 * configured checkout Price ID environment variables.
 *
 * Used by the subscription webhook after the `subscription_plans` Price ID
 * lookup and BEFORE the `metadata.planCode` fallback: subscription metadata is
 * written once at checkout, so after a Billing Portal plan change it still names
 * the old plan. The Price on the subscription is the authority for what the
 * customer is paying for.
 */
const PLAN_PRICE_ENV_NAMES: Record<string, string[]> = {
  ...Object.fromEntries(
    Object.keys(STUDIO_FOUNDER_PRICE_ENV).map((code) => [
      code,
      [STUDIO_FOUNDER_PRICE_ENV[code], STUDIO_STANDARD_PRICE_ENV[code]],
    ]),
  ),
  organizer: ["STRIPE_PRICE_ORGANIZER_FOUNDER", "STRIPE_PRICE_ORGANIZER_STANDARD"],
};

export function resolvePlanCodeFromEnvPriceId(
  priceId: string | null | undefined,
  env: Record<string, string | undefined>,
): string | null {
  const wanted = priceId?.trim();
  if (!wanted) return null;

  for (const [code, names] of Object.entries(PLAN_PRICE_ENV_NAMES)) {
    if (names.some((name) => env[name]?.trim() === wanted)) return code;
  }

  return null;
}
