/**
 * CF1 database-backed settlement, layer 3: the merged DARK missed-webhook repair (settlementRepair.ts + the cron route) against REAL rows in the
 * isolated local QA Postgres (scripts/qa/cf1-db-settlement.mjs), with Stripe's reader faked. Proves: only pending, bound-session competition
 * orders inside the age window are read; the repair finalizes through the existing path and nothing else; it never releases, expires or
 * cancels; and a webhook racing the repair settles each order exactly once (real concurrent connections).
 * Skipped unless CF1_DBQA_CONTAINER names a df-cf1r1-* container. Hosted Stripe Checkout payment completion is NOT PROVEN by this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { eventBodyFor, liveFor } from "./helpers/dbSettlementFixtures";
import { createShimAdmin, dbQaEnabled, orderState, rows, seedOrder, sql, type SeededOrder } from "./helpers/dockerPgAdmin";
import { listRepairCandidates, runCompetitionSettlementRepair, settlementRepairEnabled } from "@/lib/competition/settlementRepair";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

const CONNECT_SECRET = "whsec_cf1r1_repair_connect";
const realStripe = new Stripe("sk_test_cf1r1_repair_not_a_real_key");
type HeaderOptions = Parameters<typeof realStripe.webhooks.generateTestHeaderString>[0];

const state = vi.hoisted(() => ({
  signature: null as string | null,
  db: null as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<unknown>; from: (t: string) => unknown },
  /** session id -> what Stripe returns (or throws) for it */
  live: new Map<string, unknown>(),
  retrieved: [] as string[],
  confirmations: [] as string[],
  feeSyncs: [] as string[],
}));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => (name === "stripe-signature" ? state.signature : null) }),
}));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    webhooks: realStripe.webhooks,
    checkout: {
      sessions: {
        retrieve: async (id: string) => {
          state.retrieved.push(id);
          const live = state.live.get(id);
          if (live instanceof Error) throw live;
          if (!live) throw Object.assign(new Error("No such checkout.session"), { code: "resource_missing" });
          return live;
        },
      },
    },
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

const { POST: webhookPost } = await import("@/app/api/payments/webhook/route");
const cron = await import("@/app/api/cron/competition-settlement-repair/route");

const suite = dbQaEnabled ? describe : describe.skip;

let db: ReturnType<typeof createShimAdmin>;

const signed = (body: string) => realStripe.webhooks.generateTestHeaderString({ payload: body, secret: CONNECT_SECRET } as HeaderOptions);
async function webhook(body: string) {
  state.signature = signed(body);
  const response = await webhookPost(new Request("https://example.test/api/payments/webhook", { method: "POST", body }));
  return { status: response.status, text: await response.text() };
}
const cronRequest = (secret: string | null) => new Request("https://example.test/api/cron/competition-settlement-repair", { method: "POST", headers: secret ? { authorization: `Bearer ${secret}` } : {} });

function stripeShows(order: SeededOrder, live?: unknown) {
  state.live.set(order.sessionId as string, live ?? liveFor(order));
}

/** All orders that exist in the QA database, by id, for "nothing else changed" assertions. */
async function snapshot() {
  return rows<{ id: string; status: string; payment_status: string; updated_at: string; payments: number }>(
    `select o.id, o.status, o.payment_status, o.updated_at,
            (select count(*)::int from public.event_payments p join public.event_registrations r on r.id = p.registration_id where r.order_id = o.id) as payments
     from public.event_orders o order by o.id`);
}

/** Push every earlier order out of the repair age window so a small batch always sees this test's own rows (the candidate query samples the oldest/newest of a bounded pool). */
async function quarantineLeftovers() {
  await sql("set session_replication_role = replica; update public.event_orders set updated_at = now() - interval '40 days' where updated_at > now() - interval '39 days';");
}

beforeEach(async () => {
  if (dbQaEnabled) await quarantineLeftovers();
  db = createShimAdmin();
  state.db = db;
  state.live.clear();
  state.retrieved.length = 0;
  state.confirmations.length = 0;
  state.feeSyncs.length = 0;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_cf1r1_repair_platform";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-only";
  delete process.env.COMPETITION_SETTLEMENT_REPAIR;
  delete process.env.CRON_SECRET;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

suite("CF1 settlement repair on real Postgres: candidate selection", () => {
  it("lists exactly the pending, unpaid, bound-session competition orders inside the age window", async () => {
    const eligible = await seedOrder({ ageMinutes: 60 });
    const eligibleOld = await seedOrder({ ageMinutes: 60 * 24 * 10 });
    const tooFresh = await seedOrder({ ageMinutes: 2 });
    const tooOld = await seedOrder({ ageMinutes: 60 * 24 * 15 });
    const unbound = await seedOrder({ sessionId: null });
    const confirmed = await seedOrder({ status: "confirmed", paymentStatus: "paid" });
    const cancelled = await seedOrder({ status: "cancelled", paymentStatus: "unpaid" });
    const expired = await seedOrder({ status: "expired", paymentStatus: "unpaid" });
    const paidPending = await seedOrder({ paymentStatus: "paid" });
    const ordinary = await seedOrder({ source: null });
    const found = await listRepairCandidates(db as never, { batchSize: 50, minAgeMinutes: 15, now: Date.now(), random: () => 0 });
    const ids = new Set(found.map((c) => c.id));
    expect(ids.has(eligible.orderId)).toBe(true);
    expect(ids.has(eligibleOld.orderId)).toBe(true);
    for (const excluded of [tooFresh, tooOld, unbound, confirmed, cancelled, expired, paidPending, ordinary]) {
      expect(ids.has(excluded.orderId), `excluded ${excluded.orderId}`).toBe(false);
    }
    // everything listed is pending/pending competition with a session (including other tests' leftovers)
    const listed = await rows<{ id: string; status: string; payment_status: string; src: string; session: string | null }>(
      `select id, status, payment_status, metadata->>'source' as src, stripe_checkout_session_id as session from public.event_orders where id in (${found.map((c) => `'${c.id}'`).join(",") || "null"})`);
    for (const row of listed) expect(row).toMatchObject({ status: "pending", payment_status: "pending", src: "competition_registration" });
    for (const row of listed) expect(row.session).not.toBeNull();
  });
});

suite("CF1 settlement repair on real Postgres: repair outcomes", () => {
  it("a pending order Stripe shows paid is finalized through the existing path, once; a second run finds nothing to do; ineligible orders are untouched", async () => {
    const target = await seedOrder();
    stripeShows(target);
    const untouchedOrders = [await seedOrder({ ageMinutes: 2 }), await seedOrder({ sessionId: null }), await seedOrder({ status: "confirmed", paymentStatus: "paid" }), await seedOrder({ source: null })];
    const before = (await snapshot()).filter((r) => untouchedOrders.some((o) => o.orderId === r.id));
    const followUps: Array<{ orderId: string; paymentIntentId: string | null; accountId: string }> = [];
    const summary = await runCompetitionSettlementRepair(db as never, { checkout: { sessions: { retrieve: async (id: string) => { state.retrieved.push(id); return state.live.get(id) as never ?? Promise.reject(new Error("unknown")); } } } } as never, {
      batchSize: 50,
      onFinalized: async (info) => { followUps.push(info); },
    });
    expect(summary.outcomes.finalized).toBe(1);
    expect(await orderState(target.orderId)).toMatchObject({ status: "confirmed", payment_status: "paid", reg_status: "confirmed", payments: 1 });
    expect(followUps).toEqual([{ orderId: target.orderId, paymentIntentId: `pi_${target.sessionId?.replace("cs_test_", "")}`, accountId: target.accountId }]);
    // the repair read Stripe only for the eligible, bound session(s); never for fresh, unbound, confirmed or ordinary orders
    for (const o of untouchedOrders) expect(state.retrieved).not.toContain(o.sessionId);
    expect((await snapshot()).filter((r) => untouchedOrders.some((o) => o.orderId === r.id))).toEqual(before);
    expect(db.calls.filter((c) => c.fn === "release_competition_registration")).toEqual([]);
    expect(db.calls.map((c) => c.fn).filter((fn) => fn !== "finalize_competition_registration")).toEqual([]);

    // second run: the order is already confirmed, so it is no longer a candidate
    state.retrieved.length = 0;
    const again = await runCompetitionSettlementRepair(db as never, { checkout: { sessions: { retrieve: async (id: string) => { state.retrieved.push(id); return state.live.get(id) as never; } } } } as never, { batchSize: 50 });
    expect(state.retrieved).not.toContain(target.sessionId);
    expect(again.outcomes.finalized ?? 0).toBe(0);
    expect((await orderState(target.orderId)).payments).toBe(1);
  });

  it("never releases anything: sessions Stripe shows open/expired/unpaid, unreadable, or naming another order leave the order pending", async () => {
    const open = await seedOrder();
    stripeShows(open, liveFor(open, { session: { status: "open", payment_status: "unpaid" } }));
    const expired = await seedOrder();
    stripeShows(expired, liveFor(expired, { session: { status: "expired", payment_status: "unpaid" } }));
    const unreadable = await seedOrder();
    stripeShows(unreadable, Object.assign(new Error("stripe down"), { code: "api_connection_error" }));
    const foreign = await seedOrder();
    const other = await seedOrder();
    stripeShows(foreign, liveFor(foreign, { session: { metadata: { source: "competition_registration", order_id: other.orderId } } }));
    const mine = [open, expired, unreadable, foreign, other];
    const before = (await snapshot()).filter((r) => mine.some((o) => o.orderId === r.id));
    const reader = { checkout: { sessions: { retrieve: async (id: string) => { const live = state.live.get(id); if (live instanceof Error) throw live; if (!live) throw new Error("no such session"); return live as never; } } } };
    const summary = await runCompetitionSettlementRepair(db as never, reader as never, { batchSize: 50 });
    expect(summary.outcomes.not_paid ?? 0).toBeGreaterThanOrEqual(2);
    expect(summary.outcomes.stripe_read_failed ?? 0).toBeGreaterThanOrEqual(1);
    expect(summary.outcomes.binding_invalid ?? 0).toBeGreaterThanOrEqual(1);
    expect((await snapshot()).filter((r) => mine.some((o) => o.orderId === r.id))).toEqual(before);
    expect(db.calls.filter((c) => c.fn === "release_competition_registration")).toEqual([]);
    expect(db.calls.filter((c) => c.fn === "finalize_competition_registration")).toEqual([]);
  });

  it("an order without a stored connected account is binding_invalid and is never sent to Stripe or the database", async () => {
    const order = await seedOrder({ accountId: null, studioHasAccount: false });
    stripeShows(order);
    const reader = { checkout: { sessions: { retrieve: async (id: string) => { state.retrieved.push(id); return state.live.get(id) as never; } } } };
    const summary = await runCompetitionSettlementRepair(db as never, reader as never, { batchSize: 50 });
    expect(summary.outcomes.binding_invalid ?? 0).toBeGreaterThanOrEqual(1);
    expect(state.retrieved).not.toContain(order.sessionId);
    expect(await orderState(order.orderId)).toMatchObject({ status: "pending", payments: 0 });
  });

  it("when Stripe (read twice) agrees on a price the order does not carry, the database refuses and the order stays pending", async () => {
    const order = await seedOrder();
    stripeShows(order, liveFor(order, { session: { amount_total: order.totalCents + 500 }, intent: { amount_received: order.totalCents + 500 } }));
    const reader = { checkout: { sessions: { retrieve: async (id: string) => state.live.get(id) as never } } };
    const summary = await runCompetitionSettlementRepair(db as never, reader as never, { batchSize: 50 });
    expect(summary.outcomes.error ?? 0).toBeGreaterThanOrEqual(1);
    expect(await orderState(order.orderId)).toMatchObject({ status: "pending", payment_status: "pending", payments: 0 });
  });
});

suite("CF1 settlement repair on real Postgres: racing the webhook", () => {
  it("a webhook and the repair settling the same order at the same moment finalize it exactly once (eight rounds)", async () => {
    for (let round = 0; round < 8; round += 1) {
      const order = await seedOrder();
      stripeShows(order);
      const reader = { checkout: { sessions: { retrieve: async (id: string) => state.live.get(id) as never } } };
      state.confirmations.length = 0;
      const finalized: string[] = [];
      const [hook, summary] = await Promise.all([
        webhook(eventBodyFor(order)),
        runCompetitionSettlementRepair(db as never, reader as never, { batchSize: 50, onFinalized: async (i) => { finalized.push(i.orderId); } }),
      ]);
      expect(hook.status, `round ${round}`).toBe(200);
      void summary;
      expect(await orderState(order.orderId)).toMatchObject({ status: "confirmed", payment_status: "paid", reg_status: "confirmed", payments: 1 });
      // the confirmation fires only for the writer whose finalize returned 'finalized': exactly one of the two paths
      const fromWebhook = state.confirmations.filter((id) => id === order.orderId).length;
      const fromRepair = finalized.filter((id) => id === order.orderId).length;
      expect(fromWebhook + fromRepair, `round ${round}`).toBe(1);
    }
  });
});

suite("CF1 settlement repair on real Postgres: the cron route", () => {
  it("is invisible (404) unless COMPETITION_SETTLEMENT_REPAIR=on, then requires the cron secret, then counts only", async () => {
    expect(settlementRepairEnabled()).toBe(false);
    const target = await seedOrder();
    stripeShows(target);
    expect((await cron.POST(cronRequest("anything"))).status).toBe(404);
    expect((await orderState(target.orderId)).payments).toBe(0);

    process.env.COMPETITION_SETTLEMENT_REPAIR = "on";
    expect((await cron.POST(cronRequest(null))).status).toBe(503); // CRON_SECRET not configured
    process.env.CRON_SECRET = "cron-secret-for-local-qa-only";
    expect((await cron.POST(cronRequest(null))).status).toBe(401);
    expect((await cron.POST(cronRequest("wrong-secret"))).status).toBe(401);
    expect((await orderState(target.orderId)).payments).toBe(0);

    const response = await cron.POST(cronRequest("cron-secret-for-local-qa-only"));
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; scanned: number; processed: number; outcomes: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(body.outcomes.finalized).toBeGreaterThanOrEqual(1);
    expect(Object.keys(body).sort()).toEqual(["ok", "outcomes", "processed", "scanned"]);
    expect(await orderState(target.orderId)).toMatchObject({ status: "confirmed", payment_status: "paid", payments: 1 });
    expect(state.confirmations).toContain(target.orderId);
    expect(state.feeSyncs.length).toBeGreaterThanOrEqual(1);
    expect(db.calls.filter((c) => c.fn === "release_competition_registration")).toEqual([]);
  });
});

