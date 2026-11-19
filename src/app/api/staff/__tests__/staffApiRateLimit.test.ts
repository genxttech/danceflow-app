import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOKENS, createAdminWorldClient, createWorldClient, type AuthOutcome } from "./staffApiWorld";

/* Rate limits on the staff API guard (independent review S5, 2026-11-19). */

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, options: { global: { headers: { Authorization: string } } }) =>
    createWorldClient(options.global.headers.Authorization.replace(/^Bearer /, ""), {
      failures: {},
      authFailure: null as unknown as AuthOutcome,
    }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => createAdminWorldClient() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    throw new Error("no cookie client");
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => {
    throw new Error("no cookies");
  },
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("no redirect");
  },
}));

const { requireStaffApiUser, STAFF_API_IP_LIMIT, STAFF_API_USER_LIMIT } = await import("@/lib/auth/staffApiAuth");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  (globalThis as { __danceflowRateLimitBuckets?: Map<string, unknown> }).__danceflowRateLimitBuckets = new Map();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("S5: rate limits", () => {
  const req = (token?: string) =>
    new Request("https://app.test/api/staff/me", {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "x-forwarded-for": "203.0.113.9" },
    });

  it("answers a flat 429 with Retry-After once the per-IP limit is spent, before any token work", async () => {
    for (let i = 0; i < STAFF_API_IP_LIMIT.limit; i++) {
      const r = await requireStaffApiUser(req());
      expect(r.ok === false && r.response.status).toBe(401);
    }
    const blocked = await requireStaffApiUser(req());
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.response.status).toBe(429);
    expect(blocked.response.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(blocked.response.headers.get("cache-control")).toBe("private, no-store");
    expect(await blocked.response.json()).toEqual({ error: "Too many requests. Try again in a moment.", code: "rate_limited" });
  });

  it("limits one user from one address, and leaves another user alone", async () => {
    for (let i = 0; i < STAFF_API_USER_LIMIT.limit; i++) {
      const r = await requireStaffApiUser(req(TOKENS.ownerA));
      expect(r.ok).toBe(true);
    }
    const blocked = await requireStaffApiUser(req(TOKENS.ownerA));
    expect(blocked.ok === false && blocked.response.status).toBe(429);
    const other = await requireStaffApiUser(req(TOKENS.frontDeskA));
    expect(other.ok).toBe(true);
  });
});

