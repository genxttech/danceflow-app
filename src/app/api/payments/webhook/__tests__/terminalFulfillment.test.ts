import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { handleTerminalPaymentIntentSucceeded } from "@/app/api/payments/webhook/route";
import { fulfillTerminalPayment } from "@/lib/payments/terminal-fulfillment";

/**
 * P0.2 regression coverage: Quick Charge / Quick Pay PaymentIntents carry
 * metadata.source = "danceflow_terminal_quick_charge", while the webhook's
 * terminal handler previously recognized only "danceflow_terminal" — so a
 * successfully captured Quick Charge/Quick Pay payment was never marked
 * paid by the webhook, leaving it dependent entirely on the browser
 * remaining open and polling. These tests exercise the real
 * `handleTerminalPaymentIntentSucceeded` (webhook route) and
 * `fulfillTerminalPayment` (shared fulfillment helper) functions directly
 * against a fake Supabase layer that models the actual idempotency guard
 * (`.neq("status", "paid")`) rather than assuming it away, so a regression
 * of either the source-matching fix or the underlying idempotent-update
 * behavior would fail these tests.
 */

type FakeResult = { data?: unknown; error?: { message: string } | null };

function makeChain(resolve: () => FakeResult | Promise<FakeResult>) {
  const chain: {
    eq: (...args: unknown[]) => typeof chain;
    neq: (...args: unknown[]) => typeof chain;
    in: (...args: unknown[]) => typeof chain;
    limit: (...args: unknown[]) => typeof chain;
    or: (...args: unknown[]) => typeof chain;
    select: (...args: unknown[]) => typeof chain;
    maybeSingle: () => Promise<FakeResult>;
    single: () => Promise<FakeResult>;
    then: (
      onFulfilled: (value: FakeResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => unknown;
  } = {
    eq: () => chain,
    neq: () => chain,
    in: () => chain,
    limit: () => chain,
    // Package Refund P0, Slice 2b: these two are simple chainable
    // passthroughs -- this fake is state-driven (see the client_packages
    // update resolver below), not a real filter-chain parser, so the
    // actual NULL-safe-guard behavior is modeled inside the resolver
    // itself rather than by parsing the .or() clause string.
    or: () => chain,
    select: () => chain,
    async maybeSingle() {
      const result = await resolve();
      if (result.error) return { data: null, error: result.error };
      const rows = Array.isArray(result.data)
        ? result.data
        : result.data
          ? [result.data]
          : [];
      return { data: rows[0] ?? null, error: null };
    },
    async single() {
      const result = await resolve();
      if (result.error) return { data: null, error: result.error };
      const rows = Array.isArray(result.data)
        ? result.data
        : result.data
          ? [result.data]
          : [];
      if (!rows.length) {
        return { data: null, error: { message: "Row not found" } };
      }
      return { data: rows[0], error: null };
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
  amount: number;
  currency: string;
  status: string;
  client_package_id: string | null;
  payment_type: string;
  external_reference: string | null;
  commerce_order_id: string | null;
};

type FakeSession = {
  id: string;
  studio_id: string;
  payment_id: string;
  amount_cents: number;
  currency: string;
  stripe_payment_intent_id: string;
};

type FakeClientPackage = {
  id: string;
  studio_id: string;
  active: boolean;
  refund_status: string | null;
};

function createFakeTerminalDb(options: {
  payment: FakePayment;
  session: FakeSession | null;
  rpcError?: string;
  clientPackage?: FakeClientPackage | null;
}) {
  const state = {
    payment: { ...options.payment },
    session: options.session,
    clientPackage: options.clientPackage ? { ...options.clientPackage } : null,
    paymentUpdateAttempts: 0,
    paymentUpdateApplied: 0,
    packageUpdateAttempts: 0,
    packageUpdateApplied: 0,
    rpcCalls: [] as { name: string; params: Record<string, unknown> }[],
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
              state.paymentUpdateAttempts += 1;
              if (state.payment.status !== "paid") {
                Object.assign(state.payment, payload);
                state.paymentUpdateApplied += 1;
              }
              return { error: null };
            }),
        };
      }

      if (table === "terminal_payment_sessions") {
        return {
          select: () =>
            makeChain(() => ({
              data: state.session ? { ...state.session } : null,
              error: null,
            })),
        };
      }

      if (table === "membership_terminal_enrollments") {
        return {
          select: () => makeChain(() => ({ data: null, error: null })),
        };
      }

      if (table === "client_packages") {
        return {
          // Package Refund P0, Slice 2b: models the real
          // .or("refund_status.is.null,refund_status.neq.full") guarded
          // update -- an activation attempt (`active: true`) against a
          // refund_status='full' row applies to zero rows (not an error),
          // exactly like the real NULL-safe PostgREST predicate would.
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

      throw new Error(`Unexpected table in fake terminal db: ${table}`);
    },
    rpc(name: string, params: Record<string, unknown>) {
      state.rpcCalls.push({ name, params });
      if (options.rpcError) {
        return Promise.resolve({ error: { message: options.rpcError } });
      }
      return Promise.resolve({ error: null });
    },
  };

  return { supabase, state };
}

function basePayment(overrides: Partial<FakePayment> = {}): FakePayment {
  return {
    id: "payment-1",
    studio_id: "studio-1",
    amount: 20,
    currency: "usd",
    status: "pending",
    client_package_id: null,
    payment_type: "other",
    external_reference: null,
    commerce_order_id: null,
    ...overrides,
  };
}

function baseSession(overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    id: "session-1",
    studio_id: "studio-1",
    payment_id: "payment-1",
    amount_cents: 2000,
    currency: "usd",
    stripe_payment_intent_id: "pi_123",
    ...overrides,
  };
}

function fakePaymentIntent(
  overrides: Partial<Stripe.PaymentIntent> & {
    metadata?: Record<string, string>;
  } = {},
) {
  return {
    id: "pi_123",
    amount_received: 2000,
    currency: "usd",
    metadata: {
      source: "danceflow_terminal",
      studioId: "studio-1",
      paymentId: "payment-1",
    },
    ...overrides,
  } as unknown as Stripe.PaymentIntent;
}

describe("P0.2 — Terminal / Quick Charge / Quick Pay webhook fulfillment", () => {
  it("normal Terminal fulfillment (danceflow_terminal source) remains correct", async () => {
    const { supabase, state } = createFakeTerminalDb({
      payment: basePayment(),
      session: baseSession(),
    });

    const handled = await handleTerminalPaymentIntentSucceeded(
      supabase as never,
      fakePaymentIntent({
        metadata: {
          source: "danceflow_terminal",
          studioId: "studio-1",
          paymentId: "payment-1",
        },
      }),
    );

    expect(handled).toBe(true);
    expect(state.payment.status).toBe("paid");
    expect(state.paymentUpdateApplied).toBe(1);
  });

  it("Quick Charge/Quick Pay webhook fulfillment marks the correct DanceFlow payment paid", async () => {
    const { supabase, state } = createFakeTerminalDb({
      payment: basePayment(),
      session: baseSession(),
    });

    const handled = await handleTerminalPaymentIntentSucceeded(
      supabase as never,
      fakePaymentIntent({
        metadata: {
          source: "danceflow_terminal_quick_charge",
          studioId: "studio-1",
          paymentId: "payment-1",
        },
      }),
    );

    expect(handled).toBe(true);
    expect(state.payment.status).toBe("paid");
    expect(state.payment.id).toBe("payment-1");
    expect(state.paymentUpdateApplied).toBe(1);
  });

  it("duplicate webhook delivery for the same Quick Charge payment does not create duplicate financial effects", async () => {
    const { supabase, state } = createFakeTerminalDb({
      payment: basePayment(),
      session: baseSession(),
    });
    const intent = fakePaymentIntent({
      metadata: {
        source: "danceflow_terminal_quick_charge",
        studioId: "studio-1",
        paymentId: "payment-1",
      },
    });

    await handleTerminalPaymentIntentSucceeded(supabase as never, intent);
    await handleTerminalPaymentIntentSucceeded(supabase as never, intent);

    expect(state.payment.status).toBe("paid");
    expect(state.paymentUpdateAttempts).toBe(2);
    // Only the first delivery actually flips status -> paid; the redelivery
    // finds status already "paid" and the guarded update no-ops.
    expect(state.paymentUpdateApplied).toBe(1);
  });

  it("an already-paid payment is safely idempotent when the webhook still fires", async () => {
    const { supabase, state } = createFakeTerminalDb({
      payment: basePayment({ status: "paid" }),
      session: baseSession(),
    });

    const handled = await handleTerminalPaymentIntentSucceeded(
      supabase as never,
      fakePaymentIntent({
        metadata: {
          source: "danceflow_terminal_quick_charge",
          studioId: "studio-1",
          paymentId: "payment-1",
        },
      }),
    );

    expect(handled).toBe(true);
    expect(state.payment.status).toBe("paid");
    expect(state.paymentUpdateApplied).toBe(0);
  });

  it("ignores a PaymentIntent whose metadata.source is not a terminal source", async () => {
    const { supabase, state } = createFakeTerminalDb({
      payment: basePayment(),
      session: baseSession(),
    });

    const handled = await handleTerminalPaymentIntentSucceeded(
      supabase as never,
      fakePaymentIntent({
        metadata: {
          source: "commerce_digital_marketplace",
          studioId: "studio-1",
          paymentId: "payment-1",
        },
      }),
    );

    expect(handled).toBe(false);
    expect(state.paymentUpdateAttempts).toBe(0);
  });

  it("throws rather than fulfilling when amount does not match the terminal session (cannot be treated as paid)", async () => {
    const { supabase, state } = createFakeTerminalDb({
      payment: basePayment({ amount: 20 }),
      session: baseSession({ amount_cents: 1500 }), // session expects $15.00
    });

    await expect(
      handleTerminalPaymentIntentSucceeded(
        supabase as never,
        fakePaymentIntent({
          amount_received: 2000, // Stripe actually captured $20.00
          metadata: {
            source: "danceflow_terminal_quick_charge",
            studioId: "studio-1",
            paymentId: "payment-1",
          },
        }),
      ),
    ).rejects.toThrow("amount or currency does not match");

    expect(state.payment.status).not.toBe("paid");
    expect(state.paymentUpdateApplied).toBe(0);
  });

  it("scopes fulfillment to the correct studio — a session under a different studio cannot be fulfilled", async () => {
    const { supabase, state } = createFakeTerminalDb({
      payment: basePayment({ studio_id: "studio-1" }),
      // Session belongs to a different studio than the metadata claims.
      session: null,
    });

    await expect(
      handleTerminalPaymentIntentSucceeded(
        supabase as never,
        fakePaymentIntent({
          metadata: {
            source: "danceflow_terminal_quick_charge",
            studioId: "studio-1",
            paymentId: "payment-1",
          },
        }),
      ),
    ).rejects.toThrow("Terminal payment session was not found");

    expect(state.paymentUpdateAttempts).toBe(0);
  });

  it("throws when required fulfillment metadata (studioId/paymentId) is missing", async () => {
    const { supabase } = createFakeTerminalDb({
      payment: basePayment(),
      session: baseSession(),
    });

    await expect(
      handleTerminalPaymentIntentSucceeded(
        supabase as never,
        fakePaymentIntent({ metadata: { source: "danceflow_terminal_quick_charge" } }),
      ),
    ).rejects.toThrow("missing fulfillment metadata");
  });
});

describe("P0.2 — fulfillTerminalPayment commerce-order completion", () => {
  it("completes a linked commerce order exactly once, passing the acting user through", async () => {
    const { supabase, state } = createFakeTerminalDb({
      payment: basePayment({ commerce_order_id: "order-1" }),
      session: baseSession(),
    });

    await fulfillTerminalPayment({
      supabase: supabase as never,
      studioId: "studio-1",
      paymentId: "payment-1",
      sessionId: "session-1",
      paymentIntentId: "pi_123",
      actorUserId: "user-99",
    });

    expect(state.payment.status).toBe("paid");
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]).toMatchObject({
      name: "commerce_complete_terminal_order",
      params: {
        p_studio_id: "studio-1",
        p_order_id: "order-1",
        p_payment_id: "payment-1",
        p_actor_user_id: "user-99",
      },
    });
  });

  it("does not call the commerce-order RPC when no order is linked (main/quick-pay flows unaffected)", async () => {
    const { supabase, state } = createFakeTerminalDb({
      payment: basePayment({ commerce_order_id: null }),
      session: baseSession(),
    });

    await fulfillTerminalPayment({
      supabase: supabase as never,
      studioId: "studio-1",
      paymentId: "payment-1",
      sessionId: "session-1",
      paymentIntentId: "pi_123",
    });

    expect(state.payment.status).toBe("paid");
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("surfaces commerce-order completion failures instead of silently marking paid", async () => {
    const { supabase, state } = createFakeTerminalDb({
      payment: basePayment({ commerce_order_id: "order-1" }),
      session: baseSession(),
      rpcError: "order already claimed by another payment",
    });

    await expect(
      fulfillTerminalPayment({
        supabase: supabase as never,
        studioId: "studio-1",
        paymentId: "payment-1",
        sessionId: "session-1",
        paymentIntentId: "pi_123",
        actorUserId: "user-99",
      }),
    ).rejects.toThrow("commerce order fulfillment failed");

    // The underlying payment status flip is unconditional and already
    // committed before order completion is attempted — matching the
    // pre-existing quick-charge/refresh behavior this replaces.
    expect(state.payment.status).toBe("paid");
  });
});

describe("Package Refund P0, Slice 2b — fulfillTerminalPayment package activation guard", () => {
  it("a refund_status='full' linked package is never activated by a confirming payment", async () => {
    const { supabase, state } = createFakeTerminalDb({
      payment: basePayment({ client_package_id: "pkg-1" }),
      session: baseSession(),
      clientPackage: {
        id: "pkg-1",
        studio_id: "studio-1",
        active: false,
        refund_status: "full",
      },
    });

    await fulfillTerminalPayment({
      supabase: supabase as never,
      studioId: "studio-1",
      paymentId: "payment-1",
      sessionId: "session-1",
      paymentIntentId: "pi_123",
    });

    expect(state.payment.status).toBe("paid");
    // The guarded update was attempted (this is not a skipped call) but
    // matched zero rows -- the package must remain exactly as it was.
    expect(state.packageUpdateAttempts).toBe(1);
    expect(state.packageUpdateApplied).toBe(0);
    expect(state.clientPackage?.active).toBe(false);
  });

  it("an ordinary (never-refunded, refund_status=null) linked package still activates correctly", async () => {
    const { supabase, state } = createFakeTerminalDb({
      payment: basePayment({ client_package_id: "pkg-2" }),
      session: baseSession(),
      clientPackage: {
        id: "pkg-2",
        studio_id: "studio-1",
        active: false,
        refund_status: null,
      },
    });

    await fulfillTerminalPayment({
      supabase: supabase as never,
      studioId: "studio-1",
      paymentId: "payment-1",
      sessionId: "session-1",
      paymentIntentId: "pi_123",
    });

    expect(state.packageUpdateApplied).toBe(1);
    expect(state.clientPackage?.active).toBe(true);
  });

  it("a refund_status='partial' linked package still activates correctly (no hard block)", async () => {
    const { supabase, state } = createFakeTerminalDb({
      payment: basePayment({ client_package_id: "pkg-3" }),
      session: baseSession(),
      clientPackage: {
        id: "pkg-3",
        studio_id: "studio-1",
        active: false,
        refund_status: "partial",
      },
    });

    await fulfillTerminalPayment({
      supabase: supabase as never,
      studioId: "studio-1",
      paymentId: "payment-1",
      sessionId: "session-1",
      paymentIntentId: "pi_123",
    });

    expect(state.packageUpdateApplied).toBe(1);
    expect(state.clientPackage?.active).toBe(true);
  });
});
