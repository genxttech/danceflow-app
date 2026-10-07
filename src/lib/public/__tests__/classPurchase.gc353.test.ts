import { describe, expect, it } from "vitest";

import {
  CLASS_PURCHASE_ERROR_KINDS,
  classPurchaseErrorMessage,
  classifyClassPurchaseError,
  formatUsdCents,
  isClassPurchaseErrorKind,
  parsePurchaseReturnFlag,
  policyPriceToCents,
  resolvePurchaseView,
  type OwnPurchase,
} from "@/lib/public/classPurchase";

/** GC-3.5-3 pure helpers: price display, safe error translation and the authoritative-state view model. */

const NOW = Date.parse("2030-01-01T12:00:00Z");

function purchase(over: Partial<OwnPurchase> = {}): OwnPurchase {
  return {
    holdId: "h1", status: "held", amountCents: 2500, expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString(),
    createdAt: new Date(NOW).toISOString(), checkoutSessionId: "cs_1", stripeAccountId: "acct_1",
    clientId: null, attendeeId: null, paymentId: null, dancerFirstName: "Ada", dancerLastName: "Lovelace", ...over,
  };
}

describe("price display", () => {
  it("formats integer cents as USD", () => {
    expect(formatUsdCents(2500)).toBe("$25.00");
    expect(formatUsdCents(5)).toBe("$0.05");
    expect(formatUsdCents(1234567)).toBe("$12,345.67");
  });

  it("policy price -> cents only for positive whole cents within the limit (display only)", () => {
    expect(policyPriceToCents("25.00")).toBe(2500);
    expect(policyPriceToCents(25.5)).toBe(2550);
    expect(policyPriceToCents("0.01")).toBe(1);
    for (const bad of ["12.345", "0", "-1", "abc", null, undefined, "", "100000.01"]) expect(policyPriceToCents(bad)).toBeNull();
  });
});

describe("error translation", () => {
  it("maps every GC35 refusal to a safe kind and unknown text to a generic failure", () => {
    expect(classifyClassPurchaseError("GC35_CLASS_FULL: This class is full.")).toBe("full");
    expect(classifyClassPurchaseError("GC35_SELF_ENROLLMENT_CLOSED: x")).toBe("unavailable");
    expect(classifyClassPurchaseError("duplicate key value violates unique constraint secret_idx")).toBe("checkout_failed");
    expect(classifyClassPurchaseError(null)).toBe("checkout_failed");
  });

  it("every kind has purchaser copy with no internal codes", () => {
    for (const kind of CLASS_PURCHASE_ERROR_KINDS) {
      const text = classPurchaseErrorMessage(kind, "Salsa House");
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/GC35_|_|stripe|sql|constraint/i);
    }
  });

  it("only known kinds are accepted from the URL", () => {
    expect(isClassPurchaseErrorKind("full")).toBe(true);
    expect(isClassPurchaseErrorKind("GC35_CLASS_FULL")).toBe(false);
    expect(isClassPurchaseErrorKind("<script>")).toBe(false);
  });
});

describe("purchase view (browser return is display only)", () => {
  const base = { attendeeActive: false, refunded: false, now: NOW };

  it("no purchase -> none, whatever the URL says", () => {
    expect(resolvePurchaseView({ ...base, purchase: null, returnFlag: "return" })).toEqual({ kind: "none" });
    expect(parsePurchaseReturnFlag("paid")).toBeNull();
    expect(parsePurchaseReturnFlag("return")).toBe("return");
  });

  it("converted + active attendee -> registered; a staff-cancelled enrollment falls back to the normal flow", () => {
    const converted = purchase({ status: "converted", clientId: "c", attendeeId: "a", paymentId: "p" });
    expect(resolvePurchaseView({ ...base, purchase: converted, returnFlag: null, attendeeActive: true }).kind).toBe("registered");
    expect(resolvePurchaseView({ ...base, purchase: converted, returnFlag: null, attendeeActive: false }).kind).toBe("none");
  });

  it("conflict -> refunded only when the payment is refunded; otherwise contact the studio", () => {
    const conflict = purchase({ status: "conflict", paymentId: "p" });
    expect(resolvePurchaseView({ ...base, purchase: conflict, returnFlag: "return", refunded: true }).kind).toBe("refunded");
    expect(resolvePurchaseView({ ...base, purchase: conflict, returnFlag: "return" }).kind).toBe("needs_studio");
  });

  it("held with checkout: return -> finalizing (also inside the reconciliation grace); cancel -> not completed; else resume", () => {
    expect(resolvePurchaseView({ ...base, purchase: purchase(), returnFlag: "return" }).kind).toBe("finalizing");
    expect(resolvePurchaseView({ ...base, purchase: purchase(), returnFlag: "cancelled" }).kind).toBe("not_completed");
    expect(resolvePurchaseView({ ...base, purchase: purchase(), returnFlag: null }).kind).toBe("checkout_open");
    const justExpired = purchase({ expiresAt: new Date(NOW - 5 * 60 * 1000).toISOString() });
    expect(resolvePurchaseView({ ...base, purchase: justExpired, returnFlag: "return" }).kind).toBe("finalizing");
    expect(resolvePurchaseView({ ...base, purchase: justExpired, returnFlag: null }).kind).toBe("none");
    const longExpired = purchase({ expiresAt: new Date(NOW - 11 * 60 * 1000).toISOString() });
    expect(resolvePurchaseView({ ...base, purchase: longExpired, returnFlag: "return" }).kind).toBe("none");
  });

  it("a hold without checkout or a released hold shows the normal flow", () => {
    expect(resolvePurchaseView({ ...base, purchase: purchase({ checkoutSessionId: null }), returnFlag: "return" }).kind).toBe("none");
    expect(resolvePurchaseView({ ...base, purchase: purchase({ status: "released" }), returnFlag: "return" }).kind).toBe("none");
  });
});
