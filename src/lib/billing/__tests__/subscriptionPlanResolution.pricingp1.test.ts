import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { resolvePlanCodeFromEnvPriceId } from "../subscriptionPlanResolution";

const env = {
  STRIPE_PRICE_STUDIO_STARTER_FOUNDER: "price_s_new",
  STRIPE_PRICE_STUDIO_GROWTH_FOUNDER: "price_g_new",
  STRIPE_PRICE_STUDIO_PRO_FOUNDER: "price_p_new",
  STRIPE_PRICE_STUDIO_STARTER_STANDARD: "price_s_std",
  STRIPE_PRICE_STUDIO_GROWTH_STANDARD: " price_g_std ",
  STRIPE_PRICE_STUDIO_PRO_STANDARD: "price_p_std",
  STRIPE_PRICE_ORGANIZER_FOUNDER: "price_o_f",
  STRIPE_PRICE_ORGANIZER_STANDARD: "price_o_s",
};

describe("resolvePlanCodeFromEnvPriceId (PRICING-P1)", () => {
  it("maps every configured Founder and standard Price to its plan", () => {
    expect(resolvePlanCodeFromEnvPriceId("price_s_new", env)).toBe("starter");
    expect(resolvePlanCodeFromEnvPriceId("price_g_new", env)).toBe("growth");
    expect(resolvePlanCodeFromEnvPriceId("price_p_new", env)).toBe("pro");
    expect(resolvePlanCodeFromEnvPriceId("price_s_std", env)).toBe("starter");
    expect(resolvePlanCodeFromEnvPriceId("price_g_std", env)).toBe("growth");
    expect(resolvePlanCodeFromEnvPriceId("price_p_std", env)).toBe("pro");
    expect(resolvePlanCodeFromEnvPriceId("price_o_f", env)).toBe("organizer");
    expect(resolvePlanCodeFromEnvPriceId("price_o_s", env)).toBe("organizer");
  });

  it("a Growth -> Pro portal change resolves to Pro even when metadata says Growth", () => {
    // metadata.planCode is not an input: the Price alone decides.
    expect(resolvePlanCodeFromEnvPriceId("price_p_new", env)).toBe("pro");
  });

  it("grandfathered legacy Founder Prices resolve by Price (single or comma-separated)", () => {
    const withLegacy = {
      ...env,
      STRIPE_PRICE_STUDIO_PRO_FOUNDER: "price_p_159",
      STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY: "price_p_129, price_p_old",
    };
    expect(resolvePlanCodeFromEnvPriceId("price_p_159", withLegacy)).toBe("pro");
    expect(resolvePlanCodeFromEnvPriceId("price_p_129", withLegacy)).toBe("pro");
    expect(resolvePlanCodeFromEnvPriceId("price_p_old", withLegacy)).toBe("pro");
    // an unlisted legacy Price still falls through to metadata (null)
    expect(resolvePlanCodeFromEnvPriceId("price_p_other", withLegacy)).toBeNull();
    // legacy list does not leak across plans
    expect(resolvePlanCodeFromEnvPriceId("price_p_129", { ...withLegacy, STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY: "" })).toBeNull();
  });

  it("an unset env var never matches an empty price id", () => {
    expect(resolvePlanCodeFromEnvPriceId("", { STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY: "," })).toBeNull();
  });

  it("returns null for unknown, empty or unset prices (caller falls back to metadata)", () => {
    expect(resolvePlanCodeFromEnvPriceId("price_legacy_79", env)).toBeNull();
    expect(resolvePlanCodeFromEnvPriceId("", env)).toBeNull();
    expect(resolvePlanCodeFromEnvPriceId(null, env)).toBeNull();
    expect(resolvePlanCodeFromEnvPriceId("price_s_new", {})).toBeNull();
  });
});

describe("webhook plan resolution order (PRICING-P1)", () => {
  it("tries DB price id, then env price id, then metadata.planCode", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/payments/webhook/route.ts"), "utf8");
    const db = src.indexOf("stripe_price_id_monthly.eq.${stripePriceId}");
    const envIdx = src.indexOf("resolvePlanCodeFromEnvPriceId(stripePriceId, process.env)");
    const meta = src.indexOf("if (!planRow && metadataPlanCode)");
    expect(db).toBeGreaterThan(0);
    expect(envIdx).toBeGreaterThan(db);
    expect(meta).toBeGreaterThan(envIdx);
  });
});
