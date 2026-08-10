import { describe, expect, it, vi } from "vitest";
import { startQuickCharge, type StartQuickChargeInput } from "@/lib/payments/terminal-quick-charge";
import { FakeTable, createFakeAdminClient } from "@/lib/payments/__tests__/fakeSupabase";

/**
 * P0.1 regression coverage: quick-charge/start and quick-pay/start previously
 * inserted a new `payments` row and created a new Stripe PaymentIntent on
 * every POST, with no identifier tying a retry (double click, client
 * timeout + resubmit) back to the original attempt. These tests exercise
 * `startQuickCharge` — the logic both routes now share — against a small
 * in-memory fake Supabase admin client that models the real constraints
 * (the partial unique index on payments (studio_id, client_request_id),
 * and terminal_payment_sessions status semantics) rather than assuming
 * them away.
 */

function createFakeSupabase() {
  const payments = new FakeTable();
  payments.uniqueColumns = ["studio_id", "client_request_id"];
  const sessions = new FakeTable();

  const supabase = createFakeAdminClient({ payments, terminal_payment_sessions: sessions });

  return { supabase, payments, sessions };
}

function createFakeStripe(options: { processFails?: boolean } = {}) {
  let piCounter = 0;
  const createCalls: { idempotencyKey?: string }[] = [];

  const stripe = {
    paymentIntents: {
      create: vi.fn(async (_params: unknown, requestOptions: { idempotencyKey?: string }) => {
        piCounter += 1;
        createCalls.push({ idempotencyKey: requestOptions?.idempotencyKey });
        return { id: `pi_${piCounter}`, status: "requires_payment_method" };
      }),
      cancel: vi.fn(async () => ({ id: "pi_cancelled" })),
    },
    terminal: {
      readers: {
        processPaymentIntent: vi.fn(async () => {
          if (options.processFails) {
            throw new Error("Reader is offline");
          }
          return { id: "reader_action" };
        }),
      },
    },
  };

  return { stripe, createCalls };
}

const STUDIO = { id: "studio-1", stripe_connected_account_id: "acct_1" };
const READER = {
  id: "reader-row-1",
  label: "Front Desk",
  terminal_location_id: "loc-1",
  stripe_reader_id: "tmr_1",
  stripe_location_id: "tml_1",
};

function adHocInput(overrides: Partial<Extract<StartQuickChargeInput, { kind: "ad_hoc" }>> = {}): StartQuickChargeInput {
  return {
    kind: "ad_hoc",
    category: "group_class",
    amount: 20,
    guestName: null,
    notes: null,
    ...overrides,
  };
}

const VALID_ID_A = "11111111-1111-4111-8111-111111111111";
const VALID_ID_B = "22222222-2222-4222-8222-222222222222";

describe("startQuickCharge", () => {
  it("replays the same clientRequestId without creating a second PaymentIntent", async () => {
    const { supabase } = createFakeSupabase();
    const { stripe } = createFakeStripe();

    const first = await startQuickCharge({
      supabase: supabase as never,
      stripe: stripe as never,
      studio: STUDIO,
      reader: READER,
      userId: "user-1",
      clientRequestId: VALID_ID_A,
      idempotencyNamespace: "quick-charge",
      input: adHocInput(),
    });

    const second = await startQuickCharge({
      supabase: supabase as never,
      stripe: stripe as never,
      studio: STUDIO,
      reader: READER,
      userId: "user-1",
      clientRequestId: VALID_ID_A,
      idempotencyNamespace: "quick-charge",
      input: adHocInput(),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.paymentId).toBe(first.paymentId);
      expect(second.sessionId).toBe(first.sessionId);
    }
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);

    // Stripe Connect regression protection: every Stripe call for this
    // studio must be scoped to its connected account, on both the
    // PaymentIntent creation and the reader-dispatch call.
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ stripeAccount: STUDIO.stripe_connected_account_id }),
    );
    expect(stripe.terminal.readers.processPaymentIntent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ stripeAccount: STUDIO.stripe_connected_account_id }),
    );
  });

  it("keeps distinct clientRequestIds as distinct payments and PaymentIntents", async () => {
    const { supabase } = createFakeSupabase();
    const { stripe } = createFakeStripe();

    const first = await startQuickCharge({
      supabase: supabase as never,
      stripe: stripe as never,
      studio: STUDIO,
      reader: READER,
      userId: "user-1",
      clientRequestId: VALID_ID_A,
      idempotencyNamespace: "quick-charge",
      input: adHocInput(),
    });

    const second = await startQuickCharge({
      supabase: supabase as never,
      stripe: stripe as never,
      studio: STUDIO,
      reader: READER,
      userId: "user-1",
      clientRequestId: VALID_ID_B,
      idempotencyNamespace: "quick-charge",
      input: adHocInput(),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.paymentId).not.toBe(first.paymentId);
      expect(second.sessionId).not.toBe(first.sessionId);
    }
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(2);
  });

  it("recovers from a concurrent duplicate insert (Postgres 23505) instead of failing the request", async () => {
    const { supabase, payments } = createFakeSupabase();
    const { stripe } = createFakeStripe();

    // Simulate a genuine race: another request's INSERT commits between this
    // request's pre-check SELECT (which sees nothing) and its own INSERT.
    // The winner's row carries the same amount/category as this request
    // (as a real concurrent duplicate of the same click would), so the
    // request-consistency check doesn't reject it as a mismatch.
    payments.raceOnNextInsert = (payload) => {
      payments.rows.push({
        id: "winner-row",
        status: "pending",
        created_at: "t0",
        studio_id: payload.studio_id,
        client_request_id: payload.client_request_id,
        amount: 20,
        quick_charge_category: "group_class",
      });
    };

    const result = await startQuickCharge({
      supabase: supabase as never,
      stripe: stripe as never,
      studio: STUDIO,
      reader: READER,
      userId: "user-1",
      clientRequestId: VALID_ID_A,
      idempotencyNamespace: "quick-charge",
      input: adHocInput(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.paymentId).toBe("winner-row");
    }
    // The race was resolved by re-selecting the winner and proceeding with
    // it, not by erroring out.
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing or invalid clientRequestId with a 400", async () => {
    const { supabase } = createFakeSupabase();
    const { stripe } = createFakeStripe();

    const missing = await startQuickCharge({
      supabase: supabase as never,
      stripe: stripe as never,
      studio: STUDIO,
      reader: READER,
      userId: "user-1",
      clientRequestId: "",
      idempotencyNamespace: "quick-charge",
      input: adHocInput(),
    });

    const invalid = await startQuickCharge({
      supabase: supabase as never,
      stripe: stripe as never,
      studio: STUDIO,
      reader: READER,
      userId: "user-1",
      clientRequestId: "not-a-uuid",
      idempotencyNamespace: "quick-charge",
      input: adHocInput(),
    });

    expect(missing).toEqual({ ok: false, error: expect.any(String), status: 400 });
    expect(invalid).toEqual({ ok: false, error: expect.any(String), status: 400 });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("retries after a synchronous reader-processing failure with a fresh idempotency key, not the stale PaymentIntent", async () => {
    const { supabase, payments, sessions } = createFakeSupabase();
    const { stripe, createCalls } = createFakeStripe({ processFails: true });

    const firstAttempt = await startQuickCharge({
      supabase: supabase as never,
      stripe: stripe as never,
      studio: STUDIO,
      reader: READER,
      userId: "user-1",
      clientRequestId: VALID_ID_A,
      idempotencyNamespace: "quick-charge",
      input: adHocInput(),
    });

    expect(firstAttempt.ok).toBe(false);
    if (!firstAttempt.ok) expect(firstAttempt.status).toBe(409);
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledTimes(1);

    // Stripe Connect regression protection on the failure/rollback path too.
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith(
      expect.any(String),
      {},
      expect.objectContaining({ stripeAccount: STUDIO.stripe_connected_account_id }),
    );
    expect(stripe.terminal.readers.processPaymentIntent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ stripeAccount: STUDIO.stripe_connected_account_id }),
    );

    const paymentRow = payments.rows[0];
    expect(paymentRow.status).toBe("failed");
    const sessionRow = sessions.rows[0];
    expect(sessionRow.status).toBe("failed");

    // Retry with the same clientRequestId (the client persists it across a
    // definitive server-acknowledged failure it wants to retry).
    const { stripe: workingStripe, createCalls: workingCalls } = createFakeStripe({ processFails: false });
    const secondAttempt = await startQuickCharge({
      supabase: supabase as never,
      stripe: workingStripe as never,
      studio: STUDIO,
      reader: READER,
      userId: "user-1",
      clientRequestId: VALID_ID_A,
      idempotencyNamespace: "quick-charge",
      input: adHocInput(),
    });

    expect(secondAttempt.ok).toBe(true);
    if (secondAttempt.ok) {
      expect(secondAttempt.paymentId).toBe(paymentRow.id);
    }
    expect(workingStripe.paymentIntents.create).toHaveBeenCalledTimes(1);

    const firstKey = createCalls[0]?.idempotencyKey;
    const secondKey = workingCalls[0]?.idempotencyKey;
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBeTruthy();
    expect(secondKey).not.toBe(firstKey);
  });

  it("replays an open commerce-order session instead of creating a second PaymentIntent", async () => {
    const { supabase, sessions } = createFakeSupabase();
    const { stripe } = createFakeStripe();

    sessions.rows.push({
      id: "existing-session",
      studio_id: STUDIO.id,
      payment_id: "existing-payment",
      status: "processing",
      created_at: "t0",
    });

    const result = await startQuickCharge({
      supabase: supabase as never,
      stripe: stripe as never,
      studio: STUDIO,
      reader: READER,
      userId: "user-1",
      clientRequestId: VALID_ID_A,
      idempotencyNamespace: "quick-charge",
      input: {
        kind: "commerce_order",
        payment: { id: "existing-payment", notes: null },
        order: { id: "order-1", total: 42 },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.paymentId).toBe("existing-payment");
      expect(result.sessionId).toBe("existing-session");
      expect(result.status).toBe("processing");
    }
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("recovers from a concurrent terminal_payment_sessions insert race for the same PaymentIntent (Postgres 23505) by replaying the winner, instead of cancelling its PaymentIntent", async () => {
    // terminal_payment_sessions.stripe_payment_intent_id is globally unique
    // in the real schema. Two concurrent sub-attempts sharing the same
    // clientRequestId can both pass the pre-insert "is there an open
    // session yet" check as false, both call stripe.paymentIntents.create
    // with the same idempotency key (Stripe correctly hands both the same
    // PaymentIntent), and then race to INSERT the session row for that PI.
    // This models that race explicitly (rather than via a real Promise.all)
    // because the fake DB's operations don't have a real I/O-driven
    // interleaving window to reliably reproduce timing-sensitive concurrent
    // behavior across runs — the explicit hook deterministically exercises
    // the exact branch under test on every run.
    const { supabase, sessions } = createFakeSupabase();
    const { stripe } = createFakeStripe();

    sessions.raceOnNextInsert = (payload) => {
      sessions.rows.push({
        id: "winner-session",
        studio_id: payload.studio_id,
        payment_id: payload.payment_id,
        stripe_payment_intent_id: payload.stripe_payment_intent_id,
        status: "created",
        created_at: "t0",
      });
    };

    const result = await startQuickCharge({
      supabase: supabase as never,
      stripe: stripe as never,
      studio: STUDIO,
      reader: READER,
      userId: "user-1",
      clientRequestId: VALID_ID_A,
      idempotencyNamespace: "quick-charge",
      input: adHocInput(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessionId).toBe("winner-session");
    }
    // The critical assertion: the loser must NOT cancel the PaymentIntent
    // the winner is relying on, and must NOT mark the payment failed.
    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled();
    const paymentRow = sessions.rows.find((r) => r.id === "winner-session");
    expect(paymentRow?.status).not.toBe("failed");
  });

  it("rejects reuse of a clientRequestId with a different amount than the original attempt (409, no second PaymentIntent)", async () => {
    const { supabase } = createFakeSupabase();
    const { stripe } = createFakeStripe();

    const first = await startQuickCharge({
      supabase: supabase as never,
      stripe: stripe as never,
      studio: STUDIO,
      reader: READER,
      userId: "user-1",
      clientRequestId: VALID_ID_A,
      idempotencyNamespace: "quick-charge",
      input: adHocInput({ amount: 20 }),
    });
    expect(first.ok).toBe(true);

    const second = await startQuickCharge({
      supabase: supabase as never,
      stripe: stripe as never,
      studio: STUDIO,
      reader: READER,
      userId: "user-1",
      clientRequestId: VALID_ID_A,
      idempotencyNamespace: "quick-charge",
      input: adHocInput({ amount: 35 }),
    });

    expect(second).toEqual({ ok: false, error: expect.any(String), status: 409 });
    // Only the first attempt's PaymentIntent was ever created.
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of a clientRequestId with a different category than the original attempt (409, no second PaymentIntent)", async () => {
    const { supabase } = createFakeSupabase();
    const { stripe } = createFakeStripe();

    const first = await startQuickCharge({
      supabase: supabase as never,
      stripe: stripe as never,
      studio: STUDIO,
      reader: READER,
      userId: "user-1",
      clientRequestId: VALID_ID_A,
      idempotencyNamespace: "quick-charge",
      input: adHocInput({ category: "group_class" }),
    });
    expect(first.ok).toBe(true);

    const second = await startQuickCharge({
      supabase: supabase as never,
      stripe: stripe as never,
      studio: STUDIO,
      reader: READER,
      userId: "user-1",
      clientRequestId: VALID_ID_A,
      idempotencyNamespace: "quick-charge",
      input: adHocInput({ category: "merchandise" }),
    });

    expect(second).toEqual({ ok: false, error: expect.any(String), status: 409 });
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
  });
});
