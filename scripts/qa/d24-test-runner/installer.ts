// ELEVATED-ONLY installer logic. It is the only code that writes the install root. Every side effect goes through an injected provider so the whole flow
// is tested on throwaway temp directories; the real providers (installedcli.ts) are never exercised by tests and nothing here creates accounts,
// scheduled tasks or credentials.
//
// Order (review of PR 423): elevation -> administrator-only toolchain -> inputs -> release verification (commit on main with pinned blobs AND the merged
// PR whose merge commit it is, no downgrade) -> display -> typed confirmations -> the installer CREATES the root itself (an existing root must already
// pass the full owner+DACL gate) and sets owner+ACL BEFORE any content exists -> content is STAGED inside the locked root and verified (hashes, owner,
// DACL) -> atomic renames with rollback -> full read-back of every directory and file. Any failure restores the previous install.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, relative } from "node:path";
import { manifest } from "../d24-m3d-proof/manifest";
import { confirmAnchorCode, confirmFirstGroup, envelopeFingerprint, firstGroup } from "./fingerprint";
import { aclGate, entryViolations, fileSha256, INSTALLER_VERSION, layout, lockedTreeGate, parseRelease, PROOF_REL, rawTreeSha256, readJson, RELEASE_TSCONFIG, releaseText, RUNNER_REL, verifyInstalledTree, type AclApplier, type AclRole, type Gate, type Layout, type Release, type Who } from "./installroot";
import { parsePolicy, policySha256, policyText, proofHardCap, proofMaxLineCents, type Policy } from "./policy";
import { runnerManifest } from "./runnerpin";
import { loadAnchor } from "./webauthn";

export type Pin = { rel: string; sha256: string };
export type InstallInputs = {
  root: string;
  /** the administrator-owned clean clone the release is copied from (and the installer code runs from) */
  sourceRepo: string;
  commit: string;
  prNumber: number;
  /** the owner's GitHub login: the PR must have been merged by it */
  ownerGithubLogin: string;
  platformAcct: string;
  connectedAcct: string;
  /** the enrolled hardware anchor file: it must be pinned inside the verified source tree, or administrator-owned (anchorSourceGate) */
  anchorFile: string;
  ownerAccount: string;
  runAsAccount: string;
  ownerSid: string;
  runAsSid: string;
  ceilings?: Partial<Pick<Policy, "maxRunsPerEnvelope" | "maxEnvelopeValidityDays" | "maxRunsPerDay" | "amountCeilingMinor" | "maxCallsPerRun">>;
  /** an installed anchor with a different fingerprint is replaced only when this is true AND the owner types the new fingerprint's first group */
  rotateAnchor?: boolean;
};
export type InstallProviders = {
  isElevated(): boolean;
  /** administrator-only node/git/source/clean environment (see provenance.toolchainGates) */
  toolchainGates(): Promise<Gate[]>;
  /** commit-on-main (SHA-1-verified objects, pinned repo) AND the pinned blobs AND a clean checkout at `commit`. The real one wraps gitverify. */
  verifyRelease(o: { repoDir: string; commit: string; pins: Pin[] }): Promise<Gate[]>;
  /** the commit is the merge commit of a merged PR into main, merged by the owner (GitHub API) */
  verifyPr(o: { prNumber: number; commit: string; ownerLogin: string }): Promise<Gate>;
  /** the anchor file is pinned inside the verified tree or is administrator-owned and not writable by anyone else */
  anchorSourceGate(file: string): Promise<Gate>;
  /** `git merge-base --is-ancestor ancestor descendant` in the administrator-owned clone (releases are ordered by history, never by PR number) */
  isAncestor(o: { repoDir: string; ancestor: string; descendant: string }): Promise<boolean>;
  acl: AclApplier;
  /** prints the question and returns what the owner typed */
  confirm(question: string): Promise<string>;
  /** `npm ci --ignore-scripts` inside the STAGED release dir, with a scrubbed environment and empty administrator-owned npm configs */
  installDeps(releaseDir: string): Promise<void>;
  now(): Date;
  out(line: string): void;
};
export type InstallResult = { ok: boolean; gates: Gate[]; release?: Release };

const NO_TESTS = (name: string) => name === "__tests__";
function copyDir(src: string, dst: string, skip: (name: string) => boolean = () => false): void {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src).sort()) {
    if (skip(name)) continue;
    const s = join(src, name);
    const st = lstatSync(s);
    if (st.isSymbolicLink()) throw new Error(`refusing to copy a symlink from the release source: ${name}`);
    if (st.isDirectory()) copyDir(s, join(dst, name), skip);
    else copyFileSync(s, join(dst, name));
  }
}
const mk = (gates: Gate[], out: (l: string) => void) => (id: string, ok: boolean, detail: string): boolean => {
  gates.push({ id, ok, detail });
  out(`${ok ? "PASS" : "FAIL"}  ${id}: ${detail}`);
  return ok;
};
const SWAP = ["release", "policy.json", "anchor.json", "release.json"] as const;

export async function install(i: InstallInputs, p: InstallProviders): Promise<InstallResult> {
  const gates: Gate[] = [];
  const gate = mk(gates, p.out);
  const fail = (): InstallResult => ({ ok: false, gates });
  const l: Layout = layout(i.root);
  const who: Who = { runAsSid: i.runAsSid, ownerSid: i.ownerSid };

  // 1. elevation first, then the toolchain this very process runs on
  if (!gate("elevated", p.isElevated(), p.isElevated() ? "running elevated" : "the installer must run elevated (an agent running as the owner's user cannot write the install root)")) return fail();
  const tc = await p.toolchainGates();
  for (const g of tc) gate(g.id, g.ok, g.detail);
  if (tc.length === 0 || tc.some((g) => !g.ok)) return gate("toolchain", false, "the elevated process is not running administrator-only code with a clean environment: nothing was written"), fail();

  // 2. inputs
  if (!/^[0-9a-f]{40}$/.test(i.commit) || !Number.isInteger(i.prNumber) || i.prNumber <= 0) return gate("inputs", false, "commit must be a full 40-hex id and prNumber a positive integer"), fail();
  const srcRunner = join(i.sourceRepo, ...RUNNER_REL.split("/"));
  const srcProof = join(i.sourceRepo, ...PROOF_REL.split("/"));
  const srcLock = join(i.sourceRepo, "package-lock.json");
  const srcPkg = join(i.sourceRepo, "package.json");
  for (const f of [srcRunner, srcProof, srcLock, srcPkg]) if (!existsSync(f)) return gate("inputs", false, `release source is missing ${relative(i.sourceRepo, f)}`), fail();
  const anchorG = await p.anchorSourceGate(i.anchorFile);
  if (!gate(anchorG.id, anchorG.ok, anchorG.detail)) return fail();
  const anchor = loadAnchor(i.anchorFile);
  if (anchor === null || !anchor.ok) return gate("anchor-file", false, anchor === null ? "no anchor file at the given path" : `anchor invalid: ${anchor.problems.join("; ")}`), fail();
  gate("anchor-file", true, `anchor ${anchor.anchor.fingerprintSha256.slice(0, 16)} parsed`);

  // 3. what is about to be installed, hashed from the source tree now
  const rm = runnerManifest(srcRunner);
  const pm = manifest(srcProof);
  const lockText = readFileSync(srcLock, "utf8");
  const pkgText = readFileSync(srcPkg, "utf8");
  const lock = fileSha256(lockText);
  const pkg = fileSha256(pkgText);
  const maxCap = proofHardCap(srcProof);
  const maxLine = proofMaxLineCents(srcProof);
  if (maxCap === null || maxLine === null) return gate("proof-constants", false, "could not read HARD_CALL_CAP / maxLineCents from the release source's proof"), fail();
  const pins: Pin[] = [...rm.files.map((f) => ({ rel: `${RUNNER_REL}/${f.path}`, sha256: f.sha256 })), ...pm.files.map((f) => ({ rel: `${PROOF_REL}/${f.path}`, sha256: f.sha256 })), { rel: "package.json", sha256: pkg }, { rel: "package-lock.json", sha256: lock }];

  // 4. provenance: the commit is on main with the pinned blobs (runner, proof, package.json, lockfile) AND is the merge commit of a merged PR
  const rel = await p.verifyRelease({ repoDir: i.sourceRepo, commit: i.commit, pins });
  for (const g of rel) gate(g.id, g.ok, g.detail);
  if (rel.length === 0 || rel.some((g) => !g.ok)) return gate("release-verified", false, "the source tree is not proven to be the merge commit on main: nothing was written"), fail();
  const pr = await p.verifyPr({ prNumber: i.prNumber, commit: i.commit, ownerLogin: i.ownerGithubLogin });
  if (!gate(pr.id, pr.ok, pr.detail)) return fail();

  // 5. an existing root must already be a valid, administrator-owned install (agent-created or agent-owned roots are never adopted); no downgrade
  const existing = existsSync(l.root);
  let oldRelease: Release | null = null;
  if (existing) {
    const ag0 = await aclGate(l, p.acl, who);
    if (!gate("existing-root", ag0.ok, ag0.ok ? "the existing install root passes the full owner+DACL gate" : `the existing root is not a valid locked install (delete it as an administrator and install again): ${ag0.detail}`)) return fail();
    try {
      const r0 = parseRelease(readJson(l.releaseJson));
      oldRelease = r0.ok ? r0.release : null;
    } catch {
      oldRelease = null;
    }
    if (oldRelease) {
      const same = i.commit === oldRelease.commit;
      const forward = same || (await p.isAncestor({ repoDir: i.sourceRepo, ancestor: oldRelease.commit, descendant: i.commit }));
      if (!gate("no-downgrade", forward, forward ? (same ? "re-installing the installed commit" : `${i.commit.slice(0, 12)} descends from the installed ${oldRelease.commit.slice(0, 12)}`) : `${i.commit.slice(0, 12)} does not descend from the installed release ${oldRelease.commit.slice(0, 12)} (PR #${oldRelease.prNumber}): releases are ordered by git history, not PR number`)) return fail();
    }
  }

  // 6. policy from the elevated caller's inputs
  const polRaw: Policy = {
    v: 1, stripeMode: "test", keyKind: "rk_test", credentialStore: "dpapi-file",
    platformAcct: i.platformAcct, connectedAcct: i.connectedAcct,
    maxCallsPerRun: i.ceilings?.maxCallsPerRun ?? maxCap,
    maxRunsPerEnvelope: i.ceilings?.maxRunsPerEnvelope ?? 2,
    maxEnvelopeValidityDays: i.ceilings?.maxEnvelopeValidityDays ?? 7,
    maxRunsPerDay: i.ceilings?.maxRunsPerDay ?? 2,
    allowListSha256: pm.sha256,
    amountCeilingMinor: i.ceilings?.amountCeilingMinor ?? maxLine,
    anchorFingerprint: anchor.anchor.fingerprintSha256,
    runAsAccount: i.runAsAccount, ownerAccount: i.ownerAccount, runAsSid: i.runAsSid, ownerSid: i.ownerSid,
  };
  const pol = parsePolicy(polRaw, maxCap);
  if (!pol.ok) return gate("policy", false, pol.problems.join(" | ")), fail();
  if (maxLine > pol.policy.amountCeilingMinor) return gate("policy", false, `the proof's per-invoice cap ${maxLine} is above the amount ceiling ${pol.policy.amountCeilingMinor}`), fail();
  gate("policy", true, `ceilings: ${pol.policy.maxCallsPerRun} calls, ${pol.policy.maxRunsPerEnvelope} runs/envelope, ${pol.policy.maxEnvelopeValidityDays} days, ${pol.policy.maxRunsPerDay}/day, amount ${pol.policy.amountCeilingMinor}`);

  // 7. anchor change rule: a first install and any replacement both need the typed anchor fingerprint; a replacement also needs an explicit request
  let anchorChanges = true;
  if (existing && existsSync(l.anchorJson)) {
    const old = loadAnchor(l.anchorJson);
    const oldFp = old && old.ok ? old.anchor.fingerprintSha256 : null;
    anchorChanges = oldFp !== anchor.anchor.fingerprintSha256;
    if (anchorChanges) {
      if (!i.rotateAnchor) return gate("anchor-rotation", false, `an anchor is already installed (${oldFp ? oldFp.slice(0, 16) : "unreadable"}) and a different one (${anchor.anchor.fingerprintSha256.slice(0, 16)}) was given: rotation must be requested explicitly`), fail();
      p.out(`ANCHOR ROTATION: installed anchor ${oldFp ?? "unreadable"} will be replaced (the new fingerprint is NOT printed: type it from your enrollment record)`);
    }
  }
  if (i.rotateAnchor && !(existing && existsSync(l.anchorJson))) return gate("anchor-rotation", false, "rotateAnchor was requested but no anchor is installed"), fail();

  // 8. show the owner exactly what will be installed, then require typed confirmations
  const treeFp = envelopeFingerprint(rm.sha256);
  p.out(`INSTALL  commit ${i.commit}  PR #${i.prNumber}`);
  p.out(`         runner tree ${rm.sha256} (${rm.files.length} files)  fingerprint ${treeFp}`);
  p.out(`         proof       ${pm.sha256} (${pm.files.length} files)`);
  p.out(`         lockfile    ${lock}`);
  p.out(`         package.json ${pkg}`);
  p.out(`         anchor      (its fingerprint is deliberately NOT shown here: you type it from the record you made at enrollment)`);
  p.out(`         accounts    ${i.platformAcct} / ${i.connectedAcct}   run-as ${i.runAsAccount} (${i.runAsSid})   owner ${i.ownerAccount} (${i.ownerSid})`);
  const typedTree = await p.confirm(`Type the first group of the runner tree fingerprint (${firstGroup(treeFp)}) to install: `);
  if (!gate("owner-confirm-tree", confirmFirstGroup(typedTree, treeFp), "typed confirmation of the runner tree fingerprint")) return fail();
  if (anchorChanges) {
    const typedAnchor = await p.confirm(`Type the first 16 hex characters (64 bits) of the ${existing ? "NEW " : ""}anchor fingerprint from your enrollment record to ${existing ? "rotate" : "accept"} the approval identity: `);
    if (!gate("owner-confirm-anchor", confirmAnchorCode(typedAnchor, anchor.anchor.fingerprintSha256), "typed confirmation of the anchor fingerprint (64 bits)")) return fail();
  }

  // 9. the installer creates the root itself, owner+ACL first
  if (!existing) {
    try {
      mkdirSync(l.root);
    } catch {
      return gate("create-root", false, "the install root already exists or cannot be created (an existing root is never adopted unless it is a valid install)"), fail();
    }
    await p.acl.apply(l.root, "locked", who);
    // nothing else may exist in the root yet: a child (or junction) planted between mkdir and apply would show here, before any content is written
    const rootNow = await p.acl.readTree(l.root, true);
    const v = rootNow.flatMap((e) => entryViolations(e, "locked", who));
    const alone = rootNow.length === 1;
    if (!gate("root-owner", v.length === 0 && alone, v.length === 0 && alone ? "the new root is owned by Administrators with the locked DACL and is EMPTY before any content is written" : alone ? v.slice(0, 3).join(" | ") : `the new root already contains ${rootNow.length - 1} object(s) (planted during creation): refusing to continue`)) return fail();
  }
  for (const [dir, role] of [[l.state, "state"], [l.cred, "secret"], [l.inbox, "inbox"], [l.evidence, "evidence"]] as Array<[string, AclRole]>) {
    if (!existsSync(dir)) {
      mkdirSync(dir);
      await p.acl.apply(dir, role, who);
    }
  }
  if (!existsSync(l.tmp)) mkdirSync(l.tmp);

  // 10. stage inside the locked root, verify, then swap with rollback
  const tag = randomBytes(6).toString("hex");
  const stage = join(l.root, `staging-${tag}`);
  const rb = join(l.root, `rollback-${tag}`);
  const sl = layout(stage);
  const cleanup = () => {
    for (const d of [stage, rb]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* admin-owned scratch; the runtime gate flags anything left that is not a valid install object */
      }
    }
  };
  const abort = (id: string, detail: string): InstallResult => (gate(id, false, detail), cleanup(), fail());
  let release!: Release;
  try {
    mkdirSync(stage);
    mkdirSync(sl.release);
    copyDir(srcRunner, sl.runnerDir, NO_TESTS);
    copyDir(srcProof, sl.proofDir);
    writeFileSync(join(sl.release, "package.json"), pkgText);
    writeFileSync(join(sl.release, "package-lock.json"), lockText);
    writeFileSync(join(sl.release, "tsconfig.json"), RELEASE_TSCONFIG);
    const rmDst = runnerManifest(sl.runnerDir);
    const pmDst = manifest(sl.proofDir);
    const lockDst = fileSha256(readFileSync(join(sl.release, "package-lock.json"), "utf8"));
    const pkgDst = fileSha256(readFileSync(join(sl.release, "package.json"), "utf8"));
    if (!gate("copy-verified", rmDst.sha256 === rm.sha256 && pmDst.sha256 === pm.sha256 && lockDst === lock && pkgDst === pkg, "the staged runner, proof, package.json and lockfile hash exactly like the verified, confirmed source")) return cleanup(), fail();
    await p.installDeps(sl.release);
    const nm = rawTreeSha256(join(sl.release, "node_modules"));
    writeFileSync(sl.policyJson, policyText(pol.policy));
    const anchorText = readFileSync(i.anchorFile, "utf8");
    writeFileSync(sl.anchorJson, anchorText);
    release = {
      v: 1, commit: i.commit, prNumber: i.prNumber,
      treeSha256: rm.sha256, treeFileCount: rm.files.length,
      proofManifestSha256: pm.sha256, proofFileCount: pm.files.length,
      lockfileSha256: lock, packageJsonSha256: pkg, tsconfigSha256: fileSha256(RELEASE_TSCONFIG),
      nodeModulesSha256: nm.sha256, nodeModulesFileCount: nm.fileCount,
      policySha256: policySha256(pol.policy), anchorSha256: fileSha256(anchorText),
      installerVersion: INSTALLER_VERSION, installedAtUtc: p.now().toISOString().replace(/\.\d+Z$/, "Z"),
    };
    writeFileSync(sl.releaseJson, releaseText(release));
  } catch (e) {
    return abort("stage", `staging failed: ${String((e as Error).message).slice(0, 160)}`);
  }
  const stagedAcl = await lockedTreeGate("staged-acl", stage, true, p.acl, who);
  if (!gate(stagedAcl.id, stagedAcl.ok, stagedAcl.detail)) return cleanup(), fail();
  const stagedTree = verifyInstalledTree(sl, release);
  if (!gate("staged-tree", stagedTree.ok, stagedTree.detail)) return cleanup(), fail();

  const done: Array<[string, string]> = [];
  const undo = () => {
    for (const [from, to] of done.reverse()) {
      try {
        renameSync(to, from);
      } catch {
        /* reported by the runtime gate: a half-restored root fails closed */
      }
    }
  };
  try {
    mkdirSync(rb);
    for (const name of SWAP) {
      const live = join(l.root, name);
      if (existsSync(live)) {
        renameSync(live, join(rb, name));
        done.push([live, join(rb, name)]);
      }
      renameSync(join(stage, name), live);
      done.push([join(stage, name), live]);
    }
  } catch (e) {
    undo();
    return abort("swap", `swap failed and was rolled back: ${String((e as Error).message).slice(0, 120)}`);
  }

  // 11. read everything back; any mismatch restores the previous install
  const ag = await aclGate(l, p.acl, who);
  const tg = verifyInstalledTree(l, release);
  const back = (() => {
    try {
      return parseRelease(readJson(l.releaseJson));
    } catch {
      return { ok: false as const, problem: "release.json unreadable" };
    }
  })();
  const good = ag.ok && tg.ok && back.ok;
  gate(ag.id, ag.ok, ag.detail);
  gate(tg.id, tg.ok, tg.detail);
  gate("release-record", back.ok, back.ok ? "release.json written and re-read" : back.problem);
  if (!good) {
    undo();
    cleanup();
    gate("install-complete", false, "INSTALL FAILED AND ROLLED BACK: the read-back of the installed root did not match; the previous install (if any) was restored");
    return fail();
  }
  cleanup();
  gate("install-complete", true, `installed commit ${i.commit.slice(0, 12)} (PR #${i.prNumber})${existing && anchorChanges ? ", anchor rotated" : ""}`);
  return { ok: true, gates, release };
}
