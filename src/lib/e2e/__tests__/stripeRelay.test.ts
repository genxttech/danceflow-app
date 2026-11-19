import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { verifyStripeWebhook } from "@/lib/payments/webhookVerification";
import {
  assertRelayTarget, assertTestKey, makePost, redactSecrets, buildDeliveryBody, deliverEvent, oldestFirst, runRelay, selectUnseen, signStripePayload,
  type RelayEvent,
} from "../stripeRelay";

const SECRET = "whsec_unit_test_secret_value";
const ACCOUNT = "acct_TESTCONNECTED1";
const URL_OK = "http://127.0.0.1:3000/api/payments/webhook";
const stripe = new Stripe("sk_test_unit", { apiVersion: undefined });

const event = (id: string, created: number, type = "charge.succeeded", account?: string): RelayEvent =>
  ({ id, object: "event", type, created, ...(account ? { account } : {}), data: { object: { id: `obj_${id}` } } });

describe("signing is accepted by the app's real verifier", () => {
  it("a delivered body verifies as a Connect event under the connect secret", () => {
    const body = buildDeliveryBody(event("evt_1", 100), ACCOUNT);
    const signature = signStripePayload(body, SECRET, Math.floor(Date.now() / 1000));
    const result = verifyStripeWebhook({ body, signature, platformSecret: undefined, connectSecret: SECRET, stripe });
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.scope).toBe("connect"); expect(result.event.id).toBe("evt_1"); expect(result.event.account).toBe(ACCOUNT); }
  });
  it("a wrong secret, a tampered body and a stale timestamp are all rejected", () => {
    const body = buildDeliveryBody(event("evt_2", 100), ACCOUNT);
    const now = Math.floor(Date.now() / 1000);
    const bad = (b: string, s: string) => verifyStripeWebhook({ body: b, signature: s, platformSecret: undefined, connectSecret: SECRET, stripe }).ok;
    expect(bad(body, signStripePayload(body, "whsec_other", now))).toBe(false);
    expect(bad(body + " ", signStripePayload(body, SECRET, now))).toBe(false);
    expect(bad(body, signStripePayload(body, SECRET, now - 3600))).toBe(false);
  });
  it("the body is deterministic (a replay is byte-identical) and keeps an account the event already has", () => {
    const e = event("evt_3", 5);
    expect(buildDeliveryBody(e, ACCOUNT)).toBe(buildDeliveryBody({ ...e }, ACCOUNT));
    expect(JSON.parse(buildDeliveryBody(event("evt_4", 5, "charge.succeeded", "acct_OTHER"), ACCOUNT)).account).toBe("acct_OTHER");
  });
});

describe("guards", () => {
  it("only a loopback plain-http webhook target is allowed", () => {
    expect(assertRelayTarget(URL_OK).port).toBe("3000");
    for (const bad of ["https://127.0.0.1:3000/api/payments/webhook", "http://example.com/api/payments/webhook", "http://127.0.0.1:3000/other", "http://www.idanceflow.com/api/payments/webhook", "nope"]) {
      expect(() => assertRelayTarget(bad)).toThrow();
    }
  });
  it("only a TEST key shape is allowed", () => {
    expect(() => assertTestKey("sk_test_abc123")).not.toThrow();
    expect(() => assertTestKey("rk_test_abc123")).not.toThrow();
    for (const bad of ["sk_live_abc123", "rk_live_abc123", "pk_test_abc", "", "sk_test_"]) expect(() => assertTestKey(bad)).toThrow();
  });
});

describe("redaction", () => {
  it("masks keys, webhook secrets and JWTs in any text", () => {
    const text = "Invalid API Key provided: sk_test_****abcd and rk_live_ZZZ111 whsec_abc123 Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.c2lnbmF0dXJl end";
    const out = redactSecrets(text);
    expect(out).not.toMatch(/sk_test_|rk_live_|whsec_|eyJ/);
    expect(out).toContain("[redacted-key]");
    expect(out).toContain("[redacted-secret]");
    expect(out).toContain("[redacted-jwt]");
    expect(redactSecrets("nothing secret here: acct_123")).toBe("nothing secret here: acct_123");
  });
});

describe("ordering helpers", () => {
  it("delivers oldest first, ties by id, and drops seen events", () => {
    const list = [event("evt_c", 3), event("evt_b", 2), event("evt_a2", 2), event("evt_a", 1)];
    expect(oldestFirst(list).map((e) => e.id)).toEqual(["evt_a", "evt_a2", "evt_b", "evt_c"]);
    expect(selectUnseen(list, new Set(["evt_b"])).map((e) => e.id)).toEqual(["evt_c", "evt_a2", "evt_a"]);
  });
});

describe("relay loop", () => {
  const harness = (events: () => RelayEvent[], respond: (e: { id: string; n: number }) => number, opts: { paused?: () => boolean; maxPolls?: number } = {}) => {
    const delivered: Array<{ id: string; status: number }> = [];
    const attempts = new Map<string, number>();
    const logs: string[] = [];
    let sleeps = 0;
    const run = () => runRelay({
      url: URL_OK, secret: SECRET, account: ACCOUNT, startedAtSeconds: 1000, pollMs: 1, maxPolls: opts.maxPolls ?? 3,
      deps: {
        listEvents: async () => events(),
        post: async ({ body }) => {
          const id = JSON.parse(body).id as string;
          const n = (attempts.get(id) ?? 0) + 1;
          attempts.set(id, n);
          const status = respond({ id, n });
          delivered.push({ id, status });
          return status;
        },
        isPaused: () => opts.paused?.() ?? false,
        sleep: async () => { sleeps += 1; },
        shouldStop: () => false,
        log: (line) => logs.push(line),
        nowSeconds: () => 2000,
      },
    });
    return { run, delivered, logs, sleeps: () => sleeps };
  };

  it("delivers each event exactly once and in creation order across polls", async () => {
    const h = harness(() => [event("evt_2", 1002), event("evt_1", 1001), event("evt_3", 1003)], () => 200);
    const stats = await h.run();
    expect(h.delivered.map((d) => d.id)).toEqual(["evt_1", "evt_2", "evt_3"]);
    expect(stats).toMatchObject({ polls: 3, delivered: 3, okResponses: 3, serverErrors: 0, clientErrors: 0, stoppedBy: "maxPolls" });
  });

  it("retries a 5xx on the next poll (the event is not marked seen) and stops the batch at the failing event", async () => {
    const h = harness(() => [event("evt_1", 1001), event("evt_2", 1002)], ({ id, n }) => (id === "evt_1" && n === 1 ? 500 : 200));
    const stats = await h.run();
    expect(h.delivered.map((d) => `${d.id}:${d.status}`)).toEqual(["evt_1:500", "evt_1:200", "evt_2:200"]);
    expect(stats.serverErrors).toBe(1);
    expect(stats.retried).toBe(1);
  });

  it("a poison event that always fails is given up on after five attempts and does not stall the events behind it", async () => {
    const h = harness(() => [event("evt_bad", 1001), event("evt_ok", 1002)], ({ id }) => (id === "evt_bad" ? 503 : 200), { maxPolls: 8 });
    const stats = await h.run();
    expect(h.delivered.filter((d) => d.id === "evt_bad")).toHaveLength(5);
    expect(h.delivered.filter((d) => d.id === "evt_ok")).toHaveLength(1);
    expect(stats).toMatchObject({ gaveUp: 1, serverErrors: 5 });
  });

  it("a 4xx is counted and not retried", async () => {
    const h = harness(() => [event("evt_1", 1001)], () => 400);
    const stats = await h.run();
    expect(h.delivered).toHaveLength(1);
    expect(stats.clientErrors).toBe(1);
  });

  it("while paused nothing is listed, delivered or marked seen; afterwards the events are delivered", async () => {
    let polls = 0;
    const h = harness(() => [event("evt_1", 1001)], () => 200, { paused: () => { polls += 1; return polls <= 2; }, maxPolls: 2 });
    const stats = await h.run();
    expect(stats.paused).toBeGreaterThanOrEqual(1);
    expect(h.delivered.map((d) => d.id)).toEqual(["evt_1"]);
  });

  it("a replay of an event with the same body is accepted and counted, not duplicated by the relay itself", async () => {
    const e = event("evt_1", 1001);
    const results: number[] = [];
    const post = async ({ body, signature }: { url: string; body: string; signature: string }) => {
      results.push(verifyStripeWebhook({ body, signature, platformSecret: undefined, connectSecret: SECRET, stripe }).ok ? 200 : 400);
      return results[results.length - 1];
    };
    const first = await deliverEvent({ url: URL_OK, secret: SECRET, event: e, account: ACCOUNT, post });
    const second = await deliverEvent({ url: URL_OK, secret: SECRET, event: e, account: ACCOUNT, post });
    expect([first.status, second.status]).toEqual([200, 200]);
  });
});

describe("redirects are never followed (security review, PR 683)", () => {
  type Hit = { method: string; url: string; body: string };

  /** Two loopback servers: A (the validated target) answers with the given redirect; B (the redirect destination) records every request it receives. */
  async function withServers(status: number, run: (a: string, hits: Hit[]) => Promise<void>) {
    const { createServer } = await import("node:http");
    const hits: Hit[] = [];
    const b = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => { hits.push({ method: String(req.method), url: String(req.url), body }); res.statusCode = 200; res.end("ok"); });
    });
    await new Promise<void>((resolve) => b.listen(0, "127.0.0.1", resolve));
    const bPort = (b.address() as { port: number }).port;
    const a = createServer((req, res) => {
      req.resume();
      req.on("end", () => { res.statusCode = status; res.setHeader("location", `http://127.0.0.1:${bPort}/steal`); res.end(); });
    });
    await new Promise<void>((resolve) => a.listen(0, "127.0.0.1", resolve));
    const aPort = (a.address() as { port: number }).port;
    try { await run(`http://127.0.0.1:${aPort}/api/payments/webhook`, hits); }
    finally { await Promise.all([a, b].map((s) => new Promise<void>((resolve) => s.close(() => resolve())))); }
  }

  it.each([301, 302, 303, 307, 308])("a %i response is returned as a status, the signed body is NOT replayed to the redirect target", async (status) => {
    await withServers(status, async (target, hits) => {
      const result = await makePost()({ url: target, body: '{"id":"evt_1"}', signature: "t=1,v1=abc" });
      expect(result).toBe(status);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(hits).toEqual([]);
    });
  });

  it("the fetch is always called with redirect: manual, and the target is re-validated on every delivery", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const spy = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response("ok", { status: 200 }); }) as unknown as typeof fetch;
    await makePost(spy)({ url: URL_OK, body: "{}", signature: "s" });
    expect(calls).toHaveLength(1);
    expect(calls[0].init.redirect).toBe("manual");
    for (const bad of ["https://127.0.0.1:3000/api/payments/webhook", "http://example.com/api/payments/webhook", "http://127.0.0.1:3000/redirected"]) {
      await expect(makePost(spy)({ url: bad, body: "{}", signature: "s" })).rejects.toThrow(/refusing/);
    }
    expect(calls).toHaveLength(1);
  });

  it("the relay loop counts a 3xx as a failure (not ok), does not retry it, and logs that it was not followed", async () => {
    const logs: string[] = [];
    const stats = await runRelay({
      url: URL_OK, secret: SECRET, account: ACCOUNT, startedAtSeconds: 1000, pollMs: 1, maxPolls: 3,
      deps: {
        listEvents: async () => [event("evt_r", 1001)], post: async () => 302, isPaused: () => false, sleep: async () => undefined,
        shouldStop: () => false, log: (line) => logs.push(line), nowSeconds: () => 2000,
      },
    });
    expect(stats).toMatchObject({ delivered: 1, okResponses: 0, clientErrors: 1, serverErrors: 0 });
    expect(logs.join("\n")).toMatch(/redirect not followed/);
  });
});
