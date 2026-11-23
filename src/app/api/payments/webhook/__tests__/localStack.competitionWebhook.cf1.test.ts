/**
 * CF1 database-backed settlement, layer 2: the REAL webhook route (POST) with real Stripe test signatures, the post-#745 settlement re-read,
 * and the REAL Postgres claim/finalize/release functions on the isolated local QA database (scripts/qa/cf1-db-settlement.mjs).
 * Faked: only Stripe's API reader (checkout.sessions.retrieve), the fee sync and the confirmation e-mail queue. Not faked: the database,
 * the claim lease, the SQL functions. Duplicate and concurrent deliveries run on real, separate database connections.
 * Skipped unless CF1_DBQA_CONTAINER names a df-cf1r1-* container. Hosted Stripe Checkout payment completion is NOT PROVEN by this file.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { fakeStripeReader } from "@/lib/competition/__tests__/helpers/settlementStripeFake";
import { eventBodyFor, liveFor } from "@/lib/competition/__tests__/helpers/dbSettlementFixtures";
import { callRpc, claimRow, createShimAdmin, dbQaEnabled, orderState, seedOrder, sql, type SeededOrder } from "@/lib/competition/__tests__/helpers/dockerPgAdmin";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const CONNECT_SECRET = "whsec_cf1r1_connect";
const PLATFORM_SECRET = "whsec_cf1r1_platform";
const realStripe = new Stripe("sk_test_cf1r1_not_a_real_key");
type HeaderOptions = Parameters<typeof realStripe.webhooks.generateTestHeaderString>[0];

const state = vi.hoisted(() => ({
  /** The signature header is per request: concurrent posts each carry their own, found through async context (a shared variable would be overwritten). */
  signatures: null as unknown as { getStore(): string | undefined; run<T>(value: string, fn: () => T): T },
  db: null as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<unknown>; from: (t: string) => unknown },
  retrieve: null as unknown as (...args: unknown[]) => Promise<unknown>,
  confirmations: [] as string[],
  feeSyncs: [] as string[],
}));

state.signatures = new AsyncLocalStorage<string>();

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => (name === "stripe-signature" ? state.signatures.getStore() ?? null : null) }),
}));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    webhooks: realStripe.webhooks,
    checkout: { sessions: { retrieve: (...args: unknown[]) => state.retrieve(...args) } },
  }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => state.db.rpc(fn, args),
    from: (table: string) => state.db.from(table),
  }),
}));
vi.mock("@/lib/payments/stripeFeeSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/payments/stripeFeeSync")>()),
  syncFeeDetailsForPaymentIntent: async (_s: unknown, _t: unknown, paymentIntentId: string) => { state.feeSyncs.push(paymentIntentId); },
}));
vi.mock("@/lib/events/settlementSideEffects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/events/settlementSideEffects")>()),
  safeQueuePaidEventCartOrderConfirmation: async (params: { orderId: string }) => { state.confirmations.push(params.orderId); },
}));

const { POST } = await import("@/app/api/payments/webhook/route");

const suite = dbQaEnabled ? describe : describe.skip;

let db: ReturnType<typeof createShimAdmin>;
let retrieve: ReturnType<typeof fakeStripeReader>["retrieve"];

function stripeReturns(live: Parameters<typeof fakeStripeReader>[0]) {
  const fake = fakeStripeReader(live);
  retrieve = fake.retrieve;
  state.retrieve = fake.retrieve as unknown as typeof state.retrieve;
}
const signed = (body: string) => realStripe.webhooks.generateTestHeaderString({ payload: body, secret: CONNECT_SECRET } as HeaderOptions);

/** Each call carries its own signature header, so different events can be in flight at once. */
async function post(body: string, header: string = signed(body)) {
  const response = await state.signatures.run(header, () => POST(new Request("https://example.test/api/payments/webhook", { method: "POST", body })));
  return { status: response.status, text: await response.text() };
}
const idOf = (body: string) => (JSON.parse(body) as { id: string }).id;

beforeEach(() => {
  db = createShimAdmin();
  state.db = db;
  state.confirmations.length = 0;
  state.feeSyncs.length = 0;
  process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-only";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

async function paidOrder(options: Parameters<typeof seedOrder>[0] = {}) {
  const order = await seedOrder(options);
  stripeReturns(liveFor(order));
  return order;
}

suite("CF1 webhook route on real Postgres: signature, claim, handler, finalize", () => {
  it("a genuine signed paid event claims, re-reads Stripe on the connected account, finalizes in the database and completes the claim", async () => {
    const order = await paidOrder();
    const body = eventBodyFor(order);
    expect(await post(body)).toEqual({ status: 200, text: "Webhook processed." });
    expect(db.calls.map((c) => c.fn)).toEqual(["claim_payment_provider_event", "finalize_competition_registration", "complete_payment_provider_event"]);
    expect(retrieve).toHaveBeenCalledWith(order.sessionId, { expand: ["payment_intent"] }, { stripeAccount: order.accountId });
    expect(await orderState(order.orderId)).toMatchObject({ status: "confirmed", payment_status: "paid", reg_status: "confirmed", payments: 1 });
    expect(await claimRow(idOf(body))).toMatchObject({ status: "processed", attempt_count: 1, claim_owner: null });
    expect(state.confirmations).toEqual([order.orderId]);
    expect(state.feeSyncs).toHaveLength(1);
  });

  it("a bad signature is rejected before any claim or database write", async () => {
    const order = await paidOrder();
    const body = eventBodyFor(order);
    expect((await post(body, "t=1,v1=deadbeef")).status).toBe(400);
    expect(db.calls).toEqual([]);
    expect(await claimRow(idOf(body))).toBeNull();
    expect((await orderState(order.orderId)).payments).toBe(0);
  });

  it("the same event delivered twice serially is acknowledged the second time: no Stripe read, no second finalize", async () => {
    const order = await paidOrder();
    const body = eventBodyFor(order);
    expect((await post(body)).status).toBe(200);
    retrieve.mockClear();
    expect(await post(body)).toEqual({ status: 200, text: "Already processed" });
    expect(retrieve).not.toHaveBeenCalled();
    expect(db.count("finalize_competition_registration")).toBe(1);
    expect((await orderState(order.orderId)).payments).toBe(1);
    expect(state.confirmations).toHaveLength(1);
    expect(await claimRow(idOf(body))).toMatchObject({ status: "processed", attempt_count: 1 });
  });

  it("eight simultaneous deliveries of the same event (real concurrent connections): one worker finalizes, the order is paid exactly once", async () => {
    const order = await paidOrder();
    const body = eventBodyFor(order);
    const header = signed(body);
    const results = await Promise.all(Array.from({ length: 8 }, () => post(body, header)));
    expect(results.filter((r) => r.text === "Webhook processed.")).toHaveLength(1);
    for (const r of results) {
      if (r.text !== "Webhook processed.") expect(["409:Webhook event is being processed.", "200:Already processed"]).toContain(`${r.status}:${r.text}`);
    }
    expect(db.count("finalize_competition_registration")).toBe(1);
    expect(await orderState(order.orderId)).toMatchObject({ status: "confirmed", payment_status: "paid", payments: 1 });
    expect(await claimRow(idOf(body))).toMatchObject({ status: "processed", attempt_count: 1 });
    expect(state.confirmations).toEqual([order.orderId]);
  });

  it("two DIFFERENT events for the same paid session (completed + async_payment_succeeded) delivered concurrently finalize once", async () => {
    const order = await paidOrder();
    const a = eventBodyFor(order);
    const b = eventBodyFor(order, { type: "checkout.session.async_payment_succeeded" });
    const results = await Promise.all([post(a), post(b)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await orderState(order.orderId)).toMatchObject({ status: "confirmed", payment_status: "paid", payments: 1 });
    expect(state.confirmations).toEqual([order.orderId]);
    expect((await claimRow(idOf(a)))?.status).toBe("processed");
    expect((await claimRow(idOf(b)))?.status).toBe("processed");
  });

  it("retry after a failed delivery reclaims the lease and finalizes exactly once (Stripe read fails first, then recovers)", async () => {
    const order = await seedOrder();
    const body = eventBodyFor(order);
    stripeReturns(Object.assign(new Error("stripe unreachable"), { code: "api_connection_error" }));
    expect((await post(body)).status).toBe(500);
    expect(await claimRow(idOf(body))).toMatchObject({ status: "failed", attempt_count: 1, claim_owner: null });
    expect((await claimRow(idOf(body)))?.error).toMatch(/stripe unreachable/);
    expect(await orderState(order.orderId)).toMatchObject({ status: "pending", payment_status: "pending", payments: 0 });
    expect(state.confirmations).toEqual([]);

    stripeReturns(liveFor(order));
    expect(await post(body)).toEqual({ status: 200, text: "Webhook processed." });
    expect(await claimRow(idOf(body))).toMatchObject({ status: "processed", attempt_count: 2 });
    expect(await orderState(order.orderId)).toMatchObject({ status: "confirmed", payment_status: "paid", payments: 1 });
    expect(await post(body)).toEqual({ status: 200, text: "Already processed" });
    expect((await orderState(order.orderId)).payments).toBe(1);
    expect(state.confirmations).toEqual([order.orderId]);
  });

  it("a database refusal (Stripe and event agree on a price the order does not carry) fails the delivery, leaves the order pending and records the refusal; a retry fails the same way", async () => {
    const order = await seedOrder();
    const body = eventBodyFor(order, { session: { amount_total: order.totalCents + 100 } });
    stripeReturns(liveFor(order, { session: { amount_total: order.totalCents + 100 }, intent: { amount_received: order.totalCents + 100 } }));
    expect((await post(body)).status).toBe(500);
    expect(await claimRow(idOf(body))).toMatchObject({ status: "failed", attempt_count: 1 });
    expect((await claimRow(idOf(body)))?.error).toMatch(/COMP10C_AMOUNT_MISMATCH/);
    expect((await post(body)).status).toBe(500);
    expect(await claimRow(idOf(body))).toMatchObject({ status: "failed", attempt_count: 2 });
    expect(await orderState(order.orderId)).toMatchObject({ status: "pending", payment_status: "pending", payments: 0 });
    expect(state.confirmations).toEqual([]);
  });

  it("a currency the order does not carry (event and Stripe agree on EUR for a USD order) is refused by the DATABASE; the order stays pending", async () => {
    const order = await seedOrder();
    const body = eventBodyFor(order, { session: { currency: "eur" } });
    stripeReturns(liveFor(order, { session: { currency: "eur" }, intent: { currency: "eur" } }));
    expect((await post(body)).status).toBe(500);
    expect((await claimRow(idOf(body)))?.error).toMatch(/COMP10C_AMOUNT_MISMATCH/);
    expect(db.calls.find((c) => c.fn === "finalize_competition_registration")?.args).toMatchObject({ p_currency: "EUR" });
    expect(await orderState(order.orderId)).toMatchObject({ status: "pending", payment_status: "pending", payments: 0 });
  });

  it("a live claim held by another worker answers 409 without touching Stripe or the order; an EXPIRED lease is reclaimed and the old owner can no longer complete it", async () => {
    const order = await paidOrder();
    const body = eventBodyFor(order);
    const other = "00000000-0000-4000-8000-0000000000aa";
    const held = await callRpc("claim_payment_provider_event", { p_provider: "stripe", p_provider_event_id: idOf(body), p_event_type: "checkout.session.completed", p_payload_hash: "h", p_owner: other, p_lease_seconds: 600 });
    expect((held.data as { outcome: string }).outcome).toBe("claimed");
    db.calls.length = 0;
    expect(await post(body)).toEqual({ status: 409, text: "Webhook event is being processed." });
    expect(retrieve).not.toHaveBeenCalled();
    expect(db.calls.map((c) => c.fn)).toEqual(["claim_payment_provider_event"]);
    expect((await orderState(order.orderId)).payments).toBe(0);

    await sql(`update public.payment_provider_events set claim_expires_at = now() - interval '1 minute' where provider = 'stripe' and provider_event_id = '${idOf(body)}'`);
    expect(await post(body)).toEqual({ status: 200, text: "Webhook processed." });
    expect(await claimRow(idOf(body))).toMatchObject({ status: "processed", attempt_count: 2 });
    expect((await orderState(order.orderId)).payments).toBe(1);
    const stale = await callRpc("complete_payment_provider_event", { p_provider: "stripe", p_provider_event_id: idOf(body), p_owner: other, p_status: "processed", p_outcome: null, p_error: null });
    expect(stale.data).toBe(false);
  });
});

suite("CF1 webhook route on real Postgres: events that must not (or must only) settle", () => {
  it("a validly signed 'paid' event for an order Stripe shows UNPAID never reaches finalize; the order stays pending", async () => {
    const order = await seedOrder();
    stripeReturns(liveFor(order, { session: { payment_status: "unpaid", status: "open" } }));
    const body = eventBodyFor(order);
    expect((await post(body)).status).toBe(500);
    expect(db.count("finalize_competition_registration")).toBe(0);
    expect(await orderState(order.orderId)).toMatchObject({ status: "pending", payment_status: "pending", payments: 0 });
    expect((await claimRow(idOf(body)))?.error).toMatch(/Competition settlement refused/);
  });

  it("a signed event naming order B with order A's session is refused (Stripe says the session belongs to A); neither order settles", async () => {
    const a = await seedOrder();
    const b = await seedOrder();
    stripeReturns(liveFor(a));
    const body = eventBodyFor(a, { session: { metadata: { source: "competition_registration", order_id: b.orderId } } });
    expect((await post(body)).status).toBe(500);
    expect(db.count("finalize_competition_registration")).toBe(0);
    expect((await orderState(a.orderId)).payments).toBe(0);
    expect((await orderState(b.orderId)).payments).toBe(0);
  });

  it("an event whose account differs from the order's bound account is refused by the DATABASE even if Stripe agrees with the event", async () => {
    const order = await seedOrder();
    const body = eventBodyFor(order, { account: "acct_attackerOwned" });
    stripeReturns(liveFor(order));
    expect((await post(body)).status).toBe(500);
    expect((await claimRow(idOf(body)))?.error).toMatch(/COMP10C_BINDING_MISMATCH/);
    expect(await orderState(order.orderId)).toMatchObject({ status: "pending", payments: 0 });
  });

  it("an event for a session the order is not bound to is refused by the DATABASE even if Stripe agrees", async () => {
    const order = await seedOrder();
    const other = { ...order, sessionId: "cs_test_not_bound" } as SeededOrder;
    const metadata = { source: "competition_registration", order_id: order.orderId };
    stripeReturns(liveFor(other, { session: { metadata } }));
    const body = eventBodyFor(other, { session: { metadata } });
    expect((await post(body)).status).toBe(500);
    expect((await claimRow(idOf(body)))?.error).toMatch(/COMP10C_BINDING_MISMATCH/);
    expect(await orderState(order.orderId)).toMatchObject({ status: "pending", payments: 0 });
  });

  it("an 'expired' event releases a pending order; a later paid event for it is recorded as a late payment for review and does not reactivate it", async () => {
    const order = await seedOrder();
    stripeReturns(liveFor(order));
    expect((await post(eventBodyFor(order, { type: "checkout.session.expired", session: { status: "expired", payment_status: "unpaid" } }))).status).toBe(200);
    expect(await orderState(order.orderId)).toMatchObject({ status: "expired", payment_status: "unpaid", reg_status: "cancelled", payments: 0 });
    expect(state.confirmations).toEqual([]);
    expect((await post(eventBodyFor(order))).status).toBe(200);
    const s = await orderState(order.orderId);
    expect(s).toMatchObject({ status: "expired", payment_status: "paid", payments: 1 });
    expect(s.metadata.needs_review).toBe("late_payment_after_release");
    expect(state.confirmations).toEqual([]);
    expect(state.feeSyncs).toHaveLength(1);
  });

  it("an 'expired' or async-failed event can never release an order that is already paid", async () => {
    const order = await paidOrder();
    expect((await post(eventBodyFor(order))).status).toBe(200);
    for (const type of ["checkout.session.expired", "checkout.session.async_payment_failed"]) {
      expect((await post(eventBodyFor(order, { type, session: { status: "expired", payment_status: "unpaid" } }))).status).toBe(200);
    }
    expect(await orderState(order.orderId)).toMatchObject({ status: "confirmed", payment_status: "paid", reg_status: "confirmed", payments: 1 });
  });

  it("an event that does not claim payment moves no money: acknowledged, no Stripe read, order pending", async () => {
    const order = await seedOrder();
    stripeReturns(liveFor(order));
    const body = eventBodyFor(order, { session: { payment_status: "unpaid", status: "open" } });
    expect(await post(body)).toEqual({ status: 200, text: "Webhook processed." });
    expect(retrieve).not.toHaveBeenCalled();
    expect(await orderState(order.orderId)).toMatchObject({ status: "pending", payments: 0 });
  });
});
