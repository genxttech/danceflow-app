// ELEVATED-ONLY installer logic. It is the only code that writes the install root, so it is the only way to change the release tree, the policy
// ceilings or the approval anchor. Every side effect goes through an injected provider so the whole flow is tested on throwaway temp directories;
// the real providers (installedcli.ts) are never exercised by tests and nothing here creates accounts, scheduled tasks or credentials.
//
// Order is deliberate: elevation -> inputs -> release verification (commit-on-main + pinned blobs) -> display -> typed confirmation -> write ->
// ACLs -> re-read the ACLs and the tree. Any failure before the write leaves the root untouched.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { manifest } from "../d24-m3d-proof/manifest";
import { confirmFirstGroup, envelopeFingerprint, firstGroup } from "./fingerprint";
import { lockfileSha } from "./gitverify";
import { aclGate, fileSha256, INSTALLER_VERSION, layout, PROOF_REL, readJson, releaseText, RUNNER_REL, verifyInstalledTree, parseRelease, type AclApplier, type Gate, type Layout, type Release, type Who } from "./installroot";
import { parsePolicy, policySha256, policyText, proofHardCap, proofMaxLineCents, type Policy } from "./policy";
import { runnerManifest } from "./runnerpin";
import { loadAnchor } from "./webauthn";

export type Pin = { rel: string; sha256: string };
export type InstallInputs = {
  root: string;
  /** the verified clean clone the release is copied from */
  sourceRepo: string;
  commit: string;
  prNumber: number;
  platformAcct: string;
  connectedAcct: string;
  /** the enrolled hardware anchor file to install (owner enrollment output) */
  anchorFile: string;
  ownerAccount: string;
  runAsAccount: string;
  ceilings?: Partial<Pick<Policy, "maxRunsPerEnvelope" | "maxEnvelopeValidityDays" | "maxRunsPerDay" | "amountCeilingMinor" | "maxCallsPerRun">>;
  /** an installed anchor with a different fingerprint is replaced only when this is true AND the owner types the new fingerprint's first group */
  rotateAnchor?: boolean;
};
export type InstallProviders = {
  isElevated(): boolean;
  /** commit-on-main (SHA-1-verified objects, pinned repo) AND the pinned blobs AND a clean checkout at `commit`. The real one wraps gitverify. */
  verifyRelease(o: { repoDir: string; commit: string; pins: Pin[] }): Promise<Gate[]>;
  acl: AclApplier;
  /** prints the question and returns what the owner typed */
  confirm(question: string): Promise<string>;
  /** `npm ci --ignore-scripts` inside the release dir (the elevated, one-time dependency install) */
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

export async function install(i: InstallInputs, p: InstallProviders): Promise<InstallResult> {
  const gates: Gate[] = [];
  const gate = mk(gates, p.out);
  const fail = (): InstallResult => ({ ok: false, gates });
  const l: Layout = layout(i.root);
  const who: Who = { runAs: i.runAsAccount, owner: i.ownerAccount };

  // 1. elevation first: nothing below runs for a non-elevated caller
  if (!gate("elevated", p.isElevated(), p.isElevated() ? "running elevated" : "the installer must run elevated (an agent running as the owner's user cannot write the install root)")) return fail();

  // 2. inputs
  if (!/^[0-9a-f]{40}$/.test(i.commit) || !Number.isInteger(i.prNumber) || i.prNumber <= 0) return gate("inputs", false, "commit must be a full 40-hex id and prNumber a positive integer"), fail();
  const srcRunner = join(i.sourceRepo, ...RUNNER_REL.split("/"));
  const srcProof = join(i.sourceRepo, ...PROOF_REL.split("/"));
  const srcLock = join(i.sourceRepo, "package-lock.json");
  const srcPkg = join(i.sourceRepo, "package.json");
  for (const f of [srcRunner, srcProof, srcLock, srcPkg]) if (!existsSync(f)) return gate("inputs", false, `release source is missing ${relative(i.sourceRepo, f)}`), fail();
  const anchor = loadAnchor(i.anchorFile);
  if (anchor === null || !anchor.ok) return gate("anchor-file", false, anchor === null ? "no anchor file at the given path" : `anchor invalid: ${anchor.problems.join("; ")}`), fail();
  gate("anchor-file", true, `anchor ${anchor.anchor.fingerprintSha256.slice(0, 16)} parsed`);

  // 3. what is about to be installed, hashed from the source tree now
  const rm = runnerManifest(srcRunner);
  const pm = manifest(srcProof);
  const lock = lockfileSha(readFileSync(srcLock));
  const maxCap = proofHardCap(srcProof);
  const maxLine = proofMaxLineCents(srcProof);
  if (maxCap === null || maxLine === null) return gate("proof-constants", false, "could not read HARD_CALL_CAP / maxLineCents from the release source's proof"), fail();
  const pins: Pin[] = [...rm.files.map((f) => ({ rel: `${RUNNER_REL}/${f.path}`, sha256: f.sha256 })), ...pm.files.map((f) => ({ rel: `${PROOF_REL}/${f.path}`, sha256: f.sha256 }))];

  // 4. the release must be the merge commit of an owner-approved PR on main: verified, not claimed
  const rel = await p.verifyRelease({ repoDir: i.sourceRepo, commit: i.commit, pins });
  for (const g of rel) gate(g.id, g.ok, g.detail);
  if (rel.length === 0 || rel.some((g) => !g.ok)) return gate("release-verified", false, "the source tree is not proven to be the merge commit on main: nothing was written"), fail();

  // 5. policy from the elevated caller's inputs (strictly validated against the proof's own cap)
  const polRaw: Policy = {
    v: 1,
    stripeMode: "test",
    keyKind: "rk_test",
    credentialStore: "dpapi-file",
    platformAcct: i.platformAcct,
    connectedAcct: i.connectedAcct,
    maxCallsPerRun: i.ceilings?.maxCallsPerRun ?? maxCap,
    maxRunsPerEnvelope: i.ceilings?.maxRunsPerEnvelope ?? 2,
    maxEnvelopeValidityDays: i.ceilings?.maxEnvelopeValidityDays ?? 7,
    maxRunsPerDay: i.ceilings?.maxRunsPerDay ?? 2,
    allowListSha256: pm.sha256,
    amountCeilingMinor: i.ceilings?.amountCeilingMinor ?? maxLine,
    anchorFingerprint: anchor.anchor.fingerprintSha256,
    runAsAccount: i.runAsAccount,
    ownerAccount: i.ownerAccount,
  };
  const pol = parsePolicy(polRaw, maxCap);
  if (!pol.ok) return gate("policy", false, pol.problems.join(" | ")), fail();
  if (maxLine > pol.policy.amountCeilingMinor) return gate("policy", false, `the proof's per-invoice cap ${maxLine} is above the amount ceiling ${pol.policy.amountCeilingMinor}`), fail();
  gate("policy", true, `ceilings: ${pol.policy.maxCallsPerRun} calls, ${pol.policy.maxRunsPerEnvelope} runs/envelope, ${pol.policy.maxEnvelopeValidityDays} days, ${pol.policy.maxRunsPerDay}/day, amount ${pol.policy.amountCeilingMinor}`);

  // 6. anchor rotation rule: an installed anchor is replaced only through this path, on explicit request, with a typed new fingerprint
  let rotating = false;
  if (existsSync(l.anchorJson)) {
    const old = loadAnchor(l.anchorJson);
    const oldFp = old && old.ok ? old.anchor.fingerprintSha256 : null;
    if (oldFp !== anchor.anchor.fingerprintSha256) {
      if (!i.rotateAnchor) return gate("anchor-rotation", false, `an anchor is already installed (${oldFp ? oldFp.slice(0, 16) : "unreadable"}) and a different one (${anchor.anchor.fingerprintSha256.slice(0, 16)}) was given: rotation must be requested explicitly`), fail();
      rotating = true;
      p.out(`ANCHOR ROTATION: old ${oldFp ?? "unreadable"}`);
      p.out(`                 new ${anchor.anchor.fingerprintSha256}`);
    }
  } else if (i.rotateAnchor) return gate("anchor-rotation", false, "rotateAnchor was requested but no anchor is installed"), fail();

  // 7. show the owner exactly what will be installed, then require typed confirmation
  const treeFp = envelopeFingerprint(rm.sha256);
  p.out(`INSTALL  commit ${i.commit}  PR #${i.prNumber}`);
  p.out(`         runner tree ${rm.sha256} (${rm.files.length} files)  fingerprint ${treeFp}`);
  p.out(`         proof       ${pm.sha256} (${pm.files.length} files)`);
  p.out(`         lockfile    ${lock}`);
  p.out(`         anchor      ${anchor.anchor.fingerprintSha256}`);
  p.out(`         accounts    ${i.platformAcct} / ${i.connectedAcct}`);
  const typedTree = await p.confirm(`Type the first group of the runner tree fingerprint (${firstGroup(treeFp)}) to install: `);
  if (!gate("owner-confirm-tree", confirmFirstGroup(typedTree, treeFp), "typed confirmation of the runner tree fingerprint")) return fail();
  if (rotating) {
    const afp = envelopeFingerprint(anchor.anchor.fingerprintSha256);
    const typedAnchor = await p.confirm(`Type the first group of the NEW anchor fingerprint (${firstGroup(afp)}) to rotate the approval identity: `);
    if (!gate("owner-confirm-anchor", confirmFirstGroup(typedAnchor, afp), "typed confirmation of the new anchor fingerprint")) return fail();
  }

  // 8. write
  mkdirSync(l.root, { recursive: true });
  if (existsSync(l.release)) rmSync(l.release, { recursive: true, force: true });
  for (const d of [l.release, l.state, l.cred, l.inbox, l.evidence]) mkdirSync(d, { recursive: true });
  copyDir(srcRunner, l.runnerDir, NO_TESTS);
  copyDir(srcProof, l.proofDir);
  copyFileSync(srcLock, join(l.release, "package-lock.json"));
  copyFileSync(srcPkg, join(l.release, "package.json"));
  const rmDst = runnerManifest(l.runnerDir);
  const pmDst = manifest(l.proofDir);
  if (!gate("copy-verified", rmDst.sha256 === rm.sha256 && pmDst.sha256 === pm.sha256, "the copied runner and proof folders hash exactly like the verified source")) return fail();
  await p.installDeps(l.release);

  writeFileSync(l.policyJson, policyText(pol.policy));
  const anchorText = readFileSync(i.anchorFile, "utf8");
  writeFileSync(l.anchorJson, anchorText);
  const release: Release = {
    v: 1,
    commit: i.commit,
    prNumber: i.prNumber,
    treeSha256: rm.sha256,
    treeFileCount: rm.files.length,
    proofManifestSha256: pm.sha256,
    proofFileCount: pm.files.length,
    lockfileSha256: lock,
    policySha256: policySha256(pol.policy),
    anchorSha256: fileSha256(anchorText),
    installerVersion: INSTALLER_VERSION,
    installedAtUtc: p.now().toISOString().replace(/\.\d+Z$/, "Z"),
  };
  writeFileSync(l.releaseJson, releaseText(release));

  // 9. ACLs: root first (inherited by the locked children), then the four special directories, then re-read EVERYTHING
  await p.acl.apply(l.root, "locked", who);
  await p.acl.apply(l.state, "state", who);
  await p.acl.apply(l.cred, "secret", who);
  await p.acl.apply(l.inbox, "inbox", who);
  await p.acl.apply(l.evidence, "evidence", who);
  const ag = await aclGate(l, p.acl, who);
  if (!gate(ag.id, ag.ok, ag.detail)) return gate("install-complete", false, "INSTALL INCOMPLETE AND NOT SAFE: the ACLs read back do not match their roles; do not use this root"), fail();
  const tg = verifyInstalledTree(l, release);
  if (!gate(tg.id, tg.ok, tg.detail)) return fail();
  const back = parseRelease(readJson(l.releaseJson));
  if (!gate("release-record", back.ok, back.ok ? "release.json written and re-read" : back.problem)) return fail();
  gate("install-complete", true, `installed commit ${i.commit.slice(0, 12)} (PR #${i.prNumber})${rotating ? ", anchor rotated" : ""}`);
  return { ok: true, gates, release };
}
