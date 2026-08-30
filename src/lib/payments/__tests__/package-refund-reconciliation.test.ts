import { describe, expect, it } from "vitest";

import {
  reconcilePackageStripeRefund,
  buildPackageRefundReconciliationInput,
  restorePackageRefundReconciliation,
  buildPackageRefundReversalInput,
  type StripeRefundEventContext,
} from "@/lib/payments/package-refund-reconciliation";

/**
 * Package Refund P0, Slice 2c-1: unit coverage for the webhook-side service
 * module. The actual Case A/B/C/idempotency/identity logic lives entirely
 * in the RPC (verified separately via local-Docker SQL regression, per this
 * initiative's established convention) -- this module's own job is just
 * "resolve every matching payment, call the RPC once per payment, map the
 * result shape," so that's what's tested here with a minimal fake client.
 */

function createFakeSupabase(options: {
  payments: { id: string; studio_id: string }[];
  paymentsError?: { message: string } | null;
  rpcImpl?: (params: Record<string, unknown>) => { data: unknown; error: { message: string } | null };
}) {
  const rpcCalls: Record<string, unknown>[] = [];

  const supabase = {
    from(table: string) {
      if (table !== "payments") throw new Error(`Unexpected table: ${table}`);
      return {
        select: () => ({
          eq: async () => ({
            data: options.paymentsError ? null : options.payments,
            error: options.paymentsError ?? null,
          }),
        }),
      };
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      if (name !== "reconcile_package_stripe_refund") {
        throw new Error(`Unexpected RPC: ${name}`);
      }
      rpcCalls.push(params);
      if (options.rpcImpl) return options.rpcImpl(params);
      return {
        data: [{ reconciliation_id: "recon-1", outcome: "auto_applied", applied: true }],
        error: null,
      };
    },
  };

  return { supabase, rpcCalls };
}

describe("Package Refund P0, Slice 2c-1: reconcilePackageStripeRefund", () => {
  it("resolves every payment row for the payment intent and calls the RPC once per payment", async () => {
    const { supabase, rpcCalls } = createFakeSupabase({
      payments: [
        { id: "payment-1", studio_id: "studio-1" },
        { id: "payment-2", studio_id: "studio-2" },
      ],
    });

    const results = await reconcilePackageStripeRefund(supabase as never, {
      stripePaymentIntentId: "pi_123",
      stripeRefundId: "rf_123",
      stripeChargeId: "ch_123",
      refundAmountCents: 5000,
      refundStatus: "succeeded",
    });

    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0]).toMatchObject({
      p_studio_id: "studio-1",
      p_payment_id: "payment-1",
      p_stripe_refund_id: "rf_123",
      p_stripe_charge_id: "ch_123",
      p_refund_amount_cents: 5000,
      p_refund_status: "succeeded",
    });
    expect(rpcCalls[1]).toMatchObject({ p_studio_id: "studio-2", p_payment_id: "payment-2" });
    expect(results).toHaveLength(2);
  });

  it("passes the refund amount through unmodified -- never converts cents to dollars", async () => {
    const { supabase, rpcCalls } = createFakeSupabase({
      payments: [{ id: "payment-1", studio_id: "studio-1" }],
    });

    await reconcilePackageStripeRefund(supabase as never, {
      stripePaymentIntentId: "pi_123",
      stripeRefundId: "rf_123",
      stripeChargeId: null,
      refundAmountCents: 12345,
      refundStatus: "succeeded",
    });

    expect(rpcCalls[0].p_refund_amount_cents).toBe(12345);
  });

  it("omits p_occurred_at when not supplied, includes it when supplied", async () => {
    const { supabase, rpcCalls } = createFakeSupabase({
      payments: [{ id: "payment-1", studio_id: "studio-1" }],
    });

    await reconcilePackageStripeRefund(supabase as never, {
      stripePaymentIntentId: "pi_123",
      stripeRefundId: "rf_123",
      stripeChargeId: null,
      refundAmountCents: 100,
      refundStatus: "succeeded",
    });
    expect(rpcCalls[0]).not.toHaveProperty("p_occurred_at");

    await reconcilePackageStripeRefund(supabase as never, {
      stripePaymentIntentId: "pi_123",
      stripeRefundId: "rf_124",
      stripeChargeId: null,
      refundAmountCents: 100,
      refundStatus: "succeeded",
      occurredAt: "2026-08-22T00:00:00.000Z",
    });
    expect(rpcCalls[1]).toMatchObject({ p_occurred_at: "2026-08-22T00:00:00.000Z" });
  });

  it("maps the RPC's returned row shape correctly, including a not_package_related fallback", async () => {
    const { supabase } = createFakeSupabase({
      payments: [{ id: "payment-1", studio_id: "studio-1" }],
      rpcImpl: () => ({ data: [{ reconciliation_id: null, outcome: "not_package_related", applied: false }], error: null }),
    });

    const results = await reconcilePackageStripeRefund(supabase as never, {
      stripePaymentIntentId: "pi_123",
      stripeRefundId: "rf_123",
      stripeChargeId: null,
      refundAmountCents: 100,
      refundStatus: "succeeded",
    });

    expect(results).toEqual([
      {
        paymentId: "payment-1",
        studioId: "studio-1",
        reconciliationId: null,
        outcome: "not_package_related",
        applied: false,
      },
    ]);
  });

  it("returns an empty array when no payments match the payment intent", async () => {
    const { supabase, rpcCalls } = createFakeSupabase({ payments: [] });

    const results = await reconcilePackageStripeRefund(supabase as never, {
      stripePaymentIntentId: "pi_no_match",
      stripeRefundId: "rf_123",
      stripeChargeId: null,
      refundAmountCents: 100,
      refundStatus: "succeeded",
    });

    expect(results).toEqual([]);
    expect(rpcCalls).toHaveLength(0);
  });

  it("throws when the payments lookup fails", async () => {
    const { supabase } = createFakeSupabase({
      payments: [],
      paymentsError: { message: "lookup failed" },
    });

    await expect(
      reconcilePackageStripeRefund(supabase as never, {
        stripePaymentIntentId: "pi_123",
        stripeRefundId: "rf_123",
        stripeChargeId: null,
        refundAmountCents: 100,
        refundStatus: "succeeded",
      }),
    ).rejects.toThrow("lookup failed");
  });

  it("throws when the RPC call itself errors -- propagates to the webhook's retry-on-500 handling", async () => {
    const { supabase } = createFakeSupabase({
      payments: [{ id: "payment-1", studio_id: "studio-1" }],
      rpcImpl: () => ({ data: null, error: { message: "rpc failed" } }),
    });

    await expect(
      reconcilePackageStripeRefund(supabase as never, {
        stripePaymentIntentId: "pi_123",
        stripeRefundId: "rf_123",
        stripeChargeId: null,
        refundAmountCents: 100,
        refundStatus: "succeeded",
      }),
    ).rejects.toThrow("rpc failed");
  });
});

function baseContext(overrides: Partial<StripeRefundEventContext> = {}): StripeRefundEventContext {
  return {
    stripeRefundId: "rf_123",
    refundEventAmountCents: 3000,
    cumulativeRefundAmountCents: 3000,
    refundStatus: "succeeded",
    resolvedPaymentIntentId: "pi_123",
    chargeId: "ch_123",
    ...overrides,
  };
}

describe("Package Refund P0, Slice 2c-1: buildPackageRefundReconciliationInput", () => {
  it("requirement 1 -- uses the single-event amount, never the cumulative charge total, even when they differ", () => {
    // refund.amount = 3000 (X), the charge's cumulative amount_refunded = 9000 (Y), Y > X --
    // this is exactly the "second of several partial refunds on the same charge" shape.
    const input = buildPackageRefundReconciliationInput(
      baseContext({ refundEventAmountCents: 3000, cumulativeRefundAmountCents: 9000 }),
    );

    expect(input?.refundAmountCents).toBe(3000);
    expect(input?.refundAmountCents).not.toBe(9000);
  });

  it("requirement 2 -- propagates the actual Stripe refund status unmodified", () => {
    for (const status of ["pending", "requires_action", "succeeded", "failed", "canceled"]) {
      const input = buildPackageRefundReconciliationInput(baseContext({ refundStatus: status }));
      expect(input?.refundStatus).toBe(status);
    }
  });

  it("requirement 3 -- carries through the resolved Stripe payment intent id (including the charge-fallback case)", () => {
    // refund.payment_intent was absent; resolvedPaymentIntentId was recovered from the
    // retrieved charge's own payment_intent field -- the caller resolves this fallback,
    // this function just needs to pass whatever it's given through untouched.
    const input = buildPackageRefundReconciliationInput(
      baseContext({ resolvedPaymentIntentId: "pi_from_charge_fallback" }),
    );

    expect(input?.stripePaymentIntentId).toBe("pi_from_charge_fallback");
  });

  it("carries through stripe_refund_id and stripe_charge_id unmodified", () => {
    const input = buildPackageRefundReconciliationInput(
      baseContext({ stripeRefundId: "rf_abc", chargeId: "ch_abc" }),
    );

    expect(input?.stripeRefundId).toBe("rf_abc");
    expect(input?.stripeChargeId).toBe("ch_abc");
  });

  it("returns null (safe short-circuit) when there is no stripe_refund_id", () => {
    expect(buildPackageRefundReconciliationInput(baseContext({ stripeRefundId: null }))).toBeNull();
  });

  it("returns null (safe short-circuit) when the payment intent could not be resolved at all", () => {
    expect(
      buildPackageRefundReconciliationInput(baseContext({ resolvedPaymentIntentId: null })),
    ).toBeNull();
  });

  it("returns null (safe short-circuit) when the single-event amount is zero or negative", () => {
    expect(buildPackageRefundReconciliationInput(baseContext({ refundEventAmountCents: 0 }))).toBeNull();
    expect(buildPackageRefundReconciliationInput(baseContext({ refundEventAmountCents: -100 }))).toBeNull();
  });

  it("allows a null stripe_charge_id through -- not every refund resolves a charge", () => {
    const input = buildPackageRefundReconciliationInput(baseContext({ chargeId: null }));
    expect(input?.stripeChargeId).toBeNull();
  });
});

/**
 * Package Refund P0, Slice 2c-3: unit coverage for the reversal-restoration
 * service module, mirroring the 2c-1 coverage above exactly -- the actual
 * restoration algorithm (lock order, idempotency, exact-quantity sourcing,
 * package-lifecycle reactivation) lives entirely in
 * restore_package_refund_reconciliation, verified separately via local-Docker
 * SQL regression (test_Q_refund_reversal_restoration.sql) and concurrency
 * proof (test_N_concurrency_two_session.sh, scenarios C1-C7). This module's
 * own job is just "resolve every matching payment, call the RPC once per
 * payment, map the result shape" (restorePackageRefundReconciliation) and
 * "is this observation a reversal at all" (buildPackageRefundReversalInput).
 */
function createFakeReversalSupabase(options: {
  payments: { id: string; studio_id: string }[];
  paymentsError?: { message: string } | null;
  rpcImpl?: (params: Record<string, unknown>) => { data: unknown; error: { message: string } | null };
}) {
  const rpcCalls: Record<string, unknown>[] = [];

  const supabase = {
    from(table: string) {
      if (table !== "payments") throw new Error(`Unexpected table: ${table}`);
      return {
        select: () => ({
          eq: async () => ({
            data: options.paymentsError ? null : options.payments,
            error: options.paymentsError ?? null,
          }),
        }),
      };
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      if (name !== "restore_package_refund_reconciliation") {
        throw new Error(`Unexpected RPC: ${name}`);
      }
      rpcCalls.push(params);
      if (options.rpcImpl) return options.rpcImpl(params);
      return {
        data: [{ reconciliation_id: "recon-1", outcome: "reversed", restored_item_count: 2, applied: true }],
        error: null,
      };
    },
  };

  return { supabase, rpcCalls };
}

describe("Package Refund P0, Slice 2c-3: restorePackageRefundReconciliation", () => {
  it("resolves every payment row for the payment intent and calls the RPC once per payment", async () => {
    const { supabase, rpcCalls } = createFakeReversalSupabase({
      payments: [
        { id: "payment-1", studio_id: "studio-1" },
        { id: "payment-2", studio_id: "studio-2" },
      ],
    });

    const results = await restorePackageRefundReconciliation(supabase as never, "pi_123", {
      stripeRefundId: "rf_123",
      newRefundStatus: "failed",
    });

    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0]).toMatchObject({
      p_studio_id: "studio-1",
      p_stripe_refund_id: "rf_123",
      p_new_refund_status: "failed",
    });
    expect(rpcCalls[1]).toMatchObject({ p_studio_id: "studio-2" });
    expect(results).toHaveLength(2);
  });

  it("never sends p_payment_id -- the RPC looks up its target by stripe_refund_id alone", async () => {
    const { supabase, rpcCalls } = createFakeReversalSupabase({
      payments: [{ id: "payment-1", studio_id: "studio-1" }],
    });

    await restorePackageRefundReconciliation(supabase as never, "pi_123", {
      stripeRefundId: "rf_123",
      newRefundStatus: "canceled",
    });

    expect(rpcCalls[0]).not.toHaveProperty("p_payment_id");
  });

  it("omits p_occurred_at when not supplied, includes it when supplied", async () => {
    const { supabase, rpcCalls } = createFakeReversalSupabase({
      payments: [{ id: "payment-1", studio_id: "studio-1" }],
    });

    await restorePackageRefundReconciliation(supabase as never, "pi_123", {
      stripeRefundId: "rf_123",
      newRefundStatus: "failed",
    });
    expect(rpcCalls[0]).not.toHaveProperty("p_occurred_at");

    await restorePackageRefundReconciliation(supabase as never, "pi_123", {
      stripeRefundId: "rf_124",
      newRefundStatus: "failed",
      occurredAt: "2026-08-30T00:00:00.000Z",
    });
    expect(rpcCalls[1]).toMatchObject({ p_occurred_at: "2026-08-30T00:00:00.000Z" });
  });

  it("maps the RPC's returned row shape correctly, including a not_reconciled fallback", async () => {
    const { supabase } = createFakeReversalSupabase({
      payments: [{ id: "payment-1", studio_id: "studio-1" }],
      rpcImpl: () => ({
        data: [{ reconciliation_id: null, outcome: "not_reconciled", restored_item_count: 0, applied: false }],
        error: null,
      }),
    });

    const results = await restorePackageRefundReconciliation(supabase as never, "pi_123", {
      stripeRefundId: "rf_123",
      newRefundStatus: "failed",
    });

    expect(results).toEqual([
      {
        paymentId: "payment-1",
        studioId: "studio-1",
        reconciliationId: null,
        outcome: "not_reconciled",
        restoredItemCount: 0,
        applied: false,
      },
    ]);
  });

  it("returns an empty array when no payments match the payment intent", async () => {
    const { supabase, rpcCalls } = createFakeReversalSupabase({ payments: [] });

    const results = await restorePackageRefundReconciliation(supabase as never, "pi_no_match", {
      stripeRefundId: "rf_123",
      newRefundStatus: "failed",
    });

    expect(results).toEqual([]);
    expect(rpcCalls).toHaveLength(0);
  });

  it("throws when the payments lookup fails", async () => {
    const { supabase } = createFakeReversalSupabase({
      payments: [],
      paymentsError: { message: "lookup failed" },
    });

    await expect(
      restorePackageRefundReconciliation(supabase as never, "pi_123", {
        stripeRefundId: "rf_123",
        newRefundStatus: "failed",
      }),
    ).rejects.toThrow("lookup failed");
  });

  it("throws when the RPC call itself errors -- propagates to the webhook's retry-on-500 handling", async () => {
    const { supabase } = createFakeReversalSupabase({
      payments: [{ id: "payment-1", studio_id: "studio-1" }],
      rpcImpl: () => ({ data: null, error: { message: "rpc failed" } }),
    });

    await expect(
      restorePackageRefundReconciliation(supabase as never, "pi_123", {
        stripeRefundId: "rf_123",
        newRefundStatus: "failed",
      }),
    ).rejects.toThrow("rpc failed");
  });
});

describe("Package Refund P0, Slice 2c-3: buildPackageRefundReversalInput", () => {
  it("returns a reversal input for 'failed'", () => {
    const input = buildPackageRefundReversalInput(baseContext({ refundStatus: "failed" }));
    expect(input).toEqual({ stripeRefundId: "rf_123", newRefundStatus: "failed" });
  });

  it("returns a reversal input for 'canceled'", () => {
    const input = buildPackageRefundReversalInput(baseContext({ refundStatus: "canceled" }));
    expect(input).toEqual({ stripeRefundId: "rf_123", newRefundStatus: "canceled" });
  });

  it("returns null for 'succeeded' -- that is the forward path, not a reversal", () => {
    expect(buildPackageRefundReversalInput(baseContext({ refundStatus: "succeeded" }))).toBeNull();
  });

  it("returns null for 'pending' and 'requires_action' -- neither a success nor a reversal", () => {
    expect(buildPackageRefundReversalInput(baseContext({ refundStatus: "pending" }))).toBeNull();
    expect(buildPackageRefundReversalInput(baseContext({ refundStatus: "requires_action" }))).toBeNull();
  });

  it("returns null (safe short-circuit) when there is no stripe_refund_id", () => {
    expect(
      buildPackageRefundReversalInput(baseContext({ stripeRefundId: null, refundStatus: "failed" })),
    ).toBeNull();
  });

  it("returns null (safe short-circuit) when the payment intent could not be resolved at all", () => {
    expect(
      buildPackageRefundReversalInput(baseContext({ resolvedPaymentIntentId: null, refundStatus: "failed" })),
    ).toBeNull();
  });

  it("never carries the refund amount through -- restoration quantity is not derived from it", () => {
    const input = buildPackageRefundReversalInput(baseContext({ refundStatus: "failed" }));
    expect(input).not.toHaveProperty("refundAmountCents");
  });
});
