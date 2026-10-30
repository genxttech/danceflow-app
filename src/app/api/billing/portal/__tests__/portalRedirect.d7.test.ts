import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * D7-1: the billing portal answers a form POST. These tests pin the redirect
 * status (303, never the NextResponse.redirect default 307), the destination,
 * the authorization gate, and that every failure is visible and diagnosable
 * without leaking identifiers or card data. They do not mutate any subscription.
 */

const state = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  context: { studioId: "studio-1", studioRole: "studio_owner", isPlatformAdmin: false } as Record<string, unknown> | null,
  customer: "cus_server_written" as string | null,
  dbError: null as { message: string; code?: string } | null,
  stripeResult: { url: "https://billing.stripe.test/session/abc" } as { url?: string | null },
  stripeThrows: null as unknown,
  portalCalls: [] as Array<Record<string, unknown>>,
  errors: [] as unknown[][],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({
        data: state.customer ? { stripe_customer_id: state.customer } : null,
        error: state.dbError,
      }),
    };
    return { from: () => builder };
  },
}));
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => state.context }));
vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getIpFromRequest: () => "127.0.0.1",
  rateLimitKey: (...parts: string[]) => parts.join(":"),
  rateLimitedJson: () => new Response(null, { status: 429 }),
}));
// The mocked Stripe client exposes ONLY billingPortal.sessions.create: any
// subscription mutation attempted by the route would throw and fail these tests.
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    billingPortal: {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          state.portalCalls.push(params);
          if (state.stripeThrows) throw state.stripeThrows;
          return state.stripeResult;
        },
      },
    },
  }),
}));

import { POST } from "@/app/api/billing/portal/route";

function call() {
  return POST(new NextRequest("https://app.test/api/billing/portal", { method: "POST" }));
}

function reset() {
  state.user = { id: "user-1" };
  state.context = { studioId: "studio-1", studioRole: "studio_owner", isPlatformAdmin: false };
  state.customer = "cus_server_written";
  state.dbError = null;
  state.stripeResult = { url: "https://billing.stripe.test/session/abc" };
  state.stripeThrows = null;
  state.portalCalls = [];
  state.errors = [];
}

beforeEach(() => {
  reset();
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    state.errors.push(args);
  });
});

describe("billing portal redirect status and destination", () => {
  it("redirects to the Stripe session URL with 303 and creates a session with only customer and return_url", async () => {
    const response = await call();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://billing.stripe.test/session/abc");
    expect(state.portalCalls).toHaveLength(1);
    expect(Object.keys(state.portalCalls[0]).sort()).toEqual(["customer", "return_url"]);
    expect(state.portalCalls[0].customer).toBe("cus_server_written");
    expect(String(state.portalCalls[0].return_url)).toContain("/app/settings/billing");
  });

  it("uses 303 for every outcome the route can produce", async () => {
    const outcomes: Array<() => void> = [
      () => { state.user = null; },
      () => { state.context = null; },
      () => { state.context = { studioId: "studio-1", studioRole: "front_desk", isPlatformAdmin: false }; },
      () => { state.customer = null; },
      () => { state.dbError = { message: "boom" }; },
      () => { state.stripeThrows = new Error("stripe down"); },
      () => { state.stripeResult = { url: null }; },
    ];

    for (const arrange of outcomes) {
      reset();
      arrange();
      const response = await call();
      expect(response.status).toBe(303);
    }
  });
});

describe("billing portal authorization", () => {
  it("sends an unauthenticated caller to login and never reaches Stripe", async () => {
    state.user = null;
    const response = await call();
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    expect(state.portalCalls).toEqual([]);
  });

  it("sends a caller with no studio context to /app", async () => {
    state.context = null;
    const response = await call();
    expect(new URL(response.headers.get("location")!).pathname).toBe("/app");
    expect(state.portalCalls).toEqual([]);
  });

  it("tells a non-owner why (billing_owner_required) and never reaches Stripe", async () => {
    for (const role of ["studio_admin", "front_desk", "instructor"]) {
      state.context = { studioId: "studio-1", studioRole: role, isPlatformAdmin: false };
      const response = await call();
      expect(response.headers.get("location")).toContain("error=billing_owner_required");
    }
    expect(state.portalCalls).toEqual([]);
  });

  it("allows the studio owner, the organizer owner and a platform admin", async () => {
    for (const context of [
      { studioId: "studio-1", studioRole: "studio_owner", isPlatformAdmin: false },
      { studioId: "studio-1", studioRole: "organizer_owner", isPlatformAdmin: false },
      { studioId: "studio-1", studioRole: null, isPlatformAdmin: true },
    ]) {
      state.context = context;
      const response = await call();
      expect(response.headers.get("location")).toBe("https://billing.stripe.test/session/abc");
    }
  });
});

describe("billing portal error states are visible and diagnosable", () => {
  it("missing customer -> billing_customer_missing, logged with the studio id", async () => {
    state.customer = null;
    const response = await call();
    expect(response.headers.get("location")).toContain("error=billing_customer_missing");
    expect(JSON.stringify(state.errors)).toContain("studio-1");
    expect(state.portalCalls).toEqual([]);
  });

  it("database error -> billing_portal_failed", async () => {
    state.dbError = { message: "relation missing", code: "42P01" };
    const response = await call();
    expect(response.headers.get("location")).toContain("error=billing_portal_failed");
    expect(state.portalCalls).toEqual([]);
    const logged = JSON.stringify(state.errors);
    expect(logged).toContain("42P01");
    expect(logged).not.toContain("relation missing");
  });

  it("Stripe error -> billing_portal_failed, logging type/code/status but no identifiers, URLs or messages", async () => {
    state.stripeThrows = Object.assign(
      new Error("No configuration provided and your live mode default configuration has not been created. cus_server_written sk_live_SECRET"),
      { type: "StripeInvalidRequestError", code: "resource_missing", statusCode: 400, requestId: "req_123" },
    );
    const response = await call();
    expect(response.headers.get("location")).toContain("error=billing_portal_failed");

    const logged = JSON.stringify(state.errors);
    expect(logged).toContain("StripeInvalidRequestError");
    expect(logged).toContain("resource_missing");
    expect(logged).toContain("req_123");
    expect(logged).toContain("studio-1");
    expect(logged).not.toContain("cus_");
    expect(logged).not.toContain("sk_live");
    expect(logged).not.toContain("billing.stripe");
  });

  it("a session without a URL -> billing_portal_failed (no redirect to undefined)", async () => {
    state.stripeResult = { url: null };
    const response = await call();
    expect(response.headers.get("location")).toContain("error=billing_portal_failed");
  });
});

describe("why 303: the 307 hypothesis, tested rather than assumed", () => {
  it("NextResponse.redirect defaults to 307 and honors an explicit 303", () => {
    expect(NextResponse.redirect("https://billing.stripe.test/x").status).toBe(307);
    expect(NextResponse.redirect("https://billing.stripe.test/x", { status: 303 }).status).toBe(303);
  });

  it("a 307 makes the client repeat the POST at the destination; a 303 makes it a GET", async () => {
    const seen: Array<{ method: string; path: string }> = [];
    const server = createServer((req, res) => {
      seen.push({ method: req.method ?? "", path: req.url ?? "" });
      req.resume();
      if (req.url === "/start-307") {
        res.writeHead(307, { location: "/dest" }).end();
      } else if (req.url === "/start-303") {
        res.writeHead(303, { location: "/dest" }).end();
      } else {
        res.writeHead(200).end("ok");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const init = { method: "POST", body: "a=b", headers: { "content-type": "application/x-www-form-urlencoded" } };

    try {
      await fetch(`${base}/start-307`, init);
      await fetch(`${base}/start-303`, init);
    } finally {
      server.close();
    }

    const destinations = seen.filter((entry) => entry.path === "/dest").map((entry) => entry.method);
    expect(destinations).toEqual(["POST", "GET"]);
  });

  it("the route source never calls NextResponse.redirect without an explicit status", () => {
    const source = readFileSync("src/app/api/billing/portal/route.ts", "utf8");
    const calls = source.match(/NextResponse\.redirect\([^;]*;/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const redirectCall of calls) expect(redirectCall).toContain("status: 303");
  });
});
