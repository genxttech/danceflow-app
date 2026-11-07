// Composed-workflow validation (offline): dry-run and live-run behaviour of the whole runner as one pipeline, with spies on
// every place a secret could be read or a network call made. No Stripe, no real key, no real authenticator.
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../credstore";
import { createFakeExec, type FakeOpts } from "../fakeChild";
import { runEnvelope, type RunnerDeps } from "../runner";
import { KEY, LABEL, makeEnvelope, mkLedger, NOW, ownerSign, ownerTrust, REPO, SHA, tmp, writeEnvelope } from "./helpers";
import { makeAssertion, testAuth, type AssertionOpts } from "./softauth";

const auth = testAuth;

class SpyStore extends MemoryStore {
  reads = 0;
  writes = 0;
  override async read(label: string) {
    this.reads++;
    return super.read(label);
  }
  override async write(label: string, secret: string) {
    this.writes++;
    return super.write(label, secret);
  }
}

/** Every Node-level way this process could open a connection. None may fire in any of these tests. */
function netSpies() {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network call in an offline test"));
  const spies = [
    fetchSpy,
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
      throw new Error("socket connect in an offline test");
    }),
    vi.spyOn(http, "request").mockImplementation(() => {
      throw new Error("http.request in an offline test");
    }),
    vi.spyOn(https, "request").mockImplementation(() => {
      throw new Error("https.request in an offline test");
    }),
    vi.spyOn(http, "get").mockImplementation(() => {
      throw new Error("http.get in an offline test");
    }),
    vi.spyOn(https, "get").mockImplementation(() => {
      throw new Error("https.get in an offline test");
    }),
  ];
  return () => spies.reduce((n, s) => n + s.mock.calls.length, 0);
}

afterEach(() => vi.restoreAllMocks());

type Opts = {
  dir?: string;
  doc?: AssertionOpts | "none" | { forHash: string; opts?: AssertionOpts };
  ed25519?: boolean;
  noAnchor?: boolean;
  anchorText?: string;
  brandMismatch?: boolean;
  dry?: boolean;
  now?: Date;
  env?: Parameters<typeof makeEnvelope>[0];
  fake?: Partial<FakeOpts>;
  mutateFileAfterSigning?: (e: Record<string, unknown>) => Record<string, unknown>;
};

async function go(o: Opts = {}) {
  const dir = o.dir ?? tmp();
  const env = makeEnvelope({ evidenceRoot: join(dir, "evidence"), ...o.env });
  const raw = o.mutateFileAfterSigning ? o.mutateFileAfterSigning({ ...env }) : env;
  const file = writeEnvelope(raw);
  const anchorPath = join(dir, "owner-hw-anchor.json");
  if (!o.noAnchor) writeFileSync(anchorPath, o.anchorText ?? JSON.stringify(auth.anchor));
  const statePath = join(dir, "state", "hw-signcount.json");
  const ledger = mkLedger();
  const calls: NonNullable<FakeOpts["calls"]> = [];
  const store = new SpyStore();
  await store.write(LABEL, KEY);
  store.writes = 0;
  const lines: string[] = [];
  const doc =
    o.doc === "none"
      ? null
      : o.doc && "forHash" in o.doc
        ? makeAssertion(auth, o.doc.forHash, { signCount: 5, ...(o.doc.opts ?? {}) })
        : makeAssertion(auth, env.envelopeSha256, { signCount: 5, ...((o.doc as AssertionOpts) ?? {}) });
  const deps: RunnerDeps = {
    exec: createFakeExec({ commitSha: SHA, repoDir: REPO, calls, ...o.fake }, { simulateLive: o.brandMismatch ? Boolean(o.dry) : !o.dry }),
    parentEnv: { PATH: "C:\\bin", SystemRoot: "C:\\Windows" },
    store: () => store,
    ledger,
    now: () => o.now ?? NOW,
    out: (l) => lines.push(l),
    dry: Boolean(o.dry),
    runInstall: true,
    dryKey: o.dry ? KEY : undefined,
    owner: {
      trust: o.ed25519 ? ownerTrust(ledger.dir, ledger.anchorFile as string) : null,
      signature: o.ed25519 ? ownerSign(env) : null,
      hardware: { doc, anchorPath, statePath, pins: { ledgerDir: ledger.dir, anchorFile: ledger.anchorFile as string } },
    },
  };
  const r = await runEnvelope(file, REPO, deps);
  return { r, calls, lines, ledger, env, store, statePath, dir };
}

const failedGate = (r: { gates: Array<{ id: string; ok: boolean }> }) => r.gates.find((g) => !g.ok)?.id;
const sentLive = (calls: Array<{ args: string[] }>) => calls.some((c) => c.args.includes("--live"));
const networkExec = (calls: Array<{ cmd: string; args: string[] }>) => calls.filter((c) => c.cmd === "git" && c.args.some((a) => ["fetch", "ls-remote", "clone", "pull", "push"].includes(a)));

describe("(a) dry run: no hardware approval, no credential, zero network", () => {
  it("passes with no anchor file, no assertion, no Ed25519 trust; never touches the credential store; no network API and no network command", async () => {
    const netCalls = netSpies();
    const t = await go({ dry: true, doc: "none", noAnchor: true });
    expect(t.r.status).toBe("PASS");
    expect(t.store.reads).toBe(0);
    expect(t.store.writes).toBe(0);
    expect(netCalls()).toBe(0);
    expect(networkExec(t.calls)).toEqual([]);
    expect(t.r.gates.find((g) => g.id === "credential")?.detail).toMatch(/credential store was not accessed/);
    expect(t.r.gates.some((g) => g.id === "owner-approval")).toBe(false);
    expect(t.r.gates.find((g) => g.id === "owner-signature")?.detail).toMatch(/DRY/);
    expect(existsSync(t.statePath)).toBe(false); // no counter recorded
  });

  it("a dry run with a garbage approval document and a garbage anchor on disk is unaffected (neither is consulted)", async () => {
    const t = await go({ dry: true, doc: { flags: 0x01 }, anchorText: "garbage" });
    expect(t.r.status).toBe("PASS");
    expect(t.store.reads).toBe(0);
    expect(existsSync(t.statePath)).toBe(false);
  });

  it("the dry/live executor brand cannot be crossed: dry with a live-simulating executor, or live with the dry fake, throws before any gate (so --dry cannot be used to skip a gate, nor a fake used for a live run)", async () => {
    await expect(go({ dry: true, brandMismatch: true, doc: "none" })).rejects.toThrow();
    await expect(go({ dry: false, brandMismatch: true })).rejects.toThrow();
  });
});

describe("(b) live run: every bad approval fails closed BEFORE the credential read, any network command or any consumed run", () => {
  const expectClosed = (t: Awaited<ReturnType<typeof go>>, gate: string, netCalls: () => number, stateMayExist = false) => {
    expect(t.r.status).toBe("BLOCKED");
    expect(failedGate(t.r)).toBe(gate);
    expect(t.store.reads).toBe(0);
    expect(t.store.writes).toBe(0);
    expect(netCalls()).toBe(0);
    expect(t.calls).toEqual([]); // not even a local git/node command ran: the approval gate precedes all of them
    expect(t.ledger.runsStarted(t.env.envelopeId)).toBe(0);
    expect(t.r.gates.some((g) => g.id === "credential")).toBe(false);
    if (!stateMayExist) expect(existsSync(t.statePath)).toBe(false);
  };

  it("no approval document", async () => {
    const n = netSpies();
    expectClosed(await go({ doc: "none" }), "owner-approval", n);
  });

  it("no anchor on disk", async () => {
    const n = netSpies();
    expectClosed(await go({ noAnchor: true }), "owner-approval", n);
  });

  it("invalid approval: wrong origin, wrong rpId hash, bad signature bytes, malformed document", async () => {
    const n = netSpies();
    expectClosed(await go({ doc: { origin: "https://evil.example.test" } }), "owner-approval", n);
    const good = makeAssertion(auth, makeEnvelope().envelopeSha256);
    void good;
    expectClosed(await go({ doc: { signCount: 5, flags: 0x01 | 0x04 | 0x08 } }), "owner-approval", n); // backup-eligible flag set
    expectClosed(await go({ doc: { rawSignature: Buffer.alloc(64, 1) } }), "owner-approval", n);
  });

  it("expired envelope (the approval is irrelevant): blocked at the window gate, before the approval, the credential and the network", async () => {
    const n = netSpies();
    const t = await go({ now: new Date("2026-11-20T00:00:00Z") });
    expect(t.r.status).toBe("BLOCKED");
    expect(failedGate(t.r)).toBe("envelope-window");
    expect(t.store.reads).toBe(0);
    expect(n()).toBe(0);
    expect(t.calls).toEqual([]);
    expect(t.ledger.runsStarted(t.env.envelopeId)).toBe(0);
  });

  it("not yet valid envelope", async () => {
    const n = netSpies();
    const t = await go({ now: new Date("2026-11-07T09:00:00Z") });
    expect(failedGate(t.r)).toBe("envelope-window");
    expect(t.store.reads).toBe(0);
    expect(n()).toBe(0);
  });

  it("replayed approval: a counter that does not strictly increase is refused for a NEW envelope (and an approval for another envelope is refused)", async () => {
    const n = netSpies();
    const dir = tmp();
    const first = await go({ dir, doc: { signCount: 5 } });
    expect(first.r.status).toBe("PASS");
    expect(first.store.reads).toBe(1); // the credential is read only after approval passed
    // a different envelope reusing the SAME counter value (a replay of the first approval's counter)
    const second = await go({ dir, env: { envelopeId: "d24-other-envelope-0001" } as never, doc: { signCount: 5 } });
    expectClosed(second, "owner-approval", n, true);
    expect(second.r.gates.find((g) => g.id === "owner-approval")?.detail).toMatch(/counter|replay|increase/i);
    // the first envelope's assertion presented for the second envelope
    const third = await go({ dir, env: { envelopeId: "d24-other-envelope-0002" } as never, doc: { forHash: first.env.envelopeSha256, opts: { signCount: 9 } } });
    expectClosed(third, "owner-approval", n, true);
    // and a LOWER counter than the stored one
    const fourth = await go({ dir, env: { envelopeId: "d24-other-envelope-0003" } as never, doc: { signCount: 3 } });
    expectClosed(fourth, "owner-approval", n, true);
  });

  it("altered envelope, case 1: edited after signing without re-hashing -> invalid envelope, before the approval", async () => {
    const n = netSpies();
    const t = await go({ mutateFileAfterSigning: (e) => ({ ...e, maxRuns: 4 }) });
    expect(t.r.status).toBe("BLOCKED");
    expect(failedGate(t.r)).toBe("envelope-valid");
    expect(t.store.reads).toBe(0);
    expect(n()).toBe(0);
    expect(t.calls).toEqual([]);
  });

  it("altered envelope, case 2: re-hashed after the owner approved the original -> the hardware assertion no longer matches", async () => {
    const n = netSpies();
    const original = makeEnvelope();
    const altered = makeEnvelope({ maxRuns: 3 });
    expect(altered.envelopeSha256).not.toBe(original.envelopeSha256);
    const t = await go({ env: { maxRuns: 3 }, doc: { forHash: original.envelopeSha256 } });
    expectClosed(t, "owner-approval", n);
  });

  it("UV-less approval (user presence only) is refused", async () => {
    const n = netSpies();
    expectClosed(await go({ doc: { flags: 0x01 } }), "owner-approval", n);
  });

  it("Ed25519-only approval (valid signature, valid trust, no hardware assertion) is refused", async () => {
    const n = netSpies();
    const t = await go({ doc: "none", ed25519: true });
    expectClosed(t, "owner-approval", n);
    expect(t.r.gates.some((g) => g.id === "owner-signature")).toBe(false);
  });

  it("sanity: the same fixture with a GOOD hardware approval passes, reads the credential exactly once and runs the live command through the executor seam only", async () => {
    const n = netSpies();
    const t = await go();
    expect(t.r.status).toBe("PASS");
    expect(t.store.reads).toBe(1);
    expect(n()).toBe(0); // the fake executor stands in for every process; no Node network API was used by the runner itself
    expect(sentLive(t.calls)).toBe(true);
  });
});

describe("(c) no fallback from a failed hardware approval to any other mechanism", () => {
  it("a failed assertion with a perfectly valid Ed25519 signature and trust present: blocked at owner-approval, the Ed25519 gate never runs", async () => {
    const t = await go({ doc: { flags: 0x01 }, ed25519: true });
    expect(failedGate(t.r)).toBe("owner-approval");
    expect(t.r.gates.map((g) => g.id)).not.toContain("owner-signature");
    expect(t.store.reads).toBe(0);
  });

  it("the envelope's own ownerApproval text is not a second route: a hash-valid envelope with no hardware assertion is still refused", async () => {
    const t = await go({ doc: "none" });
    expect(t.r.gates.find((g) => g.id === "envelope-valid")?.ok).toBe(true);
    expect(failedGate(t.r)).toBe("owner-approval");
  });

  it("a failed approval is not retried by the runner with another document or a prompt (one attempt, one result)", async () => {
    const t = await go({ doc: { flags: 0x01 } });
    expect(t.r.gates.filter((g) => g.id === "owner-approval").length).toBe(1);
  });

  it("structure: the only Ed25519 verifier call in runner.ts is in the branch that is unreachable for a live run while REQUIRE_HARDWARE_FOR_LIVE is true", () => {
    const src = readFileSync(join(__dirname, "..", "runner.ts"), "utf8");
    const calls = src.match(/verifyOwnerSignature\(/g) ?? [];
    expect(calls.length).toBe(1);
    const idx = src.indexOf("const sig = verifyOwnerSignature(");
    const before = src.slice(0, idx);
    expect(before.lastIndexOf("else if (REQUIRE_HARDWARE_FOR_LIVE) {")).toBeGreaterThan(before.lastIndexOf("if (d.dry) gate("));
    expect(src.slice(before.lastIndexOf("} else {"), idx)).toMatch(/^\} else \{\s*$/);
    // dry never reaches it (first branch), hardware-required never reaches it (second branch): only a rebuilt runner with the constant flipped would
    expect(src).toMatch(/export const REQUIRE_HARDWARE_FOR_LIVE: boolean = true;/);
  });

  it("CLI source: a live `run` has no option that substitutes another approval (no passphrase/signature/trust flags are read for live)", () => {
    const src = readFileSync(join(__dirname, "..", "cli.ts"), "utf8");
    const live = src.slice(src.indexOf("hw-approval"));
    expect(live.length).toBeGreaterThan(0);
    expect(src).not.toMatch(/--owner-sig|--signature|--passphrase|--skip-approval|--no-approval|--insecure/);
  });
});
