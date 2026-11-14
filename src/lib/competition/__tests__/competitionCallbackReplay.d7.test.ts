import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

import { applyCompetitionCheckoutEvent } from "@/lib/competition/registrationLifecycle";

/**
 * D7 owner decision P2-2: payment callbacks never consult the Organizer Suite. A Checkout Session that was created while
 * the entitlement was current and is paid (or replayed) after it lapses still finalizes, and a duplicate or replayed
 * callback is a database-level no-op that reports its outcome. Nothing here cancels, refunds or re-evaluates an order.
 */

const ORDER = "11111111-2222-4333-8444-555555555555";
const ACCOUNT = "acct_studioA";

function session(overrides: Partial<Stripe.Checkout.Session> = {}) {
  return {
    id: "cs_paid",
    payment_status: "paid",
    payment_intent: "pi_1",
    amount_total: 10000,
    currency: "usd",
    metadata: { order_id: ORDER },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

function adminWith(outcomes: string[]) {
  const rpc = vi.fn(async (...call: [string, Record<string, unknown>]) => ({ called: call[0], data: { outcome: outcomes.shift() ?? "already_finalized" }, error: null }));
  const from = vi.fn(() => {
    throw new Error("payment callbacks must not read any table (no Organizer Suite lookup)");
  });
  return { admin: { rpc, from } as never, rpc, from };
}

describe("competition payment callbacks after the Organizer Suite entitlement lapsed", () => {
  it("a paid callback finalizes through the database only, with no entitlement or table read", async () => {
    const { admin, rpc, from } = adminWith(["finalized"]);
    const result = await applyCompetitionCheckoutEvent(admin, { eventType: "checkout.session.completed", session: session(), stripeAccountId: ACCOUNT });
    expect(result).toEqual({ orderId: ORDER, outcome: "finalized", paymentIntentId: "pi_1" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe("finalize_competition_registration");
    expect(from).not.toHaveBeenCalled();
  });

  it("a duplicate or replayed callback reports already_finalized and sends identical arguments (idempotent per order)", async () => {
    const { admin, rpc } = adminWith(["finalized", "already_finalized", "already_finalized"]);
    const args = { eventType: "checkout.session.completed", session: session(), stripeAccountId: ACCOUNT };
    const first = await applyCompetitionCheckoutEvent(admin, args);
    const second = await applyCompetitionCheckoutEvent(admin, args);
    const third = await applyCompetitionCheckoutEvent(admin, { ...args, eventType: "checkout.session.async_payment_succeeded" });
    expect([first.outcome, second.outcome, third.outcome]).toEqual(["finalized", "already_finalized", "already_finalized"]);
    expect(rpc.mock.calls[1][1]).toEqual(rpc.mock.calls[0][1]);
    expect(rpc.mock.calls.every((call) => call[0] === "finalize_competition_registration")).toBe(true);
  });

  it("an unpaid (async pending) callback does nothing and never releases the order", async () => {
    const { admin, rpc } = adminWith([]);
    const result = await applyCompetitionCheckoutEvent(admin, {
      eventType: "checkout.session.completed",
      session: session({ payment_status: "unpaid" }),
      stripeAccountId: ACCOUNT,
    });
    expect(result.outcome).toBe("pending_async");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a replayed expired-session callback for an order already paid reports already_paid and changes nothing", async () => {
    const { admin, rpc } = adminWith(["already_paid"]);
    const result = await applyCompetitionCheckoutEvent(admin, {
      eventType: "checkout.session.expired",
      session: session({ id: "cs_old" }),
      stripeAccountId: ACCOUNT,
    });
    expect(result.outcome).toBe("already_paid");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe("release_competition_registration");
  });
});
