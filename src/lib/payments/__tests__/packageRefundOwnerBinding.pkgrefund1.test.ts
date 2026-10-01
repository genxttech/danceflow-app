import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PACKAGE_REFUND_OWNER_MISMATCH,
  PACKAGE_REFUND_OWNER_UNVERIFIED,
  reconcilePackageStripeRefund,
  restorePackageRefundReconciliation,
} from "@/lib/payments/package-refund-reconciliation";

/**
 * PKG-REFUND-1 (L1): package-refund reconciliation and restoration only act on
 * payments owned by the verified Stripe account that delivered the webhook.
 * Rejected payments get a fixed code, no RPC call and no table write.
 */

const ACCOUNT_A = "acct_studioA";
const ACCOUNT_B = "acct_studioB";

type PaymentRow = { id: string; studio_id: string; stripe_account_id: string | null };

function createFakeSupabase(options: {
  payments: PaymentRow[];
  studios?: { id: string; stripe_connected_account_id: string }[];
  studiosError?: { message: string } | null;
}) {
  const rpcCalls: { name: string; params: Record<string, unknown> }[] = [];
  const writes: { table: string; op: string }[] = [];
  const studioLookups: unknown[] = [];

  const writeGuard = (table: string) => ({
    insert: () => {
      writes.push({ table, op: "insert" });
      throw new Error("unexpected write");
    },
    update: () => {
      writes.push({ table, op: "update" });
      throw new Error("unexpected write");
    },
    upsert: () => {
      writes.push({ table, op: "upsert" });
      throw new Error("unexpected write");
    },
  });

  const supabase = {
    from(table: string) {
      if (table === "payments") {
        return {
          ...writeGuard(table),
          select: () => ({
            eq: async () => ({ data: options.payments, error: null }),
          }),
        };
      }
      if (table === "studios") {
        return {
          ...writeGuard(table),
          select: () => ({
            eq: (_column: string, value: unknown) => ({
              maybeSingle: async () => {
                studioLookups.push(value);
                if (options.studiosError) return { data: null, error: options.studiosError };
                const studio = (options.studios ?? []).find((row) => row.stripe_connected_account_id === value);
                return { data: studio ? { id: studio.id } : null, error: null };
              },
            }),
          }),
        };
      }
      return writeGuard(table);
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      if (name === "reconcile_package_stripe_refund") {
        return { data: [{ reconciliation_id: "recon-1", outcome: "auto_applied", applied: true }], error: null };
      }
      if (name === "restore_package_refund_reconciliation") {
        return {
          data: [{ reconciliation_id: "recon-1", outcome: "reversed", restored_item_count: 1, applied: true }],
          error: null,
        };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    },
  };

  return { supabase: supabase as never, rpcCalls, writes, studioLookups };
}

const forwardInput = {
  stripePaymentIntentId: "pi_1",
  stripeRefundId: "re_1",
  stripeChargeId: "ch_1",
  refundAmountCents: 10000,
  refundStatus: "succeeded",
};

const reversalInput = { stripeRefundId: "re_1", newRefundStatus: "failed" as const };

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

function runBoth(supabase: never, account: string | null) {
  return Promise.all([
    reconcilePackageStripeRefund(supabase, forwardInput, account),
    restorePackageRefundReconciliation(supabase, "pi_1", reversalInput, account),
  ]);
}

describe("owned payments", () => {
  it("a stored owner matching the webhook account is reconciled and restored", async () => {
    const fake = createFakeSupabase({
      payments: [{ id: "pay-1", studio_id: "studio-A", stripe_account_id: ACCOUNT_A }],
    });
    const [forward, reversal] = await runBoth(fake.supabase, ACCOUNT_A);

    expect(fake.rpcCalls.map((call) => call.name)).toEqual([
      "reconcile_package_stripe_refund",
      "restore_package_refund_reconciliation",
    ]);
    expect(fake.rpcCalls[0].params).toMatchObject({ p_studio_id: "studio-A", p_payment_id: "pay-1" });
    expect(forward[0]).toMatchObject({ outcome: "auto_applied", applied: true });
    expect(reversal[0]).toMatchObject({ outcome: "reversed", applied: true });
    // An owned match never needs the account -> studio mapping.
    expect(fake.studioLookups).toEqual([]);
  });

  it("a stored owner from another account is rejected: zero RPCs, zero writes, fixed code", async () => {
    const fake = createFakeSupabase({
      payments: [{ id: "pay-1", studio_id: "studio-A", stripe_account_id: ACCOUNT_A }],
      studios: [{ id: "studio-A", stripe_connected_account_id: ACCOUNT_A }],
    });
    const [forward, reversal] = await runBoth(fake.supabase, ACCOUNT_B);

    expect(fake.rpcCalls).toEqual([]);
    expect(fake.writes).toEqual([]);
    expect(forward[0]).toMatchObject({ outcome: PACKAGE_REFUND_OWNER_MISMATCH, applied: false, reconciliationId: null });
    expect(reversal[0]).toMatchObject({
      outcome: PACKAGE_REFUND_OWNER_MISMATCH,
      applied: false,
      restoredItemCount: 0,
    });
  });

  it("a platform-scoped event never acts on a connected-account payment", async () => {
    const fake = createFakeSupabase({
      payments: [{ id: "pay-1", studio_id: "studio-A", stripe_account_id: ACCOUNT_A }],
    });
    const [forward, reversal] = await runBoth(fake.supabase, null);

    expect(fake.rpcCalls).toEqual([]);
    expect(forward[0].outcome).toBe(PACKAGE_REFUND_OWNER_MISMATCH);
    expect(reversal[0].outcome).toBe(PACKAGE_REFUND_OWNER_MISMATCH);
  });
});

describe("legacy payments without a stored owner (PAY-DC-2C Connect rule)", () => {
  it("is eligible only when its studio is the studio mapped to the webhook account", async () => {
    const fake = createFakeSupabase({
      payments: [{ id: "pay-legacy", studio_id: "studio-A", stripe_account_id: null }],
      studios: [{ id: "studio-A", stripe_connected_account_id: ACCOUNT_A }],
    });
    const [forward, reversal] = await runBoth(fake.supabase, ACCOUNT_A);

    expect(fake.rpcCalls).toHaveLength(2);
    expect(fake.rpcCalls[0].params).toMatchObject({ p_studio_id: "studio-A", p_payment_id: "pay-legacy" });
    expect(forward[0].applied).toBe(true);
    expect(reversal[0].applied).toBe(true);
    expect(fake.studioLookups).toEqual([ACCOUNT_A, ACCOUNT_A]);
  });

  it("is rejected when the webhook account maps to a different studio (cross-studio)", async () => {
    const fake = createFakeSupabase({
      payments: [{ id: "pay-legacy", studio_id: "studio-A", stripe_account_id: null }],
      studios: [{ id: "studio-B", stripe_connected_account_id: ACCOUNT_B }],
    });
    const [forward, reversal] = await runBoth(fake.supabase, ACCOUNT_B);

    expect(fake.rpcCalls).toEqual([]);
    expect(fake.writes).toEqual([]);
    expect(forward[0].outcome).toBe(PACKAGE_REFUND_OWNER_UNVERIFIED);
    expect(reversal[0].outcome).toBe(PACKAGE_REFUND_OWNER_UNVERIFIED);
  });

  it("is rejected when the webhook account maps to no studio", async () => {
    const fake = createFakeSupabase({
      payments: [{ id: "pay-legacy", studio_id: "studio-A", stripe_account_id: null }],
      studios: [],
    });
    const [forward] = await runBoth(fake.supabase, ACCOUNT_A);

    expect(fake.rpcCalls).toEqual([]);
    expect(forward[0].outcome).toBe(PACKAGE_REFUND_OWNER_UNVERIFIED);
  });

  it("is rejected for a platform-scoped event (no verified account proves no studio)", async () => {
    const fake = createFakeSupabase({
      payments: [{ id: "pay-legacy", studio_id: "studio-A", stripe_account_id: null }],
      studios: [{ id: "studio-A", stripe_connected_account_id: ACCOUNT_A }],
    });
    const [forward, reversal] = await runBoth(fake.supabase, null);

    expect(fake.rpcCalls).toEqual([]);
    expect(fake.studioLookups).toEqual([]);
    expect(forward[0].outcome).toBe(PACKAGE_REFUND_OWNER_UNVERIFIED);
    expect(reversal[0].outcome).toBe(PACKAGE_REFUND_OWNER_UNVERIFIED);
  });

  it("propagates an account-mapping lookup error so the webhook retries, with no RPC", async () => {
    const fake = createFakeSupabase({
      payments: [{ id: "pay-legacy", studio_id: "studio-A", stripe_account_id: null }],
      studiosError: { message: "studios lookup failed" },
    });

    await expect(reconcilePackageStripeRefund(fake.supabase, forwardInput, ACCOUNT_A)).rejects.toThrow(
      "studios lookup failed",
    );
    expect(fake.rpcCalls).toEqual([]);
  });
});

describe("mixed payments on one PaymentIntent", () => {
  it("only eligible payments reach the RPC; the account mapping is resolved once per call", async () => {
    const fake = createFakeSupabase({
      payments: [
        { id: "pay-owned", studio_id: "studio-A", stripe_account_id: ACCOUNT_A },
        { id: "pay-foreign", studio_id: "studio-B", stripe_account_id: ACCOUNT_B },
        { id: "pay-legacy-ok", studio_id: "studio-A", stripe_account_id: null },
        { id: "pay-legacy-other", studio_id: "studio-B", stripe_account_id: null },
      ],
      studios: [{ id: "studio-A", stripe_connected_account_id: ACCOUNT_A }],
    });

    const results = await reconcilePackageStripeRefund(fake.supabase, forwardInput, ACCOUNT_A);

    expect(fake.rpcCalls.map((call) => call.params.p_payment_id)).toEqual(["pay-owned", "pay-legacy-ok"]);
    expect(fake.studioLookups).toEqual([ACCOUNT_A]);
    expect(results.map((row) => [row.paymentId, row.outcome])).toEqual([
      ["pay-owned", "auto_applied"],
      ["pay-foreign", PACKAGE_REFUND_OWNER_MISMATCH],
      ["pay-legacy-ok", "auto_applied"],
      ["pay-legacy-other", PACKAGE_REFUND_OWNER_UNVERIFIED],
    ]);
  });

  it("logs only fixed codes for rejections (no ids or account values)", async () => {
    const fake = createFakeSupabase({
      payments: [{ id: "pay-1", studio_id: "studio-A", stripe_account_id: ACCOUNT_A }],
    });
    await reconcilePackageStripeRefund(fake.supabase, forwardInput, ACCOUNT_B);

    expect(errorSpy).toHaveBeenCalledWith(PACKAGE_REFUND_OWNER_MISMATCH);
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain("pay-1");
    expect(logged).not.toContain(ACCOUNT_A);
    expect(logged).not.toContain(ACCOUNT_B);
  });
});

describe("retry / idempotency semantics", () => {
  it("a redelivered event re-evaluates ownership identically and leaves idempotency to the RPC", async () => {
    const fake = createFakeSupabase({
      payments: [{ id: "pay-1", studio_id: "studio-A", stripe_account_id: ACCOUNT_A }],
    });
    await reconcilePackageStripeRefund(fake.supabase, forwardInput, ACCOUNT_A);
    await reconcilePackageStripeRefund(fake.supabase, forwardInput, ACCOUNT_A);

    expect(fake.rpcCalls).toHaveLength(2);
    expect(fake.rpcCalls[0].params).toEqual(fake.rpcCalls[1].params);
  });

  it("a rejected payment stays rejected on every redelivery", async () => {
    const fake = createFakeSupabase({
      payments: [{ id: "pay-1", studio_id: "studio-A", stripe_account_id: ACCOUNT_A }],
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await reconcilePackageStripeRefund(fake.supabase, forwardInput, ACCOUNT_B);
      await restorePackageRefundReconciliation(fake.supabase, "pi_1", reversalInput, ACCOUNT_B);
    }
    expect(fake.rpcCalls).toEqual([]);
    expect(fake.writes).toEqual([]);
  });
});
