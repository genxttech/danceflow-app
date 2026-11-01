import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

/**
 * D7 WP-3: route-level tests for the two Stripe webhook integrations of the price-transition reconciliation hook
 * (customer.subscription.* and subscription_schedule.*). Signatures are real Stripe test headers made with SYNTHETIC secrets;
 * the database is a recording fake with the same claim/complete semantics as the Stage 3 harness; the reconciler itself is
 * mocked so these tests pin the WIRING: dark by default, only platform events, subscription id taken from the event, failure
 * isolation, duplicate/out-of-order delivery, and no billing writes or Stripe writes caused by the hook.
 */

const PLATFORM_SECRET = "whsec_d7wp3_platform_synthetic";
const CONNECT_SECRET = "whsec_d7wp3_connect_synthetic";
const realStripe = new Stripe("sk_test_d7wp3_not_a_real_key");

let signatureHeader: string | null = null;
type EventRow = { status: string; owner: string | null; attempts: number };
const store = new Map<string, EventRow>();
const rpcLog: Array<{ fn: string; args: Record<string, unknown> }> = [];
const tableLog: Array<{ table: string; op: string }> = [];
const stripeCalls: string[] = [];

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const reconcile = vi.fn(async (..._args: unknown[]) => ({ state: "awaiting_stripe", reasons: [] as string[] }));
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const findOpen = vi.fn(async (..._args: unknown[]): Promise<string | null> => "transition-1");

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => (name === "stripe-signature" ? signatureHeader : null) }),
}));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    webhooks: realStripe.webhooks,
    subscriptions: {
      retrieve: async (id: string) => {
        stripeCalls.push(`subscriptions.retrieve:${id}`);
        return currentSubscription(id);
      },
    },
  }),
}));
vi.mock("@/lib/billing/priceTransitionReconcile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/priceTransitionReconcile")>()),
  reconcilePriceTransition: (...args: unknown[]) => reconcile(...args),
}));
vi.mock("@/lib/billing/priceTransitionReconcileDeps", () => ({
  createReconcileDeps: () => ({ marker: "deps" }),
  findOpenTransitionId: (...args: unknown[]) => findOpen(...args),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcLog.push({ fn, args });
      if (fn === "claim_payment_provider_event") {
        const id = String(args.p_provider_event_id);
        const row = store.get(id) ?? { status: "received", owner: null, attempts: 0 };
        store.set(id, row);
        if (row.status === "processed") return { data: { outcome: "already_processed", attempt_count: row.attempts }, error: null };
        row.status = "processing";
        row.owner = String(args.p_owner);
        row.attempts += 1;
        return { data: { outcome: "claimed", attempt_count: row.attempts }, error: null };
      }
      if (fn === "complete_payment_provider_event") {
        const row = store.get(String(args.p_provider_event_id));
        if (!row || row.owner !== String(args.p_owner)) return { data: false, error: null };
        row.status = String(args.p_status);
        row.owner = null;
        return { data: true, error: null };
      }
      return { data: null, error: null };
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "neq", "order", "limit", "gte", "lte", "not", "or", "ilike"]) chain[m] = () => chain;
      chain.maybeSingle = async () => ({ data: null, error: null });
      chain.single = async () => ({ data: null, error: null });
      for (const op of ["insert", "update", "upsert", "delete"]) chain[op] = () => (tableLog.push({ table, op }), chain);
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
      return chain;
    },
  }),
}));

const { POST } = await import("@/app/api/payments/webhook/route");

type TestHeaderOptions = Parameters<typeof realStripe.webhooks.generateTestHeaderString>[0];

const currentSubscription = (id: string) => ({
  id, object: "subscription", customer: "cus_1", status: "active", metadata: {}, cancel_at_period_end: false, schedule: null,
  items: { object: "list", data: [{ id: "si_1", object: "subscription_item", quantity: 1, price: { id: "price_regular", object: "price", product: "prod_1" }, current_period_start: 1_800_000_000, current_period_end: 1_802_600_000 }] },
  current_period_start: 1_800_000_000, current_period_end: 1_802_600_000,
});

function envelope(id: string, type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { id, object: "event", type, api_version: "2026-03-25.dahlia", created: 1_800_000_100, data: { object }, livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, ...extra };
}

async function send(event: Record<string, unknown>, secret = PLATFORM_SECRET) {
  const body = JSON.stringify(event);
  signatureHeader = realStripe.webhooks.generateTestHeaderString({ payload: body, secret } as TestHeaderOptions);
  const response = await POST(new Request("https://example.test/api/payments/webhook", { method: "POST", body }));
  return { status: response.status, text: await response.text() };
}

const subscriptionUpdated = (id: string, sub = "sub_PROT") => envelope(id, "customer.subscription.updated", currentSubscription(sub));
const scheduleEvent = (id: string, type: string, schedule: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  envelope(id, type, { id: "sub_sched_1", object: "subscription_schedule", status: "active", subscription: "sub_PROT", ...schedule }, extra);
const completionStatuses = () => rpcLog.filter((c) => c.fn === "complete_payment_provider_event").map((c) => c.args.p_status);

beforeEach(() => {
  store.clear();
  rpcLog.length = 0;
  tableLog.length = 0;
  stripeCalls.length = 0;
  reconcile.mockClear();
  reconcile.mockImplementation(async () => ({ state: "awaiting_stripe", reasons: [] }));
  findOpen.mockClear();
  findOpen.mockImplementation(async () => "transition-1");
  process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-only";
  delete process.env.PRICE_TRANSITION_RECONCILE_ENABLED;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network is not allowed in local tests"); }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.PRICE_TRANSITION_RECONCILE_ENABLED;
});

describe("disabled (the default)", () => {
  it("customer.subscription.updated and subscription_schedule.* events never touch the reconciler", async () => {
    for (const [i, event] of [
      subscriptionUpdated("evt_off_1"),
      scheduleEvent("evt_off_2", "subscription_schedule.released", {}),
      scheduleEvent("evt_off_3", "subscription_schedule.completed", {}),
    ].entries()) {
      const result = await send(event);
      expect(result.status, `event ${i}`).toBe(200);
    }
    expect(findOpen).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(completionStatuses()).toEqual(["processed", "processed", "processed"]);
  });

  it("a value other than exactly 'true' keeps it dark", async () => {
    process.env.PRICE_TRANSITION_RECONCILE_ENABLED = "1";
    await send(scheduleEvent("evt_off_4", "subscription_schedule.released", {}));
    expect(findOpen).not.toHaveBeenCalled();
  });
});

describe("enabled", () => {
  beforeEach(() => {
    process.env.PRICE_TRANSITION_RECONCILE_ENABLED = "true";
  });

  it("customer.subscription.updated triggers a re-evaluation keyed only by the subscription id, with apply on", async () => {
    const result = await send(subscriptionUpdated("evt_on_1"));
    expect(result.status).toBe(200);
    expect(findOpen).toHaveBeenCalledTimes(1);
    expect(findOpen.mock.calls[0][1]).toBe("sub_PROT");
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0][0]).toBe("transition-1");
    expect(reconcile.mock.calls[0][2]).toEqual({ apply: true });
    expect(completionStatuses()).toEqual(["processed"]);
  });

  it.each([
    ["subscription_schedule.updated", { subscription: "sub_PROT" }],
    ["subscription_schedule.released", { subscription: null, released_subscription: "sub_PROT", status: "released" }],
    ["subscription_schedule.completed", { subscription: null, released_subscription: "sub_PROT", status: "completed" }],
    ["subscription_schedule.canceled", { subscription: { id: "sub_PROT" }, status: "canceled" }],
  ])("%s resolves the subscription id from the schedule (including released_subscription)", async (type, schedule) => {
    const result = await send(scheduleEvent(`evt_${type}`, type, schedule));
    expect(result.status).toBe(200);
    expect(findOpen.mock.calls[0][1]).toBe("sub_PROT");
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("a schedule event for a subscription with no open transition does nothing further and is still processed", async () => {
    findOpen.mockResolvedValueOnce(null);
    const result = await send(scheduleEvent("evt_on_none", "subscription_schedule.released", {}));
    expect(result.status).toBe(200);
    expect(reconcile).not.toHaveBeenCalled();
    expect(completionStatuses()).toEqual(["processed"]);
  });

  it("a schedule event without any subscription id is ignored", async () => {
    await send(scheduleEvent("evt_on_nosub", "subscription_schedule.released", { subscription: null }));
    expect(findOpen).not.toHaveBeenCalled();
  });

  it("schedule event types the handler does not list (e.g. created) stay no-ops", async () => {
    const result = await send(scheduleEvent("evt_on_created", "subscription_schedule.created", {}));
    expect(result.status).toBe(200);
    expect(findOpen).not.toHaveBeenCalled();
  });

  it("Connect (account-scoped) events never reach the hook", async () => {
    const connectSub = envelope("evt_on_connect", "customer.subscription.updated", currentSubscription("sub_PROT"), { account: "acct_connected" });
    const connectSchedule = scheduleEvent("evt_on_connect2", "subscription_schedule.released", {}, { account: "acct_connected" });
    expect((await send(connectSub, CONNECT_SECRET)).status).toBe(200);
    expect((await send(connectSchedule, CONNECT_SECRET)).status).toBe(200);
    expect(findOpen).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("failure isolation: a reconciler error never fails, retries or alters the webhook", async () => {
    reconcile.mockRejectedValueOnce(new Error("stripe timeout"));
    const first = await send(scheduleEvent("evt_fail_1", "subscription_schedule.released", {}));
    findOpen.mockRejectedValueOnce(new Error("database unavailable"));
    const second = await send(subscriptionUpdated("evt_fail_2"));
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(completionStatuses()).toEqual(["processed", "processed"]);
    expect(rpcLog.some((c) => c.fn === "complete_payment_provider_event" && c.args.p_status === "failed")).toBe(false);
  });

  it("a needs_review outcome is logged for the owner and the webhook still succeeds", async () => {
    reconcile.mockResolvedValueOnce({ state: "needs_review", reasons: ["target_price_amount_differs_from_notice"] });
    const result = await send(scheduleEvent("evt_review", "subscription_schedule.released", {}));
    expect(result.status).toBe(200);
    expect(console.error).toHaveBeenCalledWith("price transition needs owner review", expect.objectContaining({ transitionId: "transition-1" }));
  });

  it("duplicate delivery of one event reconciles once; out-of-order distinct events each just re-evaluate", async () => {
    const released = scheduleEvent("evt_dup", "subscription_schedule.released", {});
    expect((await send(released)).status).toBe(200);
    const duplicate = await send(released);
    expect(duplicate.text).toBe("Already processed");
    expect(reconcile).toHaveBeenCalledTimes(1);

    // the subscription update arrives AFTER the schedule release: a second, independent re-evaluation of the same transition
    expect((await send(subscriptionUpdated("evt_late"))).status).toBe(200);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile.mock.calls.map((c) => c[0])).toEqual(["transition-1", "transition-1"]);
  });

  it("causes no billing writes and no Stripe writes of its own", async () => {
    await send(scheduleEvent("evt_nowrite_1", "subscription_schedule.released", {}));
    await send(scheduleEvent("evt_nowrite_2", "subscription_schedule.completed", { subscription: null, released_subscription: "sub_PROT" }));
    // schedule events: the route itself writes nothing to any table and never calls Stripe
    expect(tableLog).toEqual([]);
    expect(stripeCalls).toEqual([]);
    // the subscription event keeps its existing behaviour: a read of the CURRENT subscription from Stripe, no Stripe write
    await send(subscriptionUpdated("evt_nowrite_3"));
    expect(stripeCalls).toEqual(["subscriptions.retrieve:sub_PROT"]);
    expect(tableLog.some((t) => ["price_transitions", "protected_subscriptions", "price_transition_notices"].includes(t.table))).toBe(false);
  });
});

describe("existing behaviour is unchanged when the hook is dark vs enabled", () => {
  it("customer.subscription.updated performs the same table writes either way", async () => {
    await send(subscriptionUpdated("evt_same_off"));
    const off = tableLog.map((t) => `${t.table}:${t.op}`);
    tableLog.length = 0;
    process.env.PRICE_TRANSITION_RECONCILE_ENABLED = "true";
    await send(subscriptionUpdated("evt_same_on"));
    expect(tableLog.map((t) => `${t.table}:${t.op}`)).toEqual(off);
  });
});
