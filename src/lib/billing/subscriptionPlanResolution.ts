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

function planCodesForPriceId(
  wanted: string,
  env: Record<string, string | undefined>,
): string[] {
  const codes: string[] = [];
  for (const [code, names] of Object.entries(PLAN_PRICE_ENV_NAMES)) {
    const configured = names.flatMap((name) =>
      (env[name] ?? "").split(",").map((id) => id.trim()),
    );
    if (configured.includes(wanted)) codes.push(code);
  }
  return codes;
}

/**
 * Plan code for every Price on a subscription (a plan item may sit beside add-on
 * items such as AI credit packs). Returns the one plan code the Prices agree on.
 * Returns null when no Price is a configured plan Price, and also when the same
 * Price is configured for more than one plan or the items name different plans:
 * an ambiguous Price must never silently pick a plan, so the caller falls back
 * to metadata instead.
 */
export function resolvePlanCodeFromEnvPriceIds(
  priceIds: Array<string | null | undefined>,
  env: Record<string, string | undefined>,
): string | null {
  const found = new Set<string>();

  for (const raw of priceIds) {
    const wanted = raw?.trim();
    if (!wanted) continue;

    const codes = planCodesForPriceId(wanted, env);
    if (codes.length > 1) {
      console.error("billing plan resolution: Price configured for more than one plan", {
        plans: codes,
      });
      return null;
    }
    if (codes.length === 1) found.add(codes[0]);
  }

  return found.size === 1 ? [...found][0] : null;
}

export function resolvePlanCodeFromEnvPriceId(
  priceId: string | null | undefined,
  env: Record<string, string | undefined>,
): string | null {
  return resolvePlanCodeFromEnvPriceIds([priceId], env);
}
