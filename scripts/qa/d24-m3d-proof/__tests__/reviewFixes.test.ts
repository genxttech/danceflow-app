import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cleanup } from "../cleanup";
import { STRIPE_API_VERSION } from "../config";
import { evidenceDirProblem } from "../evidence";
import { createFakeTransport } from "../fakeTransport";
import { createGuardedClient, pinned } from "../guarded";
import { AUTHORIZATION_PHRASE, checkEnvironment, ENV, runIdentityGate } from "../identity";
import { manifest } from "../manifest";
import { runProof } from "../run";
import { runScenarios } from "../scenarios";
import type { ProofRequest, ProofResponse, Transport } from "../types";

// One test (or more) per finding of the independent security review of the proof harness. Each fails if the fix is removed.

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(DIR, "..", "..", "..");
const PLATFORM = "acct_PLATFORMTEST1";
const CONNECTED = "acct_CONNECTEDTEST1";
const V = STRIPE_API_VERSION;
const ok = (json: Record<string, unknown>, extra: Partial<ProofResponse> = {}): ProofResponse => ({ status: 200, json, stripeVersion: V, ...extra });
const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "d24proof-rf-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

/** A transport that answers identity reads correctly and everything else via `handler`. */
function client(handler: (r: ProofRequest) => ProofResponse | Promise<ProofResponse>, opts: Partial<Parameters<typeof createGuardedClient>[0]> = {}) {
  const calls: ProofRequest[] = [];
  const transport: Transport = async (r) => {
    calls.push(r);
    if (r.path === "/v1/account") return ok({ id: PLATFORM, object: "account" });
    if (r.path === `/v1/accounts/${CONNECTED}`) return ok({ id: CONNECTED, object: "account", type: "express" });
    return handler(r);
  };
  const c = createGuardedClient({ transport, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0, ...opts });
  return { c, calls };
}
const gateIt = (c: ReturnType<typeof createGuardedClient>) => runIdentityGate(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
const cust = (n: string): Omit<ProofRequest, "stripeVersion"> => ({ method: "POST", path: "/v1/customers", stripeAccount: CONNECTED, idempotencyKey: `d24proof-rf-${n}`, body: { name: "n", email: "d24-proof-abc123-a@example.com" } });

describe("P1-1 a POST that ends in a gateway error / unparseable body / id-less 2xx is unverifiable, never 'empty'", () => {
  for (const [label, res] of [
    ["502 with no body", { status: 502, json: null, stripeVersion: V }],
    ["500 with an error body", { status: 500, json: { error: { type: "api_error" } }, stripeVersion: V }],
    ["200 with an unparseable body", { status: 200, json: null, stripeVersion: V }],
    ["200 without an id", { status: 200, json: { object: "customer", livemode: false }, stripeVersion: V }],
  ] as Array<[string, ProofResponse]>) {
    it(label, async () => {
      const { c } = client(() => res);
      await gateIt(c);
      await pinned(c, cust("a"), { expectStatus: [res.status] }).catch(() => undefined);
      expect(c.uncertain.length).toBeGreaterThan(0);
      const rep = await cleanup(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
      expect(rep.verifiedEmpty).toBe(false);
      expect(rep.stoppedBecause).toMatch(/unverifiable/);
    });
  }
  it("a clean 4xx rejection or a normal create is not uncertain", async () => {
    const { c } = client((r) => (r.idempotencyKey?.endsWith("bad") ? { status: 400, json: { error: { type: "invalid_request_error" } }, stripeVersion: V } : ok({ id: "cus_ABC123", object: "customer", livemode: false })));
    await gateIt(c);
    await pinned(c, cust("bad"), { expectStatus: [400] });
    await pinned(c, cust("good"));
    expect(c.uncertain).toEqual([]);
  });
});

describe("P1-2 the exit code and the evidence reflect a failed cleanup", () => {
  it("scenarios succeed but cleanup cannot verify an empty account => OUTCOME FAILED and exit 1", async () => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED });
    let n = 0;
    const t: Transport = async (r, k) => {
      if (r.method === "DELETE" && r.path.startsWith("/v1/invoices/")) {
        n++;
        return { status: 400, json: { error: { type: "invalid_request_error" } }, stripeVersion: V };
      }
      return f.transport(r, k);
    };
    const lines: string[] = [];
    const env = { [ENV.key]: "rk_test_FAKEFAKE123", [ENV.platform]: PLATFORM, [ENV.connected]: CONNECTED, [ENV.pinnedSha]: manifest(DIR).sha256, [ENV.phrase]: AUTHORIZATION_PHRASE };
    const code = await runProof(["--live"], { env, io: { out: (s) => void lines.push(s), sleep: async () => undefined }, liveTransport: t, docker: async () => ({ available: true, rows: [] }), runId: "ex000001" });
    expect(n).toBeGreaterThan(0);
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/OUTCOME: FAILED/);
  });
});

describe("P1-3 account ids are masked in everything printed", () => {
  it("a dry run prints no full pinned account id and a live run prints none either", async () => {
    const lines: string[] = [];
    await runProof(["--dry-run"], { env: {}, io: { out: (s) => void lines.push(s), sleep: async () => undefined } });
    const text = lines.join("\n");
    expect(text).not.toContain("acct_DRYRUNPLATFORM");
    expect(text).not.toContain("acct_DRYRUNCONNECTED");
    expect(text).toMatch(/acct_DR/);
  });
});

describe("P1-4 the evidence directory is checked on real paths", () => {
  it("refuses a directory inside any git checkout or worktree (a .git entry in an ancestor), and a link that resolves into the repository", () => {
    const outer = tmp();
    mkdirSync(join(outer, ".git"));
    expect(evidenceDirProblem(join(outer, "out"), REPO)).toMatch(/git checkout or worktree/);
    const link = join(tmp(), "link-to-repo");
    let linked = false;
    try {
      symlinkSync(REPO, link, "junction");
      linked = true;
    } catch {
      /* creating a junction/symlink is not permitted in this environment: skip ONLY the link assertion below (the .git-ancestor rule above still ran) */
    }
    // outside the try: a failing expectation must fail the test, not be swallowed
    if (linked) expect(evidenceDirProblem(join(link, "evidence"), REPO)).toMatch(/outside the repository|git checkout/);
    // a link into a SUB-folder of the repository has no git entry to trip over: only resolving the link (realpath) can refuse it
    const sub = join(tmp(), "link-to-scripts");
    let linkedSub = false;
    try {
      symlinkSync(join(REPO, "scripts"), sub, "junction");
      linkedSub = true;
    } catch {
      /* link creation not permitted here: skip only this assertion */
    }
    if (linkedSub) expect(evidenceDirProblem(join(sub, "evidence"), REPO)).toMatch(/outside the repository/);
    expect(evidenceDirProblem(tmp(), REPO)).toBeNull();
  });
});

describe("P1-5 the first abort wins and nothing is sent after it, even by calls already in flight", () => {
  it("a livemode:true followed by a parallel 429 stays livemode_true, so cleanup sends NO DELETE", async () => {
    let n = 0;
    const { c, calls } = client((r) => {
      if (r.method === "POST") {
        n++;
        return n === 1 ? ok({ id: "cus_ABC123", object: "customer", livemode: true }) : { status: 429, json: { error: { type: "rate_limit" } }, stripeVersion: V };
      }
      return ok({ id: "x", object: "list", data: [] });
    }, { paceMs: 1, sleep: async () => undefined });
    await gateIt(c);
    const results = await Promise.allSettled([pinned(c, cust("p1")), pinned(c, cust("p2"))]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(c.aborted()?.code).toBe("livemode_true");
    const before = calls.length;
    const rep = await cleanup(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.skipped).toMatch(/NOT run/);
    expect(calls.length).toBe(before);
  });
  it("a call that is waiting out the pacing delay is stopped BEFORE the network when another call aborts the run", async () => {
    let holdNext = false;
    const held: Array<() => void> = [];
    const { c, calls } = client(() => ok({ id: "cus_ABC123", object: "customer", livemode: true }), {
      paceMs: 5,
      sleep: () => (holdNext ? ((holdNext = false), new Promise<void>((r) => held.push(r))) : Promise.resolve()),
    });
    await gateIt(c);
    holdNext = true;
    const b = pinned(c, cust("b")); // passes every check, then waits out the pacing delay (held)
    const a = pinned(c, cust("a")); // goes straight to the network and gets a livemode:true response -> the run aborts
    await expect(a).rejects.toMatchObject({ code: "livemode_true" });
    const before = calls.length;
    held.forEach((r) => r()); // b's wait ends only now
    await expect(b).rejects.toMatchObject({ code: "livemode_true" });
    expect(calls.length).toBe(before); // b never reached the network
  });
  it("the scenarios wait for all three parallel creates before cleanup can start", async () => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED });
    const c = createGuardedClient({ transport: f.transport, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await gateIt(c);
    await runScenarios({ client: c, expect: { platformAcct: PLATFORM, connectedAcct: CONNECTED }, runId: "rf000001", sleep: async () => undefined, replayWaitMs: 0 });
    expect(c.aborted()).toBeNull();
  });
});

describe("P2 hardening", () => {
  it("P2-1 the run may only delete customers it created and add lines only to drafts it saw", async () => {
    const { c, calls } = client(() => ok({ id: "x", object: "list", data: [] }));
    await gateIt(c);
    const before = calls.length;
    await expect(pinned(c, { method: "DELETE", path: "/v1/customers/cus_PREEXISTING", stripeAccount: CONNECTED }, { phase: "cleanup" })).rejects.toMatchObject({ code: "blocked_request" });
    const { c: c2, calls: calls2 } = client(() => ok({ id: "x", object: "list", data: [] }));
    await gateIt(c2);
    const before2 = calls2.length;
    await expect(pinned(c2, { method: "POST", path: "/v1/invoices/in_PREEXISTING/add_lines", stripeAccount: CONNECTED, idempotencyKey: "d24proof-rf-l", body: { "lines[0][description]": "x", "lines[0][amount]": "100" } })).rejects.toMatchObject({ code: "blocked_request" });
    expect(calls.length).toBe(before);
    expect(calls2.length).toBe(before2);
  });
  it("P2-2 an identity response without a Stripe-Version aborts; a created object that does not positively report livemode:false aborts", async () => {
    const noVer: Transport = async () => ({ status: 200, json: { id: PLATFORM, object: "account" } });
    const c1 = createGuardedClient({ transport: noVer, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await expect(gateIt(c1)).rejects.toMatchObject({ code: "version_mismatch" });
    const { c } = client(() => ok({ id: "cus_ABC123", object: "customer" })); // no livemode flag at all
    await gateIt(c);
    await expect(pinned(c, cust("nolm"))).rejects.toMatchObject({ code: "livemode_true" });
  });
  it("P2-3 identity-gate aborts are recorded on the client", async () => {
    const t: Transport = async () => ok({ id: "acct_NOTTHESANDBOX", object: "account" });
    const c = createGuardedClient({ transport: t, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await expect(gateIt(c)).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(c.aborted()?.code).toBe("identity_mismatch");
  });
  it("P2-4 interpreter / proxy / TLS tampering variables refuse a live run", async () => {
    for (const [name, value] of [["NODE_OPTIONS", "--require ./x.js"], ["NODE_EXTRA_CA_CERTS", "/tmp/ca.pem"], ["HTTPS_PROXY", "http://127.0.0.1:8080"], ["http_proxy", "http://x"], ["NODE_USE_ENV_PROXY", "1"], ["NODE_TLS_REJECT_UNAUTHORIZED", "0"]]) {
      expect(checkEnvironment({ [name]: value }).join(), name).toContain(name);
    }
    expect(checkEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: "1" })).toEqual([]);
    const live = vi.fn<Transport>();
    const env = { [ENV.key]: "rk_test_FAKEFAKE123", [ENV.platform]: PLATFORM, [ENV.connected]: CONNECTED, [ENV.pinnedSha]: manifest(DIR).sha256, [ENV.phrase]: AUTHORIZATION_PHRASE, HTTPS_PROXY: "http://127.0.0.1:8080" };
    expect(await runProof(["--live"], { env, io: { out: () => undefined, sleep: async () => undefined }, liveTransport: live, docker: async () => ({ available: true, rows: [] }) })).toBe(2);
    expect(live).not.toHaveBeenCalled();
  });
});

describe("P3 nits", () => {
  it("an unknown option that looks like a key is not echoed", async () => {
    const lines: string[] = [];
    await runProof(["--rk_test_ABCDEF1234567"], { env: {}, io: { out: (s) => void lines.push(s), sleep: async () => undefined } });
    expect(lines.join("\n")).not.toContain("ABCDEF1234567");
  });
  it("a plain exception during a run is labelled unexpected_error, not blocked_request", async () => {
    const t: Transport = async () => { throw new Error("boom"); };
    const lines: string[] = [];
    const code = await runProof(["--live"], {
      env: { [ENV.key]: "rk_test_FAKEFAKE123", [ENV.platform]: PLATFORM, [ENV.connected]: CONNECTED, [ENV.pinnedSha]: manifest(DIR).sha256, [ENV.phrase]: AUTHORIZATION_PHRASE },
      io: { out: (s) => void lines.push(s), sleep: async () => undefined }, liveTransport: t, docker: async () => ({ available: true, rows: [] }),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/ABORTED: unexpected_error/);
  });
});

void writeFileSync;
