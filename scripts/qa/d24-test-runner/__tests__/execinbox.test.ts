// The threat table of docs/billing/D24-TEST-RUNNER-TRUST-ANCHOR.md, one row at a time, against a THROWAWAY install root built by the real installer with
// fake security descriptors. What these tests cannot show (the OS actually enforcing the ACLs against a non-admin process, d24run isolation, a real
// authenticator, UAC) is listed in the document's Windows test plan.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../credstore";
import { type ExecInboxDeps, execInboxMain, runInstalled, verifyInstalled } from "../execinbox";
import { realExec } from "../exec";
import { createFakeExec } from "../fakeChild";
import { Ledger } from "../ledger";
import { ADMIN_NODE, type Layout } from "../installroot";
import { runEnvelope } from "../runner";
import { policyText, type Policy } from "../policy";
import { baseSpec, KEY, LABEL, makeEnvelope, NOW, REPO, SHA, tmp } from "./helpers";
import { FakeAcl, installed, OWNER_SID, RUNAS_SID, sddlFor, simulatedLive, WHO, withAce } from "./installfixture";
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
  const d: ExecInboxDeps = { layout: l, runningFile: join(l.runnerDir, "execinbox.ts"), acl, currentSid: () => RUNAS_SID, execPath: ADMIN_NODE, tmpdir: () => l.tmp, now: () => NOW, out: (x) => void lines.push(x), ...over };
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
const workLeft = (l: Layout) => (existsSync(join(l.state, "work")) ? readdirSync(join(l.state, "work")) : []);

describe("verifyInstalled: the happy path", () => {
  it("passes every gate in the documented order", async () => {
    const { l, acl } = await ready();
    const v = await verifyInstalled(RUN, depsFor(l, acl).d);
    expect(v.ok).toBe(true);
    expect(v.gates.map((g) => g.id)).toEqual(["run-id", "install-root", "policy", "identity", "node-binary", "node-binary-acl", "temp-isolation", "install-root-acl", "release-record", "tree-hash", "policy-hash", "anchor", "inbox-copy", "envelope", "envelope-window", "policy-clamp"]);
  });
});

describe("threat table: edits to the execution path", () => {
  it("runner code or REQUIRE_HARDWARE_FOR_LIVE edited in the installed tree -> tree-hash blocks", async () => {
    const { l, acl } = await ready();
    const f = join(l.runnerDir, "runner.ts");
    writeFileSync(f, readFileSync(f, "utf8").replace("REQUIRE_HARDWARE_FOR_LIVE: boolean = true", "REQUIRE_HARDWARE_FOR_LIVE: boolean = false"));
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, acl).d)).gates)).toBe("tree-hash");
  });
  it("a proof file, a node_modules file, or tsconfig.json changed -> tree-hash blocks (the key-bearing toolchain is pinned)", async () => {
    for (const edit of [(l: Layout) => appendFileSync(join(l.proofDir, "config.ts"), "\n// edited"), (l: Layout) => appendFileSync(join(l.release, "node_modules", "tsx", "dist", "cli.mjs"), "// evil"), (l: Layout) => writeFileSync(join(l.release, "tsconfig.json"), "{}")]) {
      const { l, acl } = await ready();
      edit(l);
      expect(failedGate((await verifyInstalled(RUN, depsFor(l, acl).d)).gates)).toBe("tree-hash");
    }
  });
  it("anchor.json replaced by an attacker's software-authenticator anchor -> blocked at the anchor gate", async () => {
    const { l, acl } = await ready();
    writeFileSync(l.anchorJson, JSON.stringify(makeSoftAuth().anchor));
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, acl).d)).gates)).toBe("anchor");
  });
  it("anchor.json with the same key but different bytes (reformatted) is refused: the installer-recorded byte hash is what is compared", async () => {
    const { l, acl } = await ready();
    writeFileSync(l.anchorJson, JSON.stringify(JSON.parse(readFileSync(l.anchorJson, "utf8"))));
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, acl).d)).gates)).toBe("anchor");
  });
  it("P0-1: a CONSISTENT rewrite of anchor+policy+release by an agent that OWNS the files is stopped by the owner check even though every DACL looks right", async () => {
    const { l } = await ready();
    writeFileSync(l.anchorJson, JSON.stringify(makeSoftAuth().anchor));
    const bad = new FakeAcl(l);
    for (const p of [l.anchorJson, l.policyJson, l.releaseJson, l.release]) bad.override(p, sddlFor("locked", WHO, OWNER_SID));
    const v = await verifyInstalled(RUN, depsFor(l, bad).d);
    expect(failedGate(v.gates)).toBe("install-root-acl");
    expect(v.gates.at(-1)?.detail).toMatch(/owned by S-1-5-21-111-222-333-1000/);
  });
  it("P0-1b: an agent-owned file anywhere under the root (a module under node_modules, a counter file in state) blocks", async () => {
    const { l } = await ready();
    const a = new FakeAcl(l);
    a.override(join(l.release, "node_modules", "tsx", "dist", "cli.mjs"), sddlFor("locked", WHO, OWNER_SID));
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, a).d)).gates)).toBe("install-root-acl");
    writeFileSync(join(l.state, "hw-signcount.json"), "{}");
    const b = new FakeAcl(l);
    b.override(join(l.state, "hw-signcount.json"), sddlFor("state", WHO, OWNER_SID));
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, b).d)).gates)).toBe("install-root-acl");
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
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, acl, { runningFile: join(REPO, "scripts", "qa", "d24-test-runner", "execinbox.ts"), realpath: (p) => p }).d)).gates)).toBe("install-root");
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, acl, { realpath: (p) => (p === l.root ? "D:\\elsewhere" : p) }).d)).gates)).toBe("install-root");
  });
  it("a cred/ area the owner can read, or a state/ the owner can write, is refused", async () => {
    const { l } = await ready();
    const a = new FakeAcl(l);
    a.override(l.cred, withAce(sddlFor("secret"), `(A;OICI;0x120089;;;${OWNER_SID})`));
    expect((await verifyInstalled(RUN, depsFor(l, a).d)).gates.find((g) => g.id === "install-root-acl")?.detail).toMatch(/credential area/);
    const b = new FakeAcl(l);
    b.override(l.state, withAce(sddlFor("state"), `(A;OICI;0x1301bf;;;${OWNER_SID})`));
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, b).d)).gates)).toBe("install-root-acl");
  });
});

describe("P1-2: who runs, on what node, with what TEMP", () => {
  it("only the policy's run-as SID may start the verified path (by SID, never by a name)", async () => {
    const { l, acl } = await ready();
    for (const sid of [OWNER_SID, "S-1-5-18", "", "S-1-5-21-111-222-333-1002"]) expect(failedGate((await verifyInstalled(RUN, depsFor(l, acl, { currentSid: () => sid }).d)).gates), sid).toBe("identity");
  });
  it("node must be the fixed administrator-only binary and itself administrator-owned", async () => {
    const { l, acl } = await ready();
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, acl, { execPath: "C:\\Users\\mcurt\\node.exe" }).d)).gates)).toBe("node-binary");
    const a = new FakeAcl(l);
    a.override(ADMIN_NODE, sddlFor("locked", WHO, OWNER_SID));
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, a).d)).gates)).toBe("node-binary-acl");
    const b = new FakeAcl(l);
    b.override(ADMIN_NODE, withAce(sddlFor("locked"), "(A;OICI;0x1301bf;;;BU)"));
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, b).d)).gates)).toBe("node-binary-acl");
  });
  it("a shared writable TEMP (tsx cache poisoning) is refused; only <root>\\state\\tmp passes, not a lookalike prefix", async () => {
    const { l, acl } = await ready();
    for (const t of ["C:\\Windows\\Temp", join(l.root, "state"), `${l.tmp}-evil`]) expect(failedGate((await verifyInstalled(RUN, depsFor(l, acl, { tmpdir: () => t }).d)).gates), t).toBe("temp-isolation");
    expect((await verifyInstalled(RUN, depsFor(l, acl, { tmpdir: () => join(l.tmp, "sub") }).d)).ok).toBe(true);
  });
  it("the proof child gets TEMP/TMP = <root>\\state\\tmp whatever the parent environment says", async () => {
    const f = await installed();
    drop(f.l, envFor(f.l));
    const calls: NonNullable<Parameters<typeof createFakeExec>[0]["calls"]> = [];
    const exec = createFakeExec({ commitSha: SHA, repoDir: f.l.release, calls }, { simulateLive: true });
    const store = new MemoryStore();
    await store.write(LABEL, KEY);
    await runInstalled(RUN, { ...depsFor(f.l, new FakeAcl(f.l)).d, exec, store: () => store, parentEnv: { PATH: "C:\\bin", SystemRoot: "C:\\Windows", TEMP: "C:\\Windows\\Temp", TMP: "C:\\Windows\\Temp" } });
    const live = calls.find((c) => c.args.includes("--live"));
    expect(live?.env.TEMP?.toLowerCase()).toBe(f.l.tmp.toLowerCase());
    expect(live?.env.TMP?.toLowerCase()).toBe(f.l.tmp.toLowerCase());
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
      expect(failedGate((await verifyInstalled(id, depsFor(f.l, new FakeAcl(f.l)).d)).gates), name).toBe("policy-clamp");
    }
    expect(workLeft(f.l)).toEqual([]);
  });
  it("the daily cap counts run-starts in the installed ledger over the last 24 hours", async () => {
    const { l, acl } = await ready();
    const led = new Ledger(join(l.state, "ledger"), () => NOW, join(l.state, "ledger-anchor.json"));
    for (const id of ["other-env-1", "other-env-2"]) led.endRun(led.startRun(id, "a".repeat(64), `${id}-r1`, { maxRuns: 2, keyFp: "k".repeat(16) }), "PASS");
    const v = await verifyInstalled(RUN, depsFor(l, acl).d);
    expect(failedGate(v.gates)).toBe("policy-clamp");
    expect(v.gates.at(-1)?.detail).toMatch(/already started today/);
  });
  it("an expired envelope is refused", async () => {
    const { l, acl } = await ready();
    expect(failedGate((await verifyInstalled(RUN, depsFor(l, acl, { now: () => new Date("2026-12-31T00:00:00Z") }).d)).gates)).toBe("envelope-window");
  });
});

describe("threat table: swapping the envelope or assertion; P2-3 inbox handling", () => {
  it("copy-then-verify: changing the inbox file AFTER the copy does not change what is verified or run", async () => {
    const { l, acl, env } = await ready();
    const v = await verifyInstalled(RUN, depsFor(l, acl).d);
    if (!v.ok) throw new Error("setup");
    writeFileSync(join(l.inbox, RUN, "envelope.json"), JSON.stringify(envFor(l, { envelopeId: "swapped-env-1", maxRuns: 1 })));
    expect(JSON.parse(readFileSync(v.envelopePath, "utf8")).envelopeId).toBe(env.envelopeId);
    expect(v.envelope.envelopeId).toBe(env.envelopeId);
  });
  it("an assertion for a DIFFERENT envelope is refused by the existing #419 verifier (owner-approval) before any key read", async () => {
    const f = await installed();
    drop(f.l, envFor(f.l), { doc: makeAssertion(testAuth, envFor(f.l, { envelopeId: "other-env-1" }).envelopeSha256, { signCount: 5 }) });
    const { exec, calls } = simulatedLive(f.l);
    const store = new MemoryStore();
    let reads = 0;
    const counting = { kind: "memory", read: async (x: string) => (reads++, store.read(x)), write: store.write.bind(store), remove: store.remove.bind(store) };
    await store.write(LABEL, KEY);
    const { result } = await runInstalled(RUN, { ...depsFor(f.l, new FakeAcl(f.l)).d, exec, store: () => counting, parentEnv: { PATH: "C:\\bin", SystemRoot: "C:\\Windows" } });
    expect(failedGate(result!.gates)).toBe("owner-approval");
    expect(reads).toBe(0);
    expect(calls.some((c) => c.args.includes("--live"))).toBe(false);
  });
  it("an assertion made by ANOTHER key (software authenticator) is refused against the installed anchor", async () => {
    const f = await installed();
    drop(f.l, envFor(f.l), { auth: makeSoftAuth() });
    const { exec } = simulatedLive(f.l);
    const { result } = await runInstalled(RUN, { ...depsFor(f.l, new FakeAcl(f.l)).d, exec, store: () => new MemoryStore(), parentEnv: {} });
    expect(failedGate(result!.gates)).toBe("owner-approval");
  });
  it("missing assertion/envelope, oversize file, an inbox run that is a link, bad run id -> inbox-copy / run-id block", async () => {
    const f = await installed();
    const acl = new FakeAcl(f.l);
    expect(failedGate((await verifyInstalled("nope-0001", depsFor(f.l, acl).d)).gates)).toBe("inbox-copy");
    drop(f.l, envFor(f.l));
    writeFileSync(join(f.l.inbox, RUN, "assertion.hw.json"), " ".repeat(300_000));
    expect(failedGate((await verifyInstalled(RUN, depsFor(f.l, acl).d)).gates)).toBe("inbox-copy");
    expect(failedGate((await verifyInstalled("../escape", depsFor(f.l, acl).d)).gates)).toBe("run-id");
  });
  it("P2-3a: an inbox run directory that is a link/junction to another directory is refused (not followed)", async () => {
    const f = await installed();
    drop(f.l, envFor(f.l), { runId: "real-0001" });
    symlinkSync(join(f.l.inbox, "real-0001"), join(f.l.inbox, "link-0001"), "junction");
    const v = await verifyInstalled("link-0001", depsFor(f.l, new FakeAcl(f.l)).d);
    expect(failedGate(v.gates)).toBe("inbox-copy");
    expect(workLeft(f.l)).toEqual([]);
  });
  it("P2-3a: the private work copy is removed on EVERY failure path after it was created (bad JSON, invalid envelope, expiry, clamp)", async () => {
    const f = await installed();
    const acl = new FakeAcl(f.l);
    drop(f.l, envFor(f.l), { runId: "bad-json-1" });
    writeFileSync(join(f.l.inbox, "bad-json-1", "envelope.json"), "{nope");
    drop(f.l, envFor(f.l), { runId: "bad-env-01" });
    writeFileSync(join(f.l.inbox, "bad-env-01", "envelope.json"), JSON.stringify({ ...envFor(f.l), maxRuns: 1 }));
    drop(f.l, envFor(f.l), { runId: "expired-01" });
    drop(f.l, envFor(f.l, { maxRuns: 3 }), { runId: "clamp-001" });
    expect(failedGate((await verifyInstalled("bad-json-1", depsFor(f.l, acl).d)).gates)).toBe("inbox-parse");
    expect(failedGate((await verifyInstalled("bad-env-01", depsFor(f.l, acl).d)).gates)).toBe("envelope");
    expect(failedGate((await verifyInstalled("expired-01", depsFor(f.l, acl, { now: () => new Date("2026-12-31T00:00:00Z") }).d)).gates)).toBe("envelope-window");
    expect(failedGate((await verifyInstalled("clamp-001", depsFor(f.l, acl).d)).gates)).toBe("policy-clamp");
    expect(workLeft(f.l)).toEqual([]);
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
    const { result } = await runInstalled(RUN, { ...depsFor(f.l, new FakeAcl(f.l)).d, exec, store: () => store, parentEnv: { PATH: "C:\\bin", SystemRoot: "C:\\Windows" } });
    expect(result?.status).toBe("PASS");
    const ids = result!.gates.map((g) => g.id);
    expect(ids).toEqual(expect.arrayContaining(["installed-tree", "installed-tree-recheck", "owner-approval"]));
    expect(ids).not.toContain("git-head");
    expect(ids).not.toContain("commit-on-main");
    expect(JSON.parse(readFileSync(join(f.l.state, "hw-signcount.json"), "utf8")).byEnvelope[env.envelopeSha256]).toBe(5);
    expect(readFileSync(join(f.l.state, "ledger", "ledger.jsonl"), "utf8")).toContain(env.envelopeId);
    expect(calls.some((c) => c.args.includes("--live"))).toBe(true);
    expect(workLeft(f.l)).toEqual([]);
  });
  it("the installed tree is hashed AGAIN just before the run is consumed: a change after the first check blocks with no run consumed and no live call", async () => {
    const f = await installed();
    drop(f.l, envFor(f.l));
    const calls: NonNullable<Parameters<typeof createFakeExec>[0]["calls"]> = [];
    let tampered = false;
    // a file the runner/proof held-hash gates do NOT cover (tsconfig.json) is changed during the dry-run spawn: only the installed-tree recheck sees it
    const exec = createFakeExec({ commitSha: SHA, repoDir: f.l.release, calls }, { simulateLive: true, tap: (_c, a) => {
      if (!tampered && a.includes("--dry-run")) {
        tampered = true;
        writeFileSync(join(f.l.release, "tsconfig.json"), "{\"compilerOptions\":{\"paths\":{\"*\":[\"C:/evil/*\"]}}}");
      }
    } });
    const store = new MemoryStore();
    await store.write(LABEL, KEY);
    const { result, verified } = await runInstalled(RUN, { ...depsFor(f.l, new FakeAcl(f.l)).d, exec, store: () => store, parentEnv: { PATH: "C:\\bin", SystemRoot: "C:\\Windows" } });
    expect(tampered).toBe(true);
    expect(failedGate(result!.gates)).toBe("installed-tree-recheck");
    expect(verified.ok && verified.ledger.runsStarted(verified.envelope.envelopeId)).toBe(0);
    expect(calls.some((c) => c.args.includes("--live"))).toBe(false);
    expect(existsSync(join(f.l.state, "hw-signcount.json"))).toBe(false); // the hardware counter was not recorded either
  });
  it("the real executor is refused for a live run unless the verified install root is supplied; a forged, unbranded object unlocks nothing", async () => {
    const f = await installed();
    const file = join(tmp(), "e.json");
    writeFileSync(file, JSON.stringify(envFor(f.l)));
    const mk = (installedArg: unknown) => ({ exec: realExec, parentEnv: {}, store: () => new MemoryStore(), ledger: new Ledger(join(tmp(), "l"), () => NOW, join(tmp(), "a.json")), now: () => NOW, out: () => undefined, dry: false, runInstall: false, installed: installedArg as never });
    expect(failedGate((await runEnvelope(file, REPO, mk(undefined))).gates)).toBe("installed-root");
    const forged = { layout: f.l, release: f.r.release, anchorPath: f.l.anchorJson, statePath: join(tmp(), "s.json"), ledgerDir: f.l.state, ledgerAnchorFile: "x", verifyTree: () => ({ id: "t", ok: true, detail: "" }) };
    expect(failedGate((await runEnvelope(file, REPO, mk(forged))).gates)).toBe("installed-root");
    await expect(runEnvelope(file, REPO, { ...mk(forged), owner: { trust: null, signature: null, hardware: { doc: null, anchorPath: f.l.anchorJson } } })).rejects.toThrow(/verified installed root/);
  });
  it("execInboxMain returns 2 when a gate blocks before any run and 0 for a PASS", async () => {
    const f = await installed();
    drop(f.l, envFor(f.l));
    const store = new MemoryStore();
    await store.write(LABEL, KEY);
    const { exec } = simulatedLive(f.l);
    expect(await execInboxMain(RUN, depsFor(f.l, new FakeAcl(f.l), { currentSid: () => OWNER_SID }).d, () => store, {}, exec)).toBe(2);
    expect(await execInboxMain(RUN, depsFor(f.l, new FakeAcl(f.l)).d, () => store, { PATH: "C:\\bin", SystemRoot: "C:\\Windows" }, exec)).toBe(0);
  });
});
