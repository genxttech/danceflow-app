import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

/**
 * Package Refund P0, Slice 2c-1: focused coverage for the webhook-wiring
 * seam around package-refund reconciliation. Deliberately does NOT re-test
 * what's already covered elsewhere:
 *   - Case A/B/C, idempotency, identity-safety, missing-price handling all
 *     live in the RPC itself (local-Docker SQL regression, this
 *     initiative's established convention).
 *   - The exact input-construction rule (single-event amount never
 *     cumulative, status/identity pass-through, null short-circuits) is
 *     the pure `buildPackageRefundReconciliationInput` function, unit-
 *     tested directly in package-refund-reconciliation.test.ts with no
 *     fakes needed at all.
 *   - "resolve every matching payment, call the RPC once per payment" is
 *     covered in package-refund-reconciliation.test.ts.
 *
 * What's left, and what this file proves, by exercising the real exported
 * `handleStripeRefundUpdated`/`handleChargeRefunded` against a minimal
 * fake (not a full webhook-request harness -- Stripe signature
 * verification, event dispatch, and payment_provider_events idempotency
 * are untouched by this slice and not re-tested here):
 *   1. `handleStripeRefundUpdated` actually wires the single-event amount
 *      (not the cumulative charge total it resolves for the existing,
 *      unchanged payment-summary sync) through to reconciliation, end to
 *      end -- not just that the pure builder does the right thing in
 *      isolation, but that the handler feeds it the right raw inputs.
 *   2. The existing payment-summary sync (`payments.refund_amount`) still
 *      receives the cumulative amount exactly as before -- unchanged
 *      behavior, verified directly.
 *   3. `handleChargeRefunded` (the `charge.refunded`/`charge.updated` path)
 *      never calls package reconciliation, as a genuine runtime
 *      assertion -- not just a static grep -- confirming the approved
 *      "refund.* is the sole authority" architecture.
 */

const reconcileMock = vi.fn<(supabase: unknown, input: unknown) => Promise<unknown[]>>();
reconcileMock.mockResolvedValue([]);

vi.mock("@/lib/payments/package-refund-reconciliation", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/payments/package-refund-reconciliation")
  >();
  return {
    ...actual,
    reconcilePackageStripeRefund: (supabase: unknown, input: unknown) => reconcileMock(supabase, input),
  };
});

const { handleStripeRefundUpdated, handleChargeRefunded } = await import(
  "@/app/api/payments/webhook/route"
);

type FakeResult = { data?: unknown; error?: { message: string } | null };

function makeChain(resolve: () => FakeResult | Promise<FakeResult>) {
  const chain: {
    eq: (...args: unknown[]) => typeof chain;
    then: (
      onFulfilled: (value: FakeResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => unknown;
  } = {
    eq: () => chain,
    then(onFulfilled, onRejected) {
      return Promise.resolve(resolve()).then(onFulfilled, onRejected);
    },
  };
  return chain;
}

function createFakeSupabase(payments: { id: string; amount: number }[]) {
  const paymentsUpdatePayloads: Record<string, unknown>[] = [];

  const supabase = {
    from(table: string) {
      if (table === "payments") {
        return {
          select: () => makeChain(() => ({ data: payments, error: null })),
          update: (payload: Record<string, unknown>) => {
            paymentsUpdatePayloads.push(payload);
            return makeChain(() => ({ data: null, error: null }));
          },
        };
      }
      if (table === "event_payments") {
        return {
          select: () => makeChain(() => ({ data: [], error: null })),
        };
      }
      throw new Error(`Unexpected table in fake webhook-wiring db: ${table}`);
    },
  };

  return { supabase, paymentsUpdatePayloads };
}

function createFakeStripe(charge: Partial<Stripe.Charge> | null) {
  return {
    charges: {
      retrieve: async () => charge as Stripe.Charge,
    },
    paymentIntents: {
      // Rejecting here is deliberate and safe: syncFeeDetailsForPaymentIntent
      // catches this internally and no-ops (returns false) without touching
      // Supabase at all -- confirmed by direct code read -- so this keeps the
      // fake minimal without needing to model fee-sync writes at all.
      retrieve: async () => {
        throw new Error("no fee details in this focused test");
      },
    },
  } as unknown as Stripe;
}

function fakeRefund(overrides: Partial<Stripe.Refund> = {}): Stripe.Refund {
  return {
    id: "rf_123",
    amount: 3000,
    status: "succeeded",
    payment_intent: "pi_123",
    charge: "ch_123",
    ...overrides,
  } as Stripe.Refund;
}

describe("Package Refund P0, Slice 2c-1: handleStripeRefundUpdated wiring", () => {
  it("requirement 1 -- reconciliation receives the single refund-event amount, not the charge's cumulative amount_refunded", async () => {
    reconcileMock.mockClear();
    const { supabase, paymentsUpdatePayloads } = createFakeSupabase([{ id: "payment-1", amount: 100 }]);
    const stripe = createFakeStripe({
      payment_intent: "pi_123",
      amount_refunded: 9000, // Y -- cumulative, larger than this event's own amount
    });

    await handleStripeRefundUpdated(
      supabase as never,
      stripe,
      fakeRefund({ amount: 3000 }), // X -- this event's own amount
      null,
    );

    expect(reconcileMock).toHaveBeenCalledTimes(1);
    const reconciliationInput = reconcileMock.mock.calls[0][1] as { refundAmountCents: number };
    expect(reconciliationInput.refundAmountCents).toBe(3000);
    expect(reconciliationInput.refundAmountCents).not.toBe(9000);

    // Requirement 2 (unchanged existing behavior): the payment-summary sync
    // still receives the CUMULATIVE amount, in dollars, exactly as before --
    // this slice must not change that.
    expect(paymentsUpdatePayloads[0]).toMatchObject({ refund_amount: 90 });
  });

  it("requirement 2 -- reconciliation receives the actual Stripe refund status", async () => {
    reconcileMock.mockClear();
    const { supabase } = createFakeSupabase([{ id: "payment-1", amount: 100 }]);
    const stripe = createFakeStripe({ payment_intent: "pi_123", amount_refunded: 3000 });

    await handleStripeRefundUpdated(supabase as never, stripe, fakeRefund({ status: "pending" }), null);

    const reconciliationInput = reconcileMock.mock.calls[0][1] as { refundStatus: string };
    expect(reconciliationInput.refundStatus).toBe("pending");
  });

  it("requirement 3 -- reconciliation receives the resolved Stripe payment intent id, including the charge-fallback case", async () => {
    reconcileMock.mockClear();
    const { supabase } = createFakeSupabase([{ id: "payment-1", amount: 100 }]);
    // refund.payment_intent is absent; the payment intent is only
    // recoverable from the retrieved charge -- exercises the existing
    // fallback resolution this handler already performs.
    const stripe = createFakeStripe({ payment_intent: "pi_from_charge", amount_refunded: 3000 });

    await handleStripeRefundUpdated(
      supabase as never,
      stripe,
      fakeRefund({ payment_intent: null }),
      null,
    );

    const reconciliationInput = reconcileMock.mock.calls[0][1] as { stripePaymentIntentId: string };
    expect(reconciliationInput.stripePaymentIntentId).toBe("pi_from_charge");
  });

  it("requirement 4 -- a non-package-related refund still flows through safely (the RPC/service module owns that gate, not the webhook)", async () => {
    reconcileMock.mockClear();
    reconcileMock.mockResolvedValueOnce([
      { paymentId: "payment-1", studioId: "studio-1", reconciliationId: null, outcome: "not_package_related", applied: false },
    ]);
    const { supabase } = createFakeSupabase([{ id: "payment-1", amount: 100 }]);
    const stripe = createFakeStripe({ payment_intent: "pi_123", amount_refunded: 3000 });

    await expect(
      handleStripeRefundUpdated(supabase as never, stripe, fakeRefund(), null),
    ).resolves.not.toThrow();
    expect(reconcileMock).toHaveBeenCalledTimes(1);
  });
});

describe("Package Refund P0, Slice 2c-1: handleChargeRefunded never independently triggers reconciliation (requirement 5)", () => {
  it("a charge.refunded-style event with a real cumulative refund never calls package reconciliation", async () => {
    reconcileMock.mockClear();
    const { supabase } = createFakeSupabase([{ id: "payment-1", amount: 100 }]);
    const stripe = createFakeStripe(null);

    const charge = {
      payment_intent: "pi_123",
      amount_refunded: 9000,
      refunds: { data: [{ id: "rf_latest" }] },
    } as unknown as Stripe.Charge;

    await handleChargeRefunded(supabase as never, stripe, charge, null);

    expect(reconcileMock).not.toHaveBeenCalled();
  });
});
