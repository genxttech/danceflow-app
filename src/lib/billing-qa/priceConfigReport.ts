import { isFounderPricingActiveIn } from "@/lib/billing/founderPricing";
import { isRegularPricingActivated } from "@/lib/billing/regularPricing";
import {
  STUDIO_FOUNDER_PRICE_ENV,
  STUDIO_STANDARD_PRICE_ENV,
  selectStudioMonthlyPrice,
} from "@/lib/billing/studioCheckoutPricing";
import type { BillingPlan } from "@/lib/billing/plans";
import {
  STUDIO_PLANS,
  configuredPlanPrices,
  legacyEnvName,
  legacyPriceIds,
  money,
  planLabel,
  planMappingCheck,
  priceConfigSection,
  readEnv,
} from "./priceVerifier";
import { buildReport, fail, pass, type BillingQaCheck, type BillingQaReport } from "./report";

/**
 * BILLING-QA-4. What the RUNNING app is configured to charge, from its own environment, with no Stripe call and no
 * database access. Answers the questions PRICING-P1 could only answer through the owner: are the Founder Price IDs
 * set (and non-blank) in this deployment, which IDs, which offer checkout would use, do the IDs map to their plans in
 * the webhook, is the Stripe key live or test, and are the two webhook secrets set and different.
 *
 * It cannot prove a Price's AMOUNT: that needs Stripe. Pair the Price IDs it reports with the BILLING-QA-1 price
 * verifier (test mode) or a read-only Stripe check. Reports carry Price IDs, flags and key MODES only, never a key or
 * secret (buildReport refuses one).
 */

export const PRICE_CONFIG_TOOL = "billing-qa deployed price config";

const PRICE_ID_SHAPE = /^price_[A-Za-z0-9]+$/;
type Env = Record<string, string | undefined>;

export function stripeKeyMode(value: string | undefined, kind: "secret" | "publishable"): "live" | "test" | "unset" | "unrecognized" {
  const key = value?.trim();
  if (!key) return "unset";
  const prefixes = kind === "secret" ? ["sk", "rk"] : ["pk"];
  for (const prefix of prefixes) {
    if (key.startsWith(`${prefix}_live_`)) return "live";
    if (key.startsWith(`${prefix}_test_`)) return "test";
  }
  return "unrecognized";
}

function stripeChecks(env: Env): BillingQaCheck[] {
  const secretMode = stripeKeyMode(env.STRIPE_SECRET_KEY, "secret");
  const publishableMode = stripeKeyMode(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, "publishable");
  const evidence = { secretKeyMode: secretMode, publishableKeyMode: publishableMode };
  const checks: BillingQaCheck[] = [];

  const keyTitle = "Stripe secret and publishable keys are set and in the same mode";
  if (secretMode === "unset" || secretMode === "unrecognized") {
    checks.push(fail("stripe.keys", keyTitle, `stripe_secret_key_${secretMode}`, undefined, evidence));
  } else if (publishableMode === "unset" || publishableMode === "unrecognized") {
    checks.push(fail("stripe.keys", keyTitle, `stripe_publishable_key_${publishableMode}`, undefined, evidence));
  } else if (secretMode !== publishableMode) {
    checks.push(fail("stripe.keys", keyTitle, "stripe_key_mode_mismatch", `secret ${secretMode}, publishable ${publishableMode}`, evidence));
  } else {
    checks.push(pass("stripe.keys", keyTitle, evidence, `${secretMode} mode`));
  }

  // Compared here, never reported: platform and Connect secrets must differ (PAY-DC-2B scope rule).
  const platform = env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  const connect = env.STRIPE_CONNECT_WEBHOOK_SECRET?.trim() ?? "";
  const secretsEvidence = { platformSecretSet: Boolean(platform), connectSecretSet: Boolean(connect) };
  const secretsTitle = "Platform and Connect webhook secrets are set and different";
  if (!platform) checks.push(fail("stripe.webhook_secrets", secretsTitle, "platform_webhook_secret_missing", undefined, secretsEvidence));
  else if (!connect) checks.push(fail("stripe.webhook_secrets", secretsTitle, "connect_webhook_secret_missing", undefined, secretsEvidence));
  else if (platform === connect) checks.push(fail("stripe.webhook_secrets", secretsTitle, "webhook_secrets_identical", "every Connect event would be rejected as webhook_scope_mismatch", secretsEvidence));
  else checks.push(pass("stripe.webhook_secrets", secretsTitle, secretsEvidence));
  return checks;
}

/** A Price ID variable: required when its offer is live, otherwise checked only when set. */
function priceIdCheck(id: string, title: string, envName: string, value: string | null, required: boolean): BillingQaCheck | null {
  if (!value) return required ? fail(id, title, "price_id_missing", `${envName} is not set (or blank)`) : null;
  if (!PRICE_ID_SHAPE.test(value)) return fail(id, title, "price_id_malformed", `${envName} is not a Stripe Price ID`, { envName });
  return pass(id, title, { envName, priceId: value });
}

function planChecks(env: Env, plan: BillingPlan, founderActive: boolean, regularActivated: boolean): BillingQaCheck[] {
  const checks: BillingQaCheck[] = [];
  const push = (check: BillingQaCheck | null) => {
    if (check) checks.push(check);
  };
  const founderEnv = STUDIO_FOUNDER_PRICE_ENV[plan.code];
  const standardEnv = STUDIO_STANDARD_PRICE_ENV[plan.code];
  push(priceIdCheck(`founder.${plan.code}`, `Founder ${planLabel(plan)} Price ID (${money(plan.amountMonthlyCents)}/month expected)`, founderEnv, readEnv(env, founderEnv), founderActive));
  push(priceIdCheck(`regular.${plan.code}`, `Regular ${planLabel(plan)} Price ID (${money(plan.provisionalRegularAmountMonthlyCents)}/month expected)`, standardEnv, readEnv(env, standardEnv), regularActivated && !founderActive));
  for (const [index, legacyId] of legacyPriceIds(env, plan).entries()) {
    push(priceIdCheck(`legacy.${plan.code}.${index + 1}`, `Grandfathered ${planLabel(plan)} Price ID ${index + 1}`, legacyEnvName(plan), legacyId, false));
  }
  for (const [envName, priceId] of configuredPlanPrices(env, plan)) {
    if (PRICE_ID_SHAPE.test(priceId)) checks.push(planMappingCheck(envName, priceId, plan, env));
  }

  const title = `New ${planLabel(plan)} subscriber checkout`;
  const selection = selectStudioMonthlyPrice({ plan, founderActive, regularActivated, env });
  checks.push(
    selection.ok
      ? pass(`checkout.${plan.code}`, title, { priceId: selection.stripePriceId, offerType: selection.offerType, expectedAmountCents: selection.expectedAmountCents },
          `uses ${selection.offerType} Price, expecting ${money(selection.expectedAmountCents)}/month (amount verified by Stripe at checkout)`)
      : fail(`checkout.${plan.code}`, title, `checkout_refuses_${selection.reason}`, `checkout would refuse every new ${plan.code} subscriber (${selection.reason})`),
  );
  return checks;
}

export function buildPriceConfigReport(env: Env, now: () => Date = () => new Date()): BillingQaReport {
  const startedAt = now().toISOString();
  const founderActive = isFounderPricingActiveIn(env);
  const regularActivated = isRegularPricingActivated(env);
  const checks = [...stripeChecks(env), ...STUDIO_PLANS.flatMap((plan) => planChecks(env, plan, founderActive, regularActivated))];
  return buildReport({
    tool: PRICE_CONFIG_TOOL,
    mode: "config",
    startedAt,
    completedAt: now().toISOString(),
    config: {
      ...priceConfigSection(env, founderActive, regularActivated),
      regularPricingApprovalRefSet: Boolean(env.REGULAR_PRICING_APPROVAL_REF?.trim()),
      deploymentEnvironment: env.VERCEL_ENV?.trim() || null,
      deploymentCommit: env.VERCEL_GIT_COMMIT_SHA?.trim() || null,
      stripeAmountsChecked: false,
    },
    checks,
  });
}
