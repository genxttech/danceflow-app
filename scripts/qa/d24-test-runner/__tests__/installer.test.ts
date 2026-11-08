import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { manifest } from "../../d24-m3d-proof/manifest";
import { install } from "../installer";
import { layout, parseRelease, readJson, verifyInstalledTree } from "../installroot";
import { policySha256 } from "../policy";
import { runnerManifest } from "../runnerpin";
import { loadAnchor } from "../webauthn";
import { REPO, SHA, tmp } from "./helpers";
import { aclText, FakeAcl, inputs, installed, providers, writeAnchor } from "./installfixture";
import { makeSoftAuth, testAuth } from "./softauth";

vi.setConfig({ testTimeout: 60_000 });
const freshRoot = () => join(tmp("d24-root-"), "d24-runner");
const untouched = (root: string) => expect(existsSync(root)).toBe(false);

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
  it("a tree that is not proven to be the merge commit on main (verifyRelease fails or returns nothing): nothing is written, no question is asked", async () => {
    for (const verifyRelease of [async () => [{ id: "commit-on-main", ok: false, detail: "not an ancestor of main" }], async () => [] as never[]]) {
      const root = freshRoot();
      const p = providers(layout(root), { verifyRelease });
      const r = await install(inputs(root), p);
      expect(r.ok).toBe(false);
      untouched(root);
      expect(p.questions).toEqual([]);
    }
  });
  it("a wrong, empty or absent typed confirmation: nothing is written", async () => {
    for (const ans of ["", "0000", "yes", "ABCDE"]) {
      const root = freshRoot();
      const p = providers(layout(root), {}, () => ans);
      const r = await install(inputs(root), p);
      expect(r.ok, ans).toBe(false);
      untouched(root);
    }
  });
  it("bad inputs are refused before anything else: short commit, bad PR, invalid or missing anchor, ceilings above the proof cap", async () => {
    const cases: Array<Partial<ReturnType<typeof inputs>>> = [
      { commit: "abc" },
      { prNumber: 0 },
      { anchorFile: join(tmp(), "missing.json") },
      { anchorFile: writeAnchor({ ...testAuth.anchor, rpId: "evil.example.test" }) },
      { ceilings: { maxCallsPerRun: 41 } },
      { ceilings: { amountCeilingMinor: 100 } },
      { runAsAccount: "ownerperson" },
      { platformAcct: "acct_UNITCONNECTED1" },
    ];
    for (const c of cases) {
      const root = freshRoot();
      const r = await install(inputs(root, c), providers(layout(root)));
      expect(r.ok, JSON.stringify(c)).toBe(false);
      untouched(root);
    }
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
    const firstAsk = events.indexOf("ask");
    const shown = events.slice(0, firstAsk).join("\n");
    const rm = runnerManifest(join(REPO, "scripts", "qa", "d24-test-runner"));
    expect(shown).toContain(SHA);
    expect(shown).toContain("PR #421");
    expect(shown).toContain(rm.sha256);
    const rel = parseRelease(readJson(l.releaseJson));
    expect(rel.ok && rel.release).toMatchObject({ commit: SHA, prNumber: 421, treeSha256: rm.sha256, treeFileCount: rm.files.length, proofManifestSha256: manifest(join(REPO, "scripts", "qa", "d24-m3d-proof")).sha256 });
    if (rel.ok) {
      expect(verifyInstalledTree(l, rel.release).ok).toBe(true);
      expect(rel.release.policySha256).toBe(policySha256(readJson(l.policyJson) as never));
    }
    expect(p.installDepsCalls).toEqual([l.release]);
  });
  it("the installed tree has no test folders, no symlinks and the policy/anchor beside it; ACLs were applied in order root first, then the four special dirs, then verified by a read-back", async () => {
    const { l, p } = await installed();
    expect(existsSync(join(l.runnerDir, "__tests__"))).toBe(false);
    expect(existsSync(l.policyJson) && existsSync(l.anchorJson) && existsSync(l.releaseJson)).toBe(true);
    expect(p.acl.applied.map((a) => a.role)).toEqual(["locked", "state", "secret", "inbox", "evidence"]);
    expect(p.acl.applied[0].path).toBe(l.root);
    expect(p.lines.some((x) => /install-root-acl/.test(x) && x.startsWith("PASS"))).toBe(true);
  });
  it("an ACL read-back that does not match the roles makes the install FAIL and says it is not safe", async () => {
    const root = freshRoot();
    const l = layout(root);
    const p = providers(l);
    p.acl.override(l.release, aclText(l.release, "locked").replace("Successfully", "      BUILTIN\\Users:(OI)(CI)(M)\n\nSuccessfully"));
    const r = await install(inputs(root), p);
    expect(r.ok).toBe(false);
    expect(r.gates.at(-1)).toMatchObject({ id: "install-complete", ok: false });
    expect(r.gates.at(-1)?.detail).toMatch(/NOT SAFE/);
  });
});

describe("installer: anchor rotation is possible only here, explicitly, with a typed new fingerprint", () => {
  it("re-installing the same anchor is an update, not a rotation", async () => {
    const { root } = await installed();
    const l = layout(root);
    const r = await install(inputs(root, {}), providers(l));
    expect(r.ok).toBe(true);
  });
  it("a different anchor without rotateAnchor is refused and the installed anchor is unchanged", async () => {
    const { root, l } = await installed();
    const before = readFileSync(l.anchorJson, "utf8");
    const other = makeSoftAuth();
    const r = await install(inputs(root, { anchorFile: writeAnchor(other.anchor) }), providers(l));
    expect(r.ok).toBe(false);
    expect(r.gates.at(-1)).toMatchObject({ id: "anchor-rotation", ok: false });
    expect(readFileSync(l.anchorJson, "utf8")).toBe(before);
  });
  it("rotateAnchor with a wrong typed group is refused; with the right one the anchor and the policy pin change", async () => {
    const { root, l } = await installed();
    const other = makeSoftAuth();
    const wrongFor = (q: string) => (/new anchor/i.test(q) ? "0000" : /\(([0-9A-F]{4})\)/.exec(q)![1]);
    const bad = await install(inputs(root, { anchorFile: writeAnchor(other.anchor), rotateAnchor: true }), providers(l, {}, wrongFor));
    expect(bad.ok).toBe(false);
    expect(loadAnchor(l.anchorJson)).toMatchObject({ ok: true, anchor: { fingerprintSha256: testAuth.anchor.fingerprintSha256 } });
    const p = providers(l);
    const good = await install(inputs(root, { anchorFile: writeAnchor(other.anchor), rotateAnchor: true }), p);
    expect(good.ok).toBe(true);
    expect(p.lines.join("\n")).toContain(`old ${testAuth.anchor.fingerprintSha256}`);
    expect(p.lines.join("\n")).toContain(`new ${other.anchor.fingerprintSha256}`);
    expect(loadAnchor(l.anchorJson)).toMatchObject({ ok: true, anchor: { fingerprintSha256: other.anchor.fingerprintSha256 } });
    expect((readJson(l.policyJson) as { anchorFingerprint: string }).anchorFingerprint).toBe(other.anchor.fingerprintSha256);
  });
  it("rotateAnchor on a root with no installed anchor is refused", async () => {
    const root = freshRoot();
    const r = await install(inputs(root, { rotateAnchor: true }), providers(layout(root)));
    expect(r.ok).toBe(false);
    untouched(root);
  });
  it("nothing outside this module writes the install root: no other non-test source imports the installer", async () => {
    const { readdirSync } = await import("node:fs");
    const dir = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const src = join(dir, "..");
    const importers = readdirSync(src).filter((f) => f.endsWith(".ts") && f !== "installer.ts" && /from "\.\/installer"/.test(readFileSync(join(src, f), "utf8")));
    expect(importers).toEqual(["installedcli.ts"]);
    void writeFileSync;
    void FakeAcl;
  });
});
