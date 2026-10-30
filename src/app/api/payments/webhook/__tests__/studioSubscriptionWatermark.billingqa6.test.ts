import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { createOwnershipFakeSupabase, type Row } from "@/lib/payments/__tests__/ownershipFakes";

/**
 * BILLING-QA-6 (issue #354 R-B): the read watermark on studio_subscriptions.stripe_state_read_at, through POST.
 *   - a Stripe read applies only if no NEWER read is stored, so concurrent deliveries that finish in inverted order cannot
 *     leave an older Stripe state in the row (a cancelled subscription showing active);
 *   - equal and NULL watermarks apply; an event-payload fallback applies without moving the watermark;
 *   - a skipped (stale) write has no side effects: no studio snapshot, customer or add-on write.
 */

const PLATFORM_SECRET = "whsec_billingqa6_platform_test";
const CONNECT_SECRET = "whsec_billingqa6_connect_test";
const realStripe = new Stripe("sk_test_billingqa6_not_a_real_key");

let signatureHeader: string | null = null;
let fake: ReturnType<typeof createOwnershipFakeSupabase>;
let completions: Array<{ status: unknown; error: unknown }> = [];
// What the database claim reports for the next delivery: "claimed", "already_processed" or another worker holding the lease.
let claimOutcome = "claimed";
// Stripe's CURRENT subscription state, which the webhook re-reads; post() keeps it in step unless an event is stale.
let stripeState: Record<string, unknown> = {};
const notFound = () => Object.assign(new Error("No such subscription"), { code: "resource_missing", statusCode: 404 });
const currentSubscription = async (id: string) => {
  if (!(id in stripeState)) throw notFound();
  return stripeState[id];
};
const stripeApi = {
  customers: { retrieve: vi.fn(async () => ({ id: "cus_1", name: "Studio One", email: "owner@example.com" })) },
  subscriptions: { retrieve: vi.fn(currentSubscription) },
};

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => (name === "stripe-signature" ? signatureHeader : null) }),
}));
vi.mock("@/lib/payments/stripe", () => ({ getStripe: () => ({ webhooks: realStripe.webhooks, ...stripeApi }) }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => fake.adminClient }));

const { POST } = await import("@/app/api/payments/webhook/route");

const PRICES = {
  starter: "price_starter_founder",
  growth: "price_growth_founder",
  pro: "price_pro_founder",
  proLegacy: "price_pro_legacy_129",
  addon: "price_ai_pack",
};

function seed(extra: Record<string, Row[]> = {}) {
  fake = createOwnershipFakeSupabase(
    {
      studios: [
        { id: "studio-1", billing_plan: "starter", subscription_status: "inactive", stripe_connected_account_id: "acct_studio1", billing_override_enabled: false },
        { id: "studio-2", billing_plan: "pro", subscription_status: "active", stripe_customer_id: "cus_2", stripe_subscription_id: "sub_2", billing_override_enabled: false },
        { id: "studio-comp", billing_plan: "pro", subscription_status: "inactive", billing_override_enabled: true },
      ],
      subscription_plans: ["starter", "growth", "pro", "organizer"].map((code) => ({
        id: `plan-${code}`, code, active: true, stripe_price_id_monthly: null, stripe_price_id_yearly: null,
      })),
      studio_subscriptions: [{ id: "ss-2", studio_id: "studio-2", subscription_plan_id: "plan-pro", stripe_subscription_id: "sub_2", status: "active" }],
      studio_billing_customers: [{ id: "sbc-2", studio_id: "studio-2", stripe_customer_id: "cus_2" }],
      usage_addon_entitlements: [],
      stripe_subscriptions: [],
      ...extra,
    },
    {
      rpcOverride: (name, params) => {
        if (name === "claim_payment_provider_event") return { data: { outcome: claimOutcome }, error: null };
        if (name === "complete_payment_provider_event") {
          completions.push({ status: params.p_status, error: params.p_error });
          return { data: true, error: null };
        }
        return undefined;
      },
    },
  );
}

function subscription(fields: { id?: string; status?: string; prices: string[]; metadata?: Record<string, string>; customer?: string; trialEnd?: number | null }) {
  return {
    id: fields.id ?? "sub_1",
    object: "subscription",
    customer: fields.customer ?? "cus_1",
    status: fields.status ?? "trialing",
    current_period_start: 1790000000,
    current_period_end: 1792600000,
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    trial_end: fields.trialEnd ?? null,
    latest_invoice: null,
    default_payment_method: null,
    items: { data: fields.prices.map((price, index) => ({ id: `si_${index + 1}`, price: { id: price }, metadata: {} })) },
    metadata: fields.metadata ?? { source: "studio_subscription", studioId: "studio-1", planCode: "growth" },
  };
}

function eventBody(type: string, object: unknown, account?: string, eventId?: string) {
  return JSON.stringify({
    id: eventId ?? `evt_${Math.random().toString(36).slice(2)}`,
    object: "event",
    type,
    api_version: "2026-03-25.dahlia",
    created: Math.floor(Date.now() / 1000),
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    ...(account ? { account } : {}),
  });
}

type TestHeaderOptions = Parameters<typeof realStripe.webhooks.generateTestHeaderString>[0];

/** `stale: true` delivers an event whose payload is older than Stripe's current state (late, retried or reordered). */
async function post(type: string, object: unknown, account?: string, opts: { stale?: boolean; eventId?: string } = {}) {
  if (type.startsWith("customer.subscription.") && !opts.stale) stripeState[(object as { id: string }).id] = object;
  const body = eventBody(type, object, account, opts.eventId);
  signatureHeader = realStripe.webhooks.generateTestHeaderString({ payload: body, secret: account ? CONNECT_SECRET : PLATFORM_SECRET } as TestHeaderOptions);
  const response = await POST(new Request("https://example.test/api/payments/webhook", { method: "POST", body }));
  return { status: response.status, text: await response.text() };
}

const studio = (id: string) => fake.rows("studios").find((row) => row.id === id)!;
const subsFor = (id: string) => fake.rows("studio_subscriptions").filter((row) => row.studio_id === id);

beforeEach(() => {
  completions = [];
  claimOutcome = "claimed";
  stripeState = {};
  // Full reset: a one-shot mock a previous test did not consume must never leak into the next one.
  stripeApi.subscriptions.retrieve.mockReset().mockImplementation(currentSubscription);
  seed();
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", PLATFORM_SECRET);
  vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", CONNECT_SECRET);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-only");
  vi.stubEnv("STRIPE_PRICE_STUDIO_STARTER_FOUNDER", PRICES.starter);
  vi.stubEnv("STRIPE_PRICE_STUDIO_GROWTH_FOUNDER", PRICES.growth);
  vi.stubEnv("STRIPE_PRICE_STUDIO_PRO_FOUNDER", PRICES.pro);
  vi.stubEnv("STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY", PRICES.proLegacy);
  vi.stubEnv("STRIPE_PRICE_STUDIO_STARTER_STANDARD", "");
  vi.stubEnv("STRIPE_PRICE_STUDIO_GROWTH_STANDARD", "");
  vi.stubEnv("STRIPE_PRICE_STUDIO_PRO_STANDARD", "");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const sub2 = (status: string, extra: Record<string, unknown> = {}) => ({
  ...subscription({ id: "sub_2", status, prices: [PRICES.pro], customer: "cus_2", metadata: { source: "studio_subscription", studioId: "studio-2", planCode: "pro" } }),
  ...extra,
});
const T0 = new Date("2026-10-30T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("studio_subscriptions.stripe_state_read_at (BILLING-QA-6)", () => {
  it("stamps the row with the instant the Stripe read started (update of an existing row with no watermark)", async () => {
    const result = await post("customer.subscription.updated", sub2("active"));
    expect(result.status).toBe(200);
    expect(subsFor("studio-2")[0].stripe_state_read_at).toBe(T0.toISOString());
  });

  it("stamps a newly inserted row", async () => {
    await post("customer.subscription.created", subscription({ prices: [PRICES.growth] }));
    expect(subsFor("studio-1")[0].stripe_state_read_at).toBe(T0.toISOString());
  });

  it("in-order deliveries: the later read replaces the earlier one", async () => {
    await post("customer.subscription.updated", sub2("active"));
    vi.setSystemTime(at(1000));
    await post("customer.subscription.updated", sub2("canceled", { canceled_at: 1790001000, ended_at: 1790001000 }));
    expect(subsFor("studio-2")[0]).toMatchObject({ status: expect.not.stringMatching(/^active$/), stripe_state_read_at: at(1000).toISOString() });
    expect(studio("studio-2").subscription_status).not.toBe("active");
  });

  it("INVERTED completion: a slower delivery that read an older ACTIVE state cannot overwrite a newer CANCELED state", async () => {
    // A starts its Stripe read first (t0) and finishes last; B starts later (t0+500ms) and finishes first.
    const gate = deferred<unknown>();
    stripeApi.subscriptions.retrieve.mockImplementationOnce(async () => gate.promise);
    const deliveryA = post("customer.subscription.updated", sub2("active"), undefined, { stale: true });
    await vi.waitFor(() => expect(stripeApi.subscriptions.retrieve).toHaveBeenCalledTimes(1));

    vi.setSystemTime(at(500));
    stripeApi.subscriptions.retrieve.mockImplementationOnce(async () => sub2("canceled", { canceled_at: 1790001000, ended_at: 1790001000 }));
    expect((await post("customer.subscription.updated", sub2("canceled"), undefined, { stale: true })).status).toBe(200);
    const afterB = { ...subsFor("studio-2")[0] };
    const studioAfterB = { ...studio("studio-2") };
    expect(afterB.status).not.toBe("active");
    expect(afterB.stripe_state_read_at).toBe(at(500).toISOString());

    vi.setSystemTime(at(900));
    gate.resolve(sub2("active"));
    const resultA = await deliveryA;

    expect(resultA).toEqual({ status: 200, text: "Webhook processed." });
    expect(subsFor("studio-2")[0]).toEqual(afterB);
    expect(studio("studio-2")).toEqual(studioAfterB);
    expect(console.error).toHaveBeenCalledWith("subscription_event_stale_read");
    expect(completions.map((c) => c.status)).toEqual(["processed", "processed"]);
  });

  it("a stale write has no side effects: no billing customer, snapshot or add-on write", async () => {
    await post("customer.subscription.updated", sub2("active"));
    vi.setSystemTime(at(2000));
    await post("customer.subscription.updated", sub2("past_due"));
    const before = fake.mutations.length;
    vi.setSystemTime(at(100)); // a read stamped EARLIER than the stored 2000 ms watermark
    await post("customer.subscription.updated", sub2("active"), undefined, { stale: true });
    const newMutations = fake.mutations.slice(before).filter((m) => ["studios", "studio_billing_customers", "usage_addon_entitlements"].includes(m.table));
    expect(newMutations).toEqual([]);
    expect(subsFor("studio-2")[0].status).toBe("past_due");
  });

  it("an EQUAL watermark applies (two reads started in the same millisecond)", async () => {
    await post("customer.subscription.updated", sub2("active"));
    await post("customer.subscription.updated", sub2("past_due"));
    expect(subsFor("studio-2")[0]).toMatchObject({ status: "past_due", stripe_state_read_at: T0.toISOString() });
  });

  it("a row whose watermark is NULL (every pre-migration row) is writable", async () => {
    expect(subsFor("studio-2")[0].stripe_state_read_at).toBeUndefined();
    await post("customer.subscription.updated", sub2("past_due"));
    expect(subsFor("studio-2")[0].status).toBe("past_due");
  });

  it("event-payload fallback (resource_missing): applies without moving the watermark", async () => {
    await post("customer.subscription.updated", sub2("active"));
    vi.setSystemTime(at(3000));
    const deleted = sub2("canceled", { canceled_at: 1790002000, ended_at: 1790002000 });
    delete stripeState.sub_2;
    // Stripe no longer knows the subscription: the payload is applied unstamped, the stored watermark stays at t0.
    expect((await post("customer.subscription.deleted", deleted, undefined, { stale: true })).status).toBe(200);
    expect(console.error).toHaveBeenCalledWith("subscription_event_retrieve_missing");
    expect(subsFor("studio-2")[0]).toMatchObject({ status: expect.not.stringMatching(/^active$/), stripe_state_read_at: T0.toISOString() });
  });

  it("a failing write still fails the delivery (500, ledger failed) and Stripe retries", async () => {
    const original = fake.adminClient.from;
    fake.adminClient.from = ((table: string) => {
      if (table === "studio_subscriptions") throw new Error("database unavailable");
      return original(table);
    }) as typeof original;
    const result = await post("customer.subscription.updated", sub2("active"));
    expect(result.status).toBe(500);
    expect(completions.map((c) => c.status)).toEqual(["failed"]);
  });
});
