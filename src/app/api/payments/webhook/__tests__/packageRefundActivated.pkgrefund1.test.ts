import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

/**
 * PKG-REFUND-1: the activated webhook path. The release hold is mocked to
 * false here so this file proves the activated behavior independently of the
 * committed value; PKG-REFUND-2 released the hold, and the source invariant at
 * the bottom of this file now enforces the committed value false.
 *
 * Uses the real package-refund-reconciliation module end to end so the
 * webhook's verified Stripe account is proven to reach the owner binding.
 */

vi.mock("@/lib/payments/package-refund-release-hold", () => ({
  PACKAGE_REFUND_RECONCILIATION_RELEASE_HOLD: false,
}));

const { handleStripeRefundUpdated } = await import("@/app/api/payments/webhook/route");

const ACCOUNT_A = "acct_studioA";
const ACCOUNT_B = "acct_studioB";

type FakeResult = { data?: unknown; error?: { message: string } | null };

function makeChain(resolve: () => FakeResult) {
  const chain: {
    eq: (...args: unknown[]) => typeof chain;
    maybeSingle: () => Promise<FakeResult>;
    then: (onFulfilled: (value: FakeResult) => unknown, onRejected?: (reason: unknown) => unknown) => unknown;
  } = {
    eq: () => chain,
    maybeSingle: async () => resolve(),
    then(onFulfilled, onRejected) {
      return Promise.resolve(resolve()).then(onFulfilled, onRejected);
    },
  };
  return chain;
}

function createFakeSupabase(payment: { id: string; studio_id: string; amount: number; stripe_account_id: string | null }) {
  const rpcCalls: { name: string; params: Record<string, unknown> }[] = [];
  const supabase = {
    from(table: string) {
      if (table === "payments") return { select: () => makeChain(() => ({ data: [payment], error: null })) };
      if (table === "event_payments") return { select: () => makeChain(() => ({ data: [], error: null })) };
      if (table === "studios") {
        return { select: () => makeChain(() => ({ data: { id: "studio-A" }, error: null })) };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    async rpc(name: string, params: Record<string, unknown>) {
      rpcCalls.push({ name, params });
      if (name === "_apply_payment_refund_and_reevaluate") {
        return { data: [{ applied: true, package_deactivated: false, conflict_recorded: false }], error: null };
      }
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
  return { supabase: supabase as never, rpcCalls };
}

function fakeStripe() {
  return {
    charges: { retrieve: async () => ({ payment_intent: "pi_1", amount_refunded: 10000 }) as Stripe.Charge },
    paymentIntents: {
      retrieve: async () => {
        throw new Error("no fee details in this focused test");
      },
    },
  } as unknown as Stripe;
}

function refund(status: string): Stripe.Refund {
  return { id: "re_1", amount: 10000, status, payment_intent: "pi_1", charge: "ch_1" } as Stripe.Refund;
}

const packageRpcs = (calls: { name: string; params: Record<string, unknown> }[]) =>
  calls.filter((call) => call.name === "reconcile_package_stripe_refund" || call.name === "restore_package_refund_reconciliation");

describe("activated webhook path (hold disabled in test only)", () => {
  it("forward refund from the owning account reconciles the owned payment", async () => {
    const fake = createFakeSupabase({ id: "pay-1", studio_id: "studio-A", amount: 100, stripe_account_id: ACCOUNT_A });
    await handleStripeRefundUpdated(fake.supabase, fakeStripe(), refund("succeeded"), ACCOUNT_A);

    const calls = packageRpcs(fake.rpcCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "reconcile_package_stripe_refund",
      params: { p_studio_id: "studio-A", p_payment_id: "pay-1", p_stripe_refund_id: "re_1", p_refund_amount_cents: 10000 },
    });
  });

  it("forward refund from another account makes zero package-refund RPC calls", async () => {
    const fake = createFakeSupabase({ id: "pay-1", studio_id: "studio-A", amount: 100, stripe_account_id: ACCOUNT_A });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleStripeRefundUpdated(fake.supabase, fakeStripe(), refund("succeeded"), ACCOUNT_B);
    errorSpy.mockRestore();

    expect(packageRpcs(fake.rpcCalls)).toEqual([]);
  });

  it("reversal from the owning account restores the owned payment's reconciliation", async () => {
    const fake = createFakeSupabase({ id: "pay-1", studio_id: "studio-A", amount: 100, stripe_account_id: ACCOUNT_A });
    await handleStripeRefundUpdated(fake.supabase, fakeStripe(), refund("failed"), ACCOUNT_A);

    // The forward RPC also observes the 'failed' status (its own transition
    // gate makes that a no-op once applied); the restore RPC does the reversal.
    const calls = packageRpcs(fake.rpcCalls);
    expect(calls.map((call) => call.name)).toEqual([
      "reconcile_package_stripe_refund",
      "restore_package_refund_reconciliation",
    ]);
    expect(calls[0].params).toMatchObject({ p_payment_id: "pay-1", p_refund_status: "failed" });
    expect(calls[1]).toMatchObject({
      name: "restore_package_refund_reconciliation",
      params: { p_studio_id: "studio-A", p_stripe_refund_id: "re_1", p_new_refund_status: "failed" },
    });
  });

  it("reversal from another account makes zero package-refund RPC calls", async () => {
    const fake = createFakeSupabase({ id: "pay-1", studio_id: "studio-A", amount: 100, stripe_account_id: ACCOUNT_A });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleStripeRefundUpdated(fake.supabase, fakeStripe(), refund("canceled"), ACCOUNT_B);
    errorSpy.mockRestore();

    expect(packageRpcs(fake.rpcCalls)).toEqual([]);
  });

  it("a legacy NULL-owner payment mapped to the webhook account's studio is reconciled", async () => {
    const fake = createFakeSupabase({ id: "pay-legacy", studio_id: "studio-A", amount: 100, stripe_account_id: null });
    await handleStripeRefundUpdated(fake.supabase, fakeStripe(), refund("succeeded"), ACCOUNT_A);

    expect(packageRpcs(fake.rpcCalls)).toHaveLength(1);
  });

  it("a platform-scoped refund event makes zero package-refund RPC calls", async () => {
    const fake = createFakeSupabase({ id: "pay-legacy", studio_id: "studio-A", amount: 100, stripe_account_id: null });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleStripeRefundUpdated(fake.supabase, fakeStripe(), refund("succeeded"), null);
    errorSpy.mockRestore();

    expect(packageRpcs(fake.rpcCalls)).toEqual([]);
  });
});

describe("source invariants", () => {
  const root = process.cwd();
  const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");

  it("the committed release hold is released (false) by PKG-REFUND-2", () => {
    const source = read("src/lib/payments/package-refund-release-hold.ts");
    expect(source).toMatch(/export const PACKAGE_REFUND_RECONCILIATION_RELEASE_HOLD = false;/);
    expect(source).not.toMatch(/PACKAGE_REFUND_RECONCILIATION_RELEASE_HOLD = true/);
  });

  it("the webhook passes the verified Stripe account into both package-refund helpers", () => {
    const route = read("src/app/api/payments/webhook/route.ts");
    expect(route).toContain("reconcilePackageStripeRefund(supabase, packageReconciliationInput, stripeAccountId)");
    expect(route).toMatch(
      /restorePackageRefundReconciliation\(\s*supabase,\s*resolvedPaymentIntentId,\s*packageReversalInput,\s*stripeAccountId,\s*\)/,
    );
  });

  it("the D2 restoration migration gates reactivation on PKG-P1 settlement and supersedes 20260830090000", () => {
    const sql = read("src/lib/supabase/migrations/20261003090000_pkgrefund1_package_refund_reversal_restoration.sql");
    expect(sql).toContain("SUPERSEDES 20260830090000_package_refund_reversal_restoration_rpc.sql");
    expect(sql).toContain("v_settled := public._package_payment_settled(v_pkg_id);");
    expect(sql).toMatch(/when archived_at is null and v_settled then true/);
    expect(sql).not.toMatch(/active = case when archived_at is null then true else active end/);
    expect(sql).toMatch(/revoke all on function public\.restore_package_refund_reconciliation\(uuid, text, text, timestamptz\)\s+from public, anon, authenticated;/);
    expect(sql).toMatch(/grant execute on function public\.restore_package_refund_reconciliation\(uuid, text, text, timestamptz\)\s+to service_role;/);
    // Lock order: package lock is taken before the reconciliation re-read and item locks.
    const pkgLock = sql.indexOf("from public.client_packages\n  where id = v_pkg_id_lookup");
    const reconReread = sql.indexOf("from public.package_refund_reconciliations\n  where id = v_reconciliation_id\n  for update;");
    const itemLock = sql.indexOf("from public.client_package_items\n    where id = v_void_row.client_package_item_id");
    expect(pkgLock).toBeGreaterThan(0);
    expect(reconReread).toBeGreaterThan(pkgLock);
    expect(itemLock).toBeGreaterThan(reconReread);
  });

  it("superseded historical migrations remain in the repository unchanged in role (never applied)", () => {
    const lockFix = read("src/lib/supabase/migrations/20260823093000_package_credit_writer_lock_order_fix.sql");
    const staleRestore = read("src/lib/supabase/migrations/20260830090000_package_refund_reversal_restoration_rpc.sql");
    // The stale body is recognisable (ungated reactivation) -- which is exactly why it is superseded.
    expect(staleRestore).toContain("active = case when archived_at is null then true else active end");
    expect(lockFix).toContain("create or replace function deduct_package_credit_when_appointment_attended()");
    const pkgmut1 = read("src/lib/supabase/migrations/20261002090000_pkgmut1_package_credit_lock_order.sql");
    expect(pkgmut1).toContain("SUPERSEDES 20260823093000_package_credit_writer_lock_order_fix.sql");
    expect(pkgmut1).toContain("if new.appointment_type::text = 'group_class' then");
  });
});
