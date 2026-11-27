import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

import { applyCompetitionCheckoutEvent, verifySettlementWithStripe } from "@/lib/competition/registrationLifecycle";
import { fakeStripeReader, paidLive } from "./helpers/settlementStripeFake";

/**
 * CF1 Path A: a signed webhook event is a notification, never proof of payment. Finalization happens only when Stripe's own record
 * (read back through the API on the connected account) agrees with the event. A replayed, stale or forged-but-validly-signed event that
 * disagrees with Stripe must never reach finalize_competition_registration.
 */

const ORDER = "11111111-2222-4333-8444-555555555555";
const ACCOUNT = "acct_studioA";

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_paid",
    payment_status: "paid",
    payment_intent: "pi_1",
    amount_total: 10000,
    currency: "usd",
    livemode: false,
    metadata: { source: "competition_registration", order_id: ORDER },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

function admin(outcome = "finalized") {
  const rpc = vi.fn(async (...call: [string, Record<string, unknown>]) => ({ called: call[0], data: { outcome }, error: null }));
  return { client: { rpc, from: () => { throw new Error("no direct table access"); } } as never, rpc };
}

const apply = (stripe: ReturnType<typeof fakeStripeReader>["stripe"], a: ReturnType<typeof admin>, session = event(), eventType = "checkout.session.completed") =>
  applyCompetitionCheckoutEvent(a.client, { stripe, eventType, session, stripeAccountId: ACCOUNT });

describe("settlement re-read: the happy path", () => {
  it("reads the session on the connected account with the PaymentIntent expanded, then finalizes with the values Stripe returned", async () => {
    const { stripe, retrieve } = fakeStripeReader(paidLive());
    const a = admin();
    const result = await apply(stripe, a);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledWith("cs_paid", { expand: ["payment_intent"] }, { stripeAccount: ACCOUNT });
    expect(result).toMatchObject({ orderId: ORDER, outcome: "finalized", paymentIntentId: "pi_1" });
    expect(a.rpc.mock.calls[0][1]).toEqual({ p_order_id: ORDER, p_stripe_account_id: ACCOUNT, p_checkout_session_id: "cs_paid", p_payment_intent_id: "pi_1", p_amount_cents: 10000, p_currency: "USD" });
  });

  it("finalizes from Stripe's values, not the event's, when only an expanded PaymentIntent id differs in form (event carries the id string)", async () => {
    const { stripe } = fakeStripeReader(paidLive());
    const a = admin();
    await apply(stripe, a, event({ payment_intent: { id: "pi_1" } }));
    expect(a.rpc.mock.calls[0][1]).toMatchObject({ p_payment_intent_id: "pi_1" });
  });

  it("an event that does not claim payment performs no Stripe read and no finalize", async () => {
    const { stripe, retrieve } = fakeStripeReader(paidLive());
    const a = admin();
    const result = await apply(stripe, a, event({ payment_status: "unpaid" }));
    expect(result.outcome).toBe("pending_async");
    expect(retrieve).not.toHaveBeenCalled();
    expect(a.rpc).not.toHaveBeenCalled();
  });
});

describe("settlement re-read: events that disagree with Stripe never finalize", () => {
  const cases: Array<[string, Stripe.Checkout.Session]> = [
    ["Stripe shows the session open and unpaid (a forged or replayed 'paid' event)", paidLive({ session: { status: "open", payment_status: "unpaid" } })],
    ["Stripe shows the session expired", paidLive({ session: { status: "expired", payment_status: "unpaid" } })],
    ["Stripe shows complete but still unpaid (delayed method pending)", paidLive({ session: { status: "complete", payment_status: "unpaid" } })],
    ["the amount differs", paidLive({ session: { amount_total: 100 }, intent: { amount_received: 100 } })],
    ["the currency differs", paidLive({ session: { currency: "eur" }, intent: { currency: "eur" } })],
    ["the session id differs", paidLive({ session: { id: "cs_other" } })],
    ["the order binding differs", paidLive({ session: { metadata: { source: "competition_registration", order_id: "99999999-2222-4333-8444-555555555555" } } })],
    ["the session is not a competition session", paidLive({ session: { metadata: { source: "event_cart_order", order_id: ORDER } } })],
    ["the mode is not payment", paidLive({ session: { mode: "subscription" } })],
    ["the livemode differs", paidLive({ session: { livemode: true } })],
    ["the PaymentIntent has not succeeded", paidLive({ intent: { status: "requires_payment_method" } })],
    ["the PaymentIntent was not captured in full", paidLive({ intent: { amount_received: 50 } })],
    ["the PaymentIntent id differs from the event's", paidLive({ intent: { id: "pi_other" } })],
    ["Stripe returns the PaymentIntent unexpanded", paidLive({ session: { payment_intent: "pi_1" } })],
    ["Stripe returns no PaymentIntent", paidLive({ session: { payment_intent: null } })],
    ["the session has no positive amount", paidLive({ session: { amount_total: 0 } })],
  ];
  for (const [label, live] of cases) {
    it(`refuses and never calls the database when ${label}`, async () => {
      const { stripe } = fakeStripeReader(live);
      const a = admin();
      await expect(apply(stripe, a)).rejects.toThrow(/settlement refused/);
      expect(a.rpc).not.toHaveBeenCalled();
    });
  }

  it("a Stripe read failure (outage, wrong account, permission) fails closed so the delivery is retried", async () => {
    const { stripe } = fakeStripeReader(new Error("No such checkout.session"));
    const a = admin();
    await expect(apply(stripe, a)).rejects.toThrow(/No such checkout\.session/);
    expect(a.rpc).not.toHaveBeenCalled();
  });

  it("a replay of a genuine paid event is still idempotent: it re-verifies and the database reports already_finalized", async () => {
    const { stripe, retrieve } = fakeStripeReader(paidLive());
    const a = admin("already_finalized");
    const first = await apply(stripe, a);
    const second = await apply(stripe, a);
    expect([first.outcome, second.outcome]).toEqual(["already_finalized", "already_finalized"]);
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(a.rpc.mock.calls[1][1]).toEqual(a.rpc.mock.calls[0][1]);
  });

  it("the async_payment_succeeded event is verified exactly like checkout.session.completed", async () => {
    const { stripe } = fakeStripeReader(paidLive({ session: { status: "open", payment_status: "unpaid" } }));
    const a = admin();
    await expect(apply(stripe, a, event(), "checkout.session.async_payment_succeeded")).rejects.toThrow(/settlement refused/);
    expect(a.rpc).not.toHaveBeenCalled();
  });
});

describe("settlement re-read: sequences and sparse events", () => {
  it("an unpaid completed event then a paid async_payment_succeeded event finalizes exactly once, only on the second", async () => {
    const { stripe, retrieve } = fakeStripeReader(paidLive());
    const a = admin();
    const first = await apply(stripe, a, event({ payment_status: "unpaid" }));
    const second = await apply(stripe, a, event(), "checkout.session.async_payment_succeeded");
    expect([first.outcome, second.outcome]).toEqual(["pending_async", "finalized"]);
    expect(a.rpc).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it("an event without a PaymentIntent id still finalizes with the id Stripe returned, and the result reports that verified id", async () => {
    const { stripe } = fakeStripeReader(paidLive());
    const a = admin();
    const result = await apply(stripe, a, event({ payment_intent: null }));
    expect(result.paymentIntentId).toBe("pi_1");
    expect(a.rpc.mock.calls[0][1]).toMatchObject({ p_payment_intent_id: "pi_1" });
  });

  it("an event that omits livemode is still verified against Stripe, and one that omits the amount is refused", async () => {
    const { stripe } = fakeStripeReader(paidLive());
    const a = admin();
    await apply(stripe, a, event({ livemode: undefined }));
    expect(a.rpc).toHaveBeenCalledTimes(1);
    const b = admin();
    await expect(apply(stripe, b, event({ amount_total: undefined }))).rejects.toThrow(/settlement refused/);
    expect(b.rpc).not.toHaveBeenCalled();
  });
});

describe("settlement re-read: scope and API surface", () => {
  it("the verifier requires a Stripe reader (it cannot be skipped by omission) and never logs or returns secrets", async () => {
    const { stripe } = fakeStripeReader(paidLive());
    const verified = await verifySettlementWithStripe(stripe, { eventSession: event(), accountId: ACCOUNT, orderId: ORDER });
    expect(Object.keys(verified).sort()).toEqual(["amountCents", "currency", "paymentIntentId"]);
  });

  it("release events are unchanged: they do not read Stripe and the database remains the authority (already_paid is refused there)", async () => {
    const { stripe, retrieve } = fakeStripeReader(paidLive());
    const a = admin("already_paid");
    const result = await apply(stripe, a, event({ payment_status: "unpaid" }), "checkout.session.expired");
    expect(result.outcome).toBe("already_paid");
    expect(retrieve).not.toHaveBeenCalled();
    expect(a.rpc.mock.calls[0][0]).toBe("release_competition_registration");
  });
});
