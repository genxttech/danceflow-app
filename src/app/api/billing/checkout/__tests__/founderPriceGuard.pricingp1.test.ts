import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * PRICING-P1: monthly studio checkout is fail-closed. A new Checkout Session is
 * created only when the Price ID the current offer calls for exists AND the
 * Stripe Price carries the configured amount. Existing subscribers keep going
 * to the billing portal and are never re-priced. Stripe is fully mocked.
 */

const state = vi.hoisted(() => ({
  subscriptionStatus: null as string | null,
  managedSubscription: false,
  priceAmount: 9900,
  priceActive: true,
  retrieved: [] as string[],
  stripeCalls: [] as string[],
  sessionPrice: null as string | null,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getIpFromRequest: () => "127.0.0.1",
  rateLimitKey: (...parts: string[]) => parts.join(":"),
  rateLimitedJson: () => new Response(null, { status: 429 }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1", email: "o@example.test" } } }) } }),
}));
vi.mock("@/lib/legal/agreements", () => ({ hasCurrentBusinessLegalAcceptance: async () => true }));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: "studio-1", studioRole: "studio_owner", isPlatformAdmin: false }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const rows: Record<string, unknown> = {
        studios: {
          id: "studio-1",
          name: "Test Studio",
          subscription_status: state.subscriptionStatus,
          stripe_subscription_id: state.subscriptionStatus ? "sub_1" : null,
          stripe_customer_id: "cus_1",
        },
        subscription_plans: {
          id: "plan-1",
          code: "growth",
          name: "Growth",
          stripe_price_id_monthly: "price_db_month",
          stripe_price_id_yearly: "price_db_year",
        },
        studio_billing_customers: { id: "sbc-1", stripe_customer_id: "cus_1" },
      };
      const b = {
        select: () => b,
        then: (resolve: (value: unknown) => void) => resolve({ data: table === "protected_subscriptions" ? [] : null, error: null }),
        eq: () => b,
        single: async () => ({ data: rows[table] ?? null, error: null }),
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
        upsert: async () => ({ error: null }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
      return b;
    },
  }),
}));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    prices: {
      retrieve: async (id: string) => {
        state.retrieved.push(id);
        return { id, active: state.priceActive, currency: "usd", unit_amount: state.priceAmount, recurring: { interval: "month", interval_count: 1 } };
      },
    },
    subscriptions: {
      list: async () => ({
        data: state.managedSubscription ? [{ status: "active", items: { data: [{ price: { id: "price_legacy_49" } }] } }] : [],
      }),
    },
    billingPortal: {
      sessions: {
        create: async () => {
          state.stripeCalls.push("portal");
          return { url: "https://billing.stripe.test/portal" };
        },
      },
    },
    checkout: {
      sessions: {
        create: async (args: { line_items: { price: string }[] }) => {
          state.stripeCalls.push("checkout");
          state.sessionPrice = args.line_items[0].price;
          return { id: "cs_1", url: "https://checkout.stripe.test/session" };
        },
      },
    },
    customers: { create: async () => ({ id: "cus_new" }) },
  }),
}));

import { POST } from "../route";

function post(billingInterval = "month") {
  return new NextRequest("https://app.test/api/billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ planCode: "growth", path: "studio", billingInterval }).toString(),
  });
}
const errorOf = (r: Response) => new URL(r.headers.get("location") ?? "").searchParams.get("error");

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test");
  vi.stubEnv("FOUNDER_PRICING_ACTIVE", "");
  vi.stubEnv("NEXT_PUBLIC_FOUNDER_PRICING_ACTIVE", "");
  vi.stubEnv("STRIPE_PRICE_STUDIO_GROWTH_FOUNDER", "price_founder_growth");
  vi.stubEnv("STRIPE_PRICE_STUDIO_GROWTH_STANDARD", "price_standard_growth");
  vi.stubEnv("REGULAR_PRICING_ACTIVATED", "");
  vi.stubEnv("REGULAR_PRICING_APPROVAL_REF", "");
  Object.assign(state, { subscriptionStatus: null, managedSubscription: false, priceAmount: 9900, priceActive: true, retrieved: [], stripeCalls: [], sessionPrice: null });
});

describe("PRICING-P1 studio checkout price guard", () => {
  it("charges the Founder Price when it matches $99", async () => {
    const r = await POST(post());
    expect(r.headers.get("location")).toBe("https://checkout.stripe.test/session");
    expect(state.sessionPrice).toBe("price_founder_growth");
    expect(state.retrieved).toEqual(["price_founder_growth"]);
  });

  it("refuses when the configured Founder Price is still the legacy $79 amount", async () => {
    state.priceAmount = 7900;
    const r = await POST(post());
    expect(errorOf(r)).toBe("price_mismatch");
    expect(state.stripeCalls).not.toContain("checkout");
  });

  it("refuses an inactive Stripe Price", async () => {
    state.priceActive = false;
    expect(errorOf(await POST(post()))).toBe("price_mismatch");
    expect(state.stripeCalls).not.toContain("checkout");
  });

  it("missing Founder Price ID fails closed and never falls back to standard or database prices", async () => {
    vi.stubEnv("STRIPE_PRICE_STUDIO_GROWTH_FOUNDER", "");
    const r = await POST(post());
    expect(errorOf(r)).toBe("missing_price_id");
    expect(state.stripeCalls).toEqual([]);
    expect(state.retrieved).toEqual([]);
  });

  it("Founder off without regular activation refuses rather than charging an unapproved price", async () => {
    vi.stubEnv("FOUNDER_PRICING_ACTIVE", "false");
    expect(errorOf(await POST(post()))).toBe("missing_price_id");
    expect(state.stripeCalls).toEqual([]);
  });

  it("Founder off with regular activation requires the standard Price to be exactly $149", async () => {
    vi.stubEnv("FOUNDER_PRICING_ACTIVE", "false");
    vi.stubEnv("REGULAR_PRICING_ACTIVATED", "true");
    vi.stubEnv("REGULAR_PRICING_APPROVAL_REF", "owner-approval-ref");
    state.priceAmount = 9900;
    expect(errorOf(await POST(post()))).toBe("price_mismatch");
    state.priceAmount = 14900;
    const r = await POST(post());
    expect(r.headers.get("location")).toBe("https://checkout.stripe.test/session");
    expect(state.sessionPrice).toBe("price_standard_growth");
  });

  it("existing subscribers are routed to support (D7-3a), never re-priced and never sent to a new checkout, even with no Price ID configured", async () => {
    vi.stubEnv("STRIPE_PRICE_STUDIO_GROWTH_FOUNDER", "");
    state.subscriptionStatus = "active";
    state.managedSubscription = true;
    const r = await POST(post());
    expect(r.headers.get("location")).toContain("error=plan_change_requires_support");
    expect(state.stripeCalls).toEqual([]);
    expect(state.retrieved).toEqual([]);
  });

  it("yearly checkout is unchanged (database yearly Price, no amount guard)", async () => {
    const r = await POST(post("year"));
    expect(r.headers.get("location")).toBe("https://checkout.stripe.test/session");
    expect(state.sessionPrice).toBe("price_db_year");
    expect(state.retrieved).toEqual([]);
  });
});
