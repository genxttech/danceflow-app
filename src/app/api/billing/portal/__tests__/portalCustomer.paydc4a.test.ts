import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/** PAY-DC-4A (S1): the billing portal opens only for the server-written billing customer. */

const state = vi.hoisted(() => ({
  adminReads: [] as Array<{ table: string; studioId: unknown }>,
  userReads: [] as string[],
  adminCustomer: "cus_server_written" as string | null,
  portalCustomers: [] as string[],
  context: { studioId: "studio-1", studioRole: "studio_owner", isPlatformAdmin: false } as Record<string, unknown>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => {
      state.userReads.push(table);
      // A tenant-controlled value the route must never use.
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: { stripe_customer_id: "cus_victim" }, error: null }),
      };
      return builder;
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      let studioId: unknown = null;
      const builder = {
        select: () => builder,
        eq: (_column: string, value: unknown) => {
          studioId = value;
          return builder;
        },
        maybeSingle: async () => {
          state.adminReads.push({ table, studioId });
          return {
            data: state.adminCustomer ? { stripe_customer_id: state.adminCustomer } : null,
            error: null,
          };
        },
      };
      return builder;
    },
  }),
}));

vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => state.context }));
vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getIpFromRequest: () => "127.0.0.1",
  rateLimitKey: (...parts: string[]) => parts.join(":"),
  rateLimitedJson: () => new Response(null, { status: 429 }),
}));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    billingPortal: {
      sessions: {
        create: async (params: { customer: string }) => {
          state.portalCustomers.push(params.customer);
          return { url: "https://billing.stripe.test/session" };
        },
      },
    },
  }),
}));

import { POST } from "@/app/api/billing/portal/route";

function call() {
  return POST(new NextRequest("https://app.test/api/billing/portal", { method: "POST" }));
}

beforeEach(() => {
  state.adminReads = [];
  state.userReads = [];
  state.portalCustomers = [];
  state.adminCustomer = "cus_server_written";
  state.context = { studioId: "studio-1", studioRole: "studio_owner", isPlatformAdmin: false };
});

describe("billing portal customer source", () => {
  it("uses the service-role mapping for the current studio, never the tenant client", async () => {
    const response = await call();
    expect(response.headers.get("location")).toBe("https://billing.stripe.test/session");
    expect(state.portalCustomers).toEqual(["cus_server_written"]);
    expect(state.adminReads).toEqual([{ table: "studio_billing_customers", studioId: "studio-1" }]);
    expect(state.userReads).toEqual([]);
  });

  it("keeps the owner billing gate (no customer read, no portal session)", async () => {
    state.context = { studioId: "studio-1", studioRole: "front_desk", isPlatformAdmin: false };
    await call();
    expect(state.adminReads).toEqual([]);
    expect(state.portalCustomers).toEqual([]);
  });

  it("keeps the missing-customer redirect", async () => {
    state.adminCustomer = null;
    const response = await call();
    expect(response.headers.get("location")).toContain("error=billing_customer_missing");
    expect(state.portalCustomers).toEqual([]);
  });
});
