import { BILLING_PLANS, formatPlanMoney, type BillingPlan } from "@/lib/billing/plans";
import { isFounderPricingActiveIn } from "@/lib/billing/founderPricing";
import { isRegularPricingActivated } from "@/lib/billing/regularPricing";
import {
  STUDIO_FOUNDER_PRICE_ENV,
  STUDIO_STANDARD_PRICE_ENV,
  selectStudioMonthlyPrice,
  stripePriceMatchesExpected,
} from "@/lib/billing/studioCheckoutPricing";
import { resolvePlanCodeFromEnvPriceId } from "@/lib/billing/subscriptionPlanResolution";
import { assertStripeObjectIsTestMode } from "@/lib/payment-harness/stripeTestMode";
import {
  blocked,
  buildReport,
  fail,
  pass,
  type BillingQaCheck,
  type BillingQaEvidenceValue,
  type BillingQaReport,
} from "./report";

/**
 * BILLING-QA-1. Stripe TEST-mode studio Price verifier (read-only).
 *
 * Checks the studio subscription Price configuration the way `/api/billing/checkout` and the subscription webhook will
 * use it, using the app's own selection and matching functions rather than a second copy of the rules:
 *   - founder.<plan>   the configured Founder Price is active, USD, monthly and exactly the plans.ts Founder amount;
 *   - regular.<plan>   the configured STANDARD Price is the provisional regular amount (checked whenever it is set, so
 *                      Regular Prices can be validated before activation);
 *   - legacy.<plan>.N  each grandfathered Price exists, is test mode, USD and monthly (its amount is reported);
 *   - mapping.<ENV>    every configured Price ID resolves to exactly its own plan in subscription plan resolution;
 *   - checkout.<plan>  what checkout would do right now for a new subscriber with these flags: charge which Price at
 *                      which amount, or refuse.
 *
 * Only `prices.retrieve` is ever called. Every Price read back must be `livemode: false`; a live object aborts the run.
 * Organizer pricing and yearly checkout are out of scope (unchanged by PRICING-P1).
 */

export type BillingQaPrice = {
  id: string;
  livemode?: unknown;
  active?: boolean | null;
  currency?: string | null;
  unit_amount?: number | null;
  recurring?: { interval?: string | null; interval_count?: number | null } | null;
  product?: string | { id: string } | null;
};

export type BillingQaStripeClient = {
  prices: { retrieve(id: string): Promise<BillingQaPrice> };
};

export const PRICE_VERIFIER_TOOL = "billing-qa price verifier";

// Shared with the deployed price-config report (priceConfigReport.ts).
export const STUDIO_PLANS = BILLING_PLANS.filter((plan) => plan.audience === "studio");

export const legacyEnvName = (plan: BillingPlan) => `${STUDIO_FOUNDER_PRICE_ENV[plan.code]}_LEGACY`;
export const readEnv = (env: Record<string, string | undefined>, name: string) => env[name]?.trim() || null;
const read = readEnv;
export const planLabel = (plan: BillingPlan) => plan.code[0].toUpperCase() + plan.code.slice(1);
const label = planLabel;
export const money = (cents: number | null | undefined) => (typeof cents === "number" ? formatPlanMoney(cents) : "no amount");
export const legacyPriceIds = (env: Record<string, string | undefined>, plan: BillingPlan) =>
  (env[legacyEnvName(plan)] ?? "").split(",").map((id) => id.trim()).filter(Boolean);

/** Every configured Price env var of a plan, legacy entries numbered, for mapping checks. */
export function configuredPlanPrices(env: Record<string, string | undefined>, plan: BillingPlan): Array<[string, string]> {
  return [
    [STUDIO_FOUNDER_PRICE_ENV[plan.code], readEnv(env, STUDIO_FOUNDER_PRICE_ENV[plan.code]) ?? ""],
    [STUDIO_STANDARD_PRICE_ENV[plan.code], readEnv(env, STUDIO_STANDARD_PRICE_ENV[plan.code]) ?? ""],
    ...legacyPriceIds(env, plan).map((legacyId, index): [string, string] => [`${legacyEnvName(plan)}[${index + 1}]`, legacyId]),
  ].filter(([, priceId]) => priceId) as Array<[string, string]>;
}

/** mapping.<ENV>: the Price ID resolves to exactly its own plan in subscription plan resolution. */
export function planMappingCheck(envName: string, priceId: string, plan: BillingPlan, env: Record<string, string | undefined>): BillingQaCheck {
  const resolved = resolvePlanCodeFromEnvPriceId(priceId, env);
  const title = `${envName} resolves to the ${plan.code} plan`;
  return resolved === plan.code
    ? pass(`mapping.${envName}`, title, { priceId, resolvedPlan: resolved })
    : fail(`mapping.${envName}`, title, resolved === null ? "price_maps_to_no_single_plan" : "price_maps_to_other_plan",
        resolved === null ? "the Price is configured for more than one plan (webhook falls back to metadata)" : `resolves to ${resolved}`,
        { priceId, resolvedPlan: resolved });
}

export const PRICE_ID_SHAPE = /^price_[A-Za-z0-9]+$/;

// Only well-formed Price IDs are ever echoed: anything else (e.g. a credential pasted into the wrong variable) is
// reported as "malformed", never as its value.
const shownPriceId = (value: string) => (PRICE_ID_SHAPE.test(value) ? value : "malformed");

/** Config section: flags plus every studio Price ID variable (Price IDs only; never another value). */
export function priceConfigSection(env: Record<string, string | undefined>, founderActive: boolean, regularActivated: boolean) {
  return {
    founderPricingActive: founderActive,
    regularPricingActivated: regularActivated,
    ...Object.fromEntries(
      STUDIO_PLANS.flatMap((plan) => [
        [STUDIO_FOUNDER_PRICE_ENV[plan.code], readEnv(env, STUDIO_FOUNDER_PRICE_ENV[plan.code])],
        [STUDIO_STANDARD_PRICE_ENV[plan.code], readEnv(env, STUDIO_STANDARD_PRICE_ENV[plan.code])],
        [legacyEnvName(plan), legacyPriceIds(env, plan).join(",") || null],
      ]).map(([name, value]) => [name, value ? value.split(",").map(shownPriceId).join(",") : null]),
    ),
  };
}

type Retrieved = { ok: true; price: BillingQaPrice } | { ok: false; status: "FAIL" | "BLOCKED"; reason: string; detail: string };

function classifyStripeError(error: unknown): Retrieved {
  const e = (error ?? {}) as { code?: unknown; statusCode?: unknown; type?: unknown };
  if (e.code === "resource_missing" || e.statusCode === 404) {
    return { ok: false, status: "FAIL", reason: "price_not_found", detail: "Stripe has no such Price for this key's account" };
  }
  if (e.statusCode === 401) return { ok: false, status: "BLOCKED", reason: "stripe_auth_failed", detail: "Stripe rejected the key" };
  if (e.statusCode === 403) return { ok: false, status: "BLOCKED", reason: "stripe_permission_denied", detail: "the key cannot read Prices" };
  return { ok: false, status: "BLOCKED", reason: "stripe_unavailable", detail: `Stripe request failed (${String(e.type ?? "unknown error")})` };
}

export function describePriceMismatch(price: BillingQaPrice, expectedAmountCents: number): string {
  const problems: string[] = [];
  if (price.active !== true) problems.push("inactive");
  if (price.currency !== "usd") problems.push(`currency ${price.currency ?? "none"}`);
  if (price.unit_amount !== expectedAmountCents) problems.push(`amount ${money(price.unit_amount)} (expected ${money(expectedAmountCents)})`);
  if (price.recurring?.interval !== "month" || (price.recurring?.interval_count ?? 1) !== 1) {
    problems.push(price.recurring ? `interval every ${price.recurring.interval_count ?? 1} ${price.recurring.interval ?? "?"}` : "not recurring");
  }
  return problems.join(", ");
}

function priceEvidence(price: BillingQaPrice): Record<string, BillingQaEvidenceValue> {
  return {
    priceId: price.id,
    unitAmount: price.unit_amount ?? null,
    currency: price.currency ?? null,
    interval: price.recurring?.interval ?? null,
    active: price.active ?? null,
    product: typeof price.product === "string" ? price.product : price.product?.id ?? null,
  };
}

export async function verifyStudioPrices(params: {
  env: Record<string, string | undefined>;
  stripe: BillingQaStripeClient;
  /** Report a missing STANDARD Price ID as BLOCKED instead of skipping it (validate Regular Prices before activation). */
  requireRegular?: boolean;
  now?: () => Date;
}): Promise<BillingQaReport> {
  const { env, stripe, requireRegular = false } = params;
  const now = params.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const founderActive = isFounderPricingActiveIn(env);
  const regularActivated = isRegularPricingActivated(env);
  const checks: BillingQaCheck[] = [];

  const cache = new Map<string, Promise<Retrieved>>();
  const retrieve = (id: string) => {
    if (!cache.has(id)) {
      cache.set(
        id,
        stripe.prices.retrieve(id).then(
          (price): Retrieved => {
            // A live object means the key or the configuration points at live mode: abort the whole run.
            assertStripeObjectIsTestMode(price, `billing QA price ${id}`);
            return { ok: true, price };
          },
          (error: unknown) => classifyStripeError(error),
        ),
      );
    }
    return cache.get(id)!;
  };

  const notRetrieved = (id: string, title: string, r: Extract<Retrieved, { ok: false }>, priceId: string) =>
    r.status === "FAIL" ? fail(id, title, r.reason, r.detail, { priceId }) : blocked(id, title, r.reason, r.detail, { priceId });

  const checkAmount = async (id: string, title: string, priceId: string, expected: number) => {
    const r = await retrieve(priceId);
    if (!r.ok) return notRetrieved(id, title, r, priceId);
    return stripePriceMatchesExpected(r.price, expected)
      ? pass(id, title, priceEvidence(r.price))
      : fail(id, title, "price_mismatch", describePriceMismatch(r.price, expected), priceEvidence(r.price));
  };

  for (const plan of STUDIO_PLANS) {
    const founderId = read(env, STUDIO_FOUNDER_PRICE_ENV[plan.code]);
    if (founderId) {
      checks.push(await checkAmount(`founder.${plan.code}`, `Founder ${label(plan)} Price is ${money(plan.amountMonthlyCents)}/month`, founderId, plan.amountMonthlyCents));
    }

    const regularCents = plan.provisionalRegularAmountMonthlyCents;
    const standardId = read(env, STUDIO_STANDARD_PRICE_ENV[plan.code]);
    const regularTitle = `Regular ${label(plan)} Price is ${money(regularCents)}/month`;
    if (standardId && regularCents !== undefined) {
      checks.push(await checkAmount(`regular.${plan.code}`, regularTitle, standardId, regularCents));
    } else if (requireRegular) {
      checks.push(blocked(`regular.${plan.code}`, regularTitle, "price_id_not_configured", `${STUDIO_STANDARD_PRICE_ENV[plan.code]} is not set`));
    }

    for (const [index, legacyId] of legacyPriceIds(env, plan).entries()) {
      const id = `legacy.${plan.code}.${index + 1}`;
      const title = `Grandfathered ${label(plan)} Price ${index + 1} is a monthly USD Price`;
      const r = await retrieve(legacyId);
      if (!r.ok) {
        checks.push(notRetrieved(id, title, r, legacyId));
      } else if (r.price.currency !== "usd" || r.price.recurring?.interval !== "month" || (r.price.recurring?.interval_count ?? 1) !== 1) {
        checks.push(fail(id, title, "legacy_price_shape", describePriceMismatch({ ...r.price, active: true }, r.price.unit_amount ?? -1), priceEvidence(r.price)));
      } else {
        // Grandfathered Prices may be archived (inactive) while their subscriptions continue; active is reported, not required.
        checks.push(pass(id, title, priceEvidence(r.price), `${money(r.price.unit_amount)}/month${r.price.active ? "" : " (archived)"}`));
      }
    }

    for (const [envName, priceId] of configuredPlanPrices(env, plan)) checks.push(planMappingCheck(envName, priceId, plan, env));

    const checkoutTitle = `New ${label(plan)} subscriber checkout`;
    const selection = selectStudioMonthlyPrice({ plan, founderActive, regularActivated, env });
    if (!selection.ok) {
      checks.push(fail(`checkout.${plan.code}`, checkoutTitle, `checkout_refuses_${selection.reason}`, `checkout would refuse every new ${plan.code} subscriber (${selection.reason})`));
    } else {
      const r = await retrieve(selection.stripePriceId);
      if (!r.ok) {
        checks.push(notRetrieved(`checkout.${plan.code}`, checkoutTitle, r, selection.stripePriceId));
      } else if (!stripePriceMatchesExpected(r.price, selection.expectedAmountCents)) {
        checks.push(fail(`checkout.${plan.code}`, checkoutTitle, "checkout_refuses_price_mismatch", describePriceMismatch(r.price, selection.expectedAmountCents), priceEvidence(r.price)));
      } else {
        checks.push(pass(`checkout.${plan.code}`, checkoutTitle, { ...priceEvidence(r.price), offerType: selection.offerType },
          `charges ${money(selection.expectedAmountCents)}/month (${selection.offerType})`));
      }
    }
  }

  return buildReport({
    tool: PRICE_VERIFIER_TOOL,
    mode: "test",
    startedAt,
    completedAt: now().toISOString(),
    config: { ...priceConfigSection(env, founderActive, regularActivated), requireRegular },
    checks,
  });
}
