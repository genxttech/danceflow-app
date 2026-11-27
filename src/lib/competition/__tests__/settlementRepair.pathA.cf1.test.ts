import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCompetitionRegistrationStatus } from "@/lib/competition/registrationCheckout";
import { applyCompetitionCheckoutEvent } from "@/lib/competition/registrationLifecycle";
import { reconcileProcessingEventCartOrder } from "@/lib/events/cartSettlement";
import { fakeStripeReader, paidLive } from "@/lib/competition/__tests__/helpers/settlementStripeFake";
import { ACCOUNT_ID, ORDER_ID, SESSION_ID, StatefulPaymentDb } from "@/app/api/payments/webhook/__tests__/helpers/pathAHarness";

/**
 * CF1 Path A, criterion 5 (offline): what the application does when a competition payment's webhook was missed.
 *
 * FINDING (pinned here so a change is visible): there is NO application-side reconciler for competition orders.
 *  - The registration status page reads Stripe only to DISPLAY "processing"; it never finalizes or writes.
 *  - The event-cart sweeper (reconcileProcessingEventCartOrder) works from event_order_payment_attempts, which competition
 *    orders do not have, so it settles nothing for them.
 *  - The repair that exists is redelivery: Stripe retries a failed delivery, or an operator resends the event. A redelivered
 *    event re-reads Stripe and finalizes through the database, idempotently (see pathA.competitionDelivery.cf1.test.ts).
 * A scheduled "read Stripe state and finalize" repair for competition orders is a residual gap, not a proven behaviour.
 */

const TOKEN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

type Row = Record<string, unknown>;
type World = {
  order: Row | null;
  entries: Row[];
  checkpoint: Row | null;
};

function fakeAdmin(world: World) {
  const writes: string[] = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const result = (table: string): unknown => {
    switch (table) {
      case "event_competition_registration_carts":
        return { id: "cart-1", event_id: "evt-1", order_id: ORDER_ID, events: { slug: "spring-comp", name: "Spring Comp" } };
      case "event_orders": return world.order;
      case "event_competition_entries": return world.entries;
      case "event_signing_checkpoints": return world.checkpoint;
      case "event_competition_divisions": return [];
      default: return null;
    }
  };
  const chain = (table: string) => {
    const self: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "order"]) self[method] = () => self;
    self.maybeSingle = async () => ({ data: result(table), error: null });
    self.then = (resolve: (value: unknown) => void) => resolve({ data: result(table), error: null });
    for (const method of ["update", "insert", "delete", "upsert"]) self[method] = () => { writes.push(`${method}:${table}`); return self; };
    return self;
  };
  const client = {
    from: (table: string) => chain(table),
    rpc: async (fn: string, args: Record<string, unknown>) => { rpcCalls.push({ fn, args }); return { data: { outcome: "released" }, error: null }; },
  };
  return { admin: client as unknown as SupabaseClient, writes, rpcCalls };
}

const pendingOrder = (extra: Row = {}): Row => ({
  id: ORDER_ID, status: "pending", payment_status: "pending", total_amount: 103.3, currency: "USD",
  expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  stripe_checkout_session_id: SESSION_ID,
  metadata: { stripe_account_id: ACCOUNT_ID },
  ...extra,
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

function status(admin: SupabaseClient, stripe: ReturnType<typeof fakeStripeReader> | null) {
  return loadCompetitionRegistrationStatus({ admin, stripe: stripe ? (stripe.stripe as unknown as Stripe) : null, token: TOKEN, eventSlug: "spring-comp" });
}

describe("Path A / 5: the status page reads Stripe but never repairs", () => {
  it("a pending order whose Stripe session is complete shows 'processing' and performs no finalize, release or write (repeatably)", async () => {
    const world = { order: pendingOrder(), entries: [], checkpoint: null };
    const { admin, writes, rpcCalls } = fakeAdmin(world);
    const stripe = fakeStripeReader(paidLive({ session: { id: SESSION_ID, status: "complete" } }));
    expect((await status(admin, stripe))?.state).toBe("processing");
    expect((await status(admin, stripe))?.state).toBe("processing");
    expect(stripe.retrieve).toHaveBeenCalledWith(SESSION_ID, {}, { stripeAccount: ACCOUNT_ID });
    expect(rpcCalls).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("a Stripe read failure degrades to 'awaiting_payment' and still changes nothing", async () => {
    const { admin, writes, rpcCalls } = fakeAdmin({ order: pendingOrder(), entries: [], checkpoint: null });
    const stripe = fakeStripeReader(new Error("ECONNRESET"));
    expect((await status(admin, stripe))?.state).toBe("awaiting_payment");
    expect(rpcCalls).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("a confirmed and paid order is reported confirmed without consulting Stripe", async () => {
    const { admin, rpcCalls } = fakeAdmin({ order: pendingOrder({ status: "confirmed", payment_status: "paid" }), entries: [], checkpoint: null });
    const stripe = fakeStripeReader(paidLive());
    expect((await status(admin, stripe))?.state).toBe("confirmed");
    expect(stripe.retrieve).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
  });

  it("an unpaid return from Stripe (open session) is never displayed as confirmed", async () => {
    const { admin } = fakeAdmin({ order: pendingOrder(), entries: [], checkpoint: null });
    const stripe = fakeStripeReader(paidLive({ session: { id: SESSION_ID, status: "open", payment_status: "unpaid" } }));
    expect((await status(admin, stripe))?.state).toBe("awaiting_payment");
  });

  it("lazy release is limited to an expired hold with NO Stripe session; an expired hold that has a session is left for the webhook", async () => {
    const lapsed = new Date(Date.now() - 60_000).toISOString();
    const unbound = fakeAdmin({ order: pendingOrder({ expires_at: lapsed, stripe_checkout_session_id: null }), entries: [], checkpoint: null });
    expect((await status(unbound.admin, null))?.state).toBe("expired");
    expect(unbound.rpcCalls.map((c) => c.fn)).toEqual(["release_competition_registration"]);

    const bound = fakeAdmin({ order: pendingOrder({ expires_at: lapsed }), entries: [], checkpoint: null });
    expect((await status(bound.admin, fakeStripeReader(paidLive({ session: { status: "open", payment_status: "unpaid" } }))))?.state).toBe("expired");
    expect(bound.rpcCalls).toEqual([]);
  });
});

describe("Path A / 5: the event-cart sweeper does not repair competition orders", () => {
  it("with no payment-attempt rows (competition orders have none) it reads nothing from Stripe and settles nothing", async () => {
    const rpcCalls: string[] = [];
    const tables: string[] = [];
    const admin = {
      from: (table: string) => {
        tables.push(table);
        const self: Record<string, unknown> = {};
        self.select = () => self;
        self.eq = () => self;
        self.then = (resolve: (value: unknown) => void) => resolve({ data: [], error: null });
        return self;
      },
      rpc: async (fn: string) => { rpcCalls.push(fn); return { data: null, error: null }; },
    } as unknown as SupabaseClient;
    const retrieve = vi.fn();
    const stripe = { checkout: { sessions: { retrieve } }, paymentIntents: { retrieve } } as unknown as Stripe;
    expect(await reconcileProcessingEventCartOrder({ admin, stripe, orderId: ORDER_ID })).toEqual([]);
    expect(retrieve).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
    // The sweeper only reads payment-attempt rows. That competition orders have none is a database fact not proven here.
    expect(tables).toEqual(["event_order_payment_attempts"]);
  });

  it("source guard: across non-test source, only registrationLifecycle.ts (webhook finalize) and registrationCheckout.ts (free-order branch) call finalize_competition_registration", () => {
    const callPattern = /rpc\(\s*["'`]finalize_competition_registration/;
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
        if (callPattern.test(readFileSync(full, "utf8"))) callers.push(full.replaceAll("\\", "/").split("/src/")[1]);
      }
    };
    walk(join(process.cwd(), "src"));
    expect(callers.sort()).toEqual(["lib/competition/registrationCheckout.ts", "lib/competition/registrationLifecycle.ts"]);
    const checkoutSource = readFileSync(join(process.cwd(), "src/lib/competition/registrationCheckout.ts"), "utf8");
    const anchor = checkoutSource.indexOf('prepared.state === "free"');
    expect(anchor).toBeGreaterThanOrEqual(0);
    expect(checkoutSource.search(callPattern)).toBeGreaterThan(anchor);
  });
});

describe("Path A / 5: a missed webhook is repaired only by an event that re-reads Stripe, idempotently", () => {
  const paidSession = {
    id: SESSION_ID, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", livemode: false,
    amount_total: 10330, currency: "usd", payment_intent: "pi_1",
    metadata: { source: "competition_registration", order_id: ORDER_ID },
  } as unknown as Stripe.Checkout.Session;

  it("a resent event (new event id, same session) finalizes once from Stripe's record; further resends are forwarded as the database's already_finalized answer (database idempotency itself is proven by its SQL tests)", async () => {
    const db = new StatefulPaymentDb();
    const stripe = fakeStripeReader(paidLive({ session: { id: SESSION_ID, amount_total: 10330 }, intent: { id: "pi_1", amount_received: 10330 } })).stripe;
    const apply = () => applyCompetitionCheckoutEvent(db as unknown as SupabaseClient, { stripe, eventType: "checkout.session.completed", session: paidSession, stripeAccountId: ACCOUNT_ID });

    const first = await apply();
    const second = await apply();
    const third = await apply();
    expect([first.outcome, second.outcome, third.outcome]).toEqual(["finalized", "already_finalized", "already_finalized"]);
    expect(db.finalizedOrders.size).toBe(1);
    expect(first.paymentIntentId).toBe("pi_1");
  });

  it("a resent event while Stripe still shows the session unpaid is refused and repairs nothing", async () => {
    const db = new StatefulPaymentDb();
    const stripe = fakeStripeReader(paidLive({ session: { id: SESSION_ID, status: "open", payment_status: "unpaid" } })).stripe;
    await expect(applyCompetitionCheckoutEvent(db as unknown as SupabaseClient, { stripe, eventType: "checkout.session.completed", session: paidSession, stripeAccountId: ACCOUNT_ID })).rejects.toThrow(/refused/);
    expect(db.finalizedOrders.size).toBe(0);
    expect(db.count("finalize_competition_registration")).toBe(0);
  });
});
