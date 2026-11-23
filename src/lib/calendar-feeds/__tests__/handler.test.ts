import { describe, expect, it } from "vitest";
import { handleFeedRequest, IP_LIMIT, TOKEN_LIMIT } from "../handler";
import { generateFeedSecret, hashFeedSecret } from "../token";
import { FakeAdmin } from "./fakeAdmin";

const NOW = new Date("2026-12-01T12:00:00Z");
const S1 = "11111111-1111-4111-8111-111111111111";
const U = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function setup(opts: { resolve?: "ok" | "none" | "error"; rate?: "ok" | "deny-ip" | "deny-token" | "error"; hash?: string } = {}) {
  const admin = new FakeAdmin({
    studios: [{ id: S1, name: "Studio One", public_name: null }],
    instructors: [{ id: "i1", studio_id: S1, user_id: U, active: true, first_name: "Sam" }],
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
    const isIp = String(args.p_key).startsWith("ip:");
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

  it("rate limits per IP and per token with Retry-After, before resolving the token", async () => {
    const { secret } = generateFeedSecret();
    const ipDenied = setup({ rate: "deny-ip" });
    const r1 = await handleFeedRequest(req(), secret, deps(ipDenied));
    expect(r1.status).toBe(429);
    expect(r1.headers.get("retry-after")).toBe("42");
    expect(ipDenied.rpcCalls.map((c) => c.fn)).not.toContain("calendar_feed_resolve");
    const tokDenied = setup({ rate: "deny-token" });
    const r2 = await handleFeedRequest(req(), secret, deps(tokDenied));
    expect(r2.status).toBe(429);
    expect(tokDenied.rpcCalls.map((c) => c.fn)).not.toContain("calendar_feed_resolve");
    const limits = setup({ hash: hashFeedSecret(secret) });
    await handleFeedRequest(req(), secret, deps(limits));
    expect(limits.rpcCalls[0].args).toMatchObject({ p_limit: IP_LIMIT.limit, p_window_seconds: IP_LIMIT.windowSeconds });
    expect(limits.rpcCalls[1].args).toMatchObject({ p_limit: TOKEN_LIMIT.limit, p_window_seconds: TOKEN_LIMIT.windowSeconds });
    expect(String(limits.rpcCalls[1].args.p_key)).not.toContain(secret);
  });

  it("fails closed (503) when the limiter or resolver errors, without leaking error text", async () => {
    const { secret } = generateFeedSecret();
    const limiterDown = await handleFeedRequest(req(), secret, deps(setup({ rate: "error" })));
    expect(limiterDown.status).toBe(503);
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

  it("limiter keys are hashed (no raw IP or token in keys)", async () => {
    const { secret } = generateFeedSecret();
    const admin = setup({ hash: hashFeedSecret(secret) });
    await handleFeedRequest(req(), secret, deps(admin));
    for (const c of admin.rpcCalls.filter((x) => x.fn === "calendar_feed_rate_check")) {
      expect(String(c.args.p_key)).not.toContain("203.0.113.9");
      expect(String(c.args.p_key).length).toBeLessThanOrEqual(128);
    }
  });
});
