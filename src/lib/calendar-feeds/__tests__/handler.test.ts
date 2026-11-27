import { describe, expect, it } from "vitest";
import { clientIp, handleFeedRequest, IP_MISS_LIMIT, TOKEN_LIMIT, tryHandleFeedRequest } from "../handler";
import { generateFeedSecret, hashFeedSecret } from "../token";
import { FakeAdmin } from "./fakeAdmin";

const NOW = new Date("2026-12-01T12:00:00Z");
const S1 = "11111111-1111-4111-8111-111111111111";
const U = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function setup(opts: { resolve?: "ok" | "none" | "error"; rate?: "ok" | "deny-ip" | "deny-token" | "error"; hash?: string } = {}) {
  const admin = new FakeAdmin({
    studios: [{ id: S1, name: "Studio One", public_name: null, subscription_status: "active" }],
    instructors: [{ id: "i1", studio_id: S1, user_id: U, active: true, first_name: "Sam" }],
    user_studio_roles: [{ studio_id: S1, user_id: U, active: true, role: "instructor" }],
    appointments: [
      {
        id: "a1", studio_id: S1, title: null, appointment_type: "private_lesson", status: "scheduled",
        starts_at: "2026-12-03T18:00:00Z", ends_at: "2026-12-03T19:00:00Z", location_name: null, client_id: null,
        partner_client_id: null, instructor_id: "i1", room_id: null, updated_at: "2026-11-25T10:00:00Z", cancelled_at: null,
      },
    ],
  });
  admin.rpcHandlers.calendar_feed_rate_check = (args) => {
    if (opts.rate === "error") return { data: null, error: { message: "boom" } };
    const isIp = String(args.p_key).startsWith("ip");
    const deny = (opts.rate === "deny-ip" && isIp) || (opts.rate === "deny-token" && !isIp);
    return { data: [{ allowed: !deny, hits: 1, retry_after_seconds: 42 }], error: null };
  };
  admin.rpcHandlers.calendar_feed_resolve = (args) => {
    if (opts.resolve === "error") return { data: null, error: { message: "db down: password=hunter2" } };
    if (opts.resolve === "none") return { data: [], error: null };
    if (opts.hash && args.p_token_hash !== opts.hash) return { data: [], error: null };
    return { data: [{ token_id: "t1", studio_id: S1, subject_kind: "staff", subject_user_id: U, detail_level: "minimal", include_client_ids: null }], error: null };
  };
  return admin;
}

const req = (headers: Record<string, string> = {}) => new Request("https://example.test/calendar/feed/x.ics", { headers: { "x-forwarded-for": "203.0.113.9", ...headers } });
const deps = (admin: FakeAdmin, enabled = true) => ({ admin, now: () => NOW, enabled });

describe("feed handler", () => {
  it("serves an ICS body with safe headers for a valid token", async () => {
    const { secret } = generateFeedSecret();
    const admin = setup({ hash: hashFeedSecret(secret) });
    const res = await handleFeedRequest(req(), `${secret}.ics`, deps(admin));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    expect(res.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
    const body = await res.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("UID:a1@danceflow");
    expect(body).not.toContain(secret);
  });

  it("returns 304 for a matching If-None-Match, only after the token is re-validated", async () => {
    const { secret } = generateFeedSecret();
    const admin = setup({ hash: hashFeedSecret(secret) });
    const first = await handleFeedRequest(req(), secret, deps(admin));
    const etag = first.headers.get("etag")!;
    const second = await handleFeedRequest(req({ "if-none-match": etag }), secret, deps(admin));
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    // revoked/unknown token with a valid-looking ETag must NOT get a 304
    const gone = setup({ resolve: "none" });
    const third = await handleFeedRequest(req({ "if-none-match": etag }), secret, deps(gone));
    expect(third.status).toBe(404);
  });

  it("returns an identical 404 for disabled, malformed, unknown and revoked tokens (no hints)", async () => {
    const { secret } = generateFeedSecret();
    const results = await Promise.all([
      handleFeedRequest(req(), secret, deps(setup(), false)),
      handleFeedRequest(req(), "short", deps(setup())),
      handleFeedRequest(req(), `${secret.slice(0, 42)}!`, deps(setup())),
      handleFeedRequest(req(), secret, deps(setup({ resolve: "none" }))),
    ]);
    const bodies = await Promise.all(results.map((r) => r.text()));
    for (const r of results) {
      expect(r.status).toBe(404);
      expect(r.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toBe("Not found");
  });

  it("does not touch the database at all when disabled or the token is malformed", async () => {
    const admin = setup();
    await handleFeedRequest(req(), "short", deps(admin));
    await handleFeedRequest(req(), generateFeedSecret().secret, deps(admin, false));
    expect(admin.rpcCalls).toHaveLength(0);
    expect(admin.queries).toHaveLength(0);
  });

  it("counts only MISSES against the IP bucket and limits owned tokens per token (Retry-After on 429)", async () => {
    const { secret } = generateFeedSecret();
    // a successful fetch never touches the IP bucket
    const ok = setup({ hash: hashFeedSecret(secret) });
    await handleFeedRequest(req(), secret, deps(ok));
    expect(ok.rpcCalls.map((c) => c.fn)).toEqual(["calendar_feed_resolve", "calendar_feed_rate_check"]);
    expect(ok.rpcCalls[1].args).toMatchObject({ p_limit: TOKEN_LIMIT.limit, p_window_seconds: TOKEN_LIMIT.windowSeconds });
    expect(String(ok.rpcCalls[1].args.p_key).startsWith("tok:")).toBe(true);
    // a miss counts against the IP bucket; over the limit is a 429
    const missed = setup({ resolve: "none" });
    expect((await handleFeedRequest(req(), secret, deps(missed))).status).toBe(404);
    expect(missed.rpcCalls[1].args).toMatchObject({ p_limit: IP_MISS_LIMIT.limit, p_window_seconds: IP_MISS_LIMIT.windowSeconds });
    expect(String(missed.rpcCalls[1].args.p_key).startsWith("ipmiss:")).toBe(true);
    const ipDenied = setup({ resolve: "none", rate: "deny-ip" });
    const r1 = await handleFeedRequest(req(), secret, deps(ipDenied));
    expect(r1.status).toBe(429);
    expect(r1.headers.get("retry-after")).toBe("42");
    // an owned token over its own limit is a 429 too
    const tokDenied = setup({ rate: "deny-token" });
    const r2 = await handleFeedRequest(req(), secret, deps(tokDenied));
    expect(r2.status).toBe(429);
  });

  it("fails closed (503) when the limiter or resolver errors, without leaking error text", async () => {
    const { secret } = generateFeedSecret();
    const limiterDown = await handleFeedRequest(req(), secret, deps(setup({ rate: "error" })));
    expect(limiterDown.status).toBe(503);
    const missLimiterDown = await handleFeedRequest(req(), secret, deps(setup({ resolve: "none", rate: "error" })));
    expect(missLimiterDown.status).toBe(503);
    expect(limiterDown.headers.get("retry-after")).toBe("60");
    const resolverDown = await handleFeedRequest(req(), secret, deps(setup({ resolve: "error" })));
    expect(resolverDown.status).toBe(503);
    expect(await resolverDown.text()).not.toMatch(/hunter2|db down/);
  });

  it("returns a generic 503 when rendering fails (no database text)", async () => {
    const { secret } = generateFeedSecret();
    const admin = setup({ hash: hashFeedSecret(secret) });
    admin.from = () => {
      throw new Error("relation appointments secret detail");
    };
    const res = await handleFeedRequest(req(), secret, deps(admin));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toMatch(/relation|secret detail/);
  });

  it("limiter keys are hashed and IPs come from platform headers, IPv6 bucketed by /64", async () => {
    const { secret } = generateFeedSecret();
    const admin = setup({ resolve: "none" });
    await handleFeedRequest(req({ "x-vercel-forwarded-for": "198.51.100.7" }), secret, deps(admin));
    for (const c of admin.rpcCalls.filter((x) => x.fn === "calendar_feed_rate_check")) {
      expect(String(c.args.p_key)).not.toContain("198.51.100.7");
      expect(String(c.args.p_key).length).toBeLessThanOrEqual(128);
    }
    const r = (h: Record<string, string>) => clientIp(new Request("https://x.test", { headers: h }));
    expect(r({ "x-vercel-forwarded-for": "198.51.100.7", "x-forwarded-for": "6.6.6.6, 7.7.7.7" })).toBe("198.51.100.7");
    expect(r({ "x-forwarded-for": "6.6.6.6, 7.7.7.7" })).toBe("7.7.7.7");
    expect(r({ "x-real-ip": "2001:db8:1:2:aaaa:bbbb:cccc:dddd" })).toBe(r({ "x-real-ip": "2001:db8:1:2:1111:2222:3333:4444" }));
    expect(r({ "x-real-ip": "2001:db8:1:2::5" })).toBe("2001:db8:1:2::/64");
  });
});

describe("fall-through mode (legacy routes)", () => {
  it("returns null for every condition that would otherwise be a 404 or a fault, never counting legacy tokens against the IP bucket", async () => {
    const { secret } = generateFeedSecret();
    expect(await tryHandleFeedRequest(req(), secret, deps(setup(), false))).toBeNull();
    expect(await tryHandleFeedRequest(req(), "not-a-feed-token", deps(setup()))).toBeNull();
    const unowned = setup({ resolve: "none", rate: "deny-ip" });
    expect(await tryHandleFeedRequest(req(), secret, deps(unowned))).toBeNull();
    expect(unowned.rpcCalls.map((c) => c.fn)).toEqual(["calendar_feed_resolve"]);
    expect(await tryHandleFeedRequest(req(), secret, deps(setup({ resolve: "error" })))).toBeNull();
  });

  it("is final once the token is owned: limiter and render faults are 503, never a legacy fallback", async () => {
    const { secret } = generateFeedSecret();
    expect((await tryHandleFeedRequest(req(), secret, deps(setup({ rate: "error" }))))?.status).toBe(503);
    const broken = setup({ hash: hashFeedSecret(secret) });
    broken.from = () => {
      throw new Error("boom");
    };
    expect((await tryHandleFeedRequest(req(), secret, deps(broken)))?.status).toBe(503);
  });

  it("serves migrated tokens through the new renderer and rate limits only the tokens it owns", async () => {
    const { secret } = generateFeedSecret();
    const ok = await tryHandleFeedRequest(req(), secret, deps(setup({ hash: hashFeedSecret(secret) })));
    expect(ok?.status).toBe(200);
    expect(await ok!.text()).toContain("BEGIN:VCALENDAR");
    const limited = await tryHandleFeedRequest(req(), secret, deps(setup({ rate: "deny-token" })));
    expect(limited?.status).toBe(429);
  });
});

describe("account and workspace gate", () => {
  it("a banned account or paused workspace gets the uniform 404, also in fall-through mode (no legacy fallback)", async () => {
    const { secret } = generateFeedSecret();
    const banned = setup({ hash: hashFeedSecret(secret) });
    banned.users[U] = { id: U, banned_until: "2099-01-01T00:00:00Z" };
    const normal = await handleFeedRequest(req(), secret, deps(banned));
    expect(normal.status).toBe(404);
    expect(await normal.text()).toBe("Not found");
    expect((await tryHandleFeedRequest(req(), secret, deps(banned)))?.status).toBe(404);
    const paused = setup({ hash: hashFeedSecret(secret) });
    paused.tables.studios[0].subscription_status = "past_due";
    expect((await handleFeedRequest(req(), secret, deps(paused))).status).toBe(404);
    expect(paused.queries.map((q) => q.table)).not.toContain("appointments");
  });

  it("a failing account check is a server fault, never an allow", async () => {
    const { secret } = generateFeedSecret();
    const down = setup({ hash: hashFeedSecret(secret) });
    down.authError = { status: 500, message: "secret detail" };
    const res = await handleFeedRequest(req(), secret, deps(down));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("secret detail");
    expect((await tryHandleFeedRequest(req(), secret, deps(down)))?.status).toBe(503); // no legacy fallback once the token is owned
  });
});
