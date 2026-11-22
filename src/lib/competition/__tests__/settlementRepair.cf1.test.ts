import { describe, expect, it, vi, afterEach } from "vitest";
import type Stripe from "stripe";

import { applyCompetitionCheckoutEvent } from "@/lib/competition/registrationLifecycle";
import {
  listRepairCandidates,
  repairCompetitionOrder,
  runCompetitionSettlementRepair,
  settlementRepairEnabled,
  MAX_BATCH_SIZE,
} from "@/lib/competition/settlementRepair";
import { fakeStripeReader, paidLive } from "./helpers/settlementStripeFake";

/**
 * CF1 settlement repair: a missed webhook is repaired by reading Stripe's own record, only through the existing finalize path,
 * idempotently, and never by releasing anything.
 */

const ORDER = "11111111-2222-4333-8444-555555555555";
const ACCOUNT = "acct_studioA";
const row = (over: Record<string, unknown> = {}) => ({ id: ORDER, stripe_checkout_session_id: "cs_paid", metadata: { source: "competition_registration", stripe_account_id: ACCOUNT }, ...over });

/** Minimal PostgREST-ish query chain that records every filter and resolves to the given rows. */
function adminWith(rows: unknown[], opts: { listError?: boolean } = {}) {
  const filters: Array<[string, ...unknown[]]> = [];
  let limitSeen: number | null = null;
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "eq", "not", "lt", "gt", "order"]) {
    chain[name] = (...args: unknown[]) => { filters.push([name, ...args]); return chain; };
  }
  chain.limit = (n: number) => { limitSeen = n; return Promise.resolve(opts.listError ? { data: null, error: { message: "boom" } } : { data: rows, error: null }); };
  // finalize_competition_registration is idempotent in the database; model that: first call finalizes, later ones report already_finalized.
  let finalized = false;
  const rpc = vi.fn(async (name: string) => {
    if (name !== "finalize_competition_registration") throw new Error(`unexpected rpc ${name}`);
    const outcome = finalized ? "already_finalized" : "finalized";
    finalized = true;
    return { data: { outcome }, error: null };
  });
  const from = vi.fn((table: string) => { filters.push(["from", table]); return chain; });
  return { client: { from, rpc } as never, rpc, from, filters, limit: () => limitSeen };
}

afterEach(() => vi.restoreAllMocks());

describe("candidate query", () => {
  it("lists only pending, unpaid competition orders with a bound session inside the age window, bounded, oldest first", async () => {
    const a = adminWith([row()]);
    const now = Date.parse("2027-01-10T12:00:00Z");
    await listRepairCandidates(a.client, { batchSize: 5, minAgeMinutes: 15, now, random: () => 0 });
    expect(a.filters).toEqual(expect.arrayContaining([
      ["from", "event_orders"],
      ["eq", "status", "pending"],
      ["eq", "payment_status", "pending"],
      ["eq", "metadata->>source", "competition_registration"],
      ["not", "stripe_checkout_session_id", "is", null],
      ["lt", "updated_at", "2027-01-10T11:45:00.000Z"],
      ["gt", "updated_at", "2026-12-27T12:00:00.000Z"],
      ["order", "updated_at", { ascending: true }],
      ["order", "updated_at", { ascending: false }],
    ]));
    expect(a.limit()).toBe(10);
  });

  it("a query error fails closed", async () => {
    await expect(listRepairCandidates(adminWith([], { listError: true }).client, { batchSize: 5, minAgeMinutes: 15, now: 0, random: () => 0 })).rejects.toThrow();
  });
});

describe("starvation", () => {
  it("queries both the oldest and the newest end so a newer paid order is not hidden behind old unpayable ones", async () => {
    const a = adminWith([row()]);
    await listRepairCandidates(a.client, { batchSize: 5, minAgeMinutes: 15, now: 0, random: () => 0 });
    const orders = a.filters.filter((f) => f[0] === "order").map((f) => (f[2] as { ascending: boolean }).ascending);
    expect(orders.sort()).toEqual([false, true]);
  });
});

describe("repairing one order", () => {
  it("Stripe says paid: reads on the bound account, then finalizes with Stripe's values through the existing path", async () => {
    const { stripe, retrieve } = fakeStripeReader(paidLive());
    const a = adminWith([]);
    const result = await repairCompetitionOrder(a.client, stripe, row());
    expect(result).toEqual({ outcome: "finalized", paymentIntentId: "pi_1", accountId: ACCOUNT });
    expect(retrieve.mock.calls.every((c) => c[2].stripeAccount === ACCOUNT)).toBe(true);
    expect(a.rpc).toHaveBeenCalledTimes(1);
    expect(a.rpc.mock.calls[0]).toEqual(["finalize_competition_registration", { p_order_id: ORDER, p_stripe_account_id: ACCOUNT, p_checkout_session_id: "cs_paid", p_payment_intent_id: "pi_1", p_amount_cents: 10000, p_currency: "USD" }]);
  });

  it("a second repair, or the webhook racing the repair, never duplicates: the second finalize reports already_finalized", async () => {
    const { stripe } = fakeStripeReader(paidLive());
    const a = adminWith([]);
    const webhook = applyCompetitionCheckoutEvent(a.client, { stripe, eventType: "checkout.session.completed", session: paidLive(), stripeAccountId: ACCOUNT });
    const repair = repairCompetitionOrder(a.client, stripe, row());
    const [w, r] = await Promise.all([webhook, repair]);
    expect([w.outcome, r.outcome].sort()).toEqual(["already_finalized", "finalized"]);
    expect((await repairCompetitionOrder(a.client, stripe, row())).outcome).toBe("already_finalized");
  });

  it.each([
    ["open and unpaid", { status: "open", payment_status: "unpaid" }],
    ["expired", { status: "expired", payment_status: "unpaid" }],
    ["complete but unpaid", { status: "complete", payment_status: "unpaid" }],
  ])("Stripe says %s: nothing is finalized and nothing is released", async (_label, session) => {
    const { stripe } = fakeStripeReader(paidLive({ session }));
    const a = adminWith([]);
    expect((await repairCompetitionOrder(a.client, stripe, row())).outcome).toBe("not_paid");
    expect(a.rpc).not.toHaveBeenCalled();
  });

  it("a Stripe read failure fails closed (no finalize, no release) and is not thrown", async () => {
    const { stripe } = fakeStripeReader(new Error("stripe down sk_live_secret"));
    const a = adminWith([]);
    expect((await repairCompetitionOrder(a.client, stripe, row())).outcome).toBe("stripe_read_failed");
    expect(a.rpc).not.toHaveBeenCalled();
  });

  it("wrong account / other order: Stripe's record naming a different order is refused", async () => {
    const { stripe } = fakeStripeReader(paidLive({ session: { metadata: { source: "competition_registration", order_id: "99999999-2222-4333-8444-555555555555" } } }));
    const a = adminWith([]);
    expect((await repairCompetitionOrder(a.client, stripe, row())).outcome).toBe("binding_invalid");
    expect(a.rpc).not.toHaveBeenCalled();
  });

  it("an order whose binding is incomplete or malformed is never read from Stripe", async () => {
    const { stripe, retrieve } = fakeStripeReader(paidLive());
    const a = adminWith([]);
    for (const bad of [row({ stripe_checkout_session_id: null }), row({ metadata: { source: "competition_registration" } }), row({ metadata: { stripe_account_id: "not-an-account" } }), row({ stripe_checkout_session_id: "pi_wrong" }), row({ id: "nope" })]) {
      expect((await repairCompetitionOrder(a.client, stripe, bad)).outcome).toBe("binding_invalid");
    }
    expect(retrieve).not.toHaveBeenCalled();
    expect(a.rpc).not.toHaveBeenCalled();
  });

  it("the finalize path's own re-read disagreeing (amount differs between reads) refuses without finalizing", async () => {
    let calls = 0;
    const retrieve = vi.fn(async () => (++calls === 1 ? paidLive() : paidLive({ session: { amount_total: 100 }, intent: { amount_received: 100 } })));
    const stripe = { checkout: { sessions: { retrieve } } } as never;
    const a = adminWith([]);
    expect((await repairCompetitionOrder(a.client, stripe, row())).outcome).toBe("refused");
    expect(a.rpc).not.toHaveBeenCalled();
  });

  it("never calls a release or expire path", async () => {
    const { stripe } = fakeStripeReader(paidLive({ session: { status: "expired", payment_status: "unpaid" } }));
    const a = adminWith([]);
    await repairCompetitionOrder(a.client, stripe, row());
    expect(a.rpc.mock.calls.map((c) => c[0])).not.toContain("release_competition_registration");
  });
});

describe("a run", () => {
  it("is bounded: processes at most the batch size and caps an oversized request", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => row({ id: `11111111-2222-4333-8444-${String(i).padStart(12, "0")}`, stripe_checkout_session_id: `cs_${i}` }));
    const { stripe } = fakeStripeReader(paidLive({ session: { status: "open", payment_status: "unpaid" } }));
    const a = adminWith(rows);
    const small = await runCompetitionSettlementRepair(a.client, stripe, { batchSize: 3 });
    expect(small.processed).toBe(3);
    expect(a.limit()).toBe(6);
    const big = await runCompetitionSettlementRepair(a.client, stripe, { batchSize: 10_000 });
    expect(big.processed).toBe(MAX_BATCH_SIZE);
  });

  it("one failing order does not stop the others; follow-ups run only for finalized orders and their errors are contained", async () => {
    const { stripe } = fakeStripeReader(paidLive());
    const a = adminWith([row(), row({ id: "11111111-2222-4333-8444-666666666666", stripe_checkout_session_id: null })]);
    const onFinalized = vi.fn(async () => { throw new Error("mail down"); });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const summary = await runCompetitionSettlementRepair(a.client, stripe, { random: () => 0, onFinalized });
    expect(summary.outcomes).toEqual({ finalized: 1, binding_invalid: 1 });
    expect(onFinalized).toHaveBeenCalledTimes(1);
    expect(onFinalized).toHaveBeenCalledWith({ orderId: ORDER, paymentIntentId: "pi_1", accountId: ACCOUNT });
  });

  it("logs are masked: no full order, account or session ids", async () => {
    const { stripe } = fakeStripeReader(new Error("x"));
    const a = adminWith([row()]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runCompetitionSettlementRepair(a.client, stripe);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(ORDER);
    expect(logged).not.toContain(ACCOUNT);
    expect(logged).not.toContain("cs_paid");
  });
});

describe("flag and route", () => {
  it("is off unless COMPETITION_SETTLEMENT_REPAIR is exactly 'on'", () => {
    expect(settlementRepairEnabled({})).toBe(false);
    expect(settlementRepairEnabled({ COMPETITION_SETTLEMENT_REPAIR: "1" })).toBe(false);
    expect(settlementRepairEnabled({ COMPETITION_SETTLEMENT_REPAIR: " ON " })).toBe(true);
  });

  it("the route answers 404 with the flag off (nothing read, no auth reveal) and refuses without the cron secret when on", async () => {
    vi.resetModules();
    const admin = vi.fn();
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: admin }));
    vi.doMock("@/lib/payments/stripe", () => ({ getStripe: vi.fn() }));
    const { GET } = await import("@/app/api/cron/competition-settlement-repair/route");
    vi.stubEnv("COMPETITION_SETTLEMENT_REPAIR", "");
    expect((await GET(new Request("http://x/api"))).status).toBe(404);
    vi.stubEnv("COMPETITION_SETTLEMENT_REPAIR", "on");
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await GET(new Request("http://x/api"))).status).toBe(401);
    expect(admin).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/supabase/admin");
    vi.doUnmock("@/lib/payments/stripe");
  });
});

void (undefined as unknown as Stripe.Checkout.Session);
