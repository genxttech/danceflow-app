import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

/**
 * Package Refund P0, Slice 2c-1: focused coverage for the webhook-wiring
 * seam around package-refund reconciliation.
 *
 * RELEASE HOLD (see PACKAGE_REFUND_RECONCILIATION_RELEASE_HOLD in
 * route.ts): the reconcile_package_stripe_refund migration has not been
 * applied to development or production, so `handleStripeRefundUpdated` is
 * currently hardcoded to never invoke `reconcilePackageStripeRefund` --
 * calling an RPC that doesn't exist yet would 500 the *entire* webhook
 * event, not just package-related refunds. The tests below verify that
 * hold directly, plus that it changes nothing else: existing payment-
 * summary refund handling is unaffected, and `handleChargeRefunded` never
 * referenced reconciliation in the first place.
 *
 * Deliberately does NOT re-test what's covered elsewhere, and remains
 * true regardless of the hold, since none of it runs through this call
 * site at all:
 *   - Case A/B/C, idempotency, identity-safety, missing-price handling all
 *     live in the RPC itself (local-Docker SQL regression, this
 *     initiative's established convention) -- untouched by this hotfix,
 *     still fully verified for when the hold is lifted.
 *   - The exact input-construction rule (single-event amount never
 *     cumulative, status/identity pass-through, null short-circuits) is
 *     the pure `buildPackageRefundReconciliationInput` function, still
 *     unit-tested directly in package-refund-reconciliation.test.ts --
 *     still called unconditionally by the handler (computing the would-be
 *     input is harmless and cheap), just no longer acted on while held.
 *   - "resolve every matching payment, call the RPC once per payment" is
 *     covered in package-refund-reconciliation.test.ts.
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

describe("Package Refund P0, Slice 2c-1 RELEASE HOLD: handleStripeRefundUpdated", () => {
  it("continues updating existing payment refund summaries via the cumulative charge amount, unchanged", async () => {
    reconcileMock.mockClear();
    const { supabase, paymentsUpdatePayloads } = createFakeSupabase([{ id: "payment-1", amount: 100 }]);
    const stripe = createFakeStripe({
      payment_intent: "pi_123",
      amount_refunded: 9000, // cumulative, in cents
    });

    await handleStripeRefundUpdated(
      supabase as never,
      stripe,
      fakeRefund({ amount: 3000 }), // this event's own amount -- irrelevant to this assertion
      null,
    );

    // Existing, pre-2c-1 payment-summary behavior is completely unaffected by
    // the release hold: still receives the cumulative amount, in dollars.
    expect(paymentsUpdatePayloads[0]).toMatchObject({ refund_amount: 90 });
  });

  it("does not invoke reconcilePackageStripeRefund while the release hold is active, even for an otherwise well-formed package-relevant refund", async () => {
    reconcileMock.mockClear();
    const { supabase } = createFakeSupabase([{ id: "payment-1", amount: 100 }]);
    const stripe = createFakeStripe({ payment_intent: "pi_123", amount_refunded: 3000 });

    // A refund shaped exactly like the one that would, once the hold is
    // lifted, produce a valid buildPackageRefundReconciliationInput result
    // (non-null stripeRefundId/paymentIntentId, positive amount) -- proving
    // the hold suppresses the call even when everything else about the
    // event is well-formed, not merely when there's nothing to send anyway.
    await handleStripeRefundUpdated(supabase as never, stripe, fakeRefund(), null);

    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("does not invoke reconcilePackageStripeRefund for any refund status while held, including succeeded", async () => {
    reconcileMock.mockClear();
    const { supabase } = createFakeSupabase([{ id: "payment-1", amount: 100 }]);
    const stripe = createFakeStripe({ payment_intent: "pi_123", amount_refunded: 3000 });

    await handleStripeRefundUpdated(
      supabase as never,
      stripe,
      fakeRefund({ status: "succeeded" }),
      null,
    );

    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("does not throw -- the webhook completes normally while held, exactly the regression this hotfix exists to prevent", async () => {
    reconcileMock.mockClear();
    const { supabase } = createFakeSupabase([{ id: "payment-1", amount: 100 }]);
    const stripe = createFakeStripe({ payment_intent: "pi_123", amount_refunded: 3000 });

    await expect(
      handleStripeRefundUpdated(supabase as never, stripe, fakeRefund(), null),
    ).resolves.not.toThrow();
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
