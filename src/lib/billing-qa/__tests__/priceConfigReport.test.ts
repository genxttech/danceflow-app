import { describe, expect, it } from "vitest";
import { buildPriceConfigReport, stripeKeyMode } from "@/lib/billing-qa/priceConfigReport";

// Fake values, assembled at runtime so secret scanners do not mistake the fixture for a real key.
const LIVE_SECRET = ["sk", "live", "TopSecretFixtureNeverShown"].join("_");
const PLATFORM_WHSEC = "whsec_platformSecretNeverShown";
const CONNECT_WHSEC = "whsec_connectSecretNeverShown";

// The released PRICING-P1 production shape: Founder on, Regular off, grandfathered Pro listed.
const PRODUCTION_LIKE = {
  STRIPE_SECRET_KEY: LIVE_SECRET,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_51PublicKey",
  STRIPE_WEBHOOK_SECRET: PLATFORM_WHSEC,
  STRIPE_CONNECT_WEBHOOK_SECRET: CONNECT_WHSEC,
  STRIPE_PRICE_STUDIO_STARTER_FOUNDER: "price_starter59",
  STRIPE_PRICE_STUDIO_GROWTH_FOUNDER: "price_growth99",
  STRIPE_PRICE_STUDIO_PRO_FOUNDER: "price_pro159",
  STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY: "price_pro129",
  STRIPE_PRICE_STUDIO_STARTER_STANDARD: "price_starter89",
  STRIPE_PRICE_STUDIO_GROWTH_STANDARD: "price_growth149",
  STRIPE_PRICE_STUDIO_PRO_STANDARD: "price_pro249",
  VERCEL_ENV: "production",
  VERCEL_GIT_COMMIT_SHA: "4bc938c6",
};

const at = () => new Date("2026-10-25T00:00:00.000Z");
const checksOf = (env: Record<string, string | undefined>) =>
  Object.fromEntries(buildPriceConfigReport(env, at).checks.map((c) => [c.id, c]));

describe("BILLING-QA-4 deployed price-config report", () => {
  it("production-like configuration: PASS, config mode, what checkout would use for each plan", () => {
    const report = buildPriceConfigReport(PRODUCTION_LIKE, at);
    expect([report.mode, report.overall, report.counts.FAIL, report.counts.BLOCKED]).toEqual(["config", "PASS", 0, 0]);
    const checks = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(checks["stripe.keys"]).toMatchObject({ status: "PASS", detail: "live mode" });
    expect(checks["checkout.pro"].evidence).toEqual({ priceId: "price_pro159", offerType: "founder", expectedAmountCents: 15900 });
    expect(checks["legacy.pro.1"].evidence).toEqual({ envName: "STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY", priceId: "price_pro129" });
    expect(checks["mapping.STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY[1]"].status).toBe("PASS");
    expect(report.config).toMatchObject({
      founderPricingActive: true, regularPricingActivated: false, regularPricingApprovalRefSet: false,
      deploymentEnvironment: "production", deploymentCommit: "4bc938c6", stripeAmountsChecked: false,
      STRIPE_PRICE_STUDIO_GROWTH_FOUNDER: "price_growth99",
    });
  });

  it("never reports a key or secret, only modes and presence", () => {
    const json = JSON.stringify(buildPriceConfigReport(PRODUCTION_LIKE, at));
    for (const secret of [LIVE_SECRET, PLATFORM_WHSEC, CONNECT_WHSEC, "TopSecret"]) expect(json).not.toContain(secret);
    expect(json).toContain('"platformSecretSet":true');
  });

  it("a blank Founder variable (the PRICING-P1 unknown) fails the Price ID and the checkout for that plan", () => {
    const checks = checksOf({ ...PRODUCTION_LIKE, STRIPE_PRICE_STUDIO_GROWTH_FOUNDER: "  " });
    expect(checks["founder.growth"]).toMatchObject({ status: "FAIL", reason: "price_id_missing" });
    expect(checks["checkout.growth"]).toMatchObject({ status: "FAIL", reason: "checkout_refuses_price_id_missing" });
    expect(checks["checkout.starter"].status).toBe("PASS");
  });

  it("a malformed Price ID is reported without echoing it", () => {
    const checks = checksOf({ ...PRODUCTION_LIKE, STRIPE_PRICE_STUDIO_PRO_FOUNDER: "prod_wrongObject" });
    expect(checks["founder.pro"]).toMatchObject({ status: "FAIL", reason: "price_id_malformed" });
    expect(JSON.stringify(checks["founder.pro"])).not.toContain("prod_wrongObject");
  });

  it("a Price ID configured for two plans fails mapping", () => {
    const checks = checksOf({ ...PRODUCTION_LIKE, STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY: "price_growth99" });
    expect(checks["mapping.STRIPE_PRICE_STUDIO_GROWTH_FOUNDER"]).toMatchObject({ status: "FAIL", reason: "price_maps_to_no_single_plan" });
  });

  it("Founder off without Regular activation: every checkout refuses", () => {
    const report = buildPriceConfigReport({ ...PRODUCTION_LIKE, FOUNDER_PRICING_ACTIVE: "false" }, at);
    expect(report.overall).toBe("FAIL");
    expect(report.checks.filter((c) => c.id.startsWith("checkout.")).map((c) => c.reason)).toEqual(Array(3).fill("checkout_refuses_regular_pricing_not_activated"));
  });

  it("Regular activated with Founder off: Regular Price IDs become required and checkout uses them", () => {
    const env = { ...PRODUCTION_LIKE, FOUNDER_PRICING_ACTIVE: "false", REGULAR_PRICING_ACTIVATED: "true", REGULAR_PRICING_APPROVAL_REF: "owner-2026-11", STRIPE_PRICE_STUDIO_GROWTH_STANDARD: "" };
    const checks = checksOf(env);
    expect(checks["checkout.pro"].evidence).toMatchObject({ priceId: "price_pro249", offerType: "standard", expectedAmountCents: 24900 });
    expect(checks["regular.growth"]).toMatchObject({ status: "FAIL", reason: "price_id_missing" });
    expect(checks["founder.growth"].status).toBe("PASS"); // still set, still well-formed, just not the live offer
  });

  it("Stripe keys: missing, unrecognized or mixed modes fail", () => {
    expect(checksOf({ ...PRODUCTION_LIKE, STRIPE_SECRET_KEY: "" })["stripe.keys"].reason).toBe("stripe_secret_key_unset");
    expect(checksOf({ ...PRODUCTION_LIKE, STRIPE_SECRET_KEY: "garbage" })["stripe.keys"].reason).toBe("stripe_secret_key_unrecognized");
    expect(checksOf({ ...PRODUCTION_LIKE, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_x" })["stripe.keys"]).toMatchObject({ reason: "stripe_key_mode_mismatch", detail: "secret live, publishable test" });
    expect(checksOf({ ...PRODUCTION_LIKE, STRIPE_SECRET_KEY: "rk_test_x", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_x" })["stripe.keys"].detail).toBe("test mode");
  });

  it("webhook secrets: missing or identical fail (identical breaks every Connect event)", () => {
    expect(checksOf({ ...PRODUCTION_LIKE, STRIPE_WEBHOOK_SECRET: "" })["stripe.webhook_secrets"].reason).toBe("platform_webhook_secret_missing");
    expect(checksOf({ ...PRODUCTION_LIKE, STRIPE_CONNECT_WEBHOOK_SECRET: undefined })["stripe.webhook_secrets"].reason).toBe("connect_webhook_secret_missing");
    expect(checksOf({ ...PRODUCTION_LIKE, STRIPE_CONNECT_WEBHOOK_SECRET: PLATFORM_WHSEC })["stripe.webhook_secrets"].reason).toBe("webhook_secrets_identical");
  });

  it("stripeKeyMode classifies by prefix only", () => {
    expect([stripeKeyMode("sk_live_a", "secret"), stripeKeyMode("rk_test_a", "secret"), stripeKeyMode("pk_live_a", "secret")]).toEqual(["live", "test", "unrecognized"]);
    expect([stripeKeyMode("pk_test_a", "publishable"), stripeKeyMode(undefined, "publishable")]).toEqual(["test", "unset"]);
  });
});
