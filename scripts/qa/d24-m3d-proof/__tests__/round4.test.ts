import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cleanup } from "../cleanup";
import { STRIPE_API_VERSION } from "../config";
import { EVIDENCE_ENV, writeEvidence } from "../evidence";
import { createFakeTransport } from "../fakeTransport";
import { createGuardedClient, pinned } from "../guarded";
import { checkEnvironment, runIdentityGate } from "../identity";
import { runProof } from "../run";
import { createNodeTransport } from "../transport";
import type { ProofRequest, ProofResponse, Transport } from "../types";
import { startLoopback } from "./loopback";

// Targeted final review of the round-3 fixes (fresh reviewer, clean main d474d050): one or more tests per finding. Each must fail if its fix is removed.

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(DIR, "..", "..", "..");
const PLATFORM = "acct_PLATFORMTEST1";
const CONNECTED = "acct_CONNECTEDTEST1";
const V = STRIPE_API_VERSION;
const KEY = ["rk", "test", "ROUND4KEY0123456789"].join("_");
const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "d24proof-r4-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

/** Identity reads answered correctly; every other request goes to `handler`. */
function world(handler: (r: ProofRequest) => ProofResponse | Promise<ProofResponse>) {
  const calls: ProofRequest[] = [];
  const transport: Transport = async (r) => {
    calls.push(r);
    if (r.path === "/v1/account") return { status: 200, json: { id: PLATFORM, object: "account" }, stripeVersion: V };
    if (r.path === `/v1/accounts/${CONNECTED}`) return { status: 200, json: { id: CONNECTED, object: "account", type: "express" }, stripeVersion: V };
    return handler(r);
  };
  const c = createGuardedClient({ transport, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
  return { c, calls };
}
const ready = async (w: ReturnType<typeof world>) => { await runIdentityGate(w.c, { platformAcct: PLATFORM, connectedAcct: CONNECTED }); return w; };
const cust = (n: string): Omit<ProofRequest, "stripeVersion"> => ({ method: "POST", path: "/v1/customers", stripeAccount: CONNECTED, idempotencyKey: `d24proof-r4-${n}`, body: { name: "n" } });
const inv = (cus: string, n: string): Omit<ProofRequest, "stripeVersion"> => ({
  method: "POST", path: "/v1/invoices", stripeAccount: CONNECTED, idempotencyKey: `d24proof-r4-${n}`,
  body: { customer: cus, collection_method: "send_invoice", days_until_due: "14", currency: "usd", auto_advance: "false" },
});
const ok = (json: Record<string, unknown> | null): ProofResponse => ({ status: 200, json, stripeVersion: V });

describe("P1-1 a created object is recorded BY THE RULE that sent the create, whatever `object` / `status` say", () => {
  it("a customer create answered with {id, livemode:false} but no `object` is still tracked and makes the run unverifiable", async () => {
    const w = await ready(world(() => ok({ id: "cus_NOOBJ001", livemode: false })));
    await pinned(w.c, cust("a"));
    expect([...w.c.seen.customers]).toEqual(["cus_NOOBJ001"]);
    expect(w.c.uncertain.join()).toMatch(/shape not recognised/);
    const rep = await cleanup(w.c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.verifiedEmpty).toBe(false);
  });
  it("an invoice create with object:'invoice' but no `status` is tracked as a draft candidate and unverifiable", async () => {
    let n = 0;
    const w = await ready(world((r) => (r.path === "/v1/customers" ? ok({ id: "cus_OK000001", object: "customer", livemode: false }) : (n++, ok({ id: "in_NOSTAT01", object: "invoice", livemode: false })))));
    await pinned(w.c, cust("a"));
    await pinned(w.c, inv("cus_OK000001", "i"));
    expect(w.c.seen.drafts.has("in_NOSTAT01")).toBe(true);
    expect(w.c.uncertain.join()).toMatch(/shape not recognised/);
    expect(n).toBe(1);
  });
  it("a create whose body omits livemode entirely is rejected even when `object` is missing", async () => {
    const w = await ready(world(() => ok({ id: "cus_NOLM0001" })));
    await expect(pinned(w.c, cust("a"))).rejects.toMatchObject({ code: "livemode_true" });
    expect(w.c.seen.customers.has("cus_NOLM0001")).toBe(true); // and it is still listed for manual cleanup
  });
});

describe("P2-1 non-object JSON bodies never crash the guard or hide a create", () => {
  for (const [label, body] of [["a number", 5], ["a string", "x"], ["true", true], ["an array", ["cus_ARR00001"]]] as Array<[string, unknown]>) {
    it(`a 2xx POST answered with ${label}: recorded as unverifiable, no TypeError`, async () => {
      const w = await ready(world(() => ({ status: 200, json: body as unknown as Record<string, unknown>, stripeVersion: V })));
      await pinned(w.c, cust("a")).catch(() => undefined);
      expect(w.c.aborted()?.message ?? "").not.toMatch(/Cannot use 'in' operator|TypeError/);
      expect(w.c.uncertain.length).toBeGreaterThan(0);
    });
  }
  it("the real transport turns a scalar or array JSON body into json:null", async () => {
    for (const behaviour of ["scalar", "array"] as const) {
      const s = await startLoopback(() => behaviour);
      try {
        const res = await createNodeTransport({ origin: s.origin })({ method: "GET", path: "/v1/account", stripeVersion: V }, KEY);
        expect(res.json, behaviour).toBeNull();
      } finally {
        await s.close();
      }
    }
  });
});

describe("P2-2 an edge / gateway response WITHOUT Stripe-Version keeps the 429 / 5xx rules (cleanup stays possible); a 2xx / 4xx without it is still fatal", () => {
  it("a 502 without the header on a create: the create is unverifiable, the run is NOT aborted with version_mismatch, cleanup may run", async () => {
    const w = await ready(world(() => ({ status: 502, json: null })));
    await pinned(w.c, cust("a"), { expectStatus: [502] });
    expect(w.c.aborted()).toBeNull();
    expect(w.c.uncertain.length).toBe(1);
    const rep = await cleanup(w.c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.skipped).toBeNull();
    expect(rep.verifiedEmpty).toBe(false);
  });
  it("a 429 without the header is rate_limited (benign), not version_mismatch", async () => {
    const w = await ready(world(() => ({ status: 429, json: { error: { type: "rate_limit" } } })));
    await expect(pinned(w.c, cust("a"))).rejects.toMatchObject({ code: "rate_limited" });
  });
  it("a 2xx or a 4xx without the header is still version_mismatch", async () => {
    for (const status of [200, 400, 403]) {
      const w = await ready(world(() => ({ status, json: { id: "cus_NOVER001", object: "customer", livemode: false } })));
      await expect(pinned(w.c, cust("a"), { expectStatus: [status] })).rejects.toMatchObject({ code: "version_mismatch" });
    }
  });
});

describe("P2-3 cleanup lists an object as deleted only when Stripe says deleted:true", () => {
  it("a DELETE answered 404 is not listed as deleted and the object stays in the remaining lists", async () => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED });
    const t: Transport = async (r, k) => (r.method === "DELETE" && r.path.startsWith("/v1/invoices/") ? { status: 404, json: { error: { type: "invalid_request_error" } }, stripeVersion: V } : f.transport(r, k));
    const c = createGuardedClient({ transport: t, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await runIdentityGate(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    const cus = String((await pinned(c, cust("a"))).json?.id);
    await pinned(c, inv(cus, "i"));
    const rep = await cleanup(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.deletedInvoices).toEqual([]);
    expect(rep.remainingInvoices).toHaveLength(1);
    expect(rep.verifiedEmpty).toBe(false);
  });
});

describe("P2-3b the same holds for customers", () => {
  it("a customer DELETE answered 404 is not listed as deleted, stays in remainingCustomers, and the account is not reported empty", async () => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED });
    const t: Transport = async (r, k) => (r.method === "DELETE" && r.path.startsWith("/v1/customers/") ? { status: 404, json: { error: { type: "invalid_request_error" } }, stripeVersion: V } : f.transport(r, k));
    const c = createGuardedClient({ transport: t, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await runIdentityGate(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    const cusId = String((await pinned(c, cust("a"))).json?.id);
    const rep = await cleanup(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.deletedCustomers).toEqual([]);
    expect(rep.remainingCustomers).toEqual([cusId]);
    expect(rep.verifiedEmpty).toBe(false);
  });
});

describe("P2-4 a partial evidence pack that cannot be removed is reported loudly", () => {
  it("if the second file cannot be created AND the first cannot be unlinked, the error says which file to delete by hand", () => {
    const dir = tmp();
    const input = { runId: "r4000001", mode: "dry-run" as const, outcome: "OK" as const, scriptSha256: "a".repeat(64), apiVersionPinned: "v", apiVersionsReported: [], callsUsed: 1, blocked: 0, scenarios: [], verdicts: {}, cleanup: {}, abort: null, transcriptText: "t", finishedUtc: "t" };
    writeEvidence(dir, { ...input, runId: "r4000002" }, REPO); // makes evidence-r4000002.json + transcript-r4000002.txt exist
    // second pack with a clashing TRANSCRIPT name only: remove the first pack's JSON so the JSON create succeeds and the transcript create then collides
    rmSync(join(dir, "evidence-r4000002.json"));
    expect(() => writeEvidence(dir, { ...input, runId: "r4000002" }, REPO, { unlink: () => { throw new Error("EPERM simulated"); } })).toThrow(/could not be removed[\s\S]*delete by hand/);
    expect(existsSync(join(dir, "evidence-r4000002.json"))).toBe(true); // the leftover is exactly the file named in the message
  });
});

describe("P2-5 gaps the reviewer found in the tests themselves", () => {
  it("a draft listed by a customer's invoice list is tracked (so cleanup can delete it)", async () => {
    const w = await ready(world((r) => (r.path === "/v1/customers" ? ok({ id: "cus_LIST0001", object: "customer", livemode: false }) : ok({ object: "list", data: [{ id: "in_LISTED01", object: "invoice", status: "draft" }] }))));
    await pinned(w.c, cust("a"));
    await pinned(w.c, { method: "GET", path: "/v1/invoices", stripeAccount: CONNECTED, query: { customer: "cus_LIST0001", limit: "100" } });
    expect(w.c.seen.drafts.has("in_LISTED01")).toBe(true);
  });
  it("the transcript file ends with the same OUTCOME the JSON carries", async () => {
    const dir = tmp();
    const lines: string[] = [];
    const code = await runProof(["--dry-run"], { env: { [EVIDENCE_ENV]: dir }, runId: "r4000003", io: { out: (s) => void lines.push(s), sleep: async () => undefined } });
    expect(code).toBe(0);
    const json = JSON.parse(readFileSync(join(dir, "evidence-r4000003.json"), "utf8"));
    const transcript = readFileSync(join(dir, "transcript-r4000003.txt"), "utf8");
    expect(transcript.trimEnd().split("\n").pop()).toBe(`OUTCOME (before the evidence write): ${json.outcome}`);
  });
  it("two dry runs into the same evidence folder both succeed (the dry-run run id is unique)", async () => {
    const dir = tmp();
    const run = () => runProof(["--dry-run"], { env: { [EVIDENCE_ENV]: dir }, io: { out: () => undefined, sleep: async () => undefined } });
    expect(await run()).toBe(0);
    expect(await run()).toBe(0);
    expect(readdirSync(dir)).toHaveLength(4);
  });
  it("the request deadline timer is cleared once the exchange is over (no timer left behind per request)", async () => {
    const s = await startLoopback();
    try {
      const count = () => (process.getActiveResourcesInfo?.() ?? []).filter((x) => x === "Timeout").length;
      const t = createNodeTransport({ origin: s.origin, timeoutMs: 60_000 });
      await t({ method: "GET", path: "/v1/account", stripeVersion: V }, KEY); // warm up
      await new Promise((r) => setTimeout(r, 50));
      const before = count();
      for (let i = 0; i < 5; i++) await t({ method: "GET", path: "/v1/account", stripeVersion: V }, KEY);
      await new Promise((r) => setTimeout(r, 50));
      expect(count()).toBeLessThanOrEqual(before);
    } finally {
      await s.close();
    }
  });
});

describe("P3", () => {
  it("NODE_USE_SYSTEM_CA is refused like NODE_EXTRA_CA_CERTS", () => {
    expect(checkEnvironment({ NODE_USE_SYSTEM_CA: "1" }).join()).toContain("NODE_USE_SYSTEM_CA");
  });
});
