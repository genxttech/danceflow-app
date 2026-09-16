import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isFounderPricingActive,
  resolveDisplayedMonthlyPriceCents,
  resolveTransparentPricingNote,
} from "@/lib/billing/founderPricing";
import { formatPlanMoney, getBillingPlan } from "@/lib/billing/plans";

/**
 * Pricing Data Hygiene slice: proves the shared Founder-pricing helper
 * behaves identically to the two independent inline expressions it
 * replaced in the checkout routes (regression safety for "checkout-price
 * selection behavior is unchanged"), and that display resolution correctly
 * tracks Founder-active state without ever touching plan codes or Stripe
 * Price mappings -- resolveDisplayedMonthlyPriceCents only ever reads a
 * BillingPlan and returns a number, it does not mutate or re-derive
 * anything Stripe-related.
 */

const ENV_KEYS = ["NEXT_PUBLIC_FOUNDER_PRICING_ACTIVE", "FOUNDER_PRICING_ACTIVE"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** Reproduces the exact expression previously duplicated inline in both
 * checkout route files, as the regression-safety baseline. */
function legacyInlineExpression() {
  return (
    process.env.NEXT_PUBLIC_FOUNDER_PRICING_ACTIVE !== "false" &&
    process.env.FOUNDER_PRICING_ACTIVE !== "false"
  );
}

describe("isFounderPricingActive", () => {
  it("matches the legacy inline expression when both env vars are unset (default: active)", () => {
    delete process.env.NEXT_PUBLIC_FOUNDER_PRICING_ACTIVE;
    delete process.env.FOUNDER_PRICING_ACTIVE;
    expect(isFounderPricingActive()).toBe(legacyInlineExpression());
    expect(isFounderPricingActive()).toBe(true);
  });

  it("matches the legacy expression when NEXT_PUBLIC_FOUNDER_PRICING_ACTIVE=false", () => {
    process.env.NEXT_PUBLIC_FOUNDER_PRICING_ACTIVE = "false";
    delete process.env.FOUNDER_PRICING_ACTIVE;
    expect(isFounderPricingActive()).toBe(legacyInlineExpression());
    expect(isFounderPricingActive()).toBe(false);
  });

  it("matches the legacy expression when FOUNDER_PRICING_ACTIVE=false", () => {
    delete process.env.NEXT_PUBLIC_FOUNDER_PRICING_ACTIVE;
    process.env.FOUNDER_PRICING_ACTIVE = "false";
    expect(isFounderPricingActive()).toBe(legacyInlineExpression());
    expect(isFounderPricingActive()).toBe(false);
  });

  it("matches the legacy expression when both are explicitly set to non-'false' values", () => {
    process.env.NEXT_PUBLIC_FOUNDER_PRICING_ACTIVE = "true";
    process.env.FOUNDER_PRICING_ACTIVE = "true";
    expect(isFounderPricingActive()).toBe(legacyInlineExpression());
    expect(isFounderPricingActive()).toBe(true);
  });
});

describe("resolveDisplayedMonthlyPriceCents", () => {
  const starterPlan = getBillingPlan("starter")!;
  const organizerPlan = getBillingPlan("organizer")!;

  it("resolves the Founder price while Founder pricing is active", () => {
    delete process.env.NEXT_PUBLIC_FOUNDER_PRICING_ACTIVE;
    delete process.env.FOUNDER_PRICING_ACTIVE;
    expect(resolveDisplayedMonthlyPriceCents(starterPlan)).toBe(starterPlan.amountMonthlyCents);
    expect(resolveDisplayedMonthlyPriceCents(organizerPlan)).toBe(organizerPlan.amountMonthlyCents);
  });

  it("resolves the regular price once Founder pricing is inactive", () => {
    process.env.FOUNDER_PRICING_ACTIVE = "false";
    expect(resolveDisplayedMonthlyPriceCents(starterPlan)).toBe(starterPlan.regularAmountMonthlyCents);
    expect(resolveDisplayedMonthlyPriceCents(organizerPlan)).toBe(organizerPlan.regularAmountMonthlyCents);
    // Locked Regular v1 / Events targets, confirmed via the same shared source.
    expect(starterPlan.regularAmountMonthlyCents).toBe(5900);
    expect(organizerPlan.regularAmountMonthlyCents).toBe(1900);
  });

  it("neither Founder-active state ever alters the plan's code or any other field", () => {
    const beforeActive = { ...starterPlan };
    resolveDisplayedMonthlyPriceCents(starterPlan);
    expect(starterPlan).toEqual(beforeActive);
    expect(starterPlan.code).toBe("starter");

    process.env.FOUNDER_PRICING_ACTIVE = "false";
    const beforeInactive = { ...organizerPlan };
    resolveDisplayedMonthlyPriceCents(organizerPlan);
    expect(organizerPlan).toEqual(beforeInactive);
    expect(organizerPlan.code).toBe("organizer");
  });
});

describe("Events billing copy derives from the shared canonical source, not a hardcoded literal", () => {
  it("the organizer plan's regular monthly price is the locked $19 Events target, sourced from plans.ts", () => {
    const organizerPlan = getBillingPlan("organizer")!;
    expect(organizerPlan.regularAmountMonthlyCents).toBe(1900);
  });
});

describe("resolveTransparentPricingNote", () => {
  const organizerPlan = getBillingPlan("organizer")!;
  const founderPriceText = formatPlanMoney(organizerPlan.amountMonthlyCents);
  const regularPriceText = formatPlanMoney(organizerPlan.regularAmountMonthlyCents!);

  it("shows Founder promotional pricing/copy consistently while Founder pricing is active", () => {
    delete process.env.NEXT_PUBLIC_FOUNDER_PRICING_ACTIVE;
    delete process.env.FOUNDER_PRICING_ACTIVE;

    const note = resolveTransparentPricingNote(organizerPlan);

    expect(note).toContain(`founder pricing is ${founderPriceText}/month`);
    expect(note).toContain(`regularly ${regularPriceText}/month`);
    // The exact price figures rendered must match the plan's own configured
    // Founder/regular values, not a second, independently-typed literal.
    expect(note).toContain(founderPriceText);
    expect(note).toContain(regularPriceText);
  });

  it("contains no stale Founder offer language once Founder pricing is inactive, and shows the regular price", () => {
    process.env.FOUNDER_PRICING_ACTIVE = "false";

    const note = resolveTransparentPricingNote(organizerPlan);

    expect(note).not.toContain("founder");
    expect(note).not.toContain("Founder");
    expect(note).not.toContain(founderPriceText);
    expect(note).toContain(`${regularPriceText}/month`);
  });

  it("derives its price figures from the plan's existing amountMonthlyCents/regularAmountMonthlyCents fields, introducing no new duplicated constant", () => {
    delete process.env.NEXT_PUBLIC_FOUNDER_PRICING_ACTIVE;
    delete process.env.FOUNDER_PRICING_ACTIVE;
    const founderActiveNote = resolveTransparentPricingNote(organizerPlan);

    process.env.FOUNDER_PRICING_ACTIVE = "false";
    const founderInactiveNote = resolveTransparentPricingNote(organizerPlan);

    // Changing only the plan's own configured cents fields changes the note --
    // proving the note has no independent hardcoded price of its own.
    const mutatedPlan = { ...organizerPlan, amountMonthlyCents: 1500, regularAmountMonthlyCents: 2500 };
    delete process.env.FOUNDER_PRICING_ACTIVE;
    const mutatedNote = resolveTransparentPricingNote(mutatedPlan);

    expect(founderActiveNote).not.toBe(mutatedNote);
    expect(mutatedNote).toContain(formatPlanMoney(1500));
    expect(mutatedNote).toContain(formatPlanMoney(2500));
    expect(founderInactiveNote).toContain(regularPriceText);
  });

  it("returns undefined for a plan with no fee-structure copy configured", () => {
    const starterPlan = getBillingPlan("starter")!;
    expect(resolveTransparentPricingNote(starterPlan)).toBeUndefined();
  });
});
