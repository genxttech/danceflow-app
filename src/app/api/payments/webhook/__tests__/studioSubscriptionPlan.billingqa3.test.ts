import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { createOwnershipFakeSupabase, type Row } from "@/lib/payments/__tests__/ownershipFakes";

/**
 * BILLING-QA-3: platform subscription webhooks through POST (signature, scope, claim, handler, finalization).
 *   - plan resolution order on real event payloads: subscription_plans Price, then checkout Price env (Founder,
 *     standard, grandfathered legacy), then metadata.planCode; ambiguous Prices never pick a plan;
 *   - studios.billing_plan follows the resolved plan (public embed / Discover read it);
 *   - tenant isolation: only the subscription's own studio is written;
 *   - a platform subscription without DanceFlow metadata is acknowledged with no write (was a 500 retried forever),
 *     while a DanceFlow plan subscription whose studio is not resolvable yet still fails so Stripe retries it.
 */

const PLATFORM_SECRET = "whsec_billingqa3_platform_test";
const CONNECT_SECRET = "whsec_billingqa3_connect_test";
const realStripe = new Stripe("sk_test_billingqa3_not_a_real_key");

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

describe("platform customer.subscription.* -> plan and studios.billing_plan (BILLING-QA-3)", () => {
  it("created on the Growth Founder Price: Growth subscription row, studio snapshot and billing_plan", async () => {
    expect(await post("customer.subscription.created", subscription({ prices: [PRICES.growth] }))).toEqual({ status: 200, text: "Webhook processed." });
    expect(subsFor("studio-1")).toEqual([expect.objectContaining({ subscription_plan_id: "plan-growth", stripe_subscription_id: "sub_1", status: "trialing", billing_interval: "month" })]);
    expect(studio("studio-1")).toMatchObject({ billing_plan: "growth", subscription_status: "trialing", stripe_subscription_id: "sub_1", stripe_customer_id: "cus_1" });
    expect(completions).toEqual([{ status: "processed", error: null }]);
  });

  it("Billing Portal change to Pro: follows the Price over stale metadata.planCode, updating the same row", async () => {
    await post("customer.subscription.created", subscription({ prices: [PRICES.growth] }));
    await post("customer.subscription.updated", subscription({ status: "active", prices: [PRICES.pro] }));
    expect(subsFor("studio-1")).toEqual([expect.objectContaining({ subscription_plan_id: "plan-pro", status: "active" })]);
    expect(studio("studio-1")).toMatchObject({ billing_plan: "pro", subscription_status: "active" });
  });

  it("grandfathered legacy Price with no planCode metadata resolves to Pro by Price alone", async () => {
    await post("customer.subscription.created", subscription({ prices: [PRICES.proLegacy], metadata: { source: "studio_subscription", studioId: "studio-1" } }));
    expect(subsFor("studio-1")[0].subscription_plan_id).toBe("plan-pro");
    expect(studio("studio-1").billing_plan).toBe("pro");
  });

  it("a subscription_plans Price match wins over the env and metadata", async () => {
    seed({
      subscription_plans: ["starter", "growth", "pro"].map((code) => ({
        id: `plan-${code}`, code, active: true, stripe_price_id_monthly: code === "starter" ? PRICES.growth : null, stripe_price_id_yearly: null,
      })),
    });
    await post("customer.subscription.created", subscription({ prices: [PRICES.growth] }));
    expect(subsFor("studio-1")[0].subscription_plan_id).toBe("plan-starter");
    expect(studio("studio-1").billing_plan).toBe("starter");
  });

  it("an add-on item listed before the plan item does not hide the plan", async () => {
    await post("customer.subscription.updated", subscription({ prices: [PRICES.addon, PRICES.pro] }));
    expect(subsFor("studio-1")[0].subscription_plan_id).toBe("plan-pro");
    expect(studio("studio-1").billing_plan).toBe("pro");
  });

  it("a Price configured for two plans never picks one: metadata.planCode decides", async () => {
    vi.stubEnv("STRIPE_PRICE_STUDIO_GROWTH_STANDARD", PRICES.pro);
    await post("customer.subscription.updated", subscription({ prices: [PRICES.pro], metadata: { source: "studio_subscription", studioId: "studio-1", planCode: "starter" } }));
    expect(subsFor("studio-1")[0].subscription_plan_id).toBe("plan-starter");
    expect(studio("studio-1").billing_plan).toBe("starter");
  });

  it("an unresolvable plan fails (500, ledger failed) and changes neither the subscription nor billing_plan", async () => {
    const result = await post("customer.subscription.updated", subscription({ prices: ["price_unknown"], metadata: { source: "studio_subscription", studioId: "studio-1" } }));
    expect(result.status).toBe(500);
    expect(subsFor("studio-1")).toHaveLength(0);
    expect(studio("studio-1").billing_plan).toBe("starter");
    expect(completions).toEqual([{ status: "failed", error: expect.stringContaining("Could not resolve subscription plan") }]);
  });

  it("cancellation keeps the last plan in billing_plan and marks the studio cancelled", async () => {
    await post("customer.subscription.created", subscription({ prices: [PRICES.growth] }));
    await post("customer.subscription.deleted", subscription({ status: "canceled", prices: [PRICES.growth] }));
    expect(subsFor("studio-1")).toEqual([expect.objectContaining({ subscription_plan_id: "plan-growth", status: "cancelled" })]);
    expect(studio("studio-1")).toMatchObject({ billing_plan: "growth", subscription_status: "cancelled" });
  });

  it("tenant isolation: only the subscription's studio is written", async () => {
    const before = JSON.parse(JSON.stringify({ studio: studio("studio-2"), subs: subsFor("studio-2") }));
    await post("customer.subscription.updated", subscription({ prices: [PRICES.starter], metadata: { source: "studio_subscription", studioId: "studio-1", planCode: "starter" } }));
    expect({ studio: studio("studio-2"), subs: subsFor("studio-2") }).toEqual(before);
    const studioWrites = fake.mutations.filter((m) => m.table === "studios");
    expect(studioWrites.every((m) => m.ids.every((id) => id === "studio-1"))).toBe(true);
  });

  it("checkout.session.completed for a plan subscription also records billing_plan", async () => {
    stripeApi.subscriptions.retrieve.mockResolvedValueOnce(subscription({ prices: [PRICES.pro], metadata: {} }));
    const session = { id: "cs_test_1", object: "checkout.session", mode: "subscription", customer: "cus_1", subscription: "sub_1", metadata: { source: "studio_subscription", studioId: "studio-1", planCode: "pro" } };
    expect((await post("checkout.session.completed", session)).status).toBe(200);
    expect(subsFor("studio-1")[0].subscription_plan_id).toBe("plan-pro");
    expect(studio("studio-1").billing_plan).toBe("pro");
  });
});

describe("platform subscriptions without a DanceFlow tenant (BILLING-QA-3)", () => {
  it("no DanceFlow metadata (e.g. made in the Stripe Dashboard): acknowledged, no write, fixed log code", async () => {
    for (const type of ["customer.subscription.created", "customer.subscription.deleted"]) {
      expect(await post(type, subscription({ prices: [PRICES.pro], metadata: {} }))).toEqual({ status: 200, text: "Webhook processed." });
    }
    expect(fake.mutations).toHaveLength(0);
    expect(completions.map((c) => c.status)).toEqual(["processed", "processed"]);
    expect(vi.mocked(console.error).mock.calls.flat().map(String)).toContain("subscription_event_unowned");
  });

  it("a DanceFlow plan subscription whose studio cannot be resolved yet still fails so Stripe retries it", async () => {
    const result = await post("customer.subscription.created", subscription({ prices: [PRICES.growth], metadata: { source: "studio_subscription", planCode: "growth" } }));
    expect(result.status).toBe(500);
    expect(fake.mutations).toHaveLength(0);
    expect(completions).toEqual([{ status: "failed", error: "subscription_event_studio_unresolved" }]);
  });

  it("a legacy platform membership subscription with studioId metadata is still recorded as before", async () => {
    await post("customer.subscription.updated", subscription({ prices: ["price_membership"], status: "active", metadata: { studioId: "studio-1", membershipPlanId: "mp-1" } }));
    expect(fake.rows("stripe_subscriptions")).toEqual([expect.objectContaining({ studio_id: "studio-1", stripe_account_id: null })]);
    expect(studio("studio-1").billing_plan).toBe("starter");
  });

  it("connected (studio membership) subscription events never touch DanceFlow plan billing", async () => {
    const result = await post("customer.subscription.updated", subscription({ prices: [PRICES.pro], status: "active" }), "acct_studio1");
    expect(result.status).toBe(200);
    expect(subsFor("studio-1")).toHaveLength(0);
    expect(studio("studio-1")).toMatchObject({ billing_plan: "starter", subscription_status: "inactive" });
    expect(fake.rows("stripe_subscriptions")).toEqual([expect.objectContaining({ studio_id: "studio-1", stripe_account_id: "acct_studio1" })]);
  });
});

describe("delayed and out-of-order platform subscription events (BILLING-QA-3)", () => {
  it("an older 'created' (Growth, trialing) delivered after the Pro upgrade does not roll the studio back", async () => {
    await post("customer.subscription.updated", subscription({ status: "active", prices: [PRICES.pro] }));
    await post("customer.subscription.created", subscription({ prices: [PRICES.growth] }), undefined, { stale: true });
    expect(subsFor("studio-1")).toEqual([expect.objectContaining({ subscription_plan_id: "plan-pro", status: "active" })]);
    expect(studio("studio-1")).toMatchObject({ billing_plan: "pro", subscription_status: "active" });
  });

  it("a late past_due update after the invoice was recovered does not revoke an active subscription", async () => {
    await post("customer.subscription.updated", subscription({ status: "active", prices: [PRICES.growth] }));
    await post("customer.subscription.updated", subscription({ status: "past_due", prices: [PRICES.growth] }), undefined, { stale: true });
    expect(subsFor("studio-1")[0].status).toBe("active");
    expect(studio("studio-1").subscription_status).toBe("active");
  });

  it("a late 'updated' arriving after cancellation does not resurrect the subscription", async () => {
    await post("customer.subscription.deleted", subscription({ status: "canceled", prices: [PRICES.growth] }));
    await post("customer.subscription.updated", subscription({ status: "active", prices: [PRICES.growth] }), undefined, { stale: true });
    expect(subsFor("studio-1")[0].status).toBe("cancelled");
    expect(studio("studio-1").subscription_status).toBe("cancelled");
  });

  it("the payload is used only when Stripe no longer knows the subscription", async () => {
    stripeState = {};
    const event = subscription({ prices: [PRICES.growth] });
    const body = eventBody("customer.subscription.created", event);
    signatureHeader = realStripe.webhooks.generateTestHeaderString({ payload: body, secret: PLATFORM_SECRET } as TestHeaderOptions);
    const response = await POST(new Request("https://example.test/api/payments/webhook", { method: "POST", body }));
    expect(response.status).toBe(200);
    expect(subsFor("studio-1")[0].subscription_plan_id).toBe("plan-growth");
  });

  it("a failed Stripe read fails the delivery (500, ledger failed) with no write, so Stripe retries it", async () => {
    stripeApi.subscriptions.retrieve.mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" }));
    const result = await post("customer.subscription.updated", subscription({ status: "active", prices: [PRICES.pro] }));
    expect(result.status).toBe(500);
    expect(fake.mutations).toHaveLength(0);
    expect(completions).toEqual([{ status: "failed", error: "socket hang up" }]);
  });

  it("connected (studio membership) events are not re-read from the platform account", async () => {
    await post("customer.subscription.updated", subscription({ prices: [PRICES.pro], status: "active" }), "acct_studio1");
    expect(stripeApi.subscriptions.retrieve).not.toHaveBeenCalled();
  });
});

describe("billing_plan only follows a plan the studio is on (BILLING-QA-3)", () => {
  it("an incomplete (never paid) Pro subscription records the subscription as inactive and leaves billing_plan alone", async () => {
    await post("customer.subscription.created", subscription({ status: "incomplete", prices: [PRICES.pro] }));
    expect(subsFor("studio-1")[0]).toMatchObject({ subscription_plan_id: "plan-pro", status: "inactive" });
    expect(studio("studio-1")).toMatchObject({ billing_plan: "starter", subscription_status: "inactive" });
  });

  it("past_due keeps following the plan; cancellation keeps the last plan", async () => {
    await post("customer.subscription.updated", subscription({ status: "past_due", prices: [PRICES.growth] }));
    expect(studio("studio-1")).toMatchObject({ billing_plan: "growth", subscription_status: "past_due" });
    await post("customer.subscription.deleted", subscription({ status: "canceled", prices: [PRICES.pro] }));
    expect(studio("studio-1")).toMatchObject({ billing_plan: "growth", subscription_status: "cancelled" });
  });
});

describe("independent review fixes (BILLING-QA-3)", () => {
  it("H1: a comped/ambassador studio keeps its override plan; the subscription is still recorded", async () => {
    await post("customer.subscription.updated", subscription({ status: "active", prices: [PRICES.starter], metadata: { source: "studio_subscription", studioId: "studio-comp", planCode: "starter" } }));
    expect(subsFor("studio-comp")).toEqual([expect.objectContaining({ subscription_plan_id: "plan-starter", status: "active" })]);
    expect(studio("studio-comp")).toMatchObject({ billing_plan: "pro", subscription_status: "active" });
  });

  it("H3: a late event about an older, cancelled subscription does not overwrite the studio's live one", async () => {
    const before = JSON.parse(JSON.stringify({ studio: studio("studio-2"), subs: subsFor("studio-2") }));
    const result = await post("customer.subscription.deleted", subscription({ id: "sub_old", customer: "cus_2", status: "canceled", prices: [PRICES.growth], metadata: { source: "studio_subscription", studioId: "studio-2" } }));
    expect(result.status).toBe(200);
    expect({ studio: studio("studio-2"), subs: subsFor("studio-2") }).toEqual(before);
    expect(fake.mutations.filter((m) => m.table === "studios" || m.table === "studio_subscriptions")).toHaveLength(0);
    expect(vi.mocked(console.error).mock.calls.flat().map(String)).toContain("subscription_event_superseded");
  });

  it("H3: a new live subscription for the studio still replaces the old one", async () => {
    await post("customer.subscription.created", subscription({ id: "sub_new", customer: "cus_2", status: "active", prices: [PRICES.growth], metadata: { source: "studio_subscription", studioId: "studio-2" } }));
    expect(subsFor("studio-2")).toEqual([expect.objectContaining({ stripe_subscription_id: "sub_new", subscription_plan_id: "plan-growth", status: "active" })]);
    expect(studio("studio-2")).toMatchObject({ billing_plan: "growth", stripe_subscription_id: "sub_new" });
  });

  it("M1: an unlabelled subscription for a customer DanceFlow already bills fails loudly (500), writing nothing", async () => {
    const result = await post("customer.subscription.created", subscription({ id: "sub_dash", customer: "cus_2", status: "active", prices: [PRICES.pro], metadata: {} }));
    expect(result.status).toBe(500);
    expect(fake.mutations).toHaveLength(0);
    expect(completions).toEqual([{ status: "failed", error: "subscription_event_unlabelled_known_customer" }]);
  });

  it("L1: trial_ends_at follows the subscription's trial end", async () => {
    await post("customer.subscription.created", subscription({ prices: [PRICES.growth], trialEnd: 1792600000 }));
    expect(studio("studio-1").trial_ends_at).toBe(new Date(1792600000 * 1000).toISOString());
  });

  it("invoice.payment_failed: records the invoice and applies Stripe's current past_due state (no plan features)", async () => {
    await post("customer.subscription.created", subscription({ prices: [PRICES.growth] }));
    stripeState.sub_1 = subscription({ status: "past_due", prices: [PRICES.growth] });
    const invoice = { id: "in_fail", object: "invoice", customer: "cus_1", subscription: "sub_1", status: "open", amount_due: 9900, amount_paid: 0, currency: "usd", lines: { data: [] } };
    expect((await post("invoice.payment_failed", invoice)).status).toBe(200);
    expect(fake.rows("studio_invoices")).toEqual([expect.objectContaining({ studio_id: "studio-1", stripe_invoice_id: "in_fail", status: "open", amount_due: 99 })]);
    expect(subsFor("studio-1")[0].status).toBe("past_due");
    expect(studio("studio-1")).toMatchObject({ subscription_status: "past_due", billing_plan: "growth" });
  });
});

describe("retries and replay protection at the delivery claim (BILLING-QA-3)", () => {
  it("a replay of an already-processed event is acknowledged with no handler, no write and no Stripe read", async () => {
    claimOutcome = "already_processed";
    const result = await post("customer.subscription.updated", subscription({ status: "active", prices: [PRICES.pro] }));
    expect(result).toEqual({ status: 200, text: "Already processed" });
    expect(fake.mutations).toHaveLength(0);
    expect(stripeApi.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(completions).toHaveLength(0);
  });

  it("a delivery another worker is still processing is answered 409 (Stripe retries it later) with no write", async () => {
    claimOutcome = "in_progress";
    const result = await post("customer.subscription.updated", subscription({ status: "active", prices: [PRICES.pro] }));
    expect(result.status).toBe(409);
    expect(fake.mutations).toHaveLength(0);
    expect(completions).toHaveLength(0);
  });

  it("a failed delivery is retried under the same event id: the first attempt writes nothing, the retry applies the state exactly once", async () => {
    const sub = subscription({ status: "active", prices: [PRICES.pro] });
    const eventId = "evt_retry_same_id";
    stripeApi.subscriptions.retrieve.mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" }));
    const first = await post("customer.subscription.updated", sub, undefined, { eventId });
    expect(first.status).toBe(500);
    expect(fake.mutations).toHaveLength(0);
    expect(completions).toEqual([{ status: "failed", error: "socket hang up" }]);

    const second = await post("customer.subscription.updated", sub, undefined, { eventId });
    expect(second).toEqual({ status: 200, text: "Webhook processed." });
    expect(subsFor("studio-1")).toEqual([expect.objectContaining({ subscription_plan_id: "plan-pro", status: "active" })]);
    expect(studio("studio-1")).toMatchObject({ billing_plan: "pro", subscription_status: "active" });
    expect(completions.map((c) => c.status)).toEqual(["failed", "processed"]);
  });

  it("re-applying the same live subscription is idempotent: one row, same plan and status", async () => {
    const sub = subscription({ status: "active", prices: [PRICES.growth] });
    await post("customer.subscription.updated", sub);
    const before = JSON.parse(JSON.stringify({ studio: studio("studio-1"), subs: subsFor("studio-1") }));
    await post("customer.subscription.updated", sub);
    const after = { studio: studio("studio-1"), subs: subsFor("studio-1") };
    expect(after.subs).toHaveLength(1);
    expect(after.subs[0]).toMatchObject({ subscription_plan_id: before.subs[0].subscription_plan_id, status: before.subs[0].status, stripe_subscription_id: before.subs[0].stripe_subscription_id });
    expect(after.studio).toMatchObject({ billing_plan: before.studio.billing_plan, subscription_status: before.studio.subscription_status });
  });
});

describe("independent review (Opus) follow-up fixes (BILLING-QA-3)", () => {
  // Stripe API 2025-03-31 (basil) and later: the billing period is on the subscription items, not on the subscription.
  const basil = (fields: Parameters<typeof subscription>[0], start: number, end: number) => {
    const copy = JSON.parse(JSON.stringify(subscription(fields)));
    delete copy.current_period_start;
    delete copy.current_period_end;
    copy.items.data = copy.items.data.map((item: object) => ({ ...item, current_period_start: start, current_period_end: end }));
    return copy;
  };
  const iso = (unix: number) => new Date(unix * 1000).toISOString();

  it("R1: a re-read subscription with the period on its items still fills current_period_start/end", async () => {
    const stale = subscription({ status: "active", prices: [PRICES.pro] }); // old-shape payload from an older-API endpoint
    stripeState.sub_1 = basil({ status: "active", prices: [PRICES.pro] }, 1791000000, 1793600000); // what the SDK's pinned version returns
    await post("customer.subscription.updated", stale, undefined, { stale: true });
    expect(subsFor("studio-1")[0]).toMatchObject({ current_period_start: iso(1791000000), current_period_end: iso(1793600000) });
  });

  it("R1: an old-shape re-read (period on the subscription) is unchanged", async () => {
    await post("customer.subscription.updated", subscription({ status: "active", prices: [PRICES.pro] }));
    expect(subsFor("studio-1")[0]).toMatchObject({ current_period_start: iso(1790000000), current_period_end: iso(1792600000) });
  });

  it("R1: the resource_missing payload fallback also lifts a period from the items, and logs that the fallback was used", async () => {
    stripeState = {};
    const payload = basil({ status: "active", prices: [PRICES.growth] }, 1791000000, 1793600000);
    const body = eventBody("customer.subscription.updated", payload);
    signatureHeader = realStripe.webhooks.generateTestHeaderString({ payload: body, secret: PLATFORM_SECRET } as TestHeaderOptions);
    expect((await POST(new Request("https://example.test/api/payments/webhook", { method: "POST", body }))).status).toBe(200);
    expect(subsFor("studio-1")[0]).toMatchObject({ current_period_start: iso(1791000000), current_period_end: iso(1793600000) });
    expect(vi.mocked(console.error).mock.calls.flat().map(String)).toContain("subscription_event_retrieve_missing");
  });

  it("R2: an organizer-plan subscription is recorded but never writes studios.billing_plan (the enum value is not assumed)", async () => {
    const result = await post("customer.subscription.created", subscription({ status: "active", prices: ["price_organizer"], metadata: { source: "organizer_subscription", studioId: "studio-1", planCode: "organizer" } }));
    expect(result.status).toBe(200);
    expect(subsFor("studio-1")[0]).toMatchObject({ subscription_plan_id: "plan-organizer", status: "active" });
    expect(studio("studio-1")).toMatchObject({ billing_plan: "starter", subscription_status: "active" });
  });

  it("a late event for an old, replaced subscription whose Price no longer resolves is skipped (200), not failed and retried", async () => {
    const before = JSON.parse(JSON.stringify({ studio: studio("studio-2"), subs: subsFor("studio-2") }));
    const result = await post("customer.subscription.deleted", subscription({ id: "sub_ancient", customer: "cus_2", status: "canceled", prices: ["price_retired_long_ago"], metadata: { source: "studio_subscription", studioId: "studio-2" } }));
    expect(result.status).toBe(200);
    expect({ studio: studio("studio-2"), subs: subsFor("studio-2") }).toEqual(before);
    expect(completions).toEqual([{ status: "processed", error: null }]);
  });

  it("an incomplete subscription with a different id is skipped while the studio's subscription is live", async () => {
    const before = JSON.parse(JSON.stringify(subsFor("studio-2")));
    await post("customer.subscription.created", subscription({ id: "sub_incomplete", customer: "cus_2", status: "incomplete", prices: [PRICES.growth], metadata: { source: "studio_subscription", studioId: "studio-2" } }));
    expect(subsFor("studio-2")).toEqual(before);
  });

  it("a different-id subscription replaces the row when the existing subscription is already cancelled (not live)", async () => {
    fake.rows("studio_subscriptions").find((row) => row.studio_id === "studio-2")!.status = "cancelled";
    await post("customer.subscription.created", subscription({ id: "sub_replacement", customer: "cus_2", status: "incomplete", prices: [PRICES.growth], metadata: { source: "studio_subscription", studioId: "studio-2" } }));
    expect(subsFor("studio-2")).toEqual([expect.objectContaining({ stripe_subscription_id: "sub_replacement", status: "inactive", subscription_plan_id: "plan-growth" })]);
  });

  it("an unlabelled subscription for a customer recorded only on studios.stripe_customer_id still fails loudly", async () => {
    fake.rows("studios").push({ id: "studio-3", billing_plan: "starter", subscription_status: "inactive", billing_override_enabled: false, stripe_customer_id: "cus_only_on_studio" });
    const result = await post("customer.subscription.created", subscription({ id: "sub_dash2", customer: "cus_only_on_studio", status: "active", prices: [PRICES.pro], metadata: {} }));
    expect(result.status).toBe(500);
    expect(fake.mutations).toHaveLength(0);
    expect(completions).toEqual([{ status: "failed", error: "subscription_event_unlabelled_known_customer" }]);
  });
});

describe("one period reading for every entry point (BILLING-QA-3, review N1)", () => {
  // Stripe API 2025-03-31 (basil) and later: the billing period is on the subscription items.
  const basilShaped = (fields: Parameters<typeof subscription>[0]) => {
    const copy = JSON.parse(JSON.stringify(subscription(fields)));
    delete copy.current_period_start;
    delete copy.current_period_end;
    copy.items.data = copy.items.data.map((item: object) => ({ ...item, current_period_start: 1791000000, current_period_end: 1793600000 }));
    return copy;
  };
  const periods = { current_period_start: new Date(1791000000 * 1000).toISOString(), current_period_end: new Date(1793600000 * 1000).toISOString() };
  const invoice = { id: "in_paid", object: "invoice", customer: "cus_1", subscription: "sub_1", status: "paid", amount_due: 9900, amount_paid: 9900, currency: "usd", lines: { data: [] } };

  it("invoice.paid after customer.subscription.updated does not blank the dates the subscription event wrote", async () => {
    await post("customer.subscription.updated", basilShaped({ status: "active", prices: [PRICES.growth] }));
    expect(subsFor("studio-1")[0]).toMatchObject(periods);
    stripeState.sub_1 = basilShaped({ status: "active", prices: [PRICES.growth] });
    expect((await post("invoice.paid", invoice)).status).toBe(200);
    expect(subsFor("studio-1")[0]).toMatchObject(periods);
  });

  it("the first write, from checkout.session.completed, already has the real dates", async () => {
    stripeApi.subscriptions.retrieve.mockResolvedValueOnce(basilShaped({ prices: [PRICES.pro], metadata: {} }));
    const session = { id: "cs_test_period", object: "checkout.session", mode: "subscription", customer: "cus_1", subscription: "sub_1", metadata: { source: "studio_subscription", studioId: "studio-1", planCode: "pro" } };
    expect((await post("checkout.session.completed", session)).status).toBe(200);
    expect(subsFor("studio-1")[0]).toMatchObject(periods);
  });

  it("invoice.payment_failed with a basil-shaped re-read keeps the dates too", async () => {
    await post("customer.subscription.created", basilShaped({ status: "active", prices: [PRICES.growth] })); // maps the customer to the studio, as in a real sequence
    stripeState.sub_1 = basilShaped({ status: "past_due", prices: [PRICES.growth] });
    const failed = { ...invoice, id: "in_failed", status: "open", amount_paid: 0 };
    expect((await post("invoice.payment_failed", failed)).status).toBe(200);
    expect(subsFor("studio-1")[0]).toMatchObject({ status: "past_due", ...periods });
  });
});
