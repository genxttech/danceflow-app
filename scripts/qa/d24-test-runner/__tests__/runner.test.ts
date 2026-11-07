import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../credstore";
import { createFakeExec, type FakeOpts } from "../fakeChild";
import { verifyCleanClone } from "../gitverify";
import { Ledger } from "../ledger";
import { runEnvelope, type RunnerDeps } from "../runner";
import { KEY, LABEL, makeEnvelope, mkLedger, NOW, ownerSign, ownerTrust, REPO, SHA, tmp, writeEnvelope } from "./helpers";
import type { EnvelopeSpec } from "../envelope";

type Setup = { fake?: Partial<FakeOpts>; spec?: Partial<EnvelopeSpec>; store?: MemoryStore; dry?: boolean; now?: Date; ledger?: Ledger; storeCalls?: { n: number }; install?: boolean; sig?: "none" | "other-envelope" | "garbage"; noTrust?: boolean; trustLedgerDir?: string; repoDir?: string; expireAfterInstall?: boolean };

async function go(s: Setup = {}) {
  const evidenceRoot = join(tmp(), "evidence");
  const env = makeEnvelope({ evidenceRoot, ...s.spec });
  const file = writeEnvelope(env);
  const calls: NonNullable<FakeOpts["calls"]> = [];
  const lines: string[] = [];
  const store = s.store ?? new MemoryStore();
  if (!s.store && !s.dry) await store.write(LABEL, KEY);
  const storeCalls = s.storeCalls ?? { n: 0 };
  const ledger = s.ledger ?? mkLedger();
  const trust = s.noTrust ? null : ownerTrust(s.trustLedgerDir ?? ledger.dir, ledger.anchorFile as string);
  let signature: unknown = ownerSign(env);
  if (s.sig === "none") signature = null;
  if (s.sig === "garbage") signature = { v: 1, domain: "D24-TEST-ENVELOPE-V1", envelopeSha256: env.envelopeSha256, publicKeyFingerprint: trust?.publicKeyFingerprint ?? "x", signatureBase64: Buffer.alloc(64, 7).toString("base64") };
  if (s.sig === "other-envelope") signature = ownerSign({ envelopeSha256: "ab".repeat(32) });
  const flag = { installed: false };
  const baseExec = createFakeExec({ commitSha: SHA, repoDir: REPO, calls, ...s.fake });
  const deps: RunnerDeps = {
    owner: { trust, signature },
    exec: async (cmd, args, o) => {
      if (args.some((a) => /npm-cli/.test(a))) flag.installed = true;
      return baseExec(cmd, args, o);
    },
    parentEnv: { PATH: "C:\\bin", SystemRoot: "C:\\Windows", NODE_OPTIONS: "--require evil", HTTPS_PROXY: "http://p", DATABASE_URL: "postgres://prod/db" },
    store: () => {
      storeCalls.n++;
      if (s.dry) throw new Error("store must not be touched in dry");
      return store;
    },
    ledger, now: () => (s.expireAfterInstall && flag.installed ? new Date("2026-11-15T00:00:00Z") : s.now ?? NOW), out: (l) => lines.push(l), dry: Boolean(s.dry), runInstall: s.install ?? true, dryKey: s.dry ? KEY : undefined, tsxCli: "tsx-cli-unused",
  };
  const r = await runEnvelope(file, s.repoDir ?? REPO, deps);
  return { r, calls, lines, ledger, env, storeCalls, evidenceRoot };
}
const failedGate = (r: { gates: Array<{ id: string; ok: boolean }> }) => r.gates.find((g) => !g.ok)?.id;

describe("runner happy path (fake child)", () => {
  it("passes every gate, consumes a run, writes a report and returns PASS", async () => {
    const { r, ledger, env, lines } = await go();
    expect(r.status).toBe("PASS");
    expect(r.exitCode).toBe(0);
    expect(ledger.runsStarted(env.envelopeId)).toBe(1);
    expect(ledger.load().map((e) => e.type)).toEqual(["run-start", "run-end"]);
    const report = readFileSync(r.reportPath as string, "utf8");
    expect(report).toMatch(/Decision: PASS/);
    expect(report).toMatch(/V4 \(ledger convergence\): NOT TESTED/);
    expect(report).toMatch(/expire the restricted key/);
    expect(lines.join("\n")).not.toContain(KEY);
    expect(readdirSync(join(env.evidenceRoot, env.envelopeId, "run-1")).sort()).toEqual(["evidence-fake1.json", "report.md", "runner-child-output.txt", "transcript-fake1.txt"]);
  });

  it("injects the key ONLY into the --live/--preflight child env, never into git/npm/hash children, argv or output", async () => {
    const { calls, lines, r } = await go();
    const withKey = calls.filter((c) => Object.values(c.env).some((v) => v === KEY));
    expect(withKey.map((c) => c.args[c.args.length - 1]).sort()).toEqual(["--live", "--preflight"]);
    for (const c of calls) {
      expect(c.args.join(" ")).not.toContain(KEY);
      for (const [k, v] of Object.entries(c.env)) if (v === KEY) expect(k).toBe("D24_PROOF_STRIPE_KEY");
      expect(c.env.NODE_OPTIONS).toBeUndefined();
      expect(c.env.HTTPS_PROXY).toBeUndefined();
      expect(c.env.DATABASE_URL).toBeUndefined();
    }
    expect(lines.join("\n")).not.toContain(KEY);
    const ev = readdirSync(join(r.reportPath as string, ".."));
    for (const f of ev) expect(readFileSync(join(r.reportPath as string, "..", f), "utf8")).not.toContain(KEY);
  });

  it("runs the full order: git, hash, allow-list, dry-run, preflight, live", async () => {
    const { calls } = await go();
    const flags = calls.filter((c) => c.cmd !== "git" && !c.args.some((a) => /npm-cli/.test(a))).map((c) => c.args[c.args.length - 1]);
    expect(flags).toEqual(["--print-hash", "--allow-list", "--dry-run", "--preflight", "--live"]);
  });
});

describe("owner signature (the self-approval control)", () => {
  const blockedAt = async (s: Setup, gateId: string) => {
    const { r, ledger, env, calls } = await go(s);
    expect(r.status).toBe("BLOCKED");
    expect(failedGate(r)).toBe(gateId);
    expect(ledger.runsStarted(env.envelopeId)).toBe(0);
    expect(calls.some((c) => c.args[c.args.length - 1] === "--live")).toBe(false);
    return r;
  };
  it("no registered owner key -> live refused", async () => {
    const r = await blockedAt({ noTrust: true }, "owner-signature");
    expect(r.gates.find((g) => g.id === "owner-signature")?.detail).toMatch(/no owner public key/);
  });
  it("missing signature -> refused", async () => void (await blockedAt({ sig: "none" }, "owner-signature")));
  it("garbage signature -> refused", async () => void (await blockedAt({ sig: "garbage" }, "owner-signature")));
  it("a valid owner signature over a DIFFERENT envelope hash -> refused", async () => void (await blockedAt({ sig: "other-envelope" }, "owner-signature")));
  it("a perfectly valid envelope that merely carries the right approval text (self-minted) cannot run live", async () => {
    // exactly the review's P1 scenario: approval-template | create-envelope yields a structurally valid envelope, but nobody signed it
    const { r } = await go({ sig: "none" });
    expect(failedGate(r)).toBe("owner-signature");
  });
  it("the same envelope signed by the owner runs", async () => {
    const { r } = await go();
    expect(r.status).toBe("PASS");
    expect(r.gates.find((g) => g.id === "owner-signature")?.detail).toMatch(/valid owner signature/);
  });
});

describe("runner pin, checkout pin, ceiling pin", () => {
  const blockedAt = async (s: Setup, gateId: string) => {
    const { r, ledger, env } = await go(s);
    expect(r.status).toBe("BLOCKED");
    expect(failedGate(r)).toBe(gateId);
    expect(ledger.runsStarted(env.envelopeId)).toBe(0);
    return r;
  };
  it("the runner folder hash must equal the envelope's (a modified enforcement module cannot run)", async () => {
    const r = await blockedAt({ spec: { runner: { manifestSha256: "1".repeat(64), fileCount: 20 } } }, "runner-pin");
    expect(r.gates.find((g) => g.id === "runner-pin")?.detail).toMatch(/changed after approval/);
  });
  it("--repo must be the clone this runner lives in", async () => void (await blockedAt({ repoDir: tmp("d24-other-clone-") }, "runner-in-clone")));
  it("an envelope ceiling different from the proof's enforced cap is refused (cannot be enforced live)", async () => {
    const r = await blockedAt({ spec: { apiCallCeiling: 30 } }, "ceiling-pin");
    expect(r.gates.find((g) => g.id === "ceiling-pin")?.detail).toMatch(/cannot be enforced live/);
  });
  it("the ledger must be at the location pinned in the owner trust (a fresh ledger would reset the budget)", async () => void (await blockedAt({ trustLedgerDir: join(tmp(), "some-other-ledger") }, "ledger-pinned")));
  it("expiry is re-checked when the run is consumed, after a long install", async () => {
    const r = await blockedAt({ expireAfterInstall: true }, "envelope-window-recheck");
    expect(r.gates.find((g) => g.id === "envelope-window")?.ok).toBe(true);
  });
});

describe("timeout disposition", () => {
  it("a timed-out proof is UNVERIFIABLE, never clean: the run stays open and the lock is kept", async () => {
    const { r, ledger, env } = await go({ fake: { live: "timeout" } });
    expect(r.status).toBe("UNVERIFIABLE");
    expect(r.exitCode).toBe(1);
    expect(ledger.load().map((e) => e.type)).toEqual(["run-start"]);
    expect(existsSync(ledger.lockFile)).toBe(true);
    expect(ledger.startBlockers(env.envelopeId, 2).join()).toMatch(/no recorded end|run.lock/);
    expect(readFileSync(r.reportPath as string, "utf8")).toMatch(/timed out and was killed/);
  });
});

describe("DRY mode never touches the credential store and sends nothing real", () => {
  it("passes with a fake key, store factory never called", async () => {
    const storeCalls = { n: 0 };
    const { r } = await go({ dry: true, storeCalls });
    expect(r.status).toBe("PASS");
    expect(storeCalls.n).toBe(0);
  });
});

describe("refusals (each BLOCKED before any live call, no run consumed)", () => {
  const blockedWith = async (s: Setup, gateId: string) => {
    const { r, calls, ledger, env, storeCalls } = await go(s);
    expect(r.status).toBe("BLOCKED");
    expect(r.exitCode).toBe(2);
    expect(failedGate(r)).toBe(gateId);
    expect(calls.some((c) => c.args[c.args.length - 1] === "--live")).toBe(false);
    expect(ledger.runsStarted(env.envelopeId)).toBe(0);
    return { storeCalls, calls };
  };

  it("expired envelope", async () => void (await blockedWith({ now: new Date("2026-12-01T00:00:00Z") }, "envelope-window")));
  it("not-yet-valid envelope", async () => void (await blockedWith({ now: new Date("2026-10-01T00:00:00Z") }, "envelope-window")));
  it("wrong HEAD commit", async () => void (await blockedWith({ fake: { commitSha: "d".repeat(40) } }, "git-head")));
  it("dirty tree", async () => void (await blockedWith({ fake: { dirty: true } }, "git-clean-tree")));
  it("hidden local edit (assume-unchanged)", async () => void (await blockedWith({ fake: { hiddenEdit: true } }, "git-no-hidden-edits")));
  it("npm ci integrity failure", async () => void (await blockedWith({ fake: { npmCiFails: true } }, "npm-ci")));
  it("skipped install is not verification", async () => void (await blockedWith({ install: false }, "npm-ci")));
  it("lockfile pin mismatch", async () => void (await blockedWith({ spec: { code: { commitSha: SHA, lockfileSha256: "f".repeat(64) } } }, "lockfile-hash")));
  it("proof manifest differs from the envelope", async () => void (await blockedWith({ spec: { proof: { manifestSha256: "e".repeat(64), fileCount: 30 } } }, "proof-manifest")));
  it("proof --print-hash differs from the runner's recomputation", async () => void (await blockedWith({ fake: { proofHash: "9".repeat(64) } }, "proof-manifest")));
  it("allow-list gained a rule not in the envelope", async () => void (await blockedWith({ fake: { ruleIds: ["identity.platform", "invoice.finalize"] } }, "allow-list")));
  it("allow-list lost a rule the envelope lists", async () => void (await blockedWith({ fake: { ruleIds: ["identity.platform"] } }, "allow-list")));
  it("proof dry run fails", async () => void (await blockedWith({ fake: { dryRunOk: false } }, "proof-dry-run")));
  it("preflight FAIL", async () => void (await blockedWith({ fake: { preflightFail: ["owner-values"] } }, "proof-preflight")));
  it("MANUAL item with no attestation in the envelope is not guessed", async () => {
    await blockedWith({ fake: { preflightManual: ["sandbox", "brand-new-manual-item"] } }, "proof-preflight");
  });
  it("no credential stored", async () => void (await blockedWith({ store: new MemoryStore() }, "credential")));
  it("stored key is not rk_test_ shaped (sk_test_, live, pk)", async () => {
    for (const bad of [["sk", "test", "AAAAAAAAAAAAAAAA"], ["rk", "live", "AAAAAAAAAAAAAAAA"], ["pk", "test", "AAAAAAAAAAAAAAAA"]].map((p) => p.join("_"))) {
      const store = new MemoryStore();
      await store.write(LABEL, bad);
      const { r, lines } = await go({ store });
      expect(r.status).toBe("BLOCKED");
      expect(failedGate(r)).toBe("credential-shape");
      expect(lines.join("\n")).not.toContain(bad);
    }
  });
  it("stored key differs from the approved fingerprint (swapped/rotated key)", async () => {
    const store = new MemoryStore();
    await store.write(LABEL, ["rk", "test", "DIFFERENTKEY99999999"].join("_"));
    await blockedWith({ store }, "credential-fingerprint");
  });
  it("evidence root inside a git checkout", async () => void (await blockedWith({ spec: { evidenceRoot: join(REPO, "evidence-in-repo") } }, "evidence-dir")));
  it("invalid envelope file", async () => {
    const lines: string[] = [];
    const r = await runEnvelope(join(tmp(), "missing.json"), REPO, { exec: createFakeExec({ commitSha: SHA, repoDir: REPO }), parentEnv: {}, store: () => new MemoryStore(), ledger: new Ledger(join(tmp(), "l")), now: () => NOW, out: (l) => lines.push(l), dry: true, runInstall: true });
    expect(r.status).toBe("BLOCKED");
  });
  it("the credential store is not touched when an earlier gate fails", async () => {
    const storeCalls = { n: 0 };
    await go({ fake: { dirty: true }, storeCalls });
    expect(storeCalls.n).toBe(0);
  });
});

describe("run count", () => {
  it("refuses once maxRuns is consumed; a failed run still counts", async () => {
    const ledger = mkLedger();
    const evidenceRoot = join(tmp(), "evidence");
    const spec = { evidenceRoot, maxRuns: 2 };
    const a = await go({ ledger, spec, fake: { live: "abort" } });
    expect(a.r.status).toBe("FAIL");
    expect(ledger.runsStarted(a.env.envelopeId)).toBe(1);
    const b = await go({ ledger, spec, fake: { live: "ok" } });
    expect(b.r.status).toBe("PASS");
    const c = await go({ ledger, spec });
    expect(c.r.status).toBe("BLOCKED");
    expect(failedGate(c.r)).toBe("ledger");
    expect(c.r.gates.find((g) => g.id === "ledger")?.detail).toMatch(/exhausted/);
  });
  it("a crash inside the live child still ends the run in the ledger and consumes it", async () => {
    const ledger = mkLedger();
    await expect(go({ ledger, fake: { live: "crash" } })).rejects.toThrow(/spawn failed/);
    expect(ledger.load().map((e) => e.type)).toEqual(["run-start", "run-end"]);
    expect(ledger.load()[1].outcome).toBe("UNVERIFIABLE");
  });
});

describe("post-run decisions", () => {
  it("abort -> FAIL with diagnosis", async () => {
    const { r } = await go({ fake: { live: "abort" } });
    expect(r.status).toBe("FAIL");
    expect(readFileSync(r.reportPath as string, "utf8")).toMatch(/unexpected_4xx_streak: Repeated 4xx/);
  });
  it("lost create response -> UNVERIFIABLE, not PASS", async () => {
    const { r } = await go({ fake: { live: "unverifiable" } });
    expect(r.status).toBe("UNVERIFIABLE");
  });
  it("no evidence written -> UNVERIFIABLE", async () => {
    const { r } = await go({ fake: { live: "no-evidence" } });
    expect(r.status).toBe("UNVERIFIABLE");
  });
  it("calls above the envelope ceiling -> FAIL", async () => {
    const { r } = await go({ fake: { live: "overbudget" } });
    expect(r.status).toBe("FAIL");
  });
  it("secret-shaped output (hostile stdout) -> FAIL, redacted everywhere, exact key never in any artifact", async () => {
    const { r, env } = await go({ fake: { hostileStdout: `leak ${KEY} and whsec_abcdefghijklmnop owner@example.com` } });
    expect(r.status).toBe("FAIL");
    const dir = join(env.evidenceRoot, env.envelopeId, "run-1");
    for (const f of readdirSync(dir)) {
      const t = readFileSync(join(dir, f), "utf8");
      if (f === "evidence-fake1.json" || f === "transcript-fake1.txt") continue; // proof-owned originals (hashed as written)
      expect(t, f).not.toContain(KEY);
      expect(t, f).not.toContain("whsec_abcdefghijklmnop");
      expect(t, f).not.toContain("owner@example.com");
    }
    expect(readFileSync(r.reportPath as string, "utf8")).toMatch(/SECRET: (stripe-key|exact-credential-literal)/);
  });
  it("a secret planted in the evidence JSON by a hostile response -> FAIL", async () => {
    const { r } = await go({ fake: { hostileEvidence: `oops ${["sk", "live", "ABCDEFGHIJKLMNOP1234"].join("_")}` } });
    expect(r.status).toBe("FAIL");
  });
});

describe("gitverify on its own", () => {
  it("returns gates in order and stops installing when the tree is not pinned", async () => {
    const calls: NonNullable<FakeOpts["calls"]> = [];
    const g = await verifyCleanClone({ repoDir: REPO, commitSha: SHA, env: {}, exec: createFakeExec({ commitSha: "e".repeat(40), repoDir: REPO, calls }), runInstall: true });
    expect(g.map((x) => x.id)).toEqual(["git-head"]);
    expect(calls.some((c) => c.args.some((a) => /npm-cli/.test(a)))).toBe(false);
  });
});
