// Review of PR #419 (targeted): the commit-on-main gate must not take its location from the anchor, must cover every hashed runner file,
// must not be steerable through git config / replace refs / grafts / shallow state, and the test seams must not exist on a real executor.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../credstore";
import { createFakeExec, type FakeOpts } from "../fakeChild";
import { mainVerification, pristineGates, runnerTracked } from "../gitverify";
import { manifest as proofManifest } from "../../d24-m3d-proof/manifest";
import { runnerManifest } from "../runnerpin";
import { realExec } from "../exec";
import { runEnvelope, type RunnerDeps } from "../runner";
import { PINNED_BRANCH, PINNED_REF, PINNED_REPO_URL } from "../trustroot";
import { anchorFingerprint, anchorMatchesManifest, loadAnchor, parseAnchor } from "../webauthn";
import { KEY, LABEL, makeEnvelope, mkLedger, NOW, REPO, SHA, tmp, writeEnvelope } from "./helpers";
import { makeAssertion, testAuth } from "./softauth";

const auth = testAuth;

async function go(o: { anchor?: object; fake?: Partial<FakeOpts> } = {}) {
  const dir = tmp();
  const env = makeEnvelope({ evidenceRoot: join(dir, "evidence") });
  const file = writeEnvelope(env);
  const anchorPath = join(dir, "owner-hw-anchor.json");
  writeFileSync(anchorPath, JSON.stringify(o.anchor ?? auth.anchor));
  const ledger = mkLedger();
  const calls: NonNullable<FakeOpts["calls"]> = [];
  const store = new MemoryStore();
  await store.write(LABEL, KEY);
  const deps: RunnerDeps = {
    exec: createFakeExec({ commitSha: SHA, repoDir: REPO, calls, ...o.fake }, { simulateLive: true }),
    parentEnv: { PATH: "C:\\bin", SystemRoot: "C:\\Windows" },
    store: () => store,
    ledger,
    now: () => NOW,
    out: () => undefined,
    dry: false,
    runInstall: true,
    owner: { trust: null, signature: null, hardware: { doc: makeAssertion(auth, env.envelopeSha256, { signCount: 5 }), anchorPath, statePath: join(dir, "state", "hw.json"), pins: { ledgerDir: ledger.dir, anchorFile: ledger.anchorFile as string } } },
  };
  const r = await runEnvelope(file, REPO, deps);
  return { r, calls, ledger, env, store };
}
const failed = (r: { gates: Array<{ id: string; ok: boolean }> }) => r.gates.find((g) => !g.ok)?.id;
const gateDetail = (r: { gates: Array<{ id: string; detail: string }> }, id: string) => r.gates.find((g) => g.id === id)?.detail ?? "";
const gitCalls = (calls: Array<{ cmd: string; args: string[] }>) => calls.filter((c) => /git(\.exe)?$/.test(c.cmd));

describe("P1-1: the owner-merged location is a runner constant, never taken from the anchor", () => {
  it("the constants are the owner's repository and main", () => {
    expect(PINNED_REPO_URL).toBe("https://github.com/genxttech/danceflow-app.git");
    expect(PINNED_BRANCH).toBe("main");
    expect(PINNED_REF).toBe("refs/heads/main");
  });

  it("an anchor that names another branch or another repository is INVALID and the run is BLOCKED before the approval, credential or any git network command", async () => {
    for (const over of [{ branch: "claude/x" }, { repoUrl: "https://github.com/attacker/fork.git" }]) {
      const base = { ...auth.anchor, ...over } as Record<string, unknown>;
      const bad = { ...base, fingerprintSha256: anchorFingerprint(base as never) };
      expect(parseAnchor(bad).ok, JSON.stringify(over)).toBe(false);
      const t = await go({ anchor: bad });
      expect(t.r.status).toBe("BLOCKED");
      expect(failed(t.r)).toBe("owner-approval");
      expect(gateDetail(t.r, "owner-approval")).toMatch(/repoUrl|branch/);
      expect(gitCalls(t.calls).some((c) => c.args.includes("fetch") || c.args.includes("ls-remote"))).toBe(false);
    }
  });

  it("commit-on-main is asked about the trustroot constants only: no URL or ref from the anchor reaches git or the tip lookup", async () => {
    const t = await go();
    expect(t.r.status).toBe("PASS");
    const src = readFileSync(join(__dirname, "..", "runner.ts"), "utf8");
    expect(src).not.toMatch(/hwAnchor.(repoUrl|branch)/);
    expect(readFileSync(join(__dirname, "..", "gitverify.ts"), "utf8")).toMatch(/PINNED_REPO_URL/);
  });
});

describe("P2-1: every hashed runner file (and the anchor) must be tracked by git", () => {
  it("an untracked or ignored runner file is BLOCKED (runner-tracked) before the credential is read", async () => {
    const t = await go({ fake: { untracked: ["webauthn.ts"] } });
    expect(t.r.status).toBe("BLOCKED");
    expect(failed(t.r)).toBe("runner-tracked");
    expect(gateDetail(t.r, "runner-tracked")).toMatch(/webauthn.ts/);
    expect(t.r.gates.some((g) => g.id === "credential")).toBe(false);
    expect(t.ledger.runsStarted(t.env.envelopeId)).toBe(0);
  });

  it("an untracked runner source file is BLOCKED the same way; with everything tracked the gate passes", async () => {
    const t = await go({ fake: { untracked: ["gitverify.ts"] } });
    expect(failed(t.r)).toBe("runner-tracked");
    expect((await go()).r.gates.find((g) => g.id === "runner-tracked")?.ok).toBe(true);
  });

  it("runnerTracked: names every hashed file git does not list", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "r"), { recursive: true });
    const exec = createFakeExec({ commitSha: SHA, repoDir: dir }, { simulateLive: true });
    const gate = await runnerTracked({ repoDir: dir, runnerRel: "r", files: ["a.ts", "b.ts"], env: {}, exec });
    expect(gate.ok).toBe(false); // the fake lists the files of a directory with none
    expect(gate.detail).toMatch(/a\.ts/);
    expect(gate.detail).toMatch(/b\.ts/);
  });
});

describe("P2-2 (round 3): git is only a transport and an object reader; every call is isolated and none touches the working repository", () => {
  const base = { repoDir: REPO, commitSha: SHA, env: { PATH: "x", GIT_DIR: "C:\\agent\\.git", GIT_ALTERNATE_OBJECT_DIRECTORIES: "C:\\agent\\objs" } };
  const tipOk = async () => ({ ok: true as const, sha: "e".repeat(40) });
  const run = async () => {
    const calls: NonNullable<FakeOpts["calls"]> = [];
    const exec = createFakeExec({ commitSha: SHA, repoDir: REPO, calls }, { simulateLive: true });
    const res = await mainVerification({ ...base, exec, lookupTip: tipOk });
    return { res, calls };
  };

  it("every git call runs with system and global config disabled, replace objects off, no prompts, and without any inherited GIT_* variable", async () => {
    const { calls } = await run();
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) {
      expect(c.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(c.env.GIT_CONFIG_GLOBAL).toBe(process.platform === "win32" ? "NUL" : "/dev/null");
      expect(c.env.GIT_NO_REPLACE_OBJECTS).toBe("1");
      expect(c.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(c.env.GIT_DIR).toBeUndefined();
      expect(c.env.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined();
    }
  });

  it("no command runs in, or points at, the working repository; a fresh bare repo is used; hooks, commit-graph and worktree config are off for every call", async () => {
    const { calls } = await run();
    for (const c of calls) {
      expect(c.cwd).not.toBe(REPO);
      const joined = c.args.join(" ");
      expect(joined).toContain("core.commitGraph=false");
      expect(joined).toMatch(/core\.hooksPath=.*no-hooks/);
      expect(joined).toContain("extensions.worktreeConfig=false");
      expect(joined).not.toContain(REPO);
    }
    expect(calls[0].args).toContain("init");
    expect(calls[0].args).toContain("--bare");
    expect(calls.slice(1).every((c) => c.args.some((a) => a.startsWith("--git-dir=")))).toBe(true);
  });

  it("git is never asked for the branch tip (no ls-remote): the tip comes from the repository-free lookup", async () => {
    const { calls } = await run();
    expect(calls.some((c) => c.args.includes("ls-remote"))).toBe(false);
    const lookups: string[][] = [];
    const exec = createFakeExec({ commitSha: SHA, repoDir: REPO }, { simulateLive: true });
    await mainVerification({ ...base, exec, lookupTip: async (u, r) => { lookups.push([u, r]); return { ok: true, sha: "e".repeat(40) }; } });
    expect(lookups).toEqual([[PINNED_REPO_URL, PINNED_REF]]);
  });

  it("the temporary repository is removed afterwards, also when a step fails", async () => {
    const { calls } = await run();
    const dirOf = (cs: typeof calls) => (cs[0].args.find((a) => /r\.git$/.test(a)) as string).replace(/[\\/]r\.git$/, "");
    expect(existsSync(dirOf(calls))).toBe(false);
  });

  it("an unreadable tip refuses before any git command and says what the gate needs (anonymous read access)", async () => {
    const calls: NonNullable<FakeOpts["calls"]> = [];
    const exec = createFakeExec({ commitSha: SHA, repoDir: REPO, calls }, { simulateLive: true });
    const r = await mainVerification({ ...base, exec, lookupTip: async () => ({ ok: false, why: "HTTP 404" }) });
    expect(r.ancestry.ok).toBe(false);
    expect(r.ancestry.detail).toMatch(/ANONYMOUS read access/);
    expect(r.ancestry.detail).toMatch(/owner decision/);
    expect(calls.length).toBe(0);
  });

  it("the runner never passes a URL, tip lookup, temp location or hook: only the trustroot constants and the held pins", async () => {
    const mainCalls: NonNullable<FakeOpts["mainCalls"]> = [];
    const t = await go({ fake: { mainCalls } });
    expect(t.r.status).toBe("PASS");
    expect(mainCalls.length).toBe(1);
    for (const k of ["remoteUrl", "lookupTip", "tmpRoot", "testHooks"]) expect(Object.keys(mainCalls[0])).not.toContain(k);
    const src = readFileSync(join(__dirname, "..", "runner.ts"), "utf8");
    expect(src).not.toMatch(/remoteUrl|lookupTip|testHooks/);
  });
});

describe("N2/N3 (round 3): committed blobs are compared with the hashes the run ALREADY HOLDS, and what will be executed is re-hashed just before going live", () => {
  it("the pins passed to the committed-content check are exactly the runner-folder hashes and the proof-folder hashes taken at the start (no readFile, no disk read at the call)", async () => {
    const mainCalls: NonNullable<FakeOpts["mainCalls"]> = [];
    const t = await go({ fake: { mainCalls } });
    expect(t.r.status).toBe("PASS");
    const rm = runnerManifest(join(REPO, "scripts", "qa", "d24-test-runner"));
    const pm = proofManifest(join(REPO, "scripts", "qa", "d24-m3d-proof"));
    const pins = mainCalls[0].pins ?? [];
    expect(pins.length).toBe(rm.files.length + pm.files.length);
    for (const f of rm.files) expect(pins).toContainEqual({ rel: `scripts/qa/d24-test-runner/${f.path}`, sha256: f.sha256 });
    for (const f of pm.files) expect(pins).toContainEqual({ rel: `scripts/qa/d24-m3d-proof/${f.path}`, sha256: f.sha256 });
    expect(Object.keys(mainCalls[0])).not.toContain("readFile");
  });

  it("structure: the content check uses the held values only, and the proof folder is hashed before the ledger, npm ci and the content check", () => {
    const src = readFileSync(join(__dirname, "..", "runner.ts"), "utf8");
    const iHeld = src.indexOf("const proofHeld = manifest(");
    const iLedger = src.indexOf("d.ledger.startBlockers(");
    const iInstall = src.indexOf("await verifyCleanClone(");
    const iMain = src.indexOf("await mainVerify(");
    expect(iHeld).toBeGreaterThan(0);
    expect(iHeld).toBeLessThan(iLedger);
    expect(iHeld).toBeLessThan(iInstall);
    expect(iInstall).toBeLessThan(iMain);
    const callLine = src.slice(iMain, src.indexOf("\n", iMain));
    expect(callLine).toContain("pins: heldPins");
    expect(src.slice(src.indexOf("const heldPins"), iMain)).not.toMatch(/readFileSync|manifest\(/);
  });

  it("the held-hashes-recheck gate runs after every child-process gate and BEFORE the approval counter is recorded and the run consumed", async () => {
    const t = await go();
    const ids = t.r.gates.map((g) => g.id);
    expect(ids).toContain("held-hashes-recheck");
    expect(t.r.gates.find((g) => g.id === "held-hashes-recheck")?.ok).toBe(true);
    expect(ids.indexOf("held-hashes-recheck")).toBeGreaterThan(ids.indexOf("proof-preflight"));
    expect(ids.indexOf("held-hashes-recheck")).toBeGreaterThan(ids.indexOf("recheck-tree"));
    expect(ids.indexOf("held-hashes-recheck")).toBeLessThan(ids.indexOf("envelope-window-recheck"));
  });

  it("through runEnvelope: a held hash that differs from the committed blob (altered file, a file missing from the commit, a proof file) is BLOCKED at committed-content before the credential", async () => {
    const t = await go({ fake: { tamperedContent: ["webauthn.ts"] } });
    expect(t.r.status).toBe("BLOCKED");
    expect(failed(t.r)).toBe("committed-content");
    expect(t.r.gates.some((g) => g.id === "credential")).toBe(false);
    expect(t.ledger.runsStarted(t.env.envelopeId)).toBe(0);
    expect(failed((await go({ fake: { tamperedContent: ["d24-m3d-proof/guarded.ts"] } })).r)).toBe("committed-content");
    expect(failed((await go({ fake: { missingFromTree: ["runner.ts"] } })).r)).toBe("committed-content");
    expect(gateDetail((await go()).r, "committed-content")).toMatch(/held hashes equal/);
  });
});

describe("F8: the clean-tree gates also run with the isolated git environment", () => {
  it("pristineGates passes no system/global config and no inherited GIT_* to git", async () => {
    const calls: NonNullable<FakeOpts["calls"]> = [];
    const exec = createFakeExec({ commitSha: SHA, repoDir: REPO, calls }, { simulateLive: true });
    const gates = await pristineGates({ repoDir: REPO, commitSha: SHA, env: { PATH: "x", GIT_DIR: "evil" }, exec });
    expect(gates.every((g) => g.ok)).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const c of calls) {
      expect(c.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(c.env.GIT_NO_REPLACE_OBJECTS).toBe("1");
      expect(c.env.GIT_DIR).toBeUndefined();
    }
  });
});


describe("P3-1: test seams are refused on anything but a simulated-live executor", () => {
  it("anchorPath / statePath / pins with the real executor throw before any gate", async () => {
    const dir = tmp();
    const file = writeEnvelope(makeEnvelope({ evidenceRoot: join(dir, "evidence") }));
    const ledger = mkLedger();
    const mk = (hardware: object): RunnerDeps => ({ exec: realExec, parentEnv: {}, store: () => new MemoryStore(), ledger, now: () => NOW, out: () => undefined, dry: false, runInstall: false, owner: { trust: null, signature: null, hardware: { doc: null, ...hardware } } });
    for (const h of [{ anchorPath: join(dir, "a.json") }, { statePath: join(dir, "s.json") }, { pins: { ledgerDir: dir, anchorFile: join(dir, "x") } }]) {
      await expect(runEnvelope(file, REPO, mk(h)), JSON.stringify(Object.keys(h))).rejects.toThrow(/seam/);
    }
  });
});

describe("P3-3: the anchor bytes that were parsed are the bytes that were hashed", () => {
  it("loadAnchor returns the sha256 of the exact (CRLF-normalised) bytes it parsed; the manifest comparison refuses a different file", () => {
    const dir = tmp();
    const f = join(dir, "owner-hw-anchor.json");
    writeFileSync(f, JSON.stringify(auth.anchor));
    const l = loadAnchor(f);
    expect(l && l.ok && l.sha256).toMatch(/^[0-9a-f]{64}$/);
    const sha = (l as { sha256: string }).sha256;
    expect(anchorMatchesManifest(sha, [{ path: "owner-hw-anchor.json", sha256: sha }])).toBe(true);
    expect(anchorMatchesManifest(sha, [{ path: "owner-hw-anchor.json", sha256: "0".repeat(64) }])).toBe(false);
    expect(anchorMatchesManifest(sha, [])).toBe(false);
  });
});
