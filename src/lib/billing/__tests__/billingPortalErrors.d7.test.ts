import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BILLING_PORTAL_ERROR_MESSAGES,
  BILLING_SUPPORT_EMAIL,
  resolvePlanCardCta,
} from "../billingPortalErrors";

describe("D7-1 portal error messages", () => {
  it("has a customer-visible message for every error code the portal route can emit", () => {
    const source = readFileSync("src/app/api/billing/portal/route.ts", "utf8");
    const codes = new Set([...source.matchAll(/error=([a-z_]+)/g)].map((match) => match[1]));
    expect(codes.size).toBeGreaterThanOrEqual(3);
    for (const code of codes) {
      expect(BILLING_PORTAL_ERROR_MESSAGES[code], code).toBeTruthy();
    }
  });

  it("the billing page uses these messages instead of the generic fallback", () => {
    const page = readFileSync("src/app/app/settings/billing/page.tsx", "utf8");
    expect(page).toContain("...BILLING_PORTAL_ERROR_MESSAGES");
  });
});

describe("D7-2 plan card call to action", () => {
  it("marks the current plan", () => {
    expect(resolvePlanCardCta({ isCurrent: true, hasManagedSubscription: true, planLabel: "Pro" })).toEqual({
      kind: "current",
      label: "Current Plan",
    });
  });

  it("never offers a direct plan switch to an existing subscriber: support contact, no checkout form", () => {
    const cta = resolvePlanCardCta({ isCurrent: false, hasManagedSubscription: true, planLabel: "Growth" });
    expect(cta.kind).toBe("contact_support");
    if (cta.kind !== "contact_support") return;
    expect(cta.label).not.toBe("Change Plan");
    expect(cta.mailto).toContain(`mailto:${BILLING_SUPPORT_EMAIL}`);
    expect(decodeURIComponent(cta.mailto)).toContain("Growth");
  });

  it("keeps the trial start for a studio with no managed subscription", () => {
    expect(resolvePlanCardCta({ isCurrent: false, hasManagedSubscription: false, planLabel: "Starter" })).toEqual({
      kind: "start_trial",
      label: "Start Starter Trial",
    });
  });

  it("the page no longer carries the misleading Change Plan label and routes through the helper", () => {
    const page = readFileSync("src/app/app/settings/billing/page.tsx", "utf8");
    expect(page).not.toMatch(/["'`]Change Plan["'`]/);
    expect(page).toContain("resolvePlanCardCta");
  });
});
