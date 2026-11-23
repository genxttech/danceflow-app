import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { fakeStripeReader, paidLive } from "@/lib/competition/__tests__/helpers/settlementStripeFake";
import { ACCOUNT_ID, ORDER_ID, SESSION_ID, StatefulPaymentDb, checkoutEventBody, stripeError } from "./helpers/pathAHarness";

/**
 * CF1 Path A, criteria 2-4 (offline), driven through the REAL route POST with real Stripe test signatures:
 *   2. duplicate deliveries (serial and concurrent) fulfil once; a failed delivery is reclaimed and completes exactly once;
 *   3. expired / async-failed / unpaid events never finalize, and competition orders release rather than finalize;
 *   4. a validly signed "paid" event that disagrees with Stripe's own record never reaches finalize_competition_registration.
 * Stripe's API is a fake reader and the database is StatefulPaymentDb (no network, no SQL). A synthetic or replayed event never
 * authorizes fulfilment here: finalization needs the signature AND Stripe's re-read record to agree.
 * Hosted Stripe Checkout end-to-end payment completion is NOT PROVEN by this file.
 */

const CONNECT_SECRET = "whsec_cf1patha_delivery_connect";
const PLATFORM_SECRET = "whsec_cf1patha_delivery_platform";
const realStripe = new Stripe("sk_test_cf1patha_delivery_not_a_real_key");
type HeaderOptions = Parameters<typeof realStripe.webhooks.generateTestHeaderString>[0];

const state = vi.hoisted(() => ({
  signature: null as string | null,
  db: null as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<unknown> },
  retrieve: null as unknown as (...args: unknown[]) => Promise<unknown>,
  confirmations: [] as string[],
  feeSyncs: [] as string[],
  tableReads: [] as string[],
}));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => (name === "stripe-signature" ? state.signature : null) }),
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
    from: (table: string) => { state.tableReads.push(table); throw new Error(`unexpected direct table access: ${table}`); },
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

let db: StatefulPaymentDb;
let retrieve: ReturnType<typeof fakeStripeReader>["retrieve"];

function genuineLive(overrides: Parameters<typeof paidLive>[0] = {}) {
  return paidLive({ session: { id: SESSION_ID, amount_total: 10330, ...overrides.session }, intent: { id: "pi_1", amount_received: 10330, ...overrides.intent } });
}

function useStripe(live: Parameters<typeof fakeStripeReader>[0]) {
  const fake = fakeStripeReader(live);
  retrieve = fake.retrieve;
  state.retrieve = fake.retrieve as unknown as typeof state.retrieve;
}

function signed(body: string) {
  return realStripe.webhooks.generateTestHeaderString({ payload: body, secret: CONNECT_SECRET } as HeaderOptions);
}

/** Pass a pre-built header for concurrent posts: the header mock is process-wide, so every concurrent post must carry the same valid signature. */
async function post(body: string, header: string = signed(body)) {
  state.signature = header;
  const response = await POST(new Request("https://example.test/api/payments/webhook", { method: "POST", body }));
  return { status: response.status, text: await response.text() };
}

const completed = (id = "evt_pathA_paid", session: Record<string, unknown> = {}) => checkoutEventBody(session, { id });
const finalizeCalls = () => db.count("finalize_competition_registration");

beforeEach(() => {
  db = new StatefulPaymentDb();
  state.db = db;
  state.confirmations.length = 0;
  state.feeSyncs.length = 0;
  state.tableReads.length = 0;
  useStripe(genuineLive());
  process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-only";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("Path A / 2: duplicate delivery fulfils exactly once", () => {
  it("a genuine paid delivery claims, re-reads Stripe on the connected account, finalizes from Stripe's values and completes the claim", async () => {
    expect((await post(completed())).status).toBe(200);
    expect(db.calls.map((c) => c.fn)).toEqual(["claim_payment_provider_event", "finalize_competition_registration", "complete_payment_provider_event"]);
    expect(retrieve).toHaveBeenCalledWith(SESSION_ID, { expand: ["payment_intent"] }, { stripeAccount: ACCOUNT_ID });
    expect(db.calls[1].args).toMatchObject({ p_order_id: ORDER_ID, p_stripe_account_id: ACCOUNT_ID, p_checkout_session_id: SESSION_ID, p_payment_intent_id: "pi_1", p_amount_cents: 10330, p_currency: "USD" });
    expect(db.calls[2].args).toMatchObject({ p_provider_event_id: "evt_pathA_paid", p_status: "processed" });
    expect(db.claims.get("evt_pathA_paid")?.status).toBe("processed");
    expect(state.confirmations).toEqual([ORDER_ID]);
    expect(state.tableReads).toEqual([]);
  });

  it("the same event id delivered twice serially is acknowledged the second time with no Stripe read and no second finalize", async () => {
    expect((await post(completed())).status).toBe(200);
    retrieve.mockClear();
    expect(await post(completed())).toEqual({ status: 200, text: "Already processed" });
    expect(finalizeCalls()).toBe(1);
    expect(retrieve).not.toHaveBeenCalled();
    expect(state.confirmations).toHaveLength(1);
    expect(db.count("claim_payment_provider_event")).toBe(2);
  });

  it("two concurrent deliveries of the same event id: one fulfils, the other is told to retry (409), and a later retry is acknowledged", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const live = genuineLive();
    state.retrieve = (async () => { await gate; return live; }) as unknown as typeof state.retrieve;

    let first: Promise<{ status: number; text: string }> | null = null;
    try {
      first = post(completed());
      for (let i = 0; i < 50 && db.count("claim_payment_provider_event") < 1; i += 1) await new Promise((r) => setTimeout(r, 1));
      expect(db.count("claim_payment_provider_event")).toBe(1);

      const second = await post(completed());
      expect(second.status).toBe(409);
      expect(finalizeCalls()).toBe(0);
    } finally {
      release();
    }
    expect((await first)?.status).toBe(200);
    expect(finalizeCalls()).toBe(1);
    expect(await post(completed())).toEqual({ status: 200, text: "Already processed" });
    expect(finalizeCalls()).toBe(1);
    expect(state.confirmations).toEqual([ORDER_ID]);
  }, 15_000);

  it("a burst of four simultaneous deliveries of one event: exactly one fulfils, three are told to retry, one confirmation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const live = genuineLive();
    state.retrieve = (async () => { await gate; return live; }) as unknown as typeof state.retrieve;
    const body = completed();
    const header = signed(body);
    try {
      const posts = [post(body, header), post(body, header), post(body, header), post(body, header)];
      for (let i = 0; i < 100 && db.count("claim_payment_provider_event") < 4; i += 1) await new Promise((r) => setTimeout(r, 1));
      expect(db.count("claim_payment_provider_event")).toBe(4);
      release();
      const statuses = (await Promise.all(posts)).map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409, 409, 409]);
    } finally {
      release();
    }
    expect(finalizeCalls()).toBe(1);
    expect(state.confirmations).toEqual([ORDER_ID]);
  }, 15_000);

  it("a handler failure leaves the claim failed (retryable); the redelivery reclaims it and completes exactly once", async () => {
    state.retrieve = (async () => { throw stripeError("api_connection_error"); }) as unknown as typeof state.retrieve;
    expect((await post(completed())).status).toBe(500);
    expect(finalizeCalls()).toBe(0);
    expect(db.claims.get("evt_pathA_paid")).toMatchObject({ status: "failed", attempts: 1 });

    useStripe(genuineLive());
    expect((await post(completed())).status).toBe(200);
    expect(db.claims.get("evt_pathA_paid")).toMatchObject({ status: "processed", attempts: 2 });
    expect(finalizeCalls()).toBe(1);

    expect(await post(completed())).toEqual({ status: 200, text: "Already processed" });
    expect(finalizeCalls()).toBe(1);
    expect(state.confirmations).toHaveLength(1);
  });

  it("a transient database failure at finalize fails the claim without confirming; the retry succeeds once", async () => {
    db.failNext.finalize_competition_registration = "deadlock detected";
    expect((await post(completed())).status).toBe(500);
    expect(db.claims.get("evt_pathA_paid")).toMatchObject({ status: "failed", lastError: "deadlock detected" });
    expect(state.confirmations).toEqual([]);

    expect((await post(completed())).status).toBe(200);
    expect(db.finalizedOrders.size).toBe(1);
    expect(state.confirmations).toEqual([ORDER_ID]);
  });

  it("finalizes from Stripe's record, not the event's: an event with no PaymentIntent and a mixed-case currency still finalizes with Stripe's PaymentIntent id, amount and USD", async () => {
    expect((await post(completed("evt_sparse", { payment_intent: null, currency: "UsD" }))).status).toBe(200);
    expect(db.calls.find((c) => c.fn === "finalize_competition_registration")?.args).toMatchObject({ p_payment_intent_id: "pi_1", p_amount_cents: 10330, p_currency: "USD" });
  });

  it("lost lease: if the claim is taken over while the handler runs, the delivery reports failure (500) and never reports success; after the lease lapses the redelivery completes without a second confirmation", async () => {
    const live = genuineLive();
    state.retrieve = (async () => {
      const row = db.claims.get("evt_pathA_paid");
      if (row) row.owner = "another-worker";
      return live;
    }) as unknown as typeof state.retrieve;
    expect((await post(completed())).status).toBe(500);
    expect(state.confirmations).toEqual([ORDER_ID]);
    const row = db.claims.get("evt_pathA_paid");
    if (row) row.leaseExpiresAt = 0;
    useStripe(genuineLive());
    expect((await post(completed())).status).toBe(200);
    expect(db.finalizedOrders.size).toBe(1);
    expect(state.confirmations).toEqual([ORDER_ID]);
  });

  it("the route forwards a different event id for an already-finalized session (async_payment_succeeded after completed) as already_finalized without confirming again; the database's own idempotency is proven by its SQL tests", async () => {
    expect((await post(completed("evt_pathA_a"))).status).toBe(200);
    const second = checkoutEventBody({}, { id: "evt_pathA_b", type: "checkout.session.async_payment_succeeded" });
    expect((await post(second)).status).toBe(200);
    expect(finalizeCalls()).toBe(2);
    expect(db.finalizedOrders.size).toBe(1);
    expect(state.confirmations).toEqual([ORDER_ID]);
    expect(state.feeSyncs).toEqual(["pi_1"]);
  });
});

describe("Path A / 3: expired, failed and unpaid paths never finalize", () => {
  it("checkout.session.expired releases the order, performs no Stripe read and never finalizes", async () => {
    const body = checkoutEventBody({ status: "expired", payment_status: "unpaid" }, { id: "evt_exp", type: "checkout.session.expired" });
    expect((await post(body)).status).toBe(200);
    expect(db.calls.find((c) => c.fn === "release_competition_registration")?.args).toMatchObject({ p_order_id: ORDER_ID, p_reason: "expired", p_checkout_session_id: SESSION_ID, p_stripe_account_id: ACCOUNT_ID });
    expect(finalizeCalls()).toBe(0);
    expect(retrieve).not.toHaveBeenCalled();
    expect(db.claims.get("evt_exp")?.status).toBe("processed");
    expect(state.confirmations).toEqual([]);
  });

  it("checkout.session.async_payment_failed releases with reason failed and never finalizes", async () => {
    const body = checkoutEventBody({ payment_status: "unpaid" }, { id: "evt_fail", type: "checkout.session.async_payment_failed" });
    expect((await post(body)).status).toBe(200);
    expect(db.calls.find((c) => c.fn === "release_competition_registration")?.args).toMatchObject({ p_order_id: ORDER_ID, p_reason: "failed" });
    expect(finalizeCalls()).toBe(0);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("checkout.session.completed with payment_status unpaid (delayed method) neither finalizes nor releases, and is acknowledged", async () => {
    expect((await post(completed("evt_unpaid", { payment_status: "unpaid" }))).status).toBe(200);
    expect(finalizeCalls()).toBe(0);
    expect(db.count("release_competition_registration")).toBe(0);
    expect(retrieve).not.toHaveBeenCalled();
    expect(state.confirmations).toEqual([]);
  });

  it("an unpaid completed event followed by the genuine async_payment_succeeded finalizes exactly once, on the second", async () => {
    expect((await post(completed("evt_unpaid", { payment_status: "unpaid" }))).status).toBe(200);
    expect(finalizeCalls()).toBe(0);
    const succeeded = checkoutEventBody({}, { id: "evt_async_ok", type: "checkout.session.async_payment_succeeded" });
    expect((await post(succeeded)).status).toBe(200);
    expect(finalizeCalls()).toBe(1);
  });

  it("an expired event whose payload falsely claims payment_status paid only releases (finalize is unreachable from release events)", async () => {
    const body = checkoutEventBody({ payment_status: "paid" }, { id: "evt_exp_paid", type: "checkout.session.expired" });
    expect((await post(body)).status).toBe(200);
    expect(finalizeCalls()).toBe(0);
    expect(db.count("release_competition_registration")).toBe(1);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("a duplicate expired delivery releases once (the second delivery is acknowledged without touching the lifecycle)", async () => {
    const body = checkoutEventBody({ status: "expired", payment_status: "unpaid" }, { id: "evt_exp2", type: "checkout.session.expired" });
    await post(body);
    await post(body);
    expect(db.count("release_competition_registration")).toBe(1);
  });

  it("late payment after release: a paid event for an order that was already released is recorded for review, never confirmed", async () => {
    await post(checkoutEventBody({ status: "expired", payment_status: "unpaid" }, { id: "evt_exp_first", type: "checkout.session.expired" }));
    expect((await post(completed("evt_late_paid"))).status).toBe(200);
    expect(db.latePaidOrders.has(ORDER_ID)).toBe(true);
    expect(db.finalizedOrders.size).toBe(0);
    expect(state.confirmations).toEqual([]);
    expect(state.feeSyncs).toEqual(["pi_1"]);
  });

  it("an expiry arriving after payment: the route forwards the database's already_paid answer, confirms nothing and releases nothing (the database refusal itself is proven by its SQL tests)", async () => {
    await post(completed("evt_paid_first"));
    const body = checkoutEventBody({ status: "expired", payment_status: "unpaid" }, { id: "evt_late_exp", type: "checkout.session.expired" });
    expect((await post(body)).status).toBe(200);
    expect(db.finalizedOrders.has(ORDER_ID)).toBe(true);
    expect(db.releasedOrders.has(ORDER_ID)).toBe(false);
    expect(finalizeCalls()).toBe(1);
  });
});

describe("Path A / 4: a validly signed event that disagrees with Stripe's record never reaches finalize", () => {
  const forged = (label: string, reason: RegExp, live: Parameters<typeof fakeStripeReader>[0], session: Record<string, unknown> = {}) =>
    it(`refuses (${reason.source}) and leaves the claim retryable when ${label}`, async () => {
      useStripe(live);
      expect((await post(completed("evt_forged", session))).status).toBe(500);
      expect(finalizeCalls()).toBe(0);
      expect(db.finalizedOrders.size).toBe(0);
      expect(db.claims.get("evt_forged")).toMatchObject({ status: "failed" });
      expect(db.claims.get("evt_forged")?.lastError).toMatch(reason);
      expect(state.confirmations).toEqual([]);
      expect(state.feeSyncs).toEqual([]);
    });

  const refused = (why: string) => new RegExp(`Competition settlement refused: ${why}`);
  forged("Stripe says the session is still open and unpaid", refused("Stripe does not show the session as complete and paid"), genuineLive({ session: { status: "open", payment_status: "unpaid" } }));
  forged("Stripe says the session expired", refused("Stripe does not show the session as complete and paid"), genuineLive({ session: { status: "expired", payment_status: "unpaid" } }));
  forged("Stripe says paid but the PaymentIntent has not succeeded", refused("PaymentIntent has not succeeded"), genuineLive({ intent: { status: "requires_payment_method" } }));
  forged("the PaymentIntent received less than the session total", refused("PaymentIntent amount received does not match"), genuineLive({ intent: { amount_received: 100 } }));
  forged("the event inflates the amount versus Stripe", refused("amount or currency mismatch"), genuineLive(), { amount_total: 99999 });
  forged("the event swaps the currency versus Stripe", refused("amount or currency mismatch"), genuineLive(), { currency: "eur" });
  forged("the event names a different PaymentIntent than Stripe's", refused("PaymentIntent id mismatch"), genuineLive(), { payment_intent: "pi_attacker" });
  forged("Stripe's session is bound to a different order", refused("order binding mismatch"), genuineLive({ session: { metadata: { source: "competition_registration", order_id: "99999999-2222-4333-8444-555555555555" } } }));
  forged("Stripe's session is not a competition registration", refused("order binding mismatch"), genuineLive({ session: { metadata: { source: "event_cart_order", order_id: ORDER_ID } } }));
  // The fake reader ignores the requested id; real Stripe never answers with a different session, so this exercises the defensive check only.
  forged("Stripe's session id differs from the event's", refused("session id mismatch"), genuineLive({ session: { id: "cs_other" } }));
  forged("Stripe's session is not payment mode", refused("session is not a payment-mode session"), genuineLive({ session: { mode: "subscription" } }));
  forged("Stripe's record is live-mode but the event says test mode", refused("livemode mismatch"), genuineLive({ session: { livemode: true } }));
  forged("Stripe has no such session on the claimed account (resource_missing)", /resource_missing/, stripeError("resource_missing"));
  forged("Stripe cannot be reached", /ECONNRESET/, new Error("ECONNRESET"));

  it("a validly signed paid session that exists on ANOTHER connected account, claiming this studio's order, passes the Stripe re-read but is refused by the database binding (nothing finalizes)", async () => {
    useStripe(genuineLive());
    const body = checkoutEventBody({}, { id: "evt_cross_acct", account: "acct_attacker" });
    expect((await post(body)).status).toBe(500);
    expect(db.calls.find((c) => c.fn === "finalize_competition_registration")?.args).toMatchObject({ p_stripe_account_id: "acct_attacker" });
    expect(db.finalizedOrders.size).toBe(0);
    expect(db.claims.get("evt_cross_acct")?.lastError).toBe("COMP10C_BINDING_MISMATCH");
    expect(state.confirmations).toEqual([]);
  });

  it("a forged event attributing the session to another connected account asks Stripe on THAT account (resource_missing) and finalizes nothing", async () => {
    const asked: string[] = [];
    state.retrieve = (async (_id: string, _p: unknown, options: { stripeAccount: string }) => {
      asked.push(options.stripeAccount);
      throw stripeError("resource_missing");
    }) as unknown as typeof state.retrieve;
    const body = checkoutEventBody({}, { id: "evt_other_acct", account: "acct_attacker" });
    expect((await post(body)).status).toBe(500);
    expect(asked).toEqual(["acct_attacker"]);
    expect(finalizeCalls()).toBe(0);
  });

  it("a refused event that is redelivered after Stripe's own record shows payment finalizes exactly once (the retry re-reads; it is not replay authority)", async () => {
    useStripe(genuineLive({ session: { status: "open", payment_status: "unpaid" } }));
    expect((await post(completed("evt_forged"))).status).toBe(500);
    useStripe(genuineLive());
    expect((await post(completed("evt_forged"))).status).toBe(200);
    expect(finalizeCalls()).toBe(1);
  });

  it("an event whose order_id metadata is not a uuid is refused before any Stripe read", async () => {
    expect((await post(completed("evt_bad_meta", { metadata: { source: "competition_registration", order_id: "not-a-uuid" } }))).status).toBe(500);
    expect(retrieve).not.toHaveBeenCalled();
    expect(finalizeCalls()).toBe(0);
  });
});
