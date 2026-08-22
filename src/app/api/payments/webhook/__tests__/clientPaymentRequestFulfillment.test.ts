import { describe, expect, it } from "vitest";
import type Stripe from "stripe";

import { handleClientPaymentRequestCheckoutCompleted } from "@/app/api/payments/webhook/route";

/**
 * Package Refund P0, Slice 2b: regression coverage for the
 * client-payment-request checkout webhook's package-activation guard.
 * Mirrors the style/structure of the sibling
 * `terminalFulfillment.test.ts` fake -- a small, state-driven fake rather
 * than a full PostgREST filter-chain parser, since the guard behavior
 * (`.or("refund_status.is.null,refund_status.neq.full")`) is modeled
 * directly in the `client_packages` update resolver.
 */

type FakeResult = { data?: unknown; error?: { message: string } | null };

function makeChain(resolve: () => FakeResult | Promise<FakeResult>) {
  const chain: {
    eq: (...args: unknown[]) => typeof chain;
    or: (...args: unknown[]) => typeof chain;
    select: (...args: unknown[]) => typeof chain;
    maybeSingle: () => Promise<FakeResult>;
    then: (
      onFulfilled: (value: FakeResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => unknown;
  } = {
    eq: () => chain,
    or: () => chain,
    select: () => chain,
    async maybeSingle() {
      const result = await resolve();
      if (result.error) return { data: null, error: result.error };
      const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
      return { data: rows[0] ?? null, error: null };
    },
    then(onFulfilled, onRejected) {
      return Promise.resolve(resolve()).then(onFulfilled, onRejected);
    },
  };
  return chain;
}

type FakePayment = {
  id: string;
  studio_id: string;
  client_id: string;
  client_package_id: string | null;
  client_membership_id: string | null;
  amount: number;
  status: string;
};

type FakeClientPackage = {
  id: string;
  studio_id: string;
  active: boolean;
  refund_status: string | null;
};

function createFakeClientPaymentDb(options: {
  payment: FakePayment;
  clientPackage?: FakeClientPackage | null;
}) {
  const state = {
    payment: { ...options.payment },
    clientPackage: options.clientPackage ? { ...options.clientPackage } : null,
    packageUpdateAttempts: 0,
    packageUpdateApplied: 0,
  };

  const supabase = {
    from(table: string) {
      if (table === "payments") {
        return {
          select: () =>
            makeChain(() => ({
              data: state.payment.id ? { ...state.payment } : null,
              error: null,
            })),
          update: (payload: Record<string, unknown>) =>
            makeChain(() => {
              Object.assign(state.payment, payload);
              return { data: [state.payment], error: null };
            }),
        };
      }

      if (table === "client_packages") {
        return {
          update: (payload: Record<string, unknown>) =>
            makeChain(() => {
              state.packageUpdateAttempts += 1;
              if (!state.clientPackage) return { data: [], error: null };
              const isRefundBlocked = state.clientPackage.refund_status === "full";
              if (payload.active === true && isRefundBlocked) {
                return { data: [], error: null };
              }
              Object.assign(state.clientPackage, payload);
              state.packageUpdateApplied += 1;
              return { data: [{ id: state.clientPackage.id }], error: null };
            }),
        };
      }

      if (table === "client_memberships") {
        return {
          update: () => makeChain(() => ({ data: [], error: null })),
        };
      }

      throw new Error(`Unexpected table in fake client-payment db: ${table}`);
    },
  };

  return { supabase, state };
}

function basePayment(overrides: Partial<FakePayment> = {}): FakePayment {
  return {
    id: "payment-1",
    studio_id: "studio-1",
    client_id: "client-1",
    client_package_id: null,
    client_membership_id: null,
    amount: 100,
    status: "pending",
    ...overrides,
  };
}

function fakeCheckoutSession(
  overrides: Partial<Stripe.Checkout.Session> & { metadata?: Record<string, string> } = {},
) {
  return {
    id: "cs_123",
    payment_intent: "pi_123",
    payment_status: "paid",
    amount_total: 10000,
    currency: "usd",
    metadata: {
      source: "client_payment_request",
      paymentId: "payment-1",
    },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

describe("Package Refund P0, Slice 2b — handleClientPaymentRequestCheckoutCompleted package activation guard", () => {
  it("a refund_status='full' linked package is never activated by a confirming checkout", async () => {
    const { supabase, state } = createFakeClientPaymentDb({
      payment: basePayment({ client_package_id: "pkg-1" }),
      clientPackage: {
        id: "pkg-1",
        studio_id: "studio-1",
        active: false,
        refund_status: "full",
      },
    });

    const handled = await handleClientPaymentRequestCheckoutCompleted(
      supabase as never,
      fakeCheckoutSession(),
    );

    expect(handled).toBe(true);
    expect(state.packageUpdateAttempts).toBe(1);
    expect(state.packageUpdateApplied).toBe(0);
    expect(state.clientPackage?.active).toBe(false);
  });

  it("an ordinary (never-refunded, refund_status=null) linked package still activates correctly", async () => {
    const { supabase, state } = createFakeClientPaymentDb({
      payment: basePayment({ client_package_id: "pkg-2" }),
      clientPackage: {
        id: "pkg-2",
        studio_id: "studio-1",
        active: false,
        refund_status: null,
      },
    });

    const handled = await handleClientPaymentRequestCheckoutCompleted(
      supabase as never,
      fakeCheckoutSession(),
    );

    expect(handled).toBe(true);
    expect(state.packageUpdateApplied).toBe(1);
    expect(state.clientPackage?.active).toBe(true);
  });

  it("a refund_status='partial' linked package still activates correctly (no hard block)", async () => {
    const { supabase, state } = createFakeClientPaymentDb({
      payment: basePayment({ client_package_id: "pkg-3" }),
      clientPackage: {
        id: "pkg-3",
        studio_id: "studio-1",
        active: false,
        refund_status: "partial",
      },
    });

    const handled = await handleClientPaymentRequestCheckoutCompleted(
      supabase as never,
      fakeCheckoutSession(),
    );

    expect(handled).toBe(true);
    expect(state.packageUpdateApplied).toBe(1);
    expect(state.clientPackage?.active).toBe(true);
  });
});
