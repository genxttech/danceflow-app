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
 *
 * Grandfathered subscribers stay on older Prices that are no longer a current
 * checkout Price. List those in `STRIPE_PRICE_STUDIO_<PLAN>_FOUNDER_LEGACY`
 * (comma-separated Price IDs) so a portal or webhook event for them still
 * resolves by Price instead of relying on subscription metadata.
 */
const PLAN_PRICE_ENV_NAMES: Record<string, string[]> = {
  ...Object.fromEntries(
    Object.keys(STUDIO_FOUNDER_PRICE_ENV).map((code) => [
      code,
      [
        STUDIO_FOUNDER_PRICE_ENV[code],
        STUDIO_STANDARD_PRICE_ENV[code],
        `${STUDIO_FOUNDER_PRICE_ENV[code]}_LEGACY`,
      ],
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
    const configured = names.flatMap((name) =>
      (env[name] ?? "").split(",").map((id) => id.trim()),
    );
    if (configured.includes(wanted)) return code;
  }

  return null;
}
