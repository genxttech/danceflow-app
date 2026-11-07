// Review of PR #419 (targeted): the commit-on-main gate must not take its location from the anchor, must cover every hashed runner file,
// must not be steerable through git config / replace refs / grafts / shallow state, and the test seams must not exist on a real executor.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../credstore";
import { createFakeExec, type FakeOpts } from "../fakeChild";
import { commitOnMain, runnerTracked } from "../gitverify";
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

describe("P2-2: commit-on-main is isolated from agent-writable git state", () => {
  const base = { repoDir: REPO, commitSha: SHA, env: { PATH: "x" } };
  const run = async (fake: Partial<FakeOpts> = {}, extra: { fileExists?: (p: string) => boolean } = {}) => {
    const calls: NonNullable<FakeOpts["calls"]> = [];
    const exec = createFakeExec({ commitSha: SHA, repoDir: REPO, calls, ...fake }, { simulateLive: true });
    const gate = await commitOnMain({ ...base, exec, ...extra });
    return { gate, calls };
  };

  it("every git call runs with system and global config disabled, replace objects off, no prompts", async () => {
    const { gate, calls } = await run();
    expect(gate.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(3);
    for (const c of calls) {
      expect(c.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(c.env.GIT_CONFIG_GLOBAL).toBe(process.platform === "win32" ? "NUL" : "/dev/null");
      expect(c.env.GIT_NO_REPLACE_OBJECTS).toBe("1");
      expect(c.env.GIT_TERMINAL_PROMPT).toBe("0");
    }
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
    expect(gate.detail).toMatch(/differs|changed/);
  });

  it("a local url.* / http / proxy config entry, a shallow repo, replace refs or a grafts file each refuse, and nothing is fetched into a suspicious repository", async () => {
    expect((await run({ urlConfig: true })).gate.detail).toMatch(/config/);
    expect((await run({ shallow: true })).gate.detail).toMatch(/shallow/);
    expect((await run({ replaceRefs: true })).gate.detail).toMatch(/replace/);
    expect((await run({}, { fileExists: (p) => /grafts$/.test(p) })).gate.detail).toMatch(/graft/);
    for (const f of [{ urlConfig: true }, { shallow: true }, { replaceRefs: true }]) {
      const { gate, calls } = await run(f);
      expect(gate.ok).toBe(false);
      expect(calls.some((c) => c.args.includes("fetch"))).toBe(false);
    }
  });

  it("not-on-branch still refuses", async () => {
    expect((await run({ notOnMain: true })).gate.ok).toBe(false);
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
