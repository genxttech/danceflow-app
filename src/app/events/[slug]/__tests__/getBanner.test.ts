import { describe, expect, it } from "vitest";
import { getBanner } from "../banner";

/**
 * Public Event Document-Checkpoint Remediation: getBanner() must recognize
 * cart_checkout_failed (previously fell through to `return null` -- no
 * banner at all -- part of the "blank form, no visible error" symptom) with
 * a message that makes clear no payment was made.
 */
describe("getBanner -- cart_checkout_failed", () => {
  it("renders a clear error banner distinguishing it from a Stripe-side failure", () => {
    const banner = getBanner({ error: "cart_checkout_failed" });
    expect(banner).not.toBeNull();
    expect(banner?.kind).toBe("error");
    expect(banner?.message).toMatch(/couldn't|weren't able|could not/i);
    expect(banner?.message).toMatch(/no payment/i);
  });

  it("still recognizes the pre-existing checkout_session_failed banner unchanged", () => {
    const banner = getBanner({ error: "checkout_session_failed" });
    expect(banner?.kind).toBe("error");
    expect(banner?.message).toBe("Could not start Stripe Checkout. Please try again.");
  });

  it("returns null for no search params (no false-positive banner)", () => {
    expect(getBanner({})).toBeNull();
  });
});
