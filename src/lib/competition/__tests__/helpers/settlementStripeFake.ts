import { vi } from "vitest";
import type Stripe from "stripe";
import type { SettlementStripeReader } from "@/lib/competition/registrationLifecycle";

/** A fake Stripe reader that returns what Stripe's API would say about a paid competition Checkout Session. */
export function paidLive(overrides: { session?: Record<string, unknown>; intent?: Record<string, unknown> } = {}) {
  const intent = { id: "pi_1", status: "succeeded", amount_received: 10000, currency: "usd", ...overrides.intent };
  return {
    id: "cs_paid",
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    livemode: false,
    amount_total: 10000,
    currency: "usd",
    metadata: { source: "competition_registration", order_id: "11111111-2222-4333-8444-555555555555" },
    payment_intent: intent,
    ...overrides.session,
  } as unknown as Stripe.Checkout.Session;
}

export function fakeStripeReader(live: Stripe.Checkout.Session | Error) {
  const retrieve = vi.fn(async (...call: [string, { expand: string[] }, { stripeAccount: string }]) => {
    void call;
    if (live instanceof Error) throw live;
    return live;
  });
  return { stripe: { checkout: { sessions: { retrieve } } } as SettlementStripeReader, retrieve };
}
