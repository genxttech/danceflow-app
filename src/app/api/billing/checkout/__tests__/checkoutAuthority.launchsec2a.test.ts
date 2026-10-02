import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * LAUNCH-SEC-2A (#1): the plan checkout route is an owner-level billing
 * action on both of its branches (new plan checkout, and the Stripe billing
 * portal when a subscription already exists). Studio membership alone must
 * not reach either, and a denied caller must not touch the service role or
 * Stripe at all.
 */

const state = vi.hoisted(() => ({
  user: { id: "user-1", email: "owner@example.test" } as { id: string; email: string } | null,
  context: { studioId: "studio-1", studioRole: "studio_owner", isPlatformAdmin: false } as Record<string, unknown> | null,
  subscriptionStatus: null as string | null,
  managedSubscription: false,
  adminTables: [] as string[],
  stripeCalls: [] as string[],
}));

vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getIpFromRequest: () => "127.0.0.1",
  rateLimitKey: (...parts: string[]) => parts.join(":"),
  rateLimitedJson: () => new Response(null, { status: 429 }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}));

vi.mock("@/lib/legal/agreements", () => ({
  hasCurrentBusinessLegalAcceptance: async () => true,
}));

vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => state.context,
}));

vi.mock("@/lib/billing/founderPricing", () => ({ isFounderPricingActive: () => false }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      state.adminTables.push(table);
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
      list: async () => {
        state.stripeCalls.push("subscriptions.list");
        return {
          data: state.managedSubscription
            ? [{ status: "active", items: { data: [{ price: { id: "price_year" } }] } }]
            : [],
        };
      },
    },
    billingPortal: {
      sessions: {
        create: async () => {
          state.stripeCalls.push("billingPortal.sessions.create");
          return { url: "https://billing.stripe.test/portal" };
        },
      },
    },
    checkout: {
      sessions: {
        create: async () => {
          state.stripeCalls.push("checkout.sessions.create");
          return { id: "cs_1", url: "https://checkout.stripe.test/session" };
        },
      },
    },
    customers: {
      create: async () => {
        state.stripeCalls.push("customers.create");
        return { id: "cus_new" };
      },
    },
  }),
}));

import { GET, POST } from "../route";

function postRequest() {
  const body = new URLSearchParams({ planCode: "growth", path: "studio", billingInterval: "year" });
  return new NextRequest("https://app.test/api/billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

function getRequest() {
  return new NextRequest(
    "https://app.test/api/billing/checkout?planCode=growth&path=studio&billingInterval=year",
  );
}

function setRole(studioRole: string, isPlatformAdmin = false) {
  state.context = { studioId: "studio-1", studioRole, isPlatformAdmin };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test");
  state.user = { id: "user-1", email: "owner@example.test" };
  setRole("studio_owner");
  state.subscriptionStatus = null;
  state.managedSubscription = false;
  state.adminTables = [];
  state.stripeCalls = [];
});

describe("LAUNCH-SEC-2A billing checkout authority", () => {
  it.each(["studio_owner", "organizer_owner"])("%s can start a plan checkout", async (role) => {
    setRole(role);
    const response = await POST(postRequest());
    expect(response.headers.get("location")).toBe("https://checkout.stripe.test/session");
    expect(state.stripeCalls).toContain("checkout.sessions.create");
  });

  it("a platform admin keeps the existing billing authority", async () => {
    setRole("platform_admin", true);
    const response = await POST(postRequest());
    expect(response.headers.get("location")).toBe("https://checkout.stripe.test/session");
  });

  it("the owner still reaches the billing portal for an existing subscription", async () => {
    state.subscriptionStatus = "active";
    state.managedSubscription = true;
    const response = await POST(postRequest());
    expect(response.headers.get("location")).toBe("https://billing.stripe.test/portal");
  });

  it.each([
    "instructor",
    "front_desk",
    "studio_admin",
    "organizer_admin",
    "organizer_staff",
    "independent_instructor",
    "client",
  ])("%s is denied before any service-role or Stripe call (POST and GET)", async (role) => {
    setRole(role);
    state.subscriptionStatus = "active";
    state.managedSubscription = true;

    for (const response of [await POST(postRequest()), await GET(getRequest())]) {
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.pathname).toBe("/app/settings/billing");
      expect(location.searchParams.get("error")).toBe("billing_owner_required");
    }

    expect(state.adminTables).toEqual([]);
    expect(state.stripeCalls).toEqual([]);
  });

  it("a missing role is denied", async () => {
    state.context = { studioId: "studio-1", studioRole: null, isPlatformAdmin: false };
    const response = await POST(postRequest());
    expect(new URL(response.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "billing_owner_required",
    );
    expect(state.stripeCalls).toEqual([]);
  });

  it("an unauthenticated caller is sent to login", async () => {
    state.user = null;
    const response = await POST(postRequest());
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/login");
    expect(state.adminTables).toEqual([]);
    expect(state.stripeCalls).toEqual([]);
  });
});
