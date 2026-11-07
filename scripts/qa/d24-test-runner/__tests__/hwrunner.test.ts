import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../credstore";
import { createFakeExec, type FakeOpts } from "../fakeChild";
import { runEnvelope, type RunnerDeps } from "../runner";
import { anchorFingerprint } from "../webauthn";
import { KEY, LABEL, makeEnvelope, mkLedger, NOW, ownerSign, ownerTrust, REPO, SHA, tmp, writeEnvelope } from "./helpers";
import { makeAssertion, makeSoftAuth, testAuth, type AssertionOpts } from "./softauth";
import { REQUIRE_HARDWARE_FOR_LIVE } from "../runner";
import { PINNED_REPO_URL } from "../trustroot";

const auth = testAuth;
const failed = (r: { gates: Array<{ id: string; ok: boolean }> }) => r.gates.find((g) => !g.ok)?.id;

async function go(o: { anchor?: object | string | null; doc?: AssertionOpts | "none" | "other-envelope"; ed25519?: boolean; fake?: Partial<FakeOpts>; dry?: boolean; noAnchorFile?: boolean; envSpec?: Parameters<typeof makeEnvelope>[0]; dir?: string } = {}) {
  const dir = o.dir ?? tmp();
  const env = makeEnvelope({ evidenceRoot: join(dir, "evidence"), ...o.envSpec });
  const file = writeEnvelope(env);
  const anchorPath = join(dir, "owner-hw-anchor.json");
  if (!o.noAnchorFile) writeFileSync(anchorPath, typeof o.anchor === "string" ? o.anchor : JSON.stringify(o.anchor ?? auth.anchor));
  const statePath = join(dir, "state", "hw-signcount.json");
  const ledger = mkLedger();
  const calls: NonNullable<FakeOpts["calls"]> = [];
  const store = new MemoryStore();
  await store.write(LABEL, KEY);
  const lines: string[] = [];
  const doc = o.doc === "none" ? null : o.doc === "other-envelope" ? makeAssertion(auth, "ab".repeat(32), { signCount: 5 }) : makeAssertion(auth, env.envelopeSha256, { signCount: 5, ...(o.doc ?? {}) });
  const deps: RunnerDeps = {
    exec: createFakeExec({ commitSha: SHA, repoDir: REPO, calls, ...o.fake }, { simulateLive: !o.dry }),
    parentEnv: { PATH: "C:\\bin", SystemRoot: "C:\\Windows" },
    store: () => {
      if (o.dry) throw new Error("no store in dry");
      return store;
    },
    ledger,
    now: () => NOW,
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

describe("hardware approval kind wired into the envelope gate", () => {
  it("a valid hardware-key assertion over the envelope hash lets the run proceed; the counter is recorded; the commit is checked against the PINNED repo URL", async () => {
    const { r, calls, statePath, env } = await go();
    expect(r.status).toBe("PASS");
    expect(r.gates.find((g) => g.id === "owner-approval")?.detail).toMatch(/HARDWARE-key approval/);
    expect(r.gates.find((g) => g.id === "commit-on-main")?.ok).toBe(true);
    const lsr = calls.find((c) => c.cmd === "git" && c.args.includes("ls-remote"));
    expect(lsr?.args).toEqual(expect.arrayContaining([PINNED_REPO_URL, "refs/heads/main"]));
    expect(JSON.parse(readFileSync(statePath, "utf8")).byEnvelope[env.envelopeSha256]).toBe(5);
  });

  it("Ed25519 can NEVER authorise a live run when the hardware anchor is present, even with a perfectly valid signature and trust", async () => {
    const { r, calls, store, ledger, env } = await go({ doc: "none", ed25519: true });
    expect(r.status).toBe("BLOCKED");
    expect(failed(r)).toBe("owner-approval");
    expect(r.gates.some((g) => g.id === "owner-signature")).toBe(false);
    expect(calls.some((c) => c.args[c.args.length - 1] === "--live")).toBe(false);
    expect(ledger.runsStarted(env.envelopeId)).toBe(0);
    void store;
  });

  it("refuses: assertion for a different envelope, wrong flags, replayed lower counter, tampered anchor", async () => {
    expect(failed((await go({ doc: "other-envelope" })).r)).toBe("owner-approval");
    expect(failed((await go({ doc: { flags: 0x01 } })).r)).toBe("owner-approval");
    expect(failed((await go({ doc: { flags: 0x0d } })).r)).toBe("owner-approval");
    expect(failed((await go({ doc: { origin: "https://evil.example.test" } })).r)).toBe("owner-approval");
    const bad = { ...auth.anchor, rpId: "evil.example.test" };
    const t = await go({ anchor: bad });
    expect(failed(t.r)).toBe("owner-approval");
    expect(t.r.gates.find((g) => g.id === "owner-approval")?.detail).toMatch(/anchor is invalid/);
    // an anchor re-fingerprinted by an attacker with their own key still fails: the assertion is not by that key
    const other = makeSoftAuth();
    const swapped = { ...other.anchor, credentialId: auth.anchor.credentialId };
    swapped.fingerprintSha256 = anchorFingerprint(swapped);
    expect(failed((await go({ anchor: swapped })).r)).toBe("owner-anchor-pin");
  });

  it("nothing is consumed or sent when the approval fails: no ledger run, no credential read, no live call", async () => {
    const { r, calls, ledger, env } = await go({ doc: { flags: 0x01 } });
    expect(r.status).toBe("BLOCKED");
    expect(ledger.runsStarted(env.envelopeId)).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("the pinned commit must be on the owner-merged branch: not-on-main is BLOCKED before the credential is read or any run is consumed", async () => {
    const { r, ledger, env, calls } = await go({ fake: { notOnMain: true } });
    expect(r.status).toBe("BLOCKED");
    expect(failed(r)).toBe("commit-on-main");
    expect(ledger.runsStarted(env.envelopeId)).toBe(0);
    expect(calls.some((c) => c.args[c.args.length - 1] === "--live")).toBe(false);
  });

  it("the hardware ledger location is fixed: a ledger elsewhere is refused", async () => {
    const dir = tmp();
    const env = makeEnvelope({ evidenceRoot: join(dir, "evidence") });
    const anchorPath = join(dir, "a.json");
    writeFileSync(anchorPath, JSON.stringify(auth.anchor));
    const ledger = mkLedger();
    const r = await runEnvelope(writeEnvelope(env), REPO, {
      exec: createFakeExec({ commitSha: SHA, repoDir: REPO }, { simulateLive: true }),
      parentEnv: {},
      store: () => new MemoryStore(),
      ledger,
      now: () => NOW,
      out: () => {},
      dry: false,
      runInstall: true,
      owner: { trust: null, signature: null, hardware: { doc: makeAssertion(auth, env.envelopeSha256, { signCount: 2 }), anchorPath, statePath: join(dir, "s.json"), pins: { ledgerDir: join(dir, "elsewhere"), anchorFile: join(dir, "x.json") } } },
    });
    expect(failed(r)).toBe("ledger-pinned");
  });

  it("REQUIRE_HARDWARE_FOR_LIVE is a hard-coded true constant (not read from any file, environment or argument)", () => {
    expect(REQUIRE_HARDWARE_FOR_LIVE).toBe(true);
    const src = readFileSync(join(__dirname, "..", "runner.ts"), "utf8");
    expect(src).toMatch(/export const REQUIRE_HARDWARE_FOR_LIVE: boolean = true;/);
    expect(src).not.toMatch(/REQUIRE_HARDWARE_FOR_LIVE\s*=\s*(process|d\.|opts|args|JSON|read)/);
  });

  it("deleting, renaming, blanking or corrupting the anchor BLOCKS a live run; it never downgrades to Ed25519 (even with a valid signature and trust)", async () => {
    const variants: Array<{ name: string; o: Parameters<typeof go>[0] }> = [
      { name: "deleted/renamed (file missing)", o: { noAnchorFile: true, ed25519: true } },
      { name: "blank", o: { anchor: "", ed25519: true } },
      { name: "not JSON", o: { anchor: "{oops", ed25519: true } },
      { name: "empty object", o: { anchor: {}, ed25519: true } },
      { name: "JSON null", o: { anchor: "null", ed25519: true } },
    ];
    for (const v of variants) {
      const { r, ledger, env, calls } = await go(v.o);
      expect(r.status, v.name).toBe("BLOCKED");
      expect(failed(r), v.name).toBe("owner-approval");
      expect(r.gates.some((g) => g.id === "owner-signature"), v.name).toBe(false);
      expect(ledger.runsStarted(env.envelopeId), v.name).toBe(0);
      expect(calls.some((c) => c.args[c.args.length - 1] === "--live"), v.name).toBe(false);
    }
  });

  it("the anchor fingerprint pinned INSIDE the (hardware-approved) envelope must equal the runner's anchor: a swapped anchor cannot approve an envelope written for another", async () => {
    const other = makeSoftAuth();
    // the attacker replaces the anchor with their own (valid, re-fingerprinted) one and signs with their own software key
    const dir = tmp();
    const env = makeEnvelope({ evidenceRoot: join(dir, "evidence") }); // pins the OWNER anchor
    const anchorPath = join(dir, "a.json");
    writeFileSync(anchorPath, JSON.stringify(other.anchor));
    const ledger = mkLedger();
    const r = await runEnvelope(writeEnvelope(env), REPO, {
      exec: createFakeExec({ commitSha: SHA, repoDir: REPO }, { simulateLive: true }),
      parentEnv: {},
      store: () => new MemoryStore(),
      ledger,
      now: () => NOW,
      out: () => {},
      dry: false,
      runInstall: true,
      owner: { trust: null, signature: null, hardware: { doc: makeAssertion(other, env.envelopeSha256, { signCount: 3 }), anchorPath, statePath: join(dir, "s.json"), pins: { ledgerDir: ledger.dir, anchorFile: ledger.anchorFile as string } } },
    });
    expect(failed(r)).toBe("owner-anchor-pin");
    expect(ledger.runsStarted(env.envelopeId)).toBe(0);
  });

  it("the sign counter is recorded only when the run is consumed: a run blocked by a later gate leaves the state untouched, and the SAME approval works on retry", async () => {
    const dir = tmp();
    const blocked = await go({ dir, fake: { notOnMain: true } });
    expect(failed(blocked.r)).toBe("commit-on-main");
    expect(existsSync(blocked.statePath)).toBe(false);
    const ok = await go({ dir });
    expect(ok.r.status).toBe("PASS");
    expect(JSON.parse(readFileSync(ok.statePath, "utf8")).byEnvelope[ok.env.envelopeSha256]).toBe(5);
  });

  it("dry mode never needs or records a hardware approval, even with the anchor present", async () => {
    const { r, statePath, calls } = await go({ dry: true, doc: "none" });
    expect(r.status).toBe("PASS");
    expect(existsSync(statePath)).toBe(false);
    expect(calls.some((c) => c.args.includes("fetch"))).toBe(false);
  });

  it("a state file that is malformed or unwritable location blocks (fail closed)", async () => {
    const dir = tmp();
    const env = makeEnvelope({ evidenceRoot: join(dir, "evidence") });
    const anchorPath = join(dir, "a.json");
    writeFileSync(anchorPath, JSON.stringify(auth.anchor));
    const statePath = join(dir, "s.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(statePath, "garbage");
    const ledger = mkLedger();
    const r = await runEnvelope(writeEnvelope(env), REPO, {
      exec: createFakeExec({ commitSha: SHA, repoDir: REPO }, { simulateLive: true }),
      parentEnv: {},
      store: () => new MemoryStore(),
      ledger,
      now: () => NOW,
      out: () => {},
      dry: false,
      runInstall: true,
      owner: { trust: null, signature: null, hardware: { doc: makeAssertion(auth, env.envelopeSha256, { signCount: 2 }), anchorPath, statePath, pins: { ledgerDir: ledger.dir, anchorFile: ledger.anchorFile as string } } },
    });
    expect(failed(r)).toBe("owner-approval");
  });
});
