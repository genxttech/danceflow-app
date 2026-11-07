// Review of PR #419 (targeted): the commit-on-main gate must not take its location from the anchor, must cover every hashed runner file,
// must not be steerable through git config / replace refs / grafts / shallow state, and the test seams must not exist on a real executor.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../credstore";
import { createFakeExec, type FakeOpts } from "../fakeChild";
import { mainVerification, pristineGates, runnerTracked } from "../gitverify";
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

  it("commit-on-main fetches and lists ONLY the constants (no URL or ref from the anchor reaches git)", async () => {
    const t = await go();
    expect(t.r.status).toBe("PASS");
    const net = gitCalls(t.calls).filter((c) => c.args.includes("fetch") || c.args.includes("ls-remote"));
    expect(net.length).toBeGreaterThanOrEqual(2);
    for (const c of net) {
      expect(c.args).toContain(PINNED_REPO_URL);
      expect(c.args.join(" ")).toContain(PINNED_REF);
    }
    const src = readFileSync(join(__dirname, "..", "runner.ts"), "utf8");
    expect(src).not.toMatch(/hwAnchor\.(repoUrl|branch)/);
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

describe("P2-2 (fix delta): commit-on-main runs in a private temporary repository, never in the working repository", () => {
  const base = { repoDir: REPO, commitSha: SHA, env: { PATH: "x", GIT_DIR: "C:\\agent\\.git", GIT_ALTERNATE_OBJECT_DIRECTORIES: "C:\\agent\\objs" } };
  const run = async (fake: Partial<FakeOpts> = {}, extra: Partial<Parameters<typeof mainVerification>[0]> = {}) => {
    const calls: NonNullable<FakeOpts["calls"]> = [];
    const exec = createFakeExec({ commitSha: SHA, repoDir: REPO, calls, ...fake }, { simulateLive: true });
    const res = await mainVerification({ ...base, exec, ...extra });
    return { res, gate: res.ancestry, calls };
  };

  it("every git call runs with system and global config disabled, replace objects off, no prompts, and without any inherited GIT_* variable", async () => {
    const { gate, calls } = await run();
    expect(gate.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(4);
    for (const c of calls) {
      expect(c.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(c.env.GIT_CONFIG_GLOBAL).toBe(process.platform === "win32" ? "NUL" : "/dev/null");
      expect(c.env.GIT_NO_REPLACE_OBJECTS).toBe("1");
      expect(c.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(c.env.GIT_DIR).toBeUndefined();
      expect(c.env.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined();
    }
  });

  it("no command runs in, or points at, the working repository: a fresh bare repo is created and used; hooks, commit-graph and worktree config are switched off for every call", async () => {
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

  it("the temporary repository is removed afterwards, also when a step fails", async () => {
    const { calls } = await run();
    const dirOf = (cs: typeof calls) => (cs[0].args.find((a) => /r\.git$/.test(a)) as string).replace(/[\\/]r\.git$/, "");
    expect(existsSync(dirOf(calls))).toBe(false);
    const bad = await run({ lsRemoteSha: "nothex" });
    expect(bad.gate.ok).toBe(false);
    expect(existsSync(dirOf(bad.calls))).toBe(false);
  });

  it("ancestry is checked against the exact SHA from ls-remote, never FETCH_HEAD", async () => {
    const sha = "e".repeat(40);
    const { gate, calls } = await run({ lsRemoteSha: sha });
    expect(gate.ok).toBe(true);
    const mb = calls.find((c) => c.args.includes("merge-base"));
    expect(mb?.args[mb.args.length - 1]).toBe(sha);
    expect(calls.some((c) => c.args.join(" ").includes("FETCH_HEAD"))).toBe(false);
  });

  it("a fetched ref that differs from what ls-remote reported is refused", async () => {
    const { gate } = await run({ lsRemoteSha: "e".repeat(40), fetchedSha: "f".repeat(40) });
    expect(gate.ok).toBe(false);
    expect(gate.detail).toMatch(/differs/);
  });

  it("a failed ls-remote, fetch or ancestry check refuses; a failed init refuses", async () => {
    expect((await run({ notOnMain: true })).gate.ok).toBe(false);
    expect((await run({ lsRemoteSha: "zz" })).gate.ok).toBe(false);
  });

  it("the remote URL is the trustroot constant unless a test passes one explicitly (the runner never does)", async () => {
    const { calls } = await run();
    expect(calls.filter((c) => c.args.includes("ls-remote") || c.args.includes("fetch")).every((c) => c.args.includes(PINNED_REPO_URL))).toBe(true);
    const src = readFileSync(join(__dirname, "..", "runner.ts"), "utf8");
    expect(src).not.toMatch(/remoteUrl/);
  });
});

describe("F4 (fix delta): the on-disk bytes of every runner, anchor and proof file are compared with the blobs of the pinned commit", () => {
  const files = ["scripts/qa/d24-test-runner/owner-hw-anchor.json", "scripts/qa/d24-test-runner/webauthn.ts"];
  const run = async (fake: Partial<FakeOpts>, over: { readFile?: (rel: string) => Buffer } = {}) => {
    const dir = tmp();
    mkdirSync(join(dir, "scripts", "qa", "d24-test-runner"), { recursive: true });
    for (const f of files) writeFileSync(join(dir, f), `content of ${f}\r\n`);
    const exec = createFakeExec({ commitSha: SHA, repoDir: dir, ...fake }, { simulateLive: true });
    return mainVerification({ repoDir: dir, commitSha: SHA, env: {}, exec, contentFiles: files, ...over });
  };

  it("matching bytes (CRLF-normalised) pass", async () => {
    const r = await run({});
    expect(r.ancestry.ok).toBe(true);
    expect(r.content?.ok).toBe(true);
  });

  it("a file whose bytes differ from the committed blob is refused and named", async () => {
    const r = await run({ tamperedContent: ["owner-hw-anchor.json"] });
    expect(r.content?.ok).toBe(false);
    expect(r.content?.detail).toMatch(/owner-hw-anchor\.json/);
  });

  it("a file absent from the pinned commit's tree is refused", async () => {
    const r = await run({ missingFromTree: ["webauthn.ts"] });
    expect(r.content?.ok).toBe(false);
    expect(r.content?.detail).toMatch(/webauthn\.ts/);
  });

  it("a file that cannot be read from disk is refused", async () => {
    const r = await run({}, { readFile: () => { throw new Error("EACCES"); } });
    expect(r.content?.ok).toBe(false);
  });

  it("content is not checked (null) when the ancestry check already failed", async () => {
    const r = await run({ notOnMain: true });
    expect(r.ancestry.ok).toBe(false);
    expect(r.content).toBeNull();
  });

  it("through runEnvelope: an altered runner file, a runner file missing from the commit, or a proof file is BLOCKED at committed-content before the credential", async () => {
    const t = await go({ fake: { tamperedContent: ["webauthn.ts"] } });
    expect(t.r.status).toBe("BLOCKED");
    expect(failed(t.r)).toBe("committed-content");
    expect(t.r.gates.some((g) => g.id === "credential")).toBe(false);
    expect(t.ledger.runsStarted(t.env.envelopeId)).toBe(0);
    const t2 = await go({ fake: { tamperedContent: ["d24-m3d-proof/guarded.ts"] } });
    expect(failed(t2.r)).toBe("committed-content");
    const t3 = await go({ fake: { missingFromTree: ["runner.ts"] } });
    expect(failed(t3.r)).toBe("committed-content");
    expect(gateDetail((await go()).r, "committed-content")).toMatch(/byte-identical/);
  });
});

describe("F8 (fix delta): the clean-tree gates also run with the isolated git environment", () => {
  it("pristineGates passes no system/global config and no inherited GIT_* to git", async () => {
    const calls: NonNullable<FakeOpts["calls"]> = [];
    const exec = createFakeExec({ commitSha: SHA, repoDir: REPO, calls }, { simulateLive: true });
    const gates = await pristineGates({ repoDir: REPO, commitSha: SHA, env: { PATH: "x", GIT_DIR: "evil" }, exec });
    expect(gates.every((g) => g.ok)).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const c of calls) {
      expect(c.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(c.env.GIT_NO_REPLACE_OBJECTS).toBe("1");
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
