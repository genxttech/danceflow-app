import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  blocksNewCheckout,
  classifySubscriptionStatus,
  strongestSubscriptionState,
} from "@/lib/billing/subscriptionState";
import { BILLING_CHECKOUT_BLOCK_MESSAGES } from "@/lib/billing/billingPortalErrors";

/**
 * D7-3a: the checkout route and the billing page share one subscription-state
 * rule. A managed subscription (live) or a hold (paused / incomplete) never
 * starts a new Checkout (no second subscription, no second trial); only studios
 * with no subscription, or only terminal ones, can. Stripe is fully mocked and
 * exposes no subscription-mutation call.
 */

const state = vi.hoisted(() => ({
  stripeStatuses: [] as string[],
  studioStatus: null as string | null,
  studioSubscriptionId: null as string | null,
  calls: [] as string[],
}));

vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getIpFromRequest: () => "127.0.0.1",
  rateLimitKey: (...parts: string[]) => parts.join(":"),
  rateLimitedJson: () => new Response(null, { status: 429 }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "o@example.test" } } }) } }),
}));
vi.mock("@/lib/legal/agreements", () => ({ hasCurrentBusinessLegalAcceptance: async () => true }));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: "studio-1", studioRole: "studio_owner", isPlatformAdmin: false }),
}));
vi.mock("@/lib/billing/founderPricing", () => ({ isFounderPricingActive: () => false }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const rows: Record<string, unknown> = {
        studios: {
          id: "studio-1",
          name: "Test Studio",
          subscription_status: state.studioStatus,
          stripe_subscription_id: state.studioSubscriptionId,
          stripe_customer_id: "cus_1",
        },
        subscription_plans: {
          id: "plan-1",
          code: "growth",
          name: "Growth",
          stripe_price_id_monthly: "price_month",
          stripe_price_id_yearly: "price_year",
        },
        studio_billing_customers: { id: "sbc-1", stripe_customer_id: "cus_1" },
      };
      const builder = {
        select: () => builder,
        eq: () => builder,
        single: async () => ({ data: rows[table] ?? null, error: null }),
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
        upsert: async () => ({ error: null }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
      return builder;
    },
  }),
}));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    subscriptions: {
      list: async () => ({
        data: state.stripeStatuses.map((status) => ({ status, items: { data: [{ price: { id: "price_x" } }] } })),
      }),
    },
    billingPortal: { sessions: { create: async () => { state.calls.push("portal"); return { url: "https://billing.stripe.test/p" }; } } },
    prices: { retrieve: async () => ({ unit_amount: 9900, currency: "usd", active: true, type: "recurring", recurring: { interval: "month" } }) },
    checkout: { sessions: { create: async () => { state.calls.push("checkout"); return { id: "cs_1", url: "https://checkout.stripe.test/s" }; } } },
    customers: { create: async () => { state.calls.push("customer"); return { id: "cus_new" }; } },
  }),
}));

import { POST } from "../route";

function post() {
  return new NextRequest("https://app.test/api/billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ planCode: "growth", path: "studio", billingInterval: "year" }).toString(),
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test");
  state.stripeStatuses = [];
  state.studioStatus = null;
  state.studioSubscriptionId = null;
  state.calls = [];
});

describe("subscription state rule", () => {
  it("classifies every Stripe status", () => {
    for (const status of ["active", "trialing", "past_due", "unpaid"]) expect(classifySubscriptionStatus(status)).toBe("managed");
    for (const status of ["paused", "incomplete"]) expect(classifySubscriptionStatus(status)).toBe("hold");
    for (const status of ["canceled", "incomplete_expired", null, undefined, "not_started", ""]) expect(classifySubscriptionStatus(status)).toBe("none");
    expect(blocksNewCheckout("managed")).toBe(true);
    expect(blocksNewCheckout("hold")).toBe(true);
    expect(blocksNewCheckout("none")).toBe(false);
  });

  it("takes the strongest state across subscriptions", () => {
    expect(strongestSubscriptionState(["canceled", "paused", "active"])).toBe("managed");
    expect(strongestSubscriptionState(["canceled", "incomplete"])).toBe("hold");
    expect(strongestSubscriptionState(["canceled", "incomplete_expired"])).toBe("none");
    expect(strongestSubscriptionState([])).toBe("none");
  });
});

describe("checkout is fail-closed for existing and half-created subscriptions", () => {
  it.each(["active", "trialing", "past_due", "unpaid"])("Stripe %s -> plan_change_requires_support, no checkout, no portal", async (status) => {
    state.stripeStatuses = [status];
    const response = await POST(post());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("error=plan_change_requires_support");
    expect(state.calls).toEqual([]);
  });

  it.each(["paused", "incomplete"])("Stripe %s -> subscription_needs_support, no second subscription or trial", async (status) => {
    state.stripeStatuses = [status];
    const response = await POST(post());
    expect(response.headers.get("location")).toContain("error=subscription_needs_support");
    expect(state.calls).toEqual([]);
  });

  it("stale local status (canceled) while Stripe has a live subscription is still blocked", async () => {
    state.studioStatus = "canceled";
    state.studioSubscriptionId = "sub_1";
    state.stripeStatuses = ["active"];
    const response = await POST(post());
    expect(response.headers.get("location")).toContain("error=plan_change_requires_support");
    expect(state.calls).toEqual([]);
  });

  it("local paused/incomplete studio with a subscription id is blocked even if Stripe lists nothing", async () => {
    state.studioSubscriptionId = "sub_1";
    for (const status of ["paused", "incomplete"]) {
      state.studioStatus = status;
      const response = await POST(post());
      expect(response.headers.get("location")).toContain("error=subscription_needs_support");
    }
    expect(state.calls).toEqual([]);
  });

  it("a mix of terminal and live subscriptions is blocked by the live one", async () => {
    state.stripeStatuses = ["canceled", "paused", "past_due"];
    const response = await POST(post());
    expect(response.headers.get("location")).toContain("error=plan_change_requires_support");
  });

  it("only terminal subscriptions can start a new checkout", async () => {
    state.stripeStatuses = ["canceled", "incomplete_expired"];
    const response = await POST(post());
    expect(response.headers.get("location")).toBe("https://checkout.stripe.test/s");
    expect(state.calls).toEqual(["checkout"]);
  });

  it("no subscription at all can start a checkout, and a no-card trial (status without a subscription id) still can", async () => {
    let response = await POST(post());
    expect(response.headers.get("location")).toBe("https://checkout.stripe.test/s");

    state.calls = [];
    state.studioStatus = "trialing";
    state.studioSubscriptionId = null;
    response = await POST(post());
    expect(response.headers.get("location")).toBe("https://checkout.stripe.test/s");
  });
});

describe("page and checkout use the same rule", () => {
  it("both import the shared subscription state module and keep no private copy", () => {
    const page = readFileSync("src/app/app/settings/billing/page.tsx", "utf8");
    const route = readFileSync("src/app/api/billing/checkout/route.ts", "utf8");
    expect(page).toContain("@/lib/billing/subscriptionState");
    expect(route).toContain("@/lib/billing/subscriptionState");
    expect(page).not.toMatch(/function isManagedSubscriptionStatus/);
    expect(route).not.toMatch(/function isManagedSubscriptionStatus/);
    expect(page).toContain("blocksNewCheckout");
  });

  it("the refusal codes have customer-visible messages and the page renders them", () => {
    const route = readFileSync("src/app/api/billing/checkout/route.ts", "utf8");
    for (const code of ["plan_change_requires_support", "subscription_needs_support"]) {
      expect(route).toContain(code);
      expect(BILLING_CHECKOUT_BLOCK_MESSAGES[code]).toBeTruthy();
    }
    expect(readFileSync("src/app/app/settings/billing/page.tsx", "utf8")).toContain("...BILLING_CHECKOUT_BLOCK_MESSAGES");
  });
});
