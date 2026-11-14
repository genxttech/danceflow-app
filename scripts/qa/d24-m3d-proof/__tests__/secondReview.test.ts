import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateRequest } from "../allowlist";
import { cleanup } from "../cleanup";
import { STRIPE_API_VERSION } from "../config";
import { EVIDENCE_ENV, evidenceDirProblem, writeEvidence } from "../evidence";
import { createFakeTransport } from "../fakeTransport";
import { createGuardedClient, pinned } from "../guarded";
import { AUTHORIZATION_PHRASE, checkEnvironment, ENV, runIdentityGate } from "../identity";
import { manifest } from "../manifest";
import { runProof } from "../run";
import type { ProofRequest, ProofResponse, Transport } from "../types";

// One or more tests per finding of the SECOND independent review (fresh reviewer, final head 61707b6e). Each must fail if its fix is removed.

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(DIR, "..", "..", "..");
const PLATFORM = "acct_PLATFORMTEST1";
const CONNECTED = "acct_CONNECTEDTEST1";
const V = STRIPE_API_VERSION;
const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "d24proof-sr-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
const gate = (c: ReturnType<typeof createGuardedClient>) => runIdentityGate(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
const custReq = (n: string): Omit<ProofRequest, "stripeVersion"> => ({ method: "POST", path: "/v1/customers", stripeAccount: CONNECTED, idempotencyKey: `d24proof-sr-${n}`, body: { name: "n", email: "d24-proof-abc123-a@example.com" } });
const listReq = (cus: string): Omit<ProofRequest, "stripeVersion"> => ({ method: "GET", path: "/v1/invoices", stripeAccount: CONNECTED, query: { customer: cus, limit: "100" } });

/** Fake Stripe with an override hook for chosen requests. */
function world(override: (r: ProofRequest, n: number) => ProofResponse | undefined = () => undefined) {
  const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED });
  let n = 0;
  const transport: Transport = async (r, k) => override(r, ++n) ?? f.transport(r, k);
  const c = createGuardedClient({ transport, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
  return { f, c };
}
const liveEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  [ENV.key]: ["rk", "test", "SRKEY0123456789"].join("_"), [ENV.platform]: PLATFORM, [ENV.connected]: CONNECTED, [ENV.pinnedSha]: manifest(DIR).sha256, [ENV.phrase]: AUTHORIZATION_PHRASE, ...extra,
});
const noDocker = async () => ({ available: true, rows: [] as string[] });

describe("P1-1 a failed or incomplete read-back of a customer's invoices is NOT 'empty'", () => {
  for (const [label, res] of [
    ["400 on the list read", { status: 400, json: { error: { type: "invalid_request_error" } }, stripeVersion: V }],
    ["500 on the list read", { status: 500, json: { error: { type: "api_error" } }, stripeVersion: V }],
    ["200 without a data array", { status: 200, json: {}, stripeVersion: V }],
    ["200 with has_more:true", { status: 200, json: { object: "list", data: [], has_more: true }, stripeVersion: V }],
  ] as Array<[string, ProofResponse]>) {
    it(label, async () => {
      let armed = false;
      const { f, c } = world((r) => {
        if (r.method === "DELETE" && r.path.startsWith("/v1/invoices/")) armed = true; // the read-back happens after the invoice deletes
        return armed && r.method === "GET" && r.path === "/v1/invoices" ? res : undefined;
      });
      await gate(c);
      const cus = await pinned(c, custReq("a"));
      const cusId = String(cus.json?.id);
      await pinned(c, { method: "POST", path: "/v1/invoices", stripeAccount: CONNECTED, idempotencyKey: "d24proof-sr-inv", body: { customer: cusId, collection_method: "send_invoice", days_until_due: "14", currency: "usd", auto_advance: "false" } });
      const rep = await cleanup(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
      expect(rep.verifiedEmpty).toBe(false);
      expect(rep.stoppedBecause).toMatch(/could not be read back|still has/);
      expect(rep.deletedCustomers).toEqual([]); // a customer whose invoices were not verified gone is never deleted
      expect(f.state.customers.has(cusId)).toBe(true);
    });
  }
});

describe("P2-1 Object.prototype names are not allowed query parameters", () => {
  it("constructor / toString / valueOf / hasOwnProperty / toLocaleString / __proto__ are refused, never accepted and never thrown", () => {
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "toLocaleString", "isPrototypeOf", "__proto__", "__defineGetter__"]) {
      const query = Object.defineProperty({}, name, { value: "x", enumerable: true }) as Record<string, string>;
      const r = evaluateRequest({ method: "GET", path: "/v1/invoices/in_ABC123", stripeAccount: CONNECTED, stripeVersion: V, query }, { connectedAcct: CONNECTED });
      expect(r.ok, name).toBe(false);
    }
  });
  it("a required parameter inherited from the prototype does not count as present", () => {
    const query = Object.create({ customer: "cus_ABC123", limit: "100" }) as Record<string, string>;
    expect(evaluateRequest({ method: "GET", path: "/v1/invoices", stripeAccount: CONNECTED, stripeVersion: V, query }, { connectedAcct: CONNECTED }).ok).toBe(false);
  });
});

describe("P2-3 / third review: evidence is exclusive-create, written into the resolved real directory, and a half pack never survives", () => {
  const dry = async (dir: string, runId: string) => {
    const lines: string[] = [];
    const code = await runProof(["--dry-run"], { env: { [EVIDENCE_ENV]: dir }, runId, io: { out: (s) => void lines.push(s), sleep: async () => undefined } });
    return { code, text: lines.join("\n") };
  };
  it("a pre-existing evidence file is never overwritten: EVIDENCE NOT WRITTEN, OUTCOME FAILED, exit 1, content unchanged, and no half pack is left", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "evidence-ex000009.json"), "KEEP");
    const r = await dry(dir, "ex000009");
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/EVIDENCE NOT WRITTEN/);
    expect(r.text).toMatch(/OUTCOME: FAILED/);
    expect(readFileSync(join(dir, "evidence-ex000009.json"), "utf8")).toBe("KEEP");
    expect(existsSync(join(dir, "transcript-ex000009.txt"))).toBe(false);
  });
  it("if the SECOND file cannot be created, the first (which says OK) is removed again", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "transcript-ex000010.txt"), "KEEP");
    const r = await dry(dir, "ex000010");
    expect(r.code).toBe(1);
    expect(existsSync(join(dir, "evidence-ex000010.json"))).toBe(false);
    expect(readFileSync(join(dir, "transcript-ex000010.txt"), "utf8")).toBe("KEEP");
  });
  it("a planted symlink at the evidence file name is not written through", async () => {
    const dir = tmp();
    const outside = join(tmp(), "victim.txt");
    writeFileSync(outside, "VICTIM");
    let linked = false;
    try {
      symlinkSync(outside, join(dir, "evidence-ex000011.json"), "file");
      linked = true;
    } catch {
      /* creating a file symlink is not permitted here (needs a privilege on Windows): skip only this assertion */
    }
    if (linked) {
      const r = await dry(dir, "ex000011");
      expect(r.code).toBe(1);
      expect(readFileSync(outside, "utf8")).toBe("VICTIM");
    }
  });
  it("swapping the directory for a link into the repository between the checks and the writes does not redirect the files (they go to the resolved real directory)", () => {
    const base = tmp();
    const real = join(base, "real");
    mkdirSync(real);
    const link = join(base, "link");
    let linked = false;
    try {
      symlinkSync(real, link, "junction");
      linked = true;
    } catch {
      /* link creation not permitted here: skip */
    }
    if (!linked) return;
    const repoScripts = join(REPO, "scripts");
    const stray = () => readdirSync(repoScripts).filter((n) => n.startsWith("evidence-swap") || n.startsWith("transcript-swap"));
    try {
      writeEvidence(
        link,
        { runId: "swap0001", mode: "dry-run", outcome: "OK", scriptSha256: "a".repeat(64), apiVersionPinned: "v", apiVersionsReported: [], callsUsed: 1, blocked: 0, scenarios: [], verdicts: {}, cleanup: {}, abort: null, transcriptText: "t", finishedUtc: "t" },
        REPO,
        { onBeforeWrite: () => { rmSync(link, { force: true }); symlinkSync(repoScripts, link, "junction"); } }, // the swap happens AFTER every check (rmSync removes a link on Windows and on Linux alike)
      );
      expect(readdirSync(real).sort()).toEqual(["evidence-swap0001.json", "transcript-swap0001.txt"]);
      expect(stray()).toEqual([]);
    } finally {
      for (const n of stray()) rmSync(join(repoScripts, n), { force: true });
    }
  });
  it("a '..' segment in the evidence directory is refused outright", () => {
    expect(evidenceDirProblem(`${tmp()}${sep}sub${sep}..${sep}x`, REPO)).toMatch(/\.\./);
  });
});

describe("third review P2-A: ids Stripe reports are recorded BEFORE any abort, so a rejected response never hides a created object", () => {
  it("a created customer whose response lacks Stripe-Version aborts the run, and cleanup still lists its id for manual cleanup", async () => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED });
    const t: Transport = async (r, k) => {
      const res = await f.transport(r, k);
      return r.method === "POST" && r.path === "/v1/customers" ? { ...res, stripeVersion: undefined } : res;
    };
    const c = createGuardedClient({ transport: t, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await gate(c);
    await expect(pinned(c, custReq("nv"))).rejects.toMatchObject({ code: "version_mismatch" });
    const rep = await cleanup(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.skipped).toMatch(/NOT run/);
    expect(rep.remainingCustomers).toHaveLength(1);
    expect(rep.remainingCustomers[0]).toMatch(/^cus_/);
  });
  it("a customer created in LIVE mode (livemode:true) is listed for manual cleanup too", async () => {
    const t: Transport = async (r) =>
      r.path === "/v1/account" ? { status: 200, json: { id: PLATFORM, object: "account" }, stripeVersion: V }
      : r.path.startsWith("/v1/accounts/") ? { status: 200, json: { id: CONNECTED, object: "account", type: "express" }, stripeVersion: V }
      : { status: 200, json: { id: "cus_LIVE0001", object: "customer", livemode: true }, stripeVersion: V };
    const c = createGuardedClient({ transport: t, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await gate(c);
    await expect(pinned(c, custReq("lv"))).rejects.toMatchObject({ code: "livemode_true" });
    const rep = await cleanup(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.remainingCustomers).toEqual(["cus_LIVE0001"]);
  });
});

describe("third review P2-E: a readable but NON-empty invoice list keeps the customer", () => {
  it("one draft still attached (e.g. created under a lost response) => the customer is not deleted, verifiedEmpty false, 'still has 1 invoice(s)'", async () => {
    let armed = false;
    const { f, c } = world((r) => {
      if (r.method === "DELETE" && r.path.startsWith("/v1/invoices/")) armed = true;
      return armed && r.method === "GET" && r.path === "/v1/invoices"
        ? { status: 200, json: { object: "list", data: [{ id: "in_LEFT0001", object: "invoice", status: "draft", livemode: false }] }, stripeVersion: V }
        : undefined;
    });
    await gate(c);
    const cus = await pinned(c, custReq("ne"));
    const cusId = String(cus.json?.id);
    await pinned(c, { method: "POST", path: "/v1/invoices", stripeAccount: CONNECTED, idempotencyKey: "d24proof-sr-ne-inv", body: { customer: cusId, collection_method: "send_invoice", days_until_due: "14", currency: "usd", auto_advance: "false" } });
    const rep = await cleanup(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.verifiedEmpty).toBe(false);
    expect(rep.deletedCustomers).toEqual([]);
    expect(rep.stoppedBecause).toMatch(/still has 1 invoice/);
    expect(f.state.customers.has(cusId)).toBe(true);
  });
});

describe("third review P3", () => {
  it("non-string query values (arrays, numbers) are refused", () => {
    for (const bad of [["cus_ABC123"], 100, { a: 1 }] as unknown[]) {
      const query = { customer: bad, limit: "100" } as unknown as Record<string, string>;
      expect(evaluateRequest({ method: "GET", path: "/v1/invoices", stripeAccount: CONNECTED, stripeVersion: V, query }, { connectedAcct: CONNECTED }).ok).toBe(false);
    }
  });
  it("NODE_DEBUG (can log request headers), NODE_DEBUG_NATIVE, OPENSSL_CONF and OPENSSL_MODULES refuse a live run", () => {
    for (const name of ["NODE_DEBUG", "NODE_DEBUG_NATIVE", "OPENSSL_CONF", "OPENSSL_MODULES"]) expect(checkEnvironment({ [name]: "http" }).join(), name).toContain(name);
  });
});

describe("P2-4 a fatal abort that arrives AFTER a benign one in flight still forbids cleanup", () => {
  it("429 on one call, livemode:true on another call already in flight: the abort is livemode_true and cleanup sends nothing", async () => {
    const releases: Array<() => void> = [];
    let posts = 0;
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED });
    const calls: string[] = [];
    const transport: Transport = async (r, k) => {
      calls.push(`${r.method} ${r.path}`);
      if (r.method === "POST") {
        const mine = ++posts;
        await new Promise<void>((res) => releases.push(res)); // both POSTs are in flight before either answers
        return mine === 1
          ? { status: 429, json: { error: { type: "rate_limit" } }, stripeVersion: V }
          : { status: 200, json: { id: "cus_ABC123", object: "customer", livemode: true }, stripeVersion: V };
      }
      return f.transport(r, k);
    };
    const c = createGuardedClient({ transport, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await gate(c);
    const p1 = pinned(c, custReq("p1"));
    const p2 = pinned(c, custReq("p2"));
    await new Promise((r) => setTimeout(r, 20));
    releases[0](); // call 1 gets the 429 first -> benign abort
    await expect(p1).rejects.toMatchObject({ code: "rate_limited" });
    releases[1](); // call 2 then answers livemode:true -> must UPGRADE the abort
    await expect(p2).rejects.toMatchObject({ code: "livemode_true" });
    expect(c.aborted()?.code).toBe("livemode_true");
    const before = calls.length;
    const rep = await cleanup(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.skipped).toMatch(/NOT run/);
    expect(calls.length).toBe(before);
  });
});

describe("P2-5 reads and creates are scoped to the run's own objects", () => {
  it("creating an invoice for, listing, or reading a foreign customer/invoice is refused before the network, so a foreign object can never enter `seen`", async () => {
    const { f, c } = world();
    await gate(c);
    const before = f.calls.length;
    await expect(pinned(c, { method: "POST", path: "/v1/invoices", stripeAccount: CONNECTED, idempotencyKey: "d24proof-sr-fi", body: { customer: "cus_FOREIGN1", collection_method: "send_invoice", days_until_due: "14", currency: "usd", auto_advance: "false" } })).rejects.toMatchObject({ code: "blocked_request" });
    const { c: c2, f: f2 } = world();
    await gate(c2);
    const b2 = f2.calls.length;
    await expect(pinned(c2, listReq("cus_FOREIGN1"))).rejects.toMatchObject({ code: "blocked_request" });
    const { c: c3, f: f3 } = world();
    await gate(c3);
    const b3 = f3.calls.length;
    await expect(pinned(c3, { method: "GET", path: "/v1/invoices/in_FOREIGN1", stripeAccount: CONNECTED })).rejects.toMatchObject({ code: "blocked_request" });
    expect(f.calls.length).toBe(before);
    expect(f2.calls.length).toBe(b2);
    expect(f3.calls.length).toBe(b3);
    expect(c.seen.drafts.size + c2.seen.drafts.size + c3.seen.drafts.size).toBe(0);
  });
});

describe("P2-6 the outcome and the evidence use the abort the guard recorded, even one raised during cleanup", () => {
  it("a non-draft invoice discovered by a cleanup read-back => ABORTED non_draft_invoice, OUTCOME FAILED, exit 1", async () => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED });
    let deleted = false;
    const t: Transport = async (r, k) => {
      if (r.method === "DELETE" && r.path.startsWith("/v1/invoices/")) deleted = true;
      if (deleted && r.method === "GET" && r.path === "/v1/invoices") {
        return { status: 200, json: { object: "list", data: [{ id: "in_SNEAKY1", object: "invoice", status: "open", livemode: false }] }, stripeVersion: V };
      }
      return f.transport(r, k);
    };
    const lines: string[] = [];
    const dir = tmp();
    const code = await runProof(["--live"], { env: liveEnv({ [EVIDENCE_ENV]: dir }), io: { out: (s) => void lines.push(s), sleep: async () => undefined }, liveTransport: t, docker: noDocker, runId: "sr000001" });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/ABORTED: non_draft_invoice/);
    expect(lines.join("\n")).toMatch(/OUTCOME: FAILED/);
  });
});

describe("P3 environment hardening", () => {
  it("SSL_CERT_FILE / SSL_CERT_DIR / NODE_PATH / npm proxy variables / DIRECT_URL / hosted PGHOST / a ?host= override are refused", () => {
    for (const [name, value] of [["SSL_CERT_FILE", "/x.pem"], ["SSL_CERT_DIR", "/certs"], ["NODE_PATH", "/evil"], ["npm_config_proxy", "http://p"], ["npm_config_https_proxy", "http://p"], ["DIRECT_URL", "postgres://u:p@db.supabase.co/db"], ["PGHOST", "db.abcdefgh.supabase.co"], ["DATABASE_URL", "postgresql://localhost/db?host=evil.example"]]) {
      expect(checkEnvironment({ [name]: value }).join(), name).toContain(name);
    }
    expect(checkEnvironment({ PGHOST: "localhost", DATABASE_URL: "postgres://u:p@127.0.0.1:5432/postgres" })).toEqual([]);
  });
});
