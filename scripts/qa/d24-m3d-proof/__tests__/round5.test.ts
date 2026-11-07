import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cleanup } from "../cleanup";
import { STRIPE_API_VERSION } from "../config";
import { writeEvidence } from "../evidence";
import { createFakeTransport } from "../fakeTransport";
import { createGuardedClient, pinned } from "../guarded";
import { runIdentityGate } from "../identity";
import { createNodeTransport } from "../transport";
import type { ProofRequest, ProofResponse, Transport } from "../types";
import { startLoopback } from "./loopback";

// Fifth independent review (bounded, delta d474d050..321060f7): one or more tests per finding. Each must fail if its fix is removed.

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(DIR, "..", "..", "..");
const PLATFORM = "acct_PLATFORMTEST1";
const CONNECTED = "acct_CONNECTEDTEST1";
const V = STRIPE_API_VERSION;
const KEY = ["rk", "test", "ROUND5KEY0123456789"].join("_");
const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "d24proof-r5-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

function world(handler: (r: ProofRequest) => ProofResponse | Promise<ProofResponse>) {
  const transport: Transport = async (r) => {
    if (r.path === "/v1/account") return { status: 200, json: { id: PLATFORM, object: "account" }, stripeVersion: V };
    if (r.path === `/v1/accounts/${CONNECTED}`) return { status: 200, json: { id: CONNECTED, object: "account", type: "express" }, stripeVersion: V };
    return handler(r);
  };
  return createGuardedClient({ transport, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
}
const ready = async (c: ReturnType<typeof createGuardedClient>) => { await runIdentityGate(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED }); return c; };
const cust = (n: string): Omit<ProofRequest, "stripeVersion"> => ({ method: "POST", path: "/v1/customers", stripeAccount: CONNECTED, idempotencyKey: `d24proof-r5-${n}`, body: { name: "n" } });
const ok = (json: Record<string, unknown>): ProofResponse => ({ status: 200, json, stripeVersion: V });
const evInput = (runId: string, outcome: "OK" | "FAILED" = "OK") => ({ runId, mode: "dry-run" as const, outcome, scriptSha256: "a".repeat(64), apiVersionPinned: "v", apiVersionsReported: [], callsUsed: 1, blocked: 0, scenarios: [], verdicts: {}, cleanup: {}, abort: null, transcriptText: "t", finishedUtc: "t" });
const outcomeOf = (file: string) => JSON.parse(readFileSync(file, "utf8")).outcome as string;

describe("P1-1 an evidence pack never carries an outcome next to a missing transcript", () => {
  it("success: the JSON ends with the real outcome, the transcript exists, and no temporary file is left", () => {
    const dir = tmp();
    const files = writeEvidence(dir, evInput("r5000001", "FAILED"), REPO);
    expect(outcomeOf(files.json)).toBe("FAILED");
    expect(existsSync(files.transcript)).toBe(true);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
  it("the final commit (rename) fails and nothing can be removed: the leftover JSON says INCOMPLETE, never OK", () => {
    const dir = tmp();
    expect(() => writeEvidence(dir, evInput("r5000002"), REPO, { rename: () => { throw new Error("EPERM rename"); }, unlink: () => { throw new Error("EPERM unlink"); } })).toThrow(/EPERM rename[\s\S]*delete by hand/);
    expect(outcomeOf(join(dir, "evidence-r5000002.json"))).toBe("INCOMPLETE");
  });
  it("the commit fails but removal works: nothing at all is left", () => {
    const dir = tmp();
    expect(() => writeEvidence(dir, evInput("r5000003"), REPO, { rename: () => { throw new Error("EPERM rename"); } })).toThrow(/EPERM rename/);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("a process killed after the first write (simulated by a throwing hook) leaves INCOMPLETE, not an outcome", () => {
    const dir = tmp();
    // the transcript path is pre-created by someone else, so the second step fails after the placeholder JSON exists
    writeFileSync(join(dir, "transcript-r5000004.txt"), "KEEP");
    expect(() => writeEvidence(dir, evInput("r5000004"), REPO, { unlink: () => { throw new Error("EPERM unlink"); } })).toThrow(/delete by hand/);
    expect(outcomeOf(join(dir, "evidence-r5000004.json"))).toBe("INCOMPLETE");
    expect(readFileSync(join(dir, "transcript-r5000004.txt"), "utf8")).toBe("KEEP");
  });
});

describe("P2-1 a 2xx create must carry a STRING id, whatever else the body looks like", () => {
  it("{object:'list', id:[...]} for a customer create is unverifiable and cleanup cannot report empty", async () => {
    const c = await ready(world(() => ok({ object: "list", data: [], id: ["cus_REAL0001"], livemode: false })));
    await pinned(c, cust("a"));
    expect(c.uncertain.join()).toMatch(/2xx without a string id/);
    const rep = await cleanup(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.verifiedEmpty).toBe(false);
    expect(rep.unverifiable.length).toBe(1);
  });
});

describe("P2-2 duplicate JSON keys cannot hide livemode:true", () => {
  it("the real transport + guard abort on {...,'livemode':true,'livemode':false}", async () => {
    const s = await startLoopback(() => "dupkey");
    try {
      const c = createGuardedClient({ transport: createNodeTransport({ origin: s.origin }), apiKey: KEY, connectedAcct: CONNECTED, paceMs: 0 });
      c.markIdentityVerified();
      await expect(pinned(c, cust("dup"))).rejects.toMatchObject({ code: "livemode_true" });
      expect(c.seen.customers.has("cus_DUP00001")).toBe(true); // still listed for manual cleanup
    } finally {
      await s.close();
    }
  });
});

describe("P2-3 the unverifiable list is in the cleanup report on EVERY path", () => {
  it("skipped after a fatal abort", async () => {
    let n = 0;
    const c = await ready(world((r) => (r.method === "POST" ? (++n === 1 ? { status: 502, json: null } : ok({ id: "cus_LIVE0001", object: "customer", livemode: true })) : ok({ object: "list", data: [] }))));
    await pinned(c, cust("lost"), { expectStatus: [502] });
    await expect(pinned(c, cust("live"))).rejects.toMatchObject({ code: "livemode_true" });
    const rep = await cleanup(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.skipped).toMatch(/NOT run/);
    expect(rep.unverifiable.length).toBeGreaterThan(0);
  });
  it("stopped on a non-draft invoice", async () => {
    const c = await ready(world((r) => (r.path === "/v1/customers" ? { status: 502, json: null } : ok({ id: "in_OPEN0001", object: "invoice", status: "open", livemode: false }))));
    await pinned(c, cust("lost"), { expectStatus: [502] });
    c.seen.customers.add("cus_X0000001");
    await pinned(c, { method: "POST", path: "/v1/invoices", stripeAccount: CONNECTED, idempotencyKey: "d24proof-r5-inv", body: { customer: "cus_X0000001", collection_method: "send_invoice", days_until_due: "14", currency: "usd", auto_advance: "false" } }).catch(() => undefined);
    const rep = await cleanup(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.stoppedBecause ?? rep.skipped).toBeTruthy();
    expect(rep.unverifiable.length).toBeGreaterThan(0);
  });
  it("normal path", async () => {
    const c = await ready(world(() => ({ status: 503, json: null })));
    await pinned(c, cust("a"), { expectStatus: [503] });
    const rep = await cleanup(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.unverifiable.length).toBe(1);
  });
});

describe("P2-4 gaps in the tests themselves", () => {
  it("a 4xx create that carries an id is NOT tracked (only 2xx creates are)", async () => {
    const c = await ready(world(() => ({ status: 400, json: { id: "cus_FOUR0001", error: { type: "invalid_request_error" } }, stripeVersion: V })));
    await pinned(c, cust("a"), { expectStatus: [400] });
    expect(c.seen.customers.size).toBe(0);
  });
  it("a non-object 2xx body RESOLVES with json null (no TypeError, no abort) and the POST is unverifiable", async () => {
    for (const body of [5, "x", true, null] as unknown[]) {
      const c = await ready(world(() => ({ status: 200, json: body as unknown as Record<string, unknown>, stripeVersion: V })));
      const res = await pinned(c, cust("a"));
      expect(res.json).toBeNull();
      expect(c.aborted()).toBeNull();
      expect(c.uncertain.length).toBe(1);
    }
  });
  it("500, 502 and 503 without Stripe-Version all keep the 5xx rules (no version_mismatch, cleanup allowed)", async () => {
    for (const status of [500, 502, 503]) {
      const c = await ready(world(() => ({ status, json: null })));
      await pinned(c, cust("a"), { expectStatus: [status] });
      expect(c.aborted()).toBeNull();
    }
  });
});

describe("P3 deleted means: HTTP 200, deleted:true, and the id that was requested", () => {
  const run = async (res: ProofResponse) => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED });
    const t: Transport = async (r, k) => (r.method === "DELETE" && r.path.startsWith("/v1/customers/") ? res : f.transport(r, k));
    const c = createGuardedClient({ transport: t, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await runIdentityGate(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    const id = String((await pinned(c, cust("a"))).json?.id);
    const rep = await cleanup(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    return { rep, id, c };
  };
  it("a 404 that says deleted:true is not a confirmation: not listed as deleted, still remaining, not empty", async () => {
    const { rep, id } = await run({ status: 404, json: { deleted: true, id: "cus_PLACEHOLDER" }, stripeVersion: V });
    expect(rep.deletedCustomers).toEqual([]);
    expect(rep.verifiedEmpty).toBe(false);
    expect(rep.remainingCustomers).toEqual([id]);
  });
  it("a 404 naming the REQUESTED id with deleted:true is still not a confirmation (status must be 200)", async () => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED });
    const t: Transport = async (r, k) => (r.method === "DELETE" && r.path.startsWith("/v1/customers/") ? { status: 404, json: { deleted: true, id: r.path.split("/").pop() }, stripeVersion: V } : f.transport(r, k));
    const c = createGuardedClient({ transport: t, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await runIdentityGate(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    const id = String((await pinned(c, cust("a"))).json?.id);
    const rep = await cleanup(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.deletedCustomers).toEqual([]);
    expect(rep.remainingCustomers).toEqual([id]);
    expect(rep.verifiedEmpty).toBe(false);
  });
  it("a 200 that says deleted:true for ANOTHER id is not a confirmation of the requested one", async () => {
    const { rep, id } = await run({ status: 200, json: { deleted: true, id: "cus_OTHER0001" }, stripeVersion: V });
    expect(rep.deletedCustomers).toEqual([]);
    expect(rep.remainingCustomers).toEqual([id]);
    expect(rep.verifiedEmpty).toBe(false);
  });
});

describe("P3 a delete answer can only confirm the object that was requested", () => {
  it("a 200 deleted:true that names ANOTHER tracked customer neither confirms the requested one nor erases the named one from the books", async () => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED });
    const created: string[] = [];
    const t: Transport = async (r, k) => {
      const res = await f.transport(r, k);
      if (r.method === "POST" && r.path === "/v1/customers" && typeof res.json?.id === "string") created.push(res.json.id);
      if (r.method === "DELETE" && r.path.startsWith("/v1/customers/")) {
        // deleting the FIRST customer is answered "200 deleted:true" but for the SECOND id; deleting the second is answered 404
        return r.path.endsWith(created[0]) ? { status: 200, json: { id: created[1], object: "customer", deleted: true }, stripeVersion: V } : { status: 404, json: { error: { type: "invalid_request_error" } }, stripeVersion: V };
      }
      return res;
    };
    const c = createGuardedClient({ transport: t, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await runIdentityGate(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    await pinned(c, cust("a"));
    await pinned(c, cust("b"));
    const rep = await cleanup(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.deletedCustomers).toEqual([]);
    expect([...rep.remainingCustomers].sort()).toEqual([...created].sort()); // BOTH still on the books: the second was never confirmed
    expect(rep.verifiedEmpty).toBe(false);
  });
  it("the same for an invoice: a 200 deleted:true naming another invoice does not confirm the requested one", async () => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED });
    const t: Transport = async (r, k) => (r.method === "DELETE" && r.path.startsWith("/v1/invoices/") ? { status: 200, json: { id: "in_ELSEWHERE1", object: "invoice", deleted: true }, stripeVersion: V } : f.transport(r, k));
    const c = createGuardedClient({ transport: t, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await runIdentityGate(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    const cus = String((await pinned(c, cust("a"))).json?.id);
    const invId = String((await pinned(c, { method: "POST", path: "/v1/invoices", stripeAccount: CONNECTED, idempotencyKey: "d24proof-r5-di", body: { customer: cus, collection_method: "send_invoice", days_until_due: "14", currency: "usd", auto_advance: "false" } })).json?.id);
    const rep = await cleanup(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.deletedInvoices).toEqual([]);
    expect(rep.remainingInvoices).toEqual([invId]);
    expect(rep.verifiedEmpty).toBe(false);
  });
});

describe("P3 add_lines must answer with the invoice it was sent to; full ids in the notes", () => {
  it("a different invoice id in the add_lines answer is not added to the deletable set and is unverifiable", async () => {
    const c = await ready(world((r) => (r.path === "/v1/customers" ? ok({ id: "cus_OK000001", object: "customer", livemode: false }) : r.path === "/v1/invoices" ? ok({ id: "in_MINE0001", object: "invoice", status: "draft", livemode: false }) : ok({ id: "in_THEIRS01", object: "invoice", status: "draft", livemode: false }))));
    await pinned(c, cust("a"));
    await pinned(c, { method: "POST", path: "/v1/invoices", stripeAccount: CONNECTED, idempotencyKey: "d24proof-r5-i", body: { customer: "cus_OK000001", collection_method: "send_invoice", days_until_due: "14", currency: "usd", auto_advance: "false" } });
    await pinned(c, { method: "POST", path: "/v1/invoices/in_MINE0001/add_lines", stripeAccount: CONNECTED, idempotencyKey: "d24proof-r5-l", body: { "lines[0][description]": "x", "lines[0][amount]": "100" } });
    expect(c.uncertain.join()).toMatch(/in_THEIRS01/); // full id shown, not truncated
    expect(c.seen.drafts.has("in_THEIRS01")).toBe(false); // and it never becomes deletable by this run
    expect(c.seen.drafts.has("in_MINE0001")).toBe(true);
  });
  it("a wrong-prefix id is shown in full for the operator", async () => {
    const c = await ready(world(() => ok({ id: "acct_WRONGPREFIX01", object: "customer", livemode: false })));
    await pinned(c, cust("a"));
    expect(c.uncertain.join()).toContain("acct_WRONGPREFIX01");
  });
});
