import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { BILLING_PROTECTION_MESSAGES } from "@/lib/billing/billingPortalErrors";

/**
 * D7-4 (R36): a studio with protected terms (the grandfathered $129 Pro) never
 * starts a new Checkout: not after cancelling, not with a live subscription, and
 * not when the registry cannot be read. Stripe is fully mocked and exposes no
 * subscription-mutation call; the registry is read-only here.
 */

const LEGACY = "price_legacy_129";

const state = vi.hoisted(() => ({
  stripeSubs: [] as Array<{ id: string; status: string; priceId: string }>,
  registry: { kind: "rows", rows: [] } as
    | { kind: "rows"; rows: Array<{ released_at: string | null }> }
    | { kind: "error"; code: string },
  calls: [] as string[],
  warnings: [] as unknown[][],
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
        studios: { id: "studio-1", name: "Test Studio", subscription_status: null, stripe_subscription_id: null, stripe_customer_id: "cus_1" },
        subscription_plans: { id: "plan-1", code: "growth", name: "Growth", stripe_price_id_monthly: "price_month", stripe_price_id_yearly: "price_year" },
        studio_billing_customers: { id: "sbc-1", stripe_customer_id: "cus_1" },
      };
      const builder = {
        select: () => builder,
        eq: () => builder,
        then: (resolve: (value: unknown) => void) => {
          if (table !== "protected_subscriptions") return resolve({ data: null, error: null });
          return resolve(
            state.registry.kind === "error"
              ? { data: null, error: { code: state.registry.code, message: "registry" } }
              : { data: state.registry.rows, error: null },
          );
        },
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
        data: state.stripeSubs.map((sub) => ({ id: sub.id, status: sub.status, items: { data: [{ price: { id: sub.priceId } }] } })),
      }),
    },
    billingPortal: { sessions: { create: async () => { state.calls.push("portal"); return { url: "https://billing.stripe.test/p" }; } } },
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
  vi.stubEnv("STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY", LEGACY);
  state.stripeSubs = [];
  state.registry = { kind: "rows", rows: [] };
  state.calls = [];
  state.warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { state.warnings.push(args); });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("protected subscriptions never fall through to a new checkout", () => {
  it("a registry row blocks a returning studio even when Stripe lists only a canceled subscription", async () => {
    state.registry = { kind: "rows", rows: [{ released_at: null }] };
    state.stripeSubs = [{ id: "sub_old", status: "canceled", priceId: "price_other" }];
    const response = await POST(post());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("error=protected_subscription_needs_support");
    expect(state.calls).toEqual([]);
  });

  it("a registry row blocks even when Stripe lists nothing at all", async () => {
    state.registry = { kind: "rows", rows: [{ released_at: null }] };
    const response = await POST(post());
    expect(response.headers.get("location")).toContain("error=protected_subscription_needs_support");
    expect(state.calls).toEqual([]);
  });

  it("the legacy-price backstop blocks a canceled legacy subscription with an empty registry (and with the table missing)", async () => {
    state.stripeSubs = [{ id: "sub_legacy", status: "canceled", priceId: LEGACY }];
    for (const registry of [{ kind: "rows", rows: [] }, { kind: "error", code: "42P01" }, { kind: "error", code: "PGRST205" }] as const) {
      state.registry = registry;
      const response = await POST(post());
      expect(response.headers.get("location")).toContain("error=protected_subscription_needs_support");
    }
    expect(state.calls).toEqual([]);
  });

  it("a live protected subscription gets the protected message, not a portal redirect or checkout", async () => {
    state.stripeSubs = [{ id: "sub_legacy", status: "active", priceId: LEGACY }];
    const response = await POST(post());
    expect(response.headers.get("location")).toContain("error=protected_subscription_needs_support");
    expect(state.calls).toEqual([]);
  });

  it("logs the studio id and reason only", async () => {
    state.stripeSubs = [{ id: "sub_legacy", status: "canceled", priceId: LEGACY }];
    await POST(post());
    const logged = JSON.stringify(state.warnings);
    expect(logged).toContain("studio-1");
    expect(logged).toContain("legacy_price");
    expect(logged).not.toContain("cus_");
    expect(logged).not.toContain("sub_");
    expect(logged).not.toContain(LEGACY);
  });

  it("an unreadable registry fails closed (never a checkout)", async () => {
    state.registry = { kind: "error", code: "XX000" };
    const response = await POST(post());
    expect(response.headers.get("location")).toContain("error=protection_check_failed");
    expect(state.calls).toEqual([]);
  });
});

describe("unprotected studios are unaffected", () => {
  it("released registry rows do not protect", async () => {
    state.registry = { kind: "rows", rows: [{ released_at: "2026-10-01T00:00:00Z" }] };
    const response = await POST(post());
    expect(response.headers.get("location")).toBe("https://checkout.stripe.test/s");
  });

  it("a normal Founder-priced canceled subscriber and a brand-new studio can still check out; a missing table does not block", async () => {
    state.registry = { kind: "error", code: "42P01" };
    state.stripeSubs = [{ id: "sub_a", status: "canceled", priceId: "price_founder_99" }];
    expect((await POST(post())).headers.get("location")).toBe("https://checkout.stripe.test/s");

    state.stripeSubs = [];
    expect((await POST(post())).headers.get("location")).toBe("https://checkout.stripe.test/s");
  });

  it("with no legacy price configured the backstop is off but the registry still works", async () => {
    vi.stubEnv("STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY", "");
    state.stripeSubs = [{ id: "sub_legacy", status: "canceled", priceId: LEGACY }];
    expect((await POST(post())).headers.get("location")).toBe("https://checkout.stripe.test/s");

    state.registry = { kind: "rows", rows: [{ released_at: null }] };
    expect((await POST(post())).headers.get("location")).toContain("error=protected_subscription_needs_support");
  });
});

describe("messages", () => {
  it("every protection refusal code has a customer-visible message that never states a price or promises a change", () => {
    for (const code of ["protected_subscription_needs_support", "protection_check_failed"]) {
      const message = BILLING_PROTECTION_MESSAGES[code];
      expect(message).toBeTruthy();
      expect(message).not.toMatch(/\$\d/);
    }
  });
});
