import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createOwnershipFakeSupabase, type Row } from "@/lib/payments/__tests__/ownershipFakes";
import {
  assertEventCheckoutBinding,
  asyncPaymentFailureMatchesStoredPayment,
  handleCheckoutSessionCompleted,
} from "@/app/api/payments/webhook/route";

/**
 * PAY-DC-2D (M1/M3): event checkout completions only fulfil the row whose
 * server-stored Stripe reference is this Stripe object, and only for the owning
 * studio's connected account; async failures only fail the matching pending
 * payment. Mismatches make zero writes.
 */

const STUDIO = "studio-1";
const A = "acct_studioA";
const C = "acct_otherC";

function db(rows: Record<string, Row[]>) {
  const fake = createOwnershipFakeSupabase(rows);
  return { fake, supabase: fake.client as unknown as SupabaseClient };
}

const noFeeStripe = {
  paymentIntents: {
    retrieve: async () => {
      throw new Error("fee sync not modelled");
    },
  },
} as unknown as Stripe;

function writes(fake: ReturnType<typeof createOwnershipFakeSupabase>) {
  return fake.mutations.length;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("single registration checkout binding", () => {
  function registrationDb(overrides: Row = {}, studioAccount: string | null = A) {
    return db({
      event_registrations: [
        {
          id: "reg-1",
          total_amount: 40,
          total_price: 40,
          currency: "usd",
          payment_status: "pending",
          stripe_checkout_session_id: "cs_1",
          events: { studio_id: STUDIO },
          ...overrides,
        },
      ],
      studios: [{ id: STUDIO, stripe_connected_account_id: studioAccount }],
      event_payments: [],
    });
  }

  function session(id = "cs_1") {
    return {
      id,
      payment_status: "paid",
      payment_intent: "pi_1",
      amount_total: 4000,
      currency: "usd",
      metadata: { source: "event_registration", registration_id: "reg-1" },
    } as unknown as Stripe.Checkout.Session;
  }

  it("matching account + stored session fulfils and stamps the owner", async () => {
    const { fake, supabase } = registrationDb();
    await handleCheckoutSessionCompleted(supabase, noFeeStripe, session(), A).catch(() => undefined);

    expect(fake.rows("event_registrations")[0]).toMatchObject({
      payment_status: "paid",
      status: "confirmed",
      stripe_checkout_session_id: "cs_1",
    });
    expect(fake.rows("event_payments")[0]).toMatchObject({ stripe_account_id: A, stripe_payment_intent_id: "pi_1" });
  });

  it.each([
    ["missing event.account", undefined, "cs_1", {}],
    ["event from another account", C, "cs_1", {}],
    ["session not the stored one", A, "cs_other", {}],
    ["no stored session (metadata id only)", A, "cs_1", { stripe_checkout_session_id: null }],
  ])("%s -> fixed code, zero writes", async (_name, account, sessionId, overrides) => {
    const { fake, supabase } = registrationDb(overrides as Row);
    await expect(
      handleCheckoutSessionCompleted(supabase, noFeeStripe, session(sessionId), account),
    ).rejects.toThrow(/^event_payment_(account|reference)_mismatch$/);
    expect(writes(fake)).toBe(0);
  });

  it("studio whose connected account differs -> account mismatch, zero writes", async () => {
    const { fake, supabase } = registrationDb({}, C);
    await expect(handleCheckoutSessionCompleted(supabase, noFeeStripe, session(), A)).rejects.toThrow(
      "event_payment_account_mismatch",
    );
    expect(writes(fake)).toBe(0);
  });

  it("duplicate delivery stays idempotent (one event payment row)", async () => {
    const { fake, supabase } = registrationDb();
    await handleCheckoutSessionCompleted(supabase, noFeeStripe, session(), A).catch(() => undefined);
    await handleCheckoutSessionCompleted(supabase, noFeeStripe, session(), A).catch(() => undefined);
    expect(fake.rows("event_payments")).toHaveLength(1);
  });
});

describe("cart order checkout binding", () => {
  function cartDb(orderOverrides: Row = {}) {
    return db({
      event_orders: [
        {
          id: "order-1",
          studio_id: STUDIO,
          total_amount: 25,
          currency: "usd",
          stripe_checkout_session_id: "cs_cart",
          stripe_payment_intent_id: null,
          ...orderOverrides,
        },
      ],
      event_registrations: [
        { id: "reg-c1", order_id: "order-1", total_price: 25, currency: "usd", stripe_checkout_session_id: "cs_cart" },
      ],
      studios: [{ id: STUDIO, stripe_connected_account_id: A }],
      event_payments: [],
      event_private_lesson_slots: [],
    });
  }

  function cartSession(id = "cs_cart") {
    return {
      id,
      payment_status: "paid",
      payment_intent: "pi_cart",
      amount_total: 2500,
      currency: "usd",
      metadata: { source: "event_cart_order", order_id: "order-1" },
    } as unknown as Stripe.Checkout.Session;
  }

  it("matching values confirm the order without rewriting the stored session", async () => {
    const { fake, supabase } = cartDb();
    await handleCheckoutSessionCompleted(supabase, noFeeStripe, cartSession(), A).catch(() => undefined);

    const order = fake.rows("event_orders")[0];
    expect(order).toMatchObject({ payment_status: "paid", stripe_checkout_session_id: "cs_cart" });
    const orderUpdates = fake.mutations.filter((m) => m.table === "event_orders");
    expect(orderUpdates.every((m) => !("stripe_checkout_session_id" in m.values))).toBe(true);
    const registrationUpdates = fake.mutations.filter((m) => m.table === "event_registrations");
    expect(registrationUpdates.every((m) => !("stripe_checkout_session_id" in m.values))).toBe(true);
    expect(fake.rows("event_payments")[0]).toMatchObject({ stripe_account_id: A });
  });

  it.each([
    ["other account", C, "cs_cart"],
    ["other session for the same order id", A, "cs_forged"],
  ])("%s -> zero writes", async (_name, account, sessionId) => {
    const { fake, supabase } = cartDb();
    await expect(
      handleCheckoutSessionCompleted(supabase, noFeeStripe, cartSession(sessionId), account),
    ).rejects.toThrow(/^event_payment_(account|reference)_mismatch$/);
    expect(writes(fake)).toBe(0);
  });
});

describe("cart PaymentIntent and private lesson binding", () => {
  it("PaymentIntent must equal the order's stored PaymentIntent", async () => {
    const { fake, supabase } = db({
      event_orders: [{ id: "order-2", studio_id: STUDIO, stripe_payment_intent_id: "pi_stored" }],
      studios: [{ id: STUDIO, stripe_connected_account_id: A }],
    });

    await expect(
      assertEventCheckoutBinding(supabase, { kind: "order_payment_intent", id: "order-2", paymentIntentId: "pi_other" }, A),
    ).rejects.toThrow("event_payment_reference_mismatch");
    await expect(
      assertEventCheckoutBinding(supabase, { kind: "order_payment_intent", id: "order-2", paymentIntentId: "pi_stored" }, C),
    ).rejects.toThrow("event_payment_account_mismatch");
    await expect(
      assertEventCheckoutBinding(supabase, { kind: "order_payment_intent", id: "order-2", paymentIntentId: "pi_stored" }, A),
    ).resolves.toBeUndefined();
    expect(writes(fake)).toBe(0);
  });

  it("private lesson requires the stored slot session (no longer a soft check)", async () => {
    const lessonDb = () =>
      db({
        event_private_lesson_slots: [
          { id: "slot-1", studio_id: null, price: 60, status: "held", stripe_checkout_session_id: null, events: { studio_id: STUDIO } },
        ],
        studios: [{ id: STUDIO, stripe_connected_account_id: A }],
      });
    const lessonSession = {
      id: "cs_lesson",
      payment_status: "paid",
      payment_intent: "pi_lesson",
      amount_total: 6000,
      metadata: { source: "event_private_lesson_slot", slot_id: "slot-1" },
    } as unknown as Stripe.Checkout.Session;

    const { fake, supabase } = lessonDb();
    await expect(handleCheckoutSessionCompleted(supabase, noFeeStripe, lessonSession, A)).rejects.toThrow(
      "event_payment_reference_mismatch",
    );
    expect(writes(fake)).toBe(0);

    const bound = lessonDb();
    bound.fake.rows("event_private_lesson_slots")[0].stripe_checkout_session_id = "cs_lesson";
    await handleCheckoutSessionCompleted(bound.supabase, noFeeStripe, lessonSession, A);
    expect(bound.fake.rows("event_private_lesson_slots")[0]).toMatchObject({
      status: "booked",
      stripe_checkout_session_id: "cs_lesson",
    });
  });

  it("handlers bind before their first mutation (source guard)", () => {
    const source = readFileSync(join(process.cwd(), "src", "app", "api", "payments", "webhook", "route.ts"), "utf8");
    for (const [handler, kind] of [
      ["handleEventRegistrationCheckoutCompleted", "registration"],
      ["handleEventCartOrderCheckoutCompleted", "order_session"],
      ["handleEventCartOrderPaymentIntentSucceeded", "order_payment_intent"],
      ["handleEventPrivateLessonCheckoutCompleted", "private_lesson_slot"],
    ]) {
      const start = source.indexOf(`async function ${handler}(`);
      const body = source.slice(start, source.indexOf("\nasync function ", start + 10));
      const bindAt = body.indexOf(`kind: "${kind}"`);
      const firstWrite = body.search(/\.(update|insert)\(/);
      expect(bindAt).toBeGreaterThan(0);
      expect(bindAt).toBeLessThan(firstWrite);
    }
    expect(source).toContain("handleEventPrivateLessonCheckoutCompleted(supabase, session, stripeAccountId)");
  });
});

describe("M3: async payment failure binding", () => {
  function paymentDb(overrides: Row = {}) {
    return db({
      payments: [
        { id: "pay-1", status: "pending", stripe_checkout_session_id: "cs_pkg", stripe_account_id: A, ...overrides },
      ],
    });
  }

  it("matching pending payment, session and owner -> may fail it", async () => {
    const { supabase } = paymentDb();
    await expect(
      asyncPaymentFailureMatchesStoredPayment(supabase, { paymentId: "pay-1", sessionId: "cs_pkg", stripeAccountId: A }),
    ).resolves.toBe(true);
  });

  it.each([
    ["stale session", { paymentId: "pay-1", sessionId: "cs_old", stripeAccountId: A }, {}],
    ["other account", { paymentId: "pay-1", sessionId: "cs_pkg", stripeAccountId: C }, {}],
    ["no event.account", { paymentId: "pay-1", sessionId: "cs_pkg", stripeAccountId: null }, {}],
    ["not pending", { paymentId: "pay-1", sessionId: "cs_pkg", stripeAccountId: A }, { status: "paid" }],
    ["unknown payment id", { paymentId: "pay-x", sessionId: "cs_pkg", stripeAccountId: A }, {}],
  ])("%s -> skip with code-only log, no write", async (_name, params, overrides) => {
    const { fake, supabase } = paymentDb(overrides as Row);
    await expect(asyncPaymentFailureMatchesStoredPayment(supabase, params)).resolves.toBe(false);
    expect(writes(fake)).toBe(0);
    expect(vi.mocked(console.error)).toHaveBeenCalledWith("package_payment_failed_reference_mismatch");
  });

  it("the webhook case checks the binding before the failure RPC (source guard)", () => {
    const source = readFileSync(join(process.cwd(), "src", "app", "api", "payments", "webhook", "route.ts"), "utf8");
    const start = source.indexOf('case "checkout.session.async_payment_failed"');
    const block = source.slice(start, source.indexOf("break;", start));
    expect(block.indexOf("asyncPaymentFailureMatchesStoredPayment")).toBeGreaterThan(0);
    expect(block.indexOf("asyncPaymentFailureMatchesStoredPayment")).toBeLessThan(
      block.indexOf("_mark_package_payment_failed_and_reevaluate"),
    );
  });
});
