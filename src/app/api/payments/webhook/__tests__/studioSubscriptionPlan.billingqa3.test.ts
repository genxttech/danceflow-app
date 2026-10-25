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
const stripeApi = {
  customers: { retrieve: vi.fn(async () => ({ id: "cus_1", name: "Studio One", email: "owner@example.com" })) },
  subscriptions: { retrieve: vi.fn() },
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
        { id: "studio-1", billing_plan: "starter", subscription_status: "inactive", stripe_connected_account_id: "acct_studio1" },
        { id: "studio-2", billing_plan: "pro", subscription_status: "active", stripe_customer_id: "cus_2", stripe_subscription_id: "sub_2" },
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
        if (name === "claim_payment_provider_event") return { data: { outcome: "claimed" }, error: null };
        if (name === "complete_payment_provider_event") {
          completions.push({ status: params.p_status, error: params.p_error });
          return { data: true, error: null };
        }
        return undefined;
      },
    },
  );
}

function subscription(fields: { id?: string; status?: string; prices: string[]; metadata?: Record<string, string> }) {
  return {
    id: fields.id ?? "sub_1",
    object: "subscription",
    customer: "cus_1",
    status: fields.status ?? "trialing",
    current_period_start: 1790000000,
    current_period_end: 1792600000,
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    latest_invoice: null,
    default_payment_method: null,
    items: { data: fields.prices.map((price, index) => ({ id: `si_${index + 1}`, price: { id: price }, metadata: {} })) },
    metadata: fields.metadata ?? { source: "studio_subscription", studioId: "studio-1", planCode: "growth" },
  };
}

function eventBody(type: string, object: unknown, account?: string) {
  return JSON.stringify({
    id: `evt_${Math.random().toString(36).slice(2)}`,
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

async function post(type: string, object: unknown, account?: string) {
  const body = eventBody(type, object, account);
  signatureHeader = realStripe.webhooks.generateTestHeaderString({ payload: body, secret: account ? CONNECT_SECRET : PLATFORM_SECRET } as TestHeaderOptions);
  const response = await POST(new Request("https://example.test/api/payments/webhook", { method: "POST", body }));
  return { status: response.status, text: await response.text() };
}

const studio = (id: string) => fake.rows("studios").find((row) => row.id === id)!;
const subsFor = (id: string) => fake.rows("studio_subscriptions").filter((row) => row.studio_id === id);

beforeEach(() => {
  completions = [];
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
