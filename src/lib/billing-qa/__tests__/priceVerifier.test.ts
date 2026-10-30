import { describe, expect, it, vi } from "vitest";
import { verifyStudioPrices, type BillingQaPrice, type BillingQaStripeClient } from "@/lib/billing-qa/priceVerifier";

const monthly = (id: string, unit_amount: number, extra: Partial<BillingQaPrice> = {}): BillingQaPrice => ({
  id, livemode: false, active: true, currency: "usd", unit_amount, recurring: { interval: "month", interval_count: 1 }, product: "prod_x", ...extra,
});

function fakeStripe(prices: BillingQaPrice[], errors: Record<string, unknown> = {}) {
  const retrieve = vi.fn(async (id: string) => {
    if (errors[id]) throw errors[id];
    const price = prices.find((p) => p.id === id);
    if (!price) throw Object.assign(new Error("No such price"), { code: "resource_missing", statusCode: 404 });
    return price;
  });
  return { client: { prices: { retrieve } } satisfies BillingQaStripeClient, retrieve };
}

const FOUNDER_ENV = {
  STRIPE_PRICE_STUDIO_STARTER_FOUNDER: "price_starter_f",
  STRIPE_PRICE_STUDIO_GROWTH_FOUNDER: "price_growth_f",
  STRIPE_PRICE_STUDIO_PRO_FOUNDER: "price_pro_f",
};
const FOUNDER_PRICES = [monthly("price_starter_f", 5900), monthly("price_growth_f", 9900), monthly("price_pro_f", 15900)];
const REGULAR_ENV = {
  STRIPE_PRICE_STUDIO_STARTER_STANDARD: "price_starter_r",
  STRIPE_PRICE_STUDIO_GROWTH_STANDARD: "price_growth_r",
  STRIPE_PRICE_STUDIO_PRO_STANDARD: "price_pro_r",
};
const REGULAR_PRICES = [monthly("price_starter_r", 8900), monthly("price_growth_r", 14900), monthly("price_pro_r", 24900)];

const byId = (report: Awaited<ReturnType<typeof verifyStudioPrices>>) => Object.fromEntries(report.checks.map((c) => [c.id, c]));

describe("BILLING-QA price verifier: Founder", () => {
  it("PASSes the approved $59 / $99 / $159 Founder Prices and the checkout each plan would create", async () => {
    const { client, retrieve } = fakeStripe(FOUNDER_PRICES);
    const report = await verifyStudioPrices({ env: FOUNDER_ENV, stripe: client });
    expect(report.overall).toBe("PASS");
    expect(report.counts).toEqual({ PASS: 9, FAIL: 0, BLOCKED: 0 });
    const checks = byId(report);
    expect(checks["checkout.pro"].detail).toBe("charges $159.00/month (founder)");
    expect(checks["founder.growth"].evidence).toMatchObject({ priceId: "price_growth_f", unitAmount: 9900 });
    // Read once per Price even though founder.* and checkout.* both use it.
    expect(retrieve).toHaveBeenCalledTimes(3);
    expect(report.config).toMatchObject({ founderPricingActive: true, regularPricingActivated: false });
  });

  it("FAILs a Founder Price still at the legacy $79 and says why", async () => {
    const { client } = fakeStripe([FOUNDER_PRICES[0], monthly("price_growth_f", 7900), FOUNDER_PRICES[2]]);
    const checks = byId(await verifyStudioPrices({ env: FOUNDER_ENV, stripe: client }));
    expect(checks["founder.growth"]).toMatchObject({ status: "FAIL", reason: "price_mismatch", detail: "amount $79.00 (expected $99.00)" });
    expect(checks["checkout.growth"]).toMatchObject({ status: "FAIL", reason: "checkout_refuses_price_mismatch" });
  });

  it("FAILs inactive, non-USD and yearly Prices", async () => {
    const { client } = fakeStripe([
      monthly("price_starter_f", 5900, { active: false }),
      monthly("price_growth_f", 9900, { currency: "eur" }),
      monthly("price_pro_f", 15900, { recurring: { interval: "year", interval_count: 1 } }),
    ]);
    const checks = byId(await verifyStudioPrices({ env: FOUNDER_ENV, stripe: client }));
    expect(checks["founder.starter"].detail).toBe("inactive");
    expect(checks["founder.growth"].detail).toBe("currency eur");
    expect(checks["founder.pro"].detail).toBe("interval every 1 year");
  });

  it("a missing Founder Price ID FAILs checkout (it would refuse every new subscriber)", async () => {
    const { client } = fakeStripe(FOUNDER_PRICES);
    const env = { ...FOUNDER_ENV, STRIPE_PRICE_STUDIO_STARTER_FOUNDER: "  " };
    const checks = byId(await verifyStudioPrices({ env, stripe: client }));
    expect(checks["founder.starter"]).toBeUndefined();
    expect(checks["checkout.starter"]).toMatchObject({ status: "FAIL", reason: "checkout_refuses_price_id_missing" });
  });

  it("a Price the test account does not have (e.g. a live ID) FAILs as price_not_found", async () => {
    const { client } = fakeStripe(FOUNDER_PRICES.slice(1));
    const checks = byId(await verifyStudioPrices({ env: FOUNDER_ENV, stripe: client }));
    expect(checks["founder.starter"]).toMatchObject({ status: "FAIL", reason: "price_not_found" });
  });
});

describe("BILLING-QA price verifier: Regular", () => {
  it("validates Regular $89 / $149 / $249 Prices before activation while checkout stays Founder", async () => {
    const { client } = fakeStripe([...FOUNDER_PRICES, ...REGULAR_PRICES]);
    const report = await verifyStudioPrices({ env: { ...FOUNDER_ENV, ...REGULAR_ENV }, stripe: client });
    const checks = byId(report);
    expect(report.overall).toBe("PASS");
    expect(checks["regular.pro"]).toMatchObject({ status: "PASS", evidence: expect.objectContaining({ unitAmount: 24900 }) });
    expect(checks["checkout.pro"].evidence).toMatchObject({ priceId: "price_pro_f", offerType: "founder" });
  });

  it("--require-regular reports an unset Regular Price as BLOCKED, not PASS", async () => {
    const { client } = fakeStripe(FOUNDER_PRICES);
    const report = await verifyStudioPrices({ env: FOUNDER_ENV, stripe: client, requireRegular: true });
    expect(report.overall).toBe("BLOCKED");
    expect(byId(report)["regular.starter"]).toMatchObject({ status: "BLOCKED", reason: "price_id_not_configured" });
  });

  it("Founder off without Regular activation FAILs checkout", async () => {
    const { client } = fakeStripe([...FOUNDER_PRICES, ...REGULAR_PRICES]);
    const env = { ...FOUNDER_ENV, ...REGULAR_ENV, FOUNDER_PRICING_ACTIVE: "false" };
    const checks = byId(await verifyStudioPrices({ env, stripe: client }));
    expect(checks["checkout.growth"]).toMatchObject({ status: "FAIL", reason: "checkout_refuses_regular_pricing_not_activated" });
  });

  it("Founder off with Regular activated: checkout charges the Regular Price", async () => {
    const { client } = fakeStripe([...FOUNDER_PRICES, ...REGULAR_PRICES]);
    const env = { ...FOUNDER_ENV, ...REGULAR_ENV, FOUNDER_PRICING_ACTIVE: "false", REGULAR_PRICING_ACTIVATED: "true", REGULAR_PRICING_APPROVAL_REF: "owner-ref" };
    const checks = byId(await verifyStudioPrices({ env, stripe: client }));
    expect(checks["checkout.growth"]).toMatchObject({ status: "PASS", detail: "charges $149.00/month (standard)" });
  });

  it("activation flag without an approval reference does not count as activated", async () => {
    const { client } = fakeStripe([...FOUNDER_PRICES, ...REGULAR_PRICES]);
    const env = { ...FOUNDER_ENV, ...REGULAR_ENV, FOUNDER_PRICING_ACTIVE: "false", REGULAR_PRICING_ACTIVATED: "true" };
    const report = await verifyStudioPrices({ env, stripe: client });
    expect(report.config.regularPricingActivated).toBe(false);
    expect(byId(report)["checkout.pro"].status).toBe("FAIL");
  });
});

describe("BILLING-QA price verifier: grandfathered Prices and plan mapping", () => {
  it("PASSes an archived grandfathered $129 Pro Price and maps it to Pro", async () => {
    const { client } = fakeStripe([...FOUNDER_PRICES, monthly("price_pro_legacy", 12900, { active: false })]);
    const env = { ...FOUNDER_ENV, STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY: "price_pro_legacy" };
    const checks = byId(await verifyStudioPrices({ env, stripe: client }));
    expect(checks["legacy.pro.1"]).toMatchObject({ status: "PASS", detail: "$129.00/month (archived)" });
    expect(checks["mapping.STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY[1]"]).toMatchObject({ status: "PASS", evidence: { resolvedPlan: "pro" } });
  });

  it("FAILs a grandfathered Price that is not monthly", async () => {
    const { client } = fakeStripe([...FOUNDER_PRICES, monthly("price_pro_legacy", 129000, { recurring: { interval: "year" } })]);
    const env = { ...FOUNDER_ENV, STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY: "price_pro_legacy" };
    const checks = byId(await verifyStudioPrices({ env, stripe: client }));
    expect(checks["legacy.pro.1"]).toMatchObject({ status: "FAIL", reason: "legacy_price_shape", detail: "interval every 1 year" });
  });

  it("FAILs mapping when one Price ID is configured for two plans", async () => {
    const { client } = fakeStripe(FOUNDER_PRICES);
    const env = { ...FOUNDER_ENV, STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY: "price_growth_f" };
    const checks = byId(await verifyStudioPrices({ env, stripe: client }));
    expect(checks["mapping.STRIPE_PRICE_STUDIO_GROWTH_FOUNDER"]).toMatchObject({ status: "FAIL", reason: "price_maps_to_no_single_plan" });
  });
});

describe("BILLING-QA price verifier: Stripe access and safety", () => {
  it("auth, permission and network errors are BLOCKED, not FAIL or PASS", async () => {
    const { client } = fakeStripe(FOUNDER_PRICES, {
      price_starter_f: Object.assign(new Error("bad key"), { statusCode: 401 }),
      price_growth_f: Object.assign(new Error("forbidden"), { statusCode: 403 }),
      price_pro_f: Object.assign(new Error("socket"), { type: "StripeConnectionError" }),
    });
    const report = await verifyStudioPrices({ env: FOUNDER_ENV, stripe: client });
    const checks = byId(report);
    expect(report.overall).toBe("BLOCKED");
    expect(checks["founder.starter"].reason).toBe("stripe_auth_failed");
    expect(checks["founder.growth"].reason).toBe("stripe_permission_denied");
    expect(checks["checkout.pro"]).toMatchObject({ status: "BLOCKED", reason: "stripe_unavailable" });
  });

  it("aborts the whole run on a live-mode Price", async () => {
    const { client } = fakeStripe([monthly("price_starter_f", 5900, { livemode: true }), ...FOUNDER_PRICES.slice(1)]);
    await expect(verifyStudioPrices({ env: FOUNDER_ENV, stripe: client })).rejects.toMatchObject({ code: "STRIPE_LIVEMODE_TRUE" });
  });

  it("aborts when livemode cannot be confirmed", async () => {
    const { client } = fakeStripe([monthly("price_starter_f", 5900, { livemode: undefined }), ...FOUNDER_PRICES.slice(1)]);
    await expect(verifyStudioPrices({ env: FOUNDER_ENV, stripe: client })).rejects.toMatchObject({ code: "STRIPE_LIVEMODE_UNKNOWN" });
  });
});
