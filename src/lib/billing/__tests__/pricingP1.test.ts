import { afterEach, describe, expect, it } from "vitest";
import {
  BILLING_PLANS,
  PLAN_FEATURES,
  ORGANIZER_PLAN_FEATURES,
  getBillingPlan,
  formatPlanMoney,
} from "@/lib/billing/plans";
import {
  resolveDisplayedMonthlyPriceCents,
  resolveReferenceRegularPriceCents,
  resolveTransparentPricingNote,
} from "@/lib/billing/founderPricing";
import {
  isRegularPricingActivated,
  resolveRegularMonthlyCents,
} from "@/lib/billing/regularPricing";
import {
  selectStudioMonthlyPrice,
  stripePriceMatchesExpected,
} from "@/lib/billing/studioCheckoutPricing";

/**
 * PRICING-P1. Approved Founder prices $59/$99/$159; provisional regular
 * $89/$149/$249 present in configuration but invisible to customers until
 * REGULAR_PRICING_ACTIVATED=true. No test touches Stripe.
 */

const studio = (code: string) => getBillingPlan(code)!;
const ENV_KEYS = ["FOUNDER_PRICING_ACTIVE", "NEXT_PUBLIC_FOUNDER_PRICING_ACTIVE", "REGULAR_PRICING_ACTIVATED"];
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("price configuration", () => {
  it.each([
    ["starter", 5900, 8900],
    ["growth", 9900, 14900],
    ["pro", 15900, 24900],
  ])("%s: Founder %i cents, provisional regular %i cents", (code, founder, regular) => {
    const plan = studio(code);
    expect(plan.amountMonthlyCents).toBe(founder);
    expect(plan.provisionalRegularAmountMonthlyCents).toBe(regular);
    // the live-facing regular field is not used by studio plans
    expect(plan.regularAmountMonthlyCents).toBeUndefined();
  });

  it("organizer pricing is untouched", () => {
    const plan = studio("organizer");
    expect([plan.amountMonthlyCents, plan.regularAmountMonthlyCents]).toEqual([1200, 1900]);
  });
});

describe("display", () => {
  it("shows Founder prices by default and no regular reference", () => {
    expect(["starter", "growth", "pro"].map((c) => formatPlanMoney(resolveDisplayedMonthlyPriceCents(studio(c))))).toEqual([
      "$59.00",
      "$99.00",
      "$159.00",
    ]);
    expect(resolveReferenceRegularPriceCents(studio("growth"))).toBeUndefined();
  });

  it("exposes provisional regular prices only after explicit activation", () => {
    process.env.REGULAR_PRICING_ACTIVATED = "true";
    expect(isRegularPricingActivated()).toBe(true);
    expect(resolveReferenceRegularPriceCents(studio("pro"))).toBe(24900);
    process.env.FOUNDER_PRICING_ACTIVE = "false";
    expect(resolveDisplayedMonthlyPriceCents(studio("starter"))).toBe(8900);
  });

  it.each(["", "TRUE", "1", "yes", "false"])("REGULAR_PRICING_ACTIVATED=%j is OFF", (v) => {
    process.env.REGULAR_PRICING_ACTIVATED = v;
    expect(isRegularPricingActivated()).toBe(false);
  });

  it("studio note copy is unchanged (no fee note)", () => {
    expect(resolveTransparentPricingNote(studio("starter"))).toBeUndefined();
  });

  it("no studio plan copy promises the Founder price forever", () => {
    for (const plan of BILLING_PLANS) {
      expect(plan.founderOfferNote ?? "").not.toMatch(/forever|for life|lifetime|permanent/i);
    }
  });
});

describe("checkout selection (fail-closed)", () => {
  const env = {
    STRIPE_PRICE_STUDIO_GROWTH_FOUNDER: " price_f_growth ",
    STRIPE_PRICE_STUDIO_GROWTH_STANDARD: "price_s_growth",
  };
  const base = { plan: studio("growth"), env };

  it("founder: uses the Founder Price ID and expects the Founder amount", () => {
    expect(selectStudioMonthlyPrice({ ...base, founderActive: true, regularActivated: false })).toEqual({
      ok: true,
      stripePriceId: "price_f_growth",
      offerType: "founder",
      expectedAmountCents: 9900,
    });
  });

  it("founder: missing Founder Price ID never falls back to standard", () => {
    expect(
      selectStudioMonthlyPrice({ plan: studio("growth"), env: { STRIPE_PRICE_STUDIO_GROWTH_STANDARD: "price_s" }, founderActive: true, regularActivated: true }),
    ).toEqual({ ok: false, reason: "price_id_missing" });
  });

  it("founder off + regular not activated: refuses (no standard charge at an unapproved amount)", () => {
    expect(selectStudioMonthlyPrice({ ...base, founderActive: false, regularActivated: false })).toEqual({
      ok: false,
      reason: "regular_pricing_not_activated",
    });
  });

  it("founder off + regular activated: standard Price ID with provisional regular amount", () => {
    expect(selectStudioMonthlyPrice({ ...base, founderActive: false, regularActivated: true })).toMatchObject({
      ok: true,
      stripePriceId: "price_s_growth",
      offerType: "standard",
      expectedAmountCents: 14900,
    });
  });

  it("blank env value counts as missing; organizer is out of scope", () => {
    expect(
      selectStudioMonthlyPrice({ plan: studio("pro"), env: { STRIPE_PRICE_STUDIO_PRO_FOUNDER: "  " }, founderActive: true, regularActivated: false }),
    ).toEqual({ ok: false, reason: "price_id_missing" });
    expect(selectStudioMonthlyPrice({ plan: studio("organizer"), env, founderActive: true, regularActivated: false })).toEqual({
      ok: false,
      reason: "unsupported_plan",
    });
  });

  it("verifies the Stripe Price amount, currency, interval and active state", () => {
    const good = { active: true, currency: "usd", unit_amount: 5900, recurring: { interval: "month", interval_count: 1 } };
    expect(stripePriceMatchesExpected(good, 5900)).toBe(true);
    expect(stripePriceMatchesExpected({ ...good, unit_amount: 4900 }, 5900)).toBe(false); // legacy $49 price
    expect(stripePriceMatchesExpected({ ...good, active: false }, 5900)).toBe(false);
    expect(stripePriceMatchesExpected({ ...good, currency: "cad" }, 5900)).toBe(false);
    expect(stripePriceMatchesExpected({ ...good, recurring: { interval: "year" } }, 5900)).toBe(false);
    expect(stripePriceMatchesExpected({ ...good, recurring: null }, 5900)).toBe(false);
    expect(stripePriceMatchesExpected(null, 5900)).toBe(false);
  });

  it("resolveRegularMonthlyCents: organizer keeps its regular price regardless of the gate", () => {
    expect(resolveRegularMonthlyCents(studio("organizer"), false)).toBe(1900);
    expect(resolveRegularMonthlyCents(studio("starter"), false)).toBeUndefined();
  });
});

describe("entitlements are unchanged by pricing work", () => {
  it("studio feature sets match the pre-PRICING-P1 baseline", () => {
    expect(PLAN_FEATURES.starter).toEqual(["crm_basic", "schedule_basic", "public_events", "basic_reporting"]);
    expect(PLAN_FEATURES.growth).toContain("documents");
    expect(PLAN_FEATURES.starter).not.toContain("documents");
    expect(PLAN_FEATURES.growth).not.toContain("report_exports");
    expect(PLAN_FEATURES.pro).toEqual(expect.arrayContaining(["report_exports", "wave_accounting", "documents"]));
    expect(ORGANIZER_PLAN_FEATURES.organizer).toContain("ticketing");
    for (const code of ["starter", "growth", "pro"] as const) {
      expect(studio(code).features).toEqual(PLAN_FEATURES[code]);
    }
  });
});
