import { randomBytes } from "node:crypto";
import type Stripe from "stripe";
import { paidLive } from "./settlementStripeFake";
import type { SeededOrder } from "./dockerPgAdmin";

export const newEventId = () => `evt_cf1r1_${randomBytes(5).toString("hex")}`;
export const piFor = (order: SeededOrder) => `pi_${order.sessionId?.replace(/^cs_test_/, "") ?? "x"}`;

/** Signed-event body for a seeded order, shaped like a Stripe Connect Checkout event (the signature is added by the test with Stripe's own test-header generator). */
export function eventBodyFor(order: SeededOrder, options: { eventId?: string; type?: string; session?: Record<string, unknown>; account?: string | null } = {}) {
  const account = options.account === undefined ? order.accountId : options.account;
  return JSON.stringify({
    id: options.eventId ?? newEventId(),
    object: "event",
    type: options.type ?? "checkout.session.completed",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: order.sessionId,
        object: "checkout.session",
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        livemode: false,
        amount_total: order.totalCents,
        currency: order.currency.toLowerCase(),
        payment_intent: piFor(order),
        metadata: { source: "competition_registration", order_id: order.orderId },
        ...options.session,
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    ...(account ? { account } : {}),
  });
}

/** What Stripe's API would return for the order's Checkout Session when it is genuinely paid; overrides reshape it. */
export function liveFor(order: SeededOrder, overrides: { session?: Record<string, unknown>; intent?: Record<string, unknown> } = {}): Stripe.Checkout.Session {
  return paidLive({
    session: { id: order.sessionId, amount_total: order.totalCents, currency: order.currency.toLowerCase(), metadata: { source: "competition_registration", order_id: order.orderId }, ...overrides.session },
    intent: { id: piFor(order), amount_received: order.totalCents, currency: order.currency.toLowerCase(), ...overrides.intent },
  });
}
