import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOKENS, createAdminWorldClient, createWorldClient, type AuthOutcome } from "./staffApiWorld";

/* Rate limits on the staff API guard (independent review S5, 2026-11-19). */

const getUserCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, options: { global: { headers: { Authorization: string } } }) => {
    const client = createWorldClient(options.global.headers.Authorization.replace(/^Bearer /, ""), {
      failures: {},
      authFailure: null as unknown as AuthOutcome,
    });
    const getUser = client.auth.getUser.bind(client.auth);
    client.auth.getUser = (async (jwt: string) => {
      getUserCalls.count += 1;
      return getUser(jwt);
    }) as typeof client.auth.getUser;
    return client;
  },
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

const { requireStaffApi, requireStaffApiUser, STAFF_API_IP_LIMIT, STAFF_API_USER_LIMIT } = await import("@/lib/auth/staffApiAuth");

const STUDIO = "aaaaaaaa-0000-4000-8000-000000000001";
const buckets = () => (globalThis as { __danceflowRateLimitBuckets?: Map<string, unknown> }).__danceflowRateLimitBuckets!;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  (globalThis as { __danceflowRateLimitBuckets?: Map<string, unknown> }).__danceflowRateLimitBuckets = new Map();
  getUserCalls.count = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("S5: rate limits", () => {
  const req = (token?: string, ip: string | null = "203.0.113.9") =>
    new Request("https://app.test/api/staff/me", {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(ip ? { "x-forwarded-for": ip } : {}) },
    });

  it("answers a flat 429 with Retry-After and rate headers once the per-IP limit is spent, before any token work", async () => {
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
    expect(blocked.response.headers.get("x-ratelimit-limit")).toBe(String(STAFF_API_IP_LIMIT.limit));
    expect(blocked.response.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(blocked.response.headers.get("x-ratelimit-reset")).toMatch(/^\d+$/);
    expect(await blocked.response.json()).toEqual({ error: "Too many requests. Try again in a moment.", code: "rate_limited" });
  });

  it("makes no token verification call once the IP limit has refused the request (ordering)", async () => {
    for (let i = 0; i < STAFF_API_IP_LIMIT.limit; i++) await requireStaffApiUser(req(TOKENS.ownerA, "198.51.100.1"));
    const before = getUserCalls.count;
    expect(before).toBe(STAFF_API_IP_LIMIT.limit);
    const blocked = await requireStaffApiUser(req(TOKENS.ownerA, "198.51.100.1"));
    expect(blocked.ok === false && blocked.response.status).toBe(429);
    expect(getUserCalls.count).toBe(before);
  });

  it("limits one user, and leaves another user alone", async () => {
    for (let i = 0; i < STAFF_API_USER_LIMIT.limit; i++) {
      const r = await requireStaffApiUser(req(TOKENS.ownerA));
      expect(r.ok).toBe(true);
    }
    const blocked = await requireStaffApiUser(req(TOKENS.ownerA));
    expect(blocked.ok === false && blocked.response.status).toBe(429);
    const other = await requireStaffApiUser(req(TOKENS.frontDeskA));
    expect(other.ok).toBe(true);
  });

  it("keys the user limit by user id only: one user from many addresses shares one bucket", async () => {
    for (let i = 0; i < STAFF_API_USER_LIMIT.limit; i++) {
      const r = await requireStaffApiUser(req(TOKENS.ownerA, `192.0.2.${(i % 200) + 1}`));
      expect(r.ok).toBe(true);
    }
    const fresh = await requireStaffApiUser(req(TOKENS.ownerA, "192.0.2.250"));
    expect(fresh.ok === false && fresh.response.status).toBe(429);
    expect(fresh.ok === false && fresh.response.headers.get("retry-after")).toMatch(/^\d+$/);
    expect([...buckets().keys()].filter((k) => k.startsWith("staff-api:user:"))).toHaveLength(1);
  });

  it("recovers after the window: served again once Retry-After has passed, and not before", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
    for (let i = 0; i < STAFF_API_USER_LIMIT.limit; i++) await requireStaffApiUser(req(TOKENS.ownerA));
    const blocked = await requireStaffApiUser(req(TOKENS.ownerA));
    expect(blocked.ok === false && blocked.response.status).toBe(429);
    const retryAfter = Number(blocked.ok === false && blocked.response.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(STAFF_API_USER_LIMIT.windowMs / 1000);

    vi.advanceTimersByTime((retryAfter - 1) * 1000);
    const early = await requireStaffApiUser(req(TOKENS.ownerA));
    expect(early.ok === false && early.response.status).toBe(429);

    vi.advanceTimersByTime(2000);
    const after = await requireStaffApiUser(req(TOKENS.ownerA));
    expect(after.ok).toBe(true);
  });

  it("buckets requests with no client address header together under unknown-ip", async () => {
    for (let i = 0; i < STAFF_API_IP_LIMIT.limit; i++) await requireStaffApiUser(req(undefined, null));
    const blocked = await requireStaffApiUser(req(undefined, null));
    expect(blocked.ok === false && blocked.response.status).toBe(429);
    expect([...buckets().keys()]).toContain("staff-api:ip:unknown-ip");
    const elsewhere = await requireStaffApiUser(req(undefined, "203.0.113.77"));
    expect(elsewhere.ok === false && elsewhere.response.status).toBe(401);
  });

  it("the workspace guard (requireStaffApi) also answers the flat 429", async () => {
    for (let i = 0; i < STAFF_API_IP_LIMIT.limit; i++) await requireStaffApi(req(), STUDIO);
    const blocked = await requireStaffApi(req(), STUDIO);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.response.status).toBe(429);
    expect(await blocked.response.json()).toEqual({ error: "Too many requests. Try again in a moment.", code: "rate_limited" });
  });
});
