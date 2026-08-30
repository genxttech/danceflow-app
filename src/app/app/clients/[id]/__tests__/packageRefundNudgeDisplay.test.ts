import { describe, expect, it } from "vitest";

import {
  getPackageRefundNudgeDisplay,
  type PaymentRow,
  type PackageRefundReconciliationRow,
} from "@/app/app/clients/[id]/page";

/**
 * Package Refund P0, Slice 2c-2 (extended by Pre-Activation Hardening PR 2):
 * the corrected display decision covering all four states from the plan's
 * own acceptance table -- pending review shows the real panel; any other
 * reconciliation outcome suppresses the legacy nudge entirely (a resolved
 * reconciliation must never resurface the generic "review needed" text); no
 * reconciliation row at all preserves today's real production behavior (the
 * legacy nudge, since Slice 2c-1's migration isn't applied to dev/prod yet);
 * a non-package payment type is always "legacy", regardless of
 * reconciliation state.
 *
 * PR 2 adds a third parameter, heldForPackageRefund, threaded from the
 * shared PACKAGE_REFUND_RECONCILIATION_RELEASE_HOLD constant at the
 * function's sole call site in page.tsx. Every call below passes it
 * explicitly -- no implicit default -- so the hold's one behavioral effect
 * (pending_review + held -> "none" instead of "review") is never hidden by
 * an unstated default, and every other branch is proven stable under both
 * hold states.
 */

function payment(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: "payment-1",
    amount: 100,
    payment_method: "card",
    status: "paid",
    created_at: "2026-08-01T00:00:00.000Z",
    notes: null,
    source: "stripe",
    payment_type: "package_sale",
    payment_channel: null,
    currency: "usd",
    stripe_invoice_id: null,
    stripe_payment_intent_id: "pi_123",
    stripe_charge_id: "ch_123",
    stripe_refund_id: "rf_123",
    refund_amount: 30,
    refunded_at: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

function reconciliation(overrides: Partial<PackageRefundReconciliationRow> = {}): PackageRefundReconciliationRow {
  return {
    id: "recon-1",
    payment_id: "payment-1",
    client_package_id: "pkg-1",
    refund_amount_cents: 3000,
    refund_status: "succeeded",
    reconciliation_outcome: "pending_review",
    review_reason: null,
    updated_at: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("getPackageRefundNudgeDisplay", () => {
  it('"review" -- a pending_review reconciliation exists for a package payment, hold=false', () => {
    expect(getPackageRefundNudgeDisplay(payment(), [reconciliation()], false)).toBe("review");
  });

  it('"none" -- a pending_review reconciliation exists but Package Refund is held (hold=true)', () => {
    expect(getPackageRefundNudgeDisplay(payment(), [reconciliation()], true)).toBe("none");
  });

  it('"none" -- a reconciliation exists but is already resolved (every non-pending outcome), unaffected by hold state', () => {
    for (const outcome of ["not_yet_effective", "auto_applied", "staff_applied", "no_action_needed", "reversed"]) {
      expect(
        getPackageRefundNudgeDisplay(payment(), [reconciliation({ reconciliation_outcome: outcome })], false),
      ).toBe("none");
      expect(
        getPackageRefundNudgeDisplay(payment(), [reconciliation({ reconciliation_outcome: outcome })], true),
      ).toBe("none");
    }
  });

  it('"legacy" -- no reconciliation row exists at all for a package payment (today\'s real production state), unaffected by hold state', () => {
    expect(getPackageRefundNudgeDisplay(payment(), [], false)).toBe("legacy");
    expect(getPackageRefundNudgeDisplay(payment(), [], true)).toBe("legacy");
  });

  it('"legacy" -- a reconciliation exists but for a DIFFERENT payment_id, unaffected by hold state', () => {
    expect(
      getPackageRefundNudgeDisplay(payment(), [reconciliation({ payment_id: "some-other-payment" })], false),
    ).toBe("legacy");
    expect(
      getPackageRefundNudgeDisplay(payment(), [reconciliation({ payment_id: "some-other-payment" })], true),
    ).toBe("legacy");
  });

  it('"legacy" -- a non-package payment type, regardless of reconciliation state or hold state', () => {
    const membershipPayment = payment({ payment_type: "membership" });
    expect(getPackageRefundNudgeDisplay(membershipPayment, [reconciliation()], false)).toBe("legacy");
    expect(getPackageRefundNudgeDisplay(membershipPayment, [reconciliation()], true)).toBe("legacy");
    expect(getPackageRefundNudgeDisplay(membershipPayment, [], false)).toBe("legacy");
    expect(getPackageRefundNudgeDisplay(membershipPayment, [], true)).toBe("legacy");
  });

  it('"none" (not "legacy" or "review") -- no refund amount at all, regardless of payment type or reconciliation state or hold state', () => {
    const noRefund = payment({ refund_amount: 0 });
    expect(getPackageRefundNudgeDisplay(noRefund, [reconciliation()], false)).toBe("none");
    expect(getPackageRefundNudgeDisplay(noRefund, [reconciliation()], true)).toBe("none");
  });

  it("prefers a pending_review row over other rows for the same payment when multiple exist, hold=false", () => {
    const rows = [
      reconciliation({ id: "recon-old", reconciliation_outcome: "no_action_needed", updated_at: "2026-08-03T00:00:00.000Z" }),
      reconciliation({ id: "recon-new", reconciliation_outcome: "pending_review", updated_at: "2026-08-01T00:00:00.000Z" }),
    ];
    expect(getPackageRefundNudgeDisplay(payment(), rows, false)).toBe("review");
  });

  it("the same multi-row pending_review preference collapses to none when held", () => {
    const rows = [
      reconciliation({ id: "recon-old", reconciliation_outcome: "no_action_needed", updated_at: "2026-08-03T00:00:00.000Z" }),
      reconciliation({ id: "recon-new", reconciliation_outcome: "pending_review", updated_at: "2026-08-01T00:00:00.000Z" }),
    ];
    expect(getPackageRefundNudgeDisplay(payment(), rows, true)).toBe("none");
  });
});
