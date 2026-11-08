import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { manifest } from "../../d24-m3d-proof/manifest";
import { install } from "../installer";
import { layout, parseRelease, readJson, verifyInstalledTree } from "../installroot";
import { policySha256 } from "../policy";
import { runnerManifest } from "../runnerpin";
import { loadAnchor } from "../webauthn";
import { REPO, SHA, tmp } from "./helpers";
import { FakeAcl, inputs, installed, OWNER_SID, providers, sddlFor, WHO, writeAnchor } from "./installfixture";
import { makeSoftAuth, testAuth } from "./softauth";

vi.setConfig({ testTimeout: 60_000 });
const freshRoot = () => join(tmp("d24-root-"), "d24-runner");
const untouched = (root: string) => expect(existsSync(root)).toBe(false);
const SRC = join(REPO, "scripts", "qa");

/** A throwaway copy of the files the installer reads from a source clone, so a test can mutate "the source" without touching the repository. */
function makeSource() {
  const d = tmp("d24-src-");
  for (const rel of ["d24-test-runner", "d24-m3d-proof"]) cpSync(join(SRC, rel), join(d, "scripts", "qa", rel), { recursive: true, filter: (s) => !/__tests__$/.test(s) || rel === "d24-m3d-proof" });
  cpSync(join(REPO, "package.json"), join(d, "package.json"));
  cpSync(join(REPO, "package-lock.json"), join(d, "package-lock.json"));
  return d;
}

describe("installer: refusals leave the root untouched", () => {
  it("not elevated: nothing is written", async () => {
    const root = freshRoot();
    const p = providers(layout(root), { isElevated: () => false });
    const r = await install(inputs(root), p);
    expect(r.ok).toBe(false);
    expect(r.gates.at(-1)).toMatchObject({ id: "elevated", ok: false });
    untouched(root);
    expect(p.questions).toEqual([]);
  });
  it("P0-2: the elevated process is not running administrator-only code with a clean environment -> nothing is written, no question asked", async () => {
    for (const toolchainGates of [async () => [{ id: "elevated-env", ok: false, detail: "NODE_OPTIONS is set" }], async () => [] as never[]]) {
      const root = freshRoot();
      const p = providers(layout(root), { toolchainGates });
      const r = await install(inputs(root), p);
      expect(r.ok).toBe(false);
      untouched(root);
      expect(p.questions).toEqual([]);
    }
  });
  it("a tree that is not proven to be the merge commit on main (verifyRelease fails or returns nothing): nothing is written", async () => {
    for (const verifyRelease of [async () => [{ id: "commit-on-main", ok: false, detail: "not an ancestor of main" }], async () => [] as never[]]) {
      const root = freshRoot();
      const p = providers(layout(root), { verifyRelease });
      expect((await install(inputs(root), p)).ok).toBe(false);
      untouched(root);
      expect(p.questions).toEqual([]);
    }
  });
  it("P2-4: the commit must be the merge commit of a merged PR: a failing PR check writes nothing", async () => {
    const root = freshRoot();
    const p = providers(layout(root), { verifyPr: async () => ({ id: "pr-merge-commit", ok: false, detail: "the PR's merge commit is another commit" }) });
    const r = await install(inputs(root), p);
    expect(r.gates.at(-1)).toMatchObject({ id: "pr-merge-commit", ok: false });
    untouched(root);
  });
  it("P1-3: an anchor that is neither pinned in the verified tree nor administrator-owned is refused", async () => {
    const root = freshRoot();
    const p = providers(layout(root), { anchorSourceGate: async () => ({ id: "anchor-source", ok: false, detail: "the anchor file is writable by the owner's user" }) });
    expect((await install(inputs(root), p)).ok).toBe(false);
    untouched(root);
  });
  it("a wrong, empty or absent typed confirmation of the tree or of the (first-install) anchor: nothing is written", async () => {
    for (const ans of ["", "0000", "yes", "ABCDE"]) {
      const root = freshRoot();
      expect((await install(inputs(root), providers(layout(root), {}, () => ans))).ok, ans).toBe(false);
      untouched(root);
    }
    const root = freshRoot();
    const p = providers(layout(root), {}, (q) => (/anchor fingerprint/.test(q) ? "0000" : /\(([0-9A-F]{4})\)/.exec(q)![1]));
    const r = await install(inputs(root), p);
    expect(r.gates.at(-1)).toMatchObject({ id: "owner-confirm-anchor", ok: false });
    expect(p.questions.filter((q) => /anchor fingerprint/.test(q))).toHaveLength(1);
    untouched(root);
  });
  it("bad inputs are refused before anything else", async () => {
    const cases: Array<Partial<ReturnType<typeof inputs>>> = [
      { commit: "abc" }, { prNumber: 0 }, { anchorFile: join(tmp(), "missing.json") },
      { anchorFile: writeAnchor({ ...testAuth.anchor, rpId: "evil.example.test" }) },
      { ceilings: { maxCallsPerRun: 41 } }, { ceilings: { amountCeilingMinor: 100 } },
      { runAsAccount: "ownerperson" }, { platformAcct: "acct_UNITCONNECTED1" },
      { runAsSid: "S-1-5-32-544" }, { ownerSid: "S-1-5-21-111-222-333-1001" },
    ];
    for (const c of cases) {
      const root = freshRoot();
      expect((await install(inputs(root, c), providers(layout(root)))).ok, JSON.stringify(c)).toBe(false);
      untouched(root);
    }
  });
});

describe("installer: P0-1 the root is created by the installer, owner and ACL first", () => {
  it("applies the locked owner+DACL to the NEW root while it is still empty, before any content is written", async () => {
    const root = freshRoot();
    const l = layout(root);
    const p = providers(l);
    let emptyAtLock = false;
    const apply = p.acl.apply.bind(p.acl);
    p.acl.apply = async (path, role, who) => {
      if (path === root && role === "locked") emptyAtLock = existsSync(root) && readdirSync(root).length === 0;
      return apply(path, role, who);
    };
    expect((await install(inputs(root), p)).ok).toBe(true);
    expect(emptyAtLock).toBe(true);
    expect(p.acl.applied.map((a) => a.role).slice(0, 5)).toEqual(["locked", "state", "secret", "inbox", "evidence"]);
  });
  it("a root that already exists (agent pre-created it) is never adopted: its owner/DACL must already pass the full gate", async () => {
    const root = freshRoot();
    const l = layout(root);
    mkdirSync(root, { recursive: true });
    const p = providers(l);
    p.acl.override(root, sddlFor("locked", WHO, OWNER_SID)); // perfect DACL, but OWNED by the owner's user
    const r = await install(inputs(root), p);
    expect(r.ok).toBe(false);
    expect(r.gates.at(-1)).toMatchObject({ id: "existing-root", ok: false });
    expect(r.gates.at(-1)?.detail).toMatch(/owned by/);
    expect(readdirSync(root)).toEqual([]); // nothing was written into it
  });
  it("P0-1b: staged content that is not Administrators-owned (agent-owned file raced into the staging area) stops the install before the swap", async () => {
    const root = freshRoot();
    const p = providers(layout(root));
    const orig = p.acl.readTree.bind(p.acl);
    p.acl.readTree = async (path, rec) => {
      const out = await orig(path, rec);
      return /staging-[0-9a-f]+$/.test(path) ? out.map((e, i) => (i === out.length - 1 ? { ...e, sddl: sddlFor("locked", WHO, OWNER_SID) } : e)) : out;
    };
    const r = await install(inputs(root), p);
    expect(r.gates.at(-1)).toMatchObject({ id: "staged-acl", ok: false });
    expect(existsSync(join(root, "release"))).toBe(false);
    expect(readdirSync(root).filter((n) => /^(staging|rollback)-/.test(n))).toEqual([]);
  });
  it("if the new root is not Administrators-owned after the apply (apply did not take), the install stops before writing content", async () => {
    const root = freshRoot();
    const p = providers(layout(root));
    p.acl.override(root, sddlFor("locked", WHO, OWNER_SID));
    const r = await install(inputs(root), p);
    expect(r.gates.at(-1)).toMatchObject({ id: "root-owner", ok: false });
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("installer: a good install", () => {
  it("shows commit, PR number and tree hash BEFORE it asks, then writes a release record that equals the source hashes", async () => {
    const root = freshRoot();
    const l = layout(root);
    const events: string[] = [];
    const p = providers(l, { out: (x) => void events.push(`out:${x}`), confirm: async (q) => (events.push("ask"), /\(([0-9A-F]{4})\)/.exec(q)![1]) });
    const r = await install(inputs(root), p);
    expect(r.ok).toBe(true);
    const shown = events.slice(0, events.indexOf("ask")).join("\n");
    const rm = runnerManifest(join(SRC, "d24-test-runner"));
    expect(shown).toContain(SHA);
    expect(shown).toContain("PR #421");
    expect(shown).toContain(rm.sha256);
    const rel = parseRelease(readJson(l.releaseJson));
    expect(rel.ok && rel.release).toMatchObject({ commit: SHA, prNumber: 421, treeSha256: rm.sha256, treeFileCount: rm.files.length, proofManifestSha256: manifest(join(SRC, "d24-m3d-proof")).sha256 });
    if (rel.ok) {
      expect(verifyInstalledTree(l, rel.release).ok).toBe(true);
      expect(rel.release.policySha256).toBe(policySha256(readJson(l.policyJson) as never));
    }
    // first install asks for BOTH the tree group and the anchor group
    expect(events.filter((e) => e === "ask")).toHaveLength(2);
  });
  it("the installed layout: no tests, tsconfig.json present, staging and rollback folders gone, deps installed INSIDE the staged release, state\\tmp created", async () => {
    const { l, p } = await installed();
    expect(existsSync(join(l.runnerDir, "__tests__"))).toBe(false);
    expect(readFileSync(join(l.release, "tsconfig.json"), "utf8")).toContain("compilerOptions");
    expect(readdirSync(l.root).filter((n) => /^(staging|rollback)-/.test(n))).toEqual([]);
    expect(p.installDepsCalls[0]).toMatch(/staging-[0-9a-f]+[\\/]release$/);
    expect(existsSync(l.tmp)).toBe(true);
  });
  it("P0-1b: staged content was checked for owner+DACL before the swap, and the whole root after it (an ACL read-back mismatch fails the install and rolls back)", async () => {
    const { root, l } = await installed();
    const before = readFileSync(l.releaseJson, "utf8");
    const p = providers(l);
    const orig = p.acl.readTree.bind(p.acl);
    let calls = 0;
    p.acl.readTree = async (path, rec) => {
      const out = await orig(path, rec);
      // the full-root read-back is the one whose path is the root itself and is recursive, after the swap: poison it
      if (path === root && rec && ++calls >= 2) return out.map((e) => (e.path === l.policyJson ? { ...e, sddl: sddlFor("locked", WHO, OWNER_SID) } : e));
      return out;
    };
    const r = await install(inputs(root, { prNumber: 422 }), p);
    expect(r.ok).toBe(false);
    expect(r.gates.at(-1)?.detail).toMatch(/ROLLED BACK/);
    expect(readFileSync(l.releaseJson, "utf8")).toBe(before); // previous install restored
    expect(readdirSync(root).filter((n) => /^(staging|rollback)-/.test(n))).toEqual([]);
  });
});

describe("installer: P1-1 the confirmed bytes are the installed bytes", () => {
  it("package.json and the lockfile that were hashed, verified and shown are the bytes installed: a swap in the source during the confirmation prompt changes nothing", async () => {
    for (const file of ["package-lock.json", "package.json"]) {
      const src = makeSource();
      const root = freshRoot();
      const original = readFileSync(join(src, file), "utf8");
      const p = providers(layout(root));
      p.confirm = async (q) => {
        writeFileSync(join(src, file), `${original} `);
        return /(([0-9A-F]{4}))/.exec(q)![1];
      };
      const r = await install(inputs(root, { sourceRepo: src }), p);
      expect(r.ok, file).toBe(true);
      expect(readFileSync(join(root, "release", file), "utf8")).toBe(original);
    }
  });
  it("a runner or proof file swapped in the source during the prompt is caught by the staged re-hash (copy-verified), and nothing is installed", async () => {
    for (const rel of [["d24-test-runner", "runner.ts"], ["d24-m3d-proof", "config.ts"]]) {
      const src = makeSource();
      const root = freshRoot();
      const f = join(src, "scripts", "qa", rel[0], rel[1]);
      const p = providers(layout(root));
      p.confirm = async (q) => {
        writeFileSync(f, `${readFileSync(f, "utf8")}
// swapped`);
        return /(([0-9A-F]{4}))/.exec(q)![1];
      };
      const r = await install(inputs(root, { sourceRepo: src }), p);
      expect(r.gates.at(-1), rel[1]).toMatchObject({ id: "copy-verified", ok: false });
      expect(existsSync(join(root, "release"))).toBe(false);
      expect(readdirSync(root).filter((n) => /^(staging|rollback)-/.test(n))).toEqual([]);
    }
  });
  it("the pins handed to the release verifier include package.json and package-lock.json", async () => {
    const root = freshRoot();
    let pins: Array<{ rel: string }> = [];
    await install(inputs(root), providers(layout(root), { verifyRelease: async (o) => ((pins = o.pins), [{ id: "commit-on-main", ok: true, detail: "" }]) }));
    expect(pins.map((x) => x.rel)).toEqual(expect.arrayContaining(["package.json", "package-lock.json"]));
  });
});

describe("installer: updates, downgrade protection, anchor rotation", () => {
  it("re-installing the same release is an update; a newer PR is accepted; an older PR or another commit of the same PR is refused as a downgrade", async () => {
    const { root, l } = await installed();
    expect((await install(inputs(root), providers(l))).ok).toBe(true);
    expect((await install(inputs(root, { prNumber: 430 }), providers(l))).ok).toBe(true);
    const older = await install(inputs(root, { prNumber: 425 }), providers(l));
    expect(older.gates.at(-1)).toMatchObject({ id: "no-downgrade", ok: false });
    const other = await install(inputs(root, { prNumber: 430, commit: "d".repeat(40) }), providers(l));
    expect(other.gates.at(-1)).toMatchObject({ id: "no-downgrade", ok: false });
    expect(((readJson(l.releaseJson) as { prNumber: number }).prNumber)).toBe(430);
  });
  it("a different anchor without rotateAnchor is refused and the installed anchor is unchanged", async () => {
    const { root, l } = await installed();
    const before = readFileSync(l.anchorJson, "utf8");
    const r = await install(inputs(root, { anchorFile: writeAnchor(makeSoftAuth().anchor) }), providers(l));
    expect(r.gates.at(-1)).toMatchObject({ id: "anchor-rotation", ok: false });
    expect(readFileSync(l.anchorJson, "utf8")).toBe(before);
  });
  it("rotateAnchor with a wrong typed group is refused; with the right one the anchor and the policy pin change", async () => {
    const { root, l } = await installed();
    const other = makeSoftAuth();
    const wrongFor = (q: string) => (/anchor fingerprint/i.test(q) ? "0000" : /\(([0-9A-F]{4})\)/.exec(q)![1]);
    expect((await install(inputs(root, { anchorFile: writeAnchor(other.anchor), rotateAnchor: true }), providers(l, {}, wrongFor))).ok).toBe(false);
    expect(loadAnchor(l.anchorJson)).toMatchObject({ ok: true, anchor: { fingerprintSha256: testAuth.anchor.fingerprintSha256 } });
    const p = providers(l);
    expect((await install(inputs(root, { anchorFile: writeAnchor(other.anchor), rotateAnchor: true }), p)).ok).toBe(true);
    expect(p.lines.join("\n")).toContain(`old ${testAuth.anchor.fingerprintSha256}`);
    expect(loadAnchor(l.anchorJson)).toMatchObject({ ok: true, anchor: { fingerprintSha256: other.anchor.fingerprintSha256 } });
    expect((readJson(l.policyJson) as { anchorFingerprint: string }).anchorFingerprint).toBe(other.anchor.fingerprintSha256);
  });
  it("rotateAnchor on a root with no installed anchor is refused", async () => {
    const root = freshRoot();
    expect((await install(inputs(root, { rotateAnchor: true }), providers(layout(root)))).ok).toBe(false);
    untouched(root);
  });
});

describe("static import scans", () => {
  const src = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
  const nonTest = readdirSync(src).filter((f) => f.endsWith(".ts") && statSync(join(src, f)).isFile());
  const importers = (mod: string, name: string) => nonTest.filter((f) => f !== `${mod}.ts` && new RegExp(`import[^;]*${name}[^;]*from "\\./${mod}"`).test(readFileSync(join(src, f), "utf8")));
  it("only installedcli imports the installer (nothing else can write the install root)", () => {
    expect(nonTest.filter((f) => f !== "installer.ts" && /from "\.\/installer"/.test(readFileSync(join(src, f), "utf8")))).toEqual(["installedcli.ts"]);
  });
  it("P2-2: only execinbox mints the verified-install brand; no test file imports the mint", () => {
    expect(importers("installmint", "markVerifiedInstalled")).toEqual(["execinbox.ts"]);
    const tests = readdirSync(join(src, "__tests__")).filter((f) => f.endsWith(".ts"));
    expect(tests.filter((f) => /markVerifiedInstalled|installmint/.test(readFileSync(join(src, "__tests__", f), "utf8")) && f !== "installer.test.ts")).toEqual([]);
  });
  it("the unused FakeAcl type import path stays referenced", () => expect(FakeAcl).toBeDefined());
});
