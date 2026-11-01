import { describe, expect, it } from "vitest";
import { resolvePlanCodeFromEnvPriceIds } from "../subscriptionPlanResolution";

describe("D7 WP-3: the approved future regular Pro Price is recognised by the webhook plan mapping", () => {
  const env = {
    STRIPE_PRICE_STUDIO_PRO_FOUNDER: "price_founder_pro",
    STRIPE_PRICE_STUDIO_PRO_STANDARD: "price_standard_pro",
    STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY: "price_legacy129",
    STRIPE_PRICE_STUDIO_PRO_STANDARD_TRANSITION: "price_july_2027",
  };

  it("maps the transition Price, the legacy Price and the current prices to pro", () => {
    for (const price of ["price_july_2027", "price_legacy129", "price_standard_pro", "price_founder_pro"]) {
      expect(resolvePlanCodeFromEnvPriceIds([price], env)).toBe("pro");
    }
  });

  it("does not map the transition Price before it is configured", () => {
    const { STRIPE_PRICE_STUDIO_PRO_STANDARD_TRANSITION: _omitted, ...without } = env;
    void _omitted;
    expect(resolvePlanCodeFromEnvPriceIds(["price_july_2027"], without)).toBeNull();
  });
});
