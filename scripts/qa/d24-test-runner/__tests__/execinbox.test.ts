// The threat table of docs/billing/D24-TEST-RUNNER-TRUST-ANCHOR.md, one row at a time, against a THROWAWAY install root built by the real installer with
// fake ACL text. What these tests cannot show (the OS actually enforcing the ACLs against a non-admin process, d24run isolation, a real authenticator,
// UAC) is listed in the document's Windows test plan.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../credstore";
import { ExecInboxDeps, execInboxMain, runInstalled, verifyInstalled } from "../execinbox";
import { realExec } from "../exec";
import { Ledger } from "../ledger";
import { markVerifiedInstalled, type Layout } from "../installroot";
import { runEnvelope } from "../runner";
import { policyText, policySha256, type Policy } from "../policy";
import { baseSpec, KEY, LABEL, makeEnvelope, NOW, REPO, SHA, tmp } from "./helpers";
import { aclText, FakeAcl, installed, simulatedLive, writeAnchor } from "./installfixture";
import { makeAssertion, makeSoftAuth, testAuth } from "./softauth";

vi.setConfig({ testTimeout: 60_000 });
const RUN = "run-0001";
type EnvOver = Parameters<typeof makeEnvelope>[0];

function envFor(l: Layout, over: EnvOver = {}) {
  return makeEnvelope({ evidenceRoot: join(l.evidence, "runs"), credential: { ...baseSpec().credential, store: "dpapi-file" }, ...over });
}
function drop(l: Layout, env: ReturnType<typeof makeEnvelope>, o: { sign?: Parameters<typeof makeAssertion>[2]; auth?: typeof testAuth; runId?: string; doc?: object } = {}) {
  const dir = join(l.inbox, o.runId ?? RUN);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "envelope.json"), JSON.stringify(env));
  writeFileSync(join(dir, "assertion.hw.json"), JSON.stringify(o.doc ?? makeAssertion(o.auth ?? testAuth, env.envelopeSha256, { signCount: 5, ...(o.sign ?? {}) })));
}
function depsFor(l: Layout, acl: FakeAcl, over: Partial<ExecInboxDeps> = {}) {
  const lines: string[] = [];
  const d: ExecInboxDeps = { layout: l, runningFile: join(l.runnerDir, "execinbox.ts"), acl, whoami: () => "PC\\d24run", now: () => NOW, out: (x) => void lines.push(x), ...over };
  return { d, lines };
}
async function ready(over: EnvOver = {}) {
  const f = await installed();
  const env = envFor(f.l, over);
  drop(f.l, env);
  return { ...f, env, acl: new FakeAcl(f.l) };
}
// the failing gate must also be the LAST one: a gate that is recorded as failed but not enforced lets later gates run, and is reported as CONTINUED
const failedGate = (g: Array<{ id: string; ok: boolean }>) => {
  const bad = g.find((x) => !x.ok);
  return bad === undefined ? undefined : g[g.length - 1] === bad ? bad.id : `CONTINUED-PAST-${bad.id}`;
};

describe("verifyInstalled: the happy path", () => {
  it("passes every gate in the documented order and brands the result", async () => {
    const { l, acl } = await ready();
    const { d } = depsFor(l, acl);
    const v = await verifyInstalled(RUN, d);
    expect(v.ok).toBe(true);
    expect(v.gates.map((g) => g.id)).toEqual(["identity", "run-id", "install-root", "policy", "policy-run-as", "install-root-acl", "release-record", "tree-hash", "policy-hash", "anchor", "inbox-copy", "envelope", "envelope-window", "policy-clamp"]);
  });
});

describe("threat table: edits to the execution path", () => {
  it("runner code or REQUIRE_HARDWARE_FOR_LIVE edited in the installed tree -> tree-hash blocks, no key read", async () => {
    const { l, acl } = await ready();
    const f = join(l.runnerDir, "runner.ts");
    writeFileSync(f, readFileSync(f, "utf8").replace("REQUIRE_HARDWARE_FOR_LIVE: boolean = true", "REQUIRE_HARDWARE_FOR_LIVE: boolean = false"));
    const v = await verifyInstalled(RUN, depsFor(l, acl).d);
    expect(failedGate(v.gates)).toBe("tree-hash");
  });
  it("a proof file changed -> tree-hash blocks", async () => {
    const { l, acl } = await ready();
    appendFileSync(join(l.proofDir, "config.ts"), "\n// edited");
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, acl).d)).gates)).toBe("tree-hash");
  });
  it("anchor.json replaced by an attacker's software-authenticator anchor -> blocked at the anchor gate (hash differs from the release record)", async () => {
    const { l, acl } = await ready();
    const evil = makeSoftAuth();
    writeFileSync(l.anchorJson, JSON.stringify(evil.anchor));
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, acl).d)).gates)).toBe("anchor");
  });
  it("anchor.json with the same key but different bytes (reformatted) is refused: the installer-recorded byte hash is what is compared", async () => {
    const { l, acl } = await ready();
    writeFileSync(l.anchorJson, JSON.stringify(JSON.parse(readFileSync(l.anchorJson, "utf8"))));
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, acl).d)).gates)).toBe("anchor");
  });
  it("anchor.json, policy.json and release.json ALL rewritten consistently -> the ACL gate is what stops it (the files would only be writable if the ACL were wrong)", async () => {
    const { l } = await ready();
    const evil = makeSoftAuth();
    writeFileSync(l.anchorJson, JSON.stringify(evil.anchor));
    const bad = new FakeAcl(l);
    for (const p of [l.anchorJson, l.policyJson, l.releaseJson]) bad.override(p, aclText(p, "locked").replace("Successfully", "      PC\\ownerperson:(M)\n\nSuccessfully"));
    const v = await verifyInstalled(RUN, depsFor(l, bad).d);
    expect(failedGate(v.gates)).toBe("install-root-acl");
  });
  it("policy.json edited -> policy-hash blocks; a widened policy fails to parse; a missing one blocks", async () => {
    const { l, acl } = await ready();
    const pol = JSON.parse(readFileSync(l.policyJson, "utf8")) as Policy;
    writeFileSync(l.policyJson, policyText({ ...pol, maxRunsPerDay: 1 }));
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, acl).d)).gates)).toBe("policy-hash");
    writeFileSync(l.policyJson, policyText({ ...pol, maxCallsPerRun: 99 }));
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, acl).d)).gates)).toBe("policy");
    writeFileSync(l.policyJson, "{");
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, acl).d)).gates)).toBe("policy");
    void policySha256;
  });
  it("release.json edited (to bless a modified tree) -> parse or hash mismatch blocks", async () => {
    const { l, acl } = await ready();
    const rel = JSON.parse(readFileSync(l.releaseJson, "utf8"));
    writeFileSync(l.releaseJson, JSON.stringify({ ...rel, treeSha256: "f".repeat(64) }));
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, acl).d)).gates)).toBe("tree-hash");
    writeFileSync(l.releaseJson, JSON.stringify({ ...rel, extra: 1 }));
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, acl).d)).gates)).toBe("release-record");
  });
  it("code running from a copy outside the install root is refused; so is a redirected root", async () => {
    const { l, acl } = await ready();
    const outside = depsFor(l, acl, { runningFile: join(REPO, "scripts", "qa", "d24-test-runner", "execinbox.ts"), realpath: (p) => p });
    expect(failedGate((await verifyInstalled(RUN, outside.d)).gates)).toBe("install-root");
    const redirected = depsFor(l, acl, { realpath: (p) => (p === l.root ? "D:\\elsewhere" : p) });
    expect(failedGate((await verifyInstalled(RUN, redirected.d)).gates)).toBe("install-root");
  });
  it("a state/ or cred/ ACL that lets the owner user write or read is refused", async () => {
    const { l } = await ready();
    const a = new FakeAcl(l);
    a.override(l.cred, aclText(l.cred, "secret").replace("Successfully", "      PC\\ownerperson:(RX)\n\nSuccessfully"));
    expect((await verifyInstalled(RUN, depsFor(l, a).d)).gates.find((g) => g.id === "install-root-acl")?.detail).toMatch(/credential directory/);
    const b = new FakeAcl(l);
    b.override(l.state, aclText(l.state, "state").replace("Successfully", "      PC\\ownerperson:(M)\n\nSuccessfully"));
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, b).d)).gates)).toBe("install-root-acl");
  });
  it("anyone but d24run is refused (the agent's user cannot start the verified path)", async () => {
    const { l, acl } = await ready();
    for (const who of ["PC\\ownerperson", "SYSTEM", "d24run2", ""]) {
      const v = await verifyInstalled(RUN, depsFor(l, acl, { whoami: () => who }).d);
      expect(failedGate(v.gates), who).toBe("identity");
    }
    expect((await verifyInstalled(RUN, depsFor(l, acl, { whoami: () => "D24RUN" }).d)).ok).toBe(true);
  });
});

describe("threat table: the envelope against the admin-owned policy", () => {
  it("each way to widen the envelope beyond the policy is refused at policy-clamp, nothing consumed", async () => {
    const cases: Array<[string, EnvOver]> = [
      ["more runs", { maxRuns: 3 }],
      ["longer validity", { expiresUtc: "2026-11-15T10:00:00Z" }],
      ["retargeted platform account", { accounts: { platformAcct: "acct_OTHERPLAT01", connectedAcct: "acct_UNITCONNECTED1" } }],
      ["retargeted connected account", { accounts: { platformAcct: "acct_UNITPLATFORM1", connectedAcct: "acct_OTHERCONN01" } }],
      ["another proof manifest", { proof: { manifestSha256: "9".repeat(64), fileCount: 2 } }],
      ["a different anchor", { hardwareAnchorFingerprintSha256: "8".repeat(64) }],
      ["user-profile credential store", { credential: { ...baseSpec().credential, store: "windows-credential-manager" } }],
      ["evidence outside the install root", { evidenceRoot: join(tmp(), "evidence") }],
    ];
    const f = await installed();
    let n = 0;
    for (const [name, over] of cases) {
      const id = `case-${String(++n).padStart(4, "0")}`;
      drop(f.l, envFor(f.l, over), { runId: id });
      const v = await verifyInstalled(id, depsFor(f.l, new FakeAcl(f.l)).d);
      expect(failedGate(v.gates), name).toBe("policy-clamp");
    }
  });
  it("the daily cap counts run-starts in the installed ledger over the last 24 hours", async () => {
    const { l, acl } = await ready();
    const led = new Ledger(join(l.state, "ledger"), () => NOW, join(l.state, "ledger-anchor.json"));
    for (const id of ["other-env-1", "other-env-2"]) {
      const s = led.startRun(id, "a".repeat(64), `${id}-r1`, { maxRuns: 2, keyFp: "k".repeat(16) });
      led.endRun(s, "PASS");
    }
    const v = await verifyInstalled(RUN, depsFor(l, acl).d);
    expect(failedGate(v.gates)).toBe("policy-clamp");
    expect(v.gates.at(-1)?.detail).toMatch(/already started today/);
  });
  it("an expired envelope is refused", async () => {
    const { l, acl } = await ready();
    const v = await verifyInstalled(RUN, depsFor(l, acl, { now: () => new Date("2026-12-31T00:00:00Z") }).d);
    expect(failedGate(v.gates)).toBe("envelope-window");
  });
});

describe("threat table: swapping the envelope or assertion", () => {
  it("copy-then-verify: changing the inbox file AFTER the copy does not change what is verified or run", async () => {
    const { l, acl, env } = await ready();
    const v = await verifyInstalled(RUN, depsFor(l, acl).d);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    writeFileSync(join(l.inbox, RUN, "envelope.json"), JSON.stringify(envFor(l, { envelopeId: "swapped-env-1", maxRuns: 1 })));
    expect(JSON.parse(readFileSync(v.envelopePath, "utf8")).envelopeId).toBe(env.envelopeId);
    expect(v.envelope.envelopeId).toBe(env.envelopeId);
  });
  it("an assertion for a DIFFERENT envelope is refused by the existing #419 verifier (the owner-approval gate), before any key read", async () => {
    const f = await installed();
    const env = envFor(f.l);
    drop(f.l, env, { doc: makeAssertion(testAuth, envFor(f.l, { envelopeId: "other-env-1" }).envelopeSha256, { signCount: 5 }) });
    const { exec, calls } = simulatedLive(f.l);
    const store = new MemoryStore();
    let reads = 0;
    const counting = { ...store, kind: "memory", read: async (x: string) => (reads++, store.read(x)), write: store.write.bind(store), remove: store.remove.bind(store) };
    await store.write(LABEL, KEY);
    const { result } = await runInstalled(RUN, { ...depsFor(f.l, new FakeAcl(f.l)).d, exec, store: () => counting, parentEnv: { PATH: "C:\\bin", SystemRoot: "C:\\Windows" } });
    expect(result?.status).toBe("BLOCKED");
    expect(failedGate(result!.gates)).toBe("owner-approval");
    expect(reads).toBe(0);
    expect(calls.some((c) => c.args.includes("--live"))).toBe(false);
  });
  it("an assertion made by ANOTHER key (software authenticator) is refused against the installed anchor", async () => {
    const f = await installed();
    const env = envFor(f.l);
    drop(f.l, env, { auth: makeSoftAuth() });
    const { exec } = simulatedLive(f.l);
    const { result } = await runInstalled(RUN, { ...depsFor(f.l, new FakeAcl(f.l)).d, exec, store: () => new MemoryStore(), parentEnv: {} });
    expect(failedGate(result!.gates)).toBe("owner-approval");
  });
  it("missing assertion or envelope, oversize file, bad run id -> inbox-copy / run-id block", async () => {
    const f = await installed();
    const acl = new FakeAcl(f.l);
    expect(failedGate((await verifyInstalled("nope-0001", depsFor(f.l, acl).d)).gates)).toBe("inbox-copy");
    drop(f.l, envFor(f.l));
    writeFileSync(join(f.l.inbox, RUN, "assertion.hw.json"), " ".repeat(300_000));
    expect(failedGate((await verifyInstalled(RUN, depsFor(f.l, acl).d)).gates)).toBe("inbox-copy");
    expect(failedGate((await verifyInstalled("../escape", depsFor(f.l, acl).d)).gates)).toBe("run-id");
  });
});

describe("the end-to-end installed run (simulated executor, in-memory key)", () => {
  it("passes, records the counter and ledger under state\\, skips git clean-clone gates, uses the installed tree gates, and removes its work copy", async () => {
    const f = await installed();
    const env = envFor(f.l);
    drop(f.l, env);
    const { exec, calls } = simulatedLive(f.l);
    const store = new MemoryStore();
    await store.write(LABEL, KEY);
    const { result, verified } = await runInstalled(RUN, { ...depsFor(f.l, new FakeAcl(f.l)).d, exec, store: () => store, parentEnv: { PATH: "C:\\bin", SystemRoot: "C:\\Windows" } });
    expect(result?.status).toBe("PASS");
    const ids = result!.gates.map((g) => g.id);
    expect(ids).toContain("installed-tree");
    expect(ids).toContain("installed-tree-recheck");
    expect(ids).toContain("owner-approval");
    expect(ids).not.toContain("git-head");
    expect(ids).not.toContain("commit-on-main");
    expect(JSON.parse(readFileSync(join(f.l.state, "hw-signcount.json"), "utf8")).byEnvelope[env.envelopeSha256]).toBe(5);
    expect(readFileSync(join(f.l.state, "ledger", "ledger.jsonl"), "utf8")).toContain(env.envelopeId);
    expect(calls.some((c) => c.args.includes("--live"))).toBe(true);
    if (verified.ok) expect(existsSync(verified.workDir)).toBe(false);
    expect(readdirSync(join(f.l.state, "work"))).toEqual([]);
    // the same assertion cannot buy a second envelope or exceed the envelope's run budget
    const again = await runInstalled(RUN, { ...depsFor(f.l, new FakeAcl(f.l)).d, exec, store: () => store, parentEnv: {} });
    expect(again.result?.status === "PASS" || again.result?.status === "BLOCKED").toBe(true);
  });
  it("the installed tree is hashed AGAIN just before the run is consumed: a change after the first check blocks with no run consumed and no live call", async () => {
    const f = await installed();
    drop(f.l, envFor(f.l));
    const v = await verifyInstalled(RUN, depsFor(f.l, new FakeAcl(f.l)).d);
    if (!v.ok) throw new Error("setup");
    let n = 0;
    const flaky = markVerifiedInstalled({ ...v.installed, verifyTree: () => ({ id: "tree-hash", ok: ++n < 2, detail: n < 2 ? "ok" : "tree changed" }) });
    const { exec, calls } = simulatedLive(f.l);
    const store = new MemoryStore();
    await store.write(LABEL, KEY);
    const r = await runEnvelope(v.envelopePath, f.l.release, { exec, parentEnv: { PATH: "C:\bin", SystemRoot: "C:\Windows" }, store: () => store, ledger: v.ledger, now: () => NOW, out: () => undefined, dry: false, runInstall: false, installed: flaky, owner: { trust: null, signature: null, hardware: { doc: v.hardwareDoc as never, anchorPath: flaky.anchorPath, statePath: flaky.statePath, pins: { ledgerDir: flaky.ledgerDir, anchorFile: flaky.ledgerAnchorFile } } } });
    expect(failedGate(r.gates)).toBe("installed-tree-recheck");
    expect(v.ledger.runsStarted(v.envelope.envelopeId)).toBe(0);
    expect(calls.some((c) => c.args.includes("--live"))).toBe(false);
    expect(existsSync(flaky.statePath)).toBe(false); // the hardware counter was not recorded either
  });
  it("the real executor is refused for a live run unless the verified install root is supplied", async () => {
    const f = await installed();
    const env = envFor(f.l);
    const file = join(tmp(), "e.json");
    writeFileSync(file, JSON.stringify(env));
    const mk = (installedArg: unknown) => ({ exec: realExec, parentEnv: {}, store: () => new MemoryStore(), ledger: new Ledger(join(tmp(), "l"), () => NOW, join(tmp(), "a.json")), now: () => NOW, out: () => undefined, dry: false, runInstall: false, installed: installedArg as never });
    const r = await runEnvelope(file, REPO, mk(undefined));
    expect(r.status).toBe("BLOCKED");
    expect(failedGate(r.gates)).toBe("installed-root");
    // a forged, unbranded object does not unlock the real executor or the test seams
    const forged = { layout: f.l, release: f.r.release, anchorPath: f.l.anchorJson, statePath: join(tmp(), "s.json"), ledgerDir: f.l.state, ledgerAnchorFile: "x", verifyTree: () => ({ id: "t", ok: true, detail: "" }) };
    const r2 = await runEnvelope(file, REPO, mk(forged));
    expect(failedGate(r2.gates)).toBe("installed-root");
    await expect(runEnvelope(file, REPO, { ...mk(forged), owner: { trust: null, signature: null, hardware: { doc: null, anchorPath: f.l.anchorJson } } })).rejects.toThrow(/verified installed root/);
  });
  it("execInboxMain returns 2 when a gate blocks before any run and 0 for a PASS", async () => {
    const f = await installed();
    const env = envFor(f.l);
    drop(f.l, env);
    const store = new MemoryStore();
    await store.write(LABEL, KEY);
    const { exec } = simulatedLive(f.l);
    const blocked = await execInboxMain(RUN, depsFor(f.l, new FakeAcl(f.l), { whoami: () => "PC\\ownerperson" }).d, () => store, {}, exec);
    expect(blocked).toBe(2);
    const ok = await execInboxMain(RUN, depsFor(f.l, new FakeAcl(f.l)).d, () => store, { PATH: "C:\\bin", SystemRoot: "C:\\Windows" }, exec);
    expect(ok).toBe(0);
    void writeAnchor;
    void SHA;
  });
});
