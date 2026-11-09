import { afterEach, describe, expect, it } from "vitest";
import { STRIPE_API_VERSION } from "../config";
import { createGuardedClient, pinned } from "../guarded";
import { createNodeTransport } from "../transport";
import type { ProofRequest } from "../types";
import { startLoopback } from "./loopback";

// The real transport, exercised against a loopback server that counts the requests that actually arrive. Answers "can the client silently re-send a request?"
// (the open undici caveat): with node:https, agent:false and Connection: close, one call is exactly one request on a fresh connection.

const KEY = ["rk", "test", "LOOPBACKKEY0123456789"].join("_");
const CONNECTED = "acct_CONNECTEDTEST1";
const open: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { while (open.length) await open.pop()!.close(); });
const srv = async (b?: Parameters<typeof startLoopback>[0]) => { const s = await startLoopback(b); open.push(s); return s; };
const get = (path = "/v1/account"): ProofRequest => ({ method: "GET", path, stripeVersion: STRIPE_API_VERSION });
const post: ProofRequest = {
  method: "POST", path: "/v1/customers", stripeAccount: CONNECTED, stripeVersion: STRIPE_API_VERSION, idempotencyKey: "d24proof-lb-1", body: { name: "n", email: "d24-proof-abc123-a@example.com", "metadata[d24_intent_id]": "i1" },
};

describe("node transport: what leaves the client", () => {
  it("one call is exactly one request, each on its own connection (no pooling, no keep-alive reuse), for GET and POST", async () => {
    const s = await srv();
    const t = createNodeTransport({ origin: s.origin });
    for (let i = 0; i < 4; i++) await t(i % 2 ? post : get(), KEY);
    expect(s.requests).toHaveLength(4);
    expect(new Set(s.requests.map((r) => r.socketId)).size).toBe(4);
    for (const r of s.requests) expect(r.headers.connection).toBe("close");
  });
  it("sends exactly the intended headers and form body, and nothing else", async () => {
    const s = await srv();
    await createNodeTransport({ origin: s.origin })(post, KEY);
    const r = s.requests[0];
    expect(r.method).toBe("POST");
    expect(r.url).toBe("/v1/customers");
    expect(r.body).toBe("name=n&email=d24-proof-abc123-a%40example.com&metadata%5Bd24_intent_id%5D=i1");
    expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(r.headers["stripe-version"]).toBe(STRIPE_API_VERSION);
    expect(r.headers["stripe-account"]).toBe(CONNECTED);
    expect(r.headers["idempotency-key"]).toBe("d24proof-lb-1");
    expect(r.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const allowed = new Set(["host", "authorization", "accept", "connection", "stripe-account", "stripe-version", "idempotency-key", "content-type", "content-length"]);
    expect(Object.keys(r.headers).filter((h) => !allowed.has(h))).toEqual([]);
  });
  it("identity GETs carry no Stripe-Account, no Idempotency-Key and no content headers; the values sent equal the request fields", async () => {
    const s = await srv();
    const tr = createNodeTransport({ origin: s.origin });
    await tr(get(), KEY);
    await tr({ method: "GET", path: "/v1/invoices/in_ABC123", stripeAccount: CONNECTED, stripeVersion: STRIPE_API_VERSION }, KEY);
    const [idRead, invRead] = s.requests;
    for (const h of ["stripe-account", "idempotency-key", "content-type", "content-length"]) expect(idRead.headers[h], h).toBeUndefined();
    expect(idRead.headers["stripe-version"]).toBe(STRIPE_API_VERSION);
    expect(invRead.headers["stripe-account"]).toBe(CONNECTED);
    expect(invRead.headers["idempotency-key"]).toBeUndefined();
  });
  it("a GET carries its query and no body or content headers", async () => {
    const s = await srv();
    await createNodeTransport({ origin: s.origin })({ method: "GET", path: "/v1/invoices", stripeAccount: CONNECTED, stripeVersion: STRIPE_API_VERSION, query: { customer: "cus_ABC123", limit: "100" } }, KEY);
    expect(s.requests[0].url).toBe("/v1/invoices?customer=cus_ABC123&limit=100");
    expect(s.requests[0].headers["content-type"]).toBeUndefined();
  });
  it("parses status, request id, Stripe-Version and the replay header", async () => {
    const s = await srv();
    const t = createNodeTransport({ origin: s.origin });
    await t(post, KEY);
    const second = await t(post, KEY);
    expect(second).toMatchObject({ status: 200, stripeVersion: STRIPE_API_VERSION, replayed: true, json: { id: "acct_LOOPBACK1" } });
    expect(second.requestId).toMatch(/^req_loop/);
  });
});

describe("node transport: failures are surfaced once and never retried", () => {
  it("a connection reset mid-flight rejects once and the server saw exactly ONE request (GET and POST)", async () => {
    for (const req of [get(), post]) {
      const s = await srv(() => "reset");
      await expect(createNodeTransport({ origin: s.origin })(req, KEY)).rejects.toBeTruthy();
      expect(s.requests).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 100)); // time for any (unwanted) silent retry to arrive
      expect(s.requests).toHaveLength(1);
    }
  });
  it("through the guard, a lost POST is recorded as unverifiable and is not re-sent", async () => {
    const s = await srv(() => "reset");
    const client = createGuardedClient({ transport: createNodeTransport({ origin: s.origin }), apiKey: KEY, connectedAcct: CONNECTED, paceMs: 0 });
    client.markIdentityVerified();
    await expect(pinned(client, { method: "POST", path: "/v1/customers", stripeAccount: CONNECTED, idempotencyKey: "d24proof-lb-2", body: { name: "n", email: "d24-proof-abc123-a@example.com" } })).rejects.toBeTruthy();
    expect(client.uncertain).toHaveLength(1);
    expect(s.requests).toHaveLength(1);
  });
  it("redirects are not followed (a 302 is returned as is; the second URL is never requested)", async () => {
    const s = await srv(() => "redirect");
    const res = await createNodeTransport({ origin: s.origin })(get(), KEY);
    expect(res.status).toBe(302);
    expect(s.requests).toHaveLength(1);
  });
  it("a hung request times out with an error, once", async () => {
    const s = await srv(() => "hang");
    await expect(createNodeTransport({ origin: s.origin, timeoutMs: 150 })(get(), KEY)).rejects.toThrow(/timed out/);
    expect(s.requests).toHaveLength(1);
  });
  it("a slow-drip response (a byte every 40 ms) is cut off by the ABSOLUTE deadline, not just the idle timer", async () => {
    const s = await srv(() => "drip");
    const started = Date.now();
    await expect(createNodeTransport({ origin: s.origin, timeoutMs: 250 })(get(), KEY)).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(s.requests).toHaveLength(1);
  });
  it("an unparseable body gives json:null, and an oversized body is rejected", async () => {
    const g = await srv(() => "garbage");
    expect((await createNodeTransport({ origin: g.origin })(get(), KEY)).json).toBeNull();
    const b = await srv(() => "big");
    await expect(createNodeTransport({ origin: b.origin })(get(), KEY)).rejects.toBeTruthy();
  });
});

describe("node transport: reachable hosts", () => {
  it("only api.stripe.com (or a 127.0.0.1 test server) can be configured; anything else is refused at construction", () => {
    expect(() => createNodeTransport()).not.toThrow();
    for (const origin of ["https://evil.example", "http://localhost:3000", "http://127.0.0.1.evil.example:80", "https://api.stripe.com.evil.example", "http://api.stripe.com", "http://10.0.0.1:80", "ftp://127.0.0.1:21"]) {
      expect(() => createNodeTransport({ origin }), origin).toThrow(/may only reach/);
    }
  });
  it("a path that tries to leave the origin is refused before any socket is opened", async () => {
    const s = await srv();
    const t = createNodeTransport({ origin: s.origin });
    await expect(t({ method: "GET", path: "//evil.example/x", stripeVersion: STRIPE_API_VERSION }, KEY)).rejects.toThrow(/pinned origin/);
    expect(s.requests).toHaveLength(0);
  });
});

describe("through the guard: blocked requests never reach a socket, allowed ones do exactly once", () => {
  it("finalize / send / pay / void / mark_uncollectible and a foreign account: the loopback server sees nothing", async () => {
    const s = await srv();
    const client = createGuardedClient({ transport: createNodeTransport({ origin: s.origin }), apiKey: KEY, connectedAcct: CONNECTED, paceMs: 0 });
    for (const verb of ["finalize", "send", "pay", "void", "mark_uncollectible"]) {
      const c = createGuardedClient({ transport: createNodeTransport({ origin: s.origin }), apiKey: KEY, connectedAcct: CONNECTED, paceMs: 0 });
      await expect(c.call({ method: "POST", path: `/v1/invoices/in_ABC123/${verb}`, stripeAccount: CONNECTED, stripeVersion: STRIPE_API_VERSION, idempotencyKey: "d24proof-lb-3", body: {} })).rejects.toMatchObject({ code: "blocked_request" });
    }
    await expect(client.call({ ...post, stripeAccount: "acct_SOMEONEELSE99" })).rejects.toMatchObject({ code: "blocked_request" });
    expect(s.requests).toHaveLength(0);
    const ok = createGuardedClient({ transport: createNodeTransport({ origin: s.origin }), apiKey: KEY, connectedAcct: CONNECTED, paceMs: 0 });
    await ok.call(get());
    expect(s.requests).toHaveLength(1);
  });
});
