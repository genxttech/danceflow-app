// The admin-owned install root (see docs/billing/D24-TEST-RUNNER-TRUST-ANCHOR.md). Everything that decides whether a live run may happen lives under
// INSTALL_ROOT, a CONSTANT here (never read from an environment variable, argument or config). This module is pure apart from the injected providers.
//
// ACL model (review of PR 423): protection is judged from SDDL (owner SID + DACL with trustee SIDs and access masks) of EVERY directory and file under
// the root, never from names and never from the DACL alone. The owner of an object holds WRITE_DAC implicitly, so an object owned by anyone but
// Administrators/SYSTEM (or, for the data directories, the run-as account) is a violation whatever its DACL says. Anything not understood fails closed.
//
// What it can prove offline: the parsing and decision rules on crafted/captured SDDL. What it cannot: that the real OS enforces them against a
// non-admin process, and the real SDDL of a real install (Windows test plan).

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { manifest } from "../d24-m3d-proof/manifest";
import { canonicalJson } from "./canon";
import { runnerManifest } from "./runnerpin";
import { verifiedInstalledSet } from "./installmint";

export const INSTALL_ROOT = String.raw`C:\ProgramData\d24-runner`;
/** the only node binary a live run may execute under (admin-writable only); checked by execinbox, not taken from PATH */
export const ADMIN_NODE = String.raw`C:\Program Files\nodejs\node.exe`;
export const RUN_AS_ACCOUNT = "d24run";
export const INSTALLER_VERSION = 2;
export const RUNNER_REL = "scripts/qa/d24-test-runner";
export const PROOF_REL = "scripts/qa/d24-m3d-proof";
/** installer-written constant: stops tsx from walking up to a user-creatable C:\ProgramData\tsconfig.json or C:\tsconfig.json */
export const RELEASE_TSCONFIG = `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true } }, null, 2)}\n`;

export type Layout = ReturnType<typeof layout>;
export const layout = (root: string) => ({
  root,
  release: join(root, "release"),
  releaseJson: join(root, "release.json"),
  policyJson: join(root, "policy.json"),
  anchorJson: join(root, "anchor.json"),
  state: join(root, "state"),
  tmp: join(root, "state", "tmp"),
  cred: join(root, "cred"),
  inbox: join(root, "inbox"),
  evidence: join(root, "evidence"),
  runnerDir: join(root, "release", ...RUNNER_REL.split("/")),
  proofDir: join(root, "release", ...PROOF_REL.split("/")),
});

export type Gate = { id: string; ok: boolean; detail: string };

// ---------------------------------------------------------------- hashing
export const fileSha256 = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
export const jsonSha256 = (v: unknown) => createHash("sha256").update(canonicalJson(v)).digest("hex");

/** Raw-byte hash of a whole directory tree (sorted relative paths; no line-ending normalisation; a link or special file is an error). */
export function rawTreeSha256(dir: string): { sha256: string; fileCount: number } {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`link in hashed tree: ${relative(dir, p)}`);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) files.push(p);
      else throw new Error(`special file in hashed tree: ${relative(dir, p)}`);
    }
  };
  walk(dir);
  const roll = createHash("sha256");
  for (const f of files) roll.update(`${relative(dir, f).split(sep).join("/")}\0${createHash("sha256").update(readFileSync(f)).digest("hex")}\n`);
  return { sha256: roll.digest("hex"), fileCount: files.length };
}

// ---------------------------------------------------------------- release record
export type Release = {
  v: 1;
  commit: string;
  prNumber: number;
  /** runnerManifest(release/scripts/qa/d24-test-runner).sha256 */
  treeSha256: string;
  treeFileCount: number;
  proofManifestSha256: string;
  proofFileCount: number;
  lockfileSha256: string;
  packageJsonSha256: string;
  tsconfigSha256: string;
  /** raw-byte hash of release/node_modules (installed by the elevated, scrubbed `npm ci --ignore-scripts`) */
  nodeModulesSha256: string;
  nodeModulesFileCount: number;
  policySha256: string;
  anchorSha256: string;
  installerVersion: number;
  installedAtUtc: string;
};
const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);
const RELEASE_KEYS = ["v", "commit", "prNumber", "treeSha256", "treeFileCount", "proofManifestSha256", "proofFileCount", "lockfileSha256", "packageJsonSha256", "tsconfigSha256", "nodeModulesSha256", "nodeModulesFileCount", "policySha256", "anchorSha256", "installerVersion", "installedAtUtc"];
export function parseRelease(raw: unknown): { ok: true; release: Release } | { ok: false; problem: string } {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, problem: "release.json is not an object" };
  if (Object.keys(r).length !== RELEASE_KEYS.length || !RELEASE_KEYS.every((k) => k in r)) return { ok: false, problem: "release.json has missing or unknown fields" };
  const sha = (k: string) => typeof r[k] === "string" && HEX(64).test(r[k] as string);
  const int = (k: string) => Number.isInteger(r[k]) && (r[k] as number) > 0;
  const bad =
    r.v !== 1 || typeof r.commit !== "string" || !HEX(40).test(r.commit) || !int("prNumber") || !sha("treeSha256") || !int("treeFileCount") || !sha("proofManifestSha256") || !int("proofFileCount") || !sha("lockfileSha256") || !sha("packageJsonSha256") || !sha("tsconfigSha256") || !sha("nodeModulesSha256") || !int("nodeModulesFileCount") || !sha("policySha256") || !sha("anchorSha256") || r.installerVersion !== INSTALLER_VERSION || typeof r.installedAtUtc !== "string" || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(r.installedAtUtc);
  return bad ? { ok: false, problem: "release.json has an invalid field" } : { ok: true, release: r as unknown as Release };
}
export const releaseText = (r: Release) => `${JSON.stringify(r, null, 2)}\n`;

/** Re-hashes everything the release record pins, from disk: runner + proof folders, lockfile, package.json, tsconfig.json, node_modules. */
export function verifyInstalledTree(l: Layout, rel: Release): Gate {
  try {
    const rm = runnerManifest(l.runnerDir);
    const pm = manifest(l.proofDir);
    const lock = fileSha256(readFileSync(join(l.release, "package-lock.json"), "utf8"));
    const pkg = fileSha256(readFileSync(join(l.release, "package.json"), "utf8"));
    const ts = fileSha256(readFileSync(join(l.release, "tsconfig.json"), "utf8"));
    const nm = rawTreeSha256(join(l.release, "node_modules"));
    const parts: string[] = [];
    if (rm.sha256 !== rel.treeSha256 || rm.files.length !== rel.treeFileCount) parts.push("runner folder");
    if (pm.sha256 !== rel.proofManifestSha256 || pm.files.length !== rel.proofFileCount) parts.push("proof folder");
    if (lock !== rel.lockfileSha256) parts.push("package-lock.json");
    if (pkg !== rel.packageJsonSha256) parts.push("package.json");
    if (ts !== rel.tsconfigSha256 || ts !== fileSha256(RELEASE_TSCONFIG)) parts.push("tsconfig.json");
    if (nm.sha256 !== rel.nodeModulesSha256 || nm.fileCount !== rel.nodeModulesFileCount) parts.push("node_modules");
    return parts.length === 0 ? { id: "tree-hash", ok: true, detail: `installed runner ${rm.sha256.slice(0, 12)} (${rm.files.length} files), proof ${pm.sha256.slice(0, 12)}, lockfile, package.json, tsconfig and node_modules (${nm.fileCount} files) equal the release record` } : { id: "tree-hash", ok: false, detail: `installed tree differs from release.json: ${parts.join(", ")}` };
  } catch {
    return { id: "tree-hash", ok: false, detail: "the installed tree could not be read and hashed" };
  }
}

// ---------------------------------------------------------------- SDDL model
export const SID_ADMINS = "S-1-5-32-544";
export const SID_SYSTEM = "S-1-5-18";
export type Who = { runAsSid: string; ownerSid: string };
export type AclRole = "locked" | "state" | "secret" | "inbox" | "evidence";
export type TreeEntry = { path: string; kind: "dir" | "file" | "link"; /** `GetSecurityDescriptorSddlForm('Owner,Access')` */ sddl: string };
/** Reads owner+DACL SDDL for a path (and, with recurse, EVERY directory and file below it, links reported as kind "link"). One call, not one per file. */
export interface AclReader {
  readTree(path: string, recurse: boolean): Promise<TreeEntry[]>;
}
export interface AclApplier extends AclReader {
  /** sets the OWNER to Administrators and the DACL for the role (inheritance removed) on the path and everything below it */
  apply(path: string, role: AclRole, who: Who): Promise<void>;
}

const ALIAS_SID: Record<string, string> = { BA: SID_ADMINS, SY: SID_SYSTEM, BU: "S-1-5-32-545", BG: "S-1-5-32-546", PU: "S-1-5-32-547", WD: "S-1-1-0", AU: "S-1-5-11", CO: "S-1-3-0", OW: "S-1-3-4", IU: "S-1-5-4", NU: "S-1-5-2", LS: "S-1-5-19", NS: "S-1-5-20", AN: "S-1-5-7", AC: "S-1-15-2-1", SU: "S-1-5-6" };
const RIGHT_ALIAS: Record<string, number> = { GA: 0x10000000, GR: 0x80000000, GW: 0x40000000, GX: 0x20000000, FA: 0x1f01ff, FR: 0x120089, FW: 0x120116, FX: 0x1200a0, SD: 0x10000, RC: 0x20000, WD: 0x40000, WO: 0x80000 };
const WRITE_BITS = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
const READ_BITS = 0x1 | 0x8 | 0x20 | 0x80 | 0x20000 | 0x100000 | 0x20000000 | 0x80000000;
const CREATE_BITS = 0x2 | 0x4;

export type Ace = { type: "A" | "D"; mask: number; sid: string };
const sidOf = (t: string) => ALIAS_SID[t] ?? t;
function maskOf(s: string): number | null {
  if (/^0x[0-9a-fA-F]{1,8}$/.test(s)) return Number.parseInt(s, 16) >>> 0;
  if (/^\d{1,10}$/.test(s)) return Number(s) >>> 0;
  if (s.length === 0 || s.length % 2 !== 0) return null;
  let m = 0;
  for (let i = 0; i < s.length; i += 2) {
    const v = RIGHT_ALIAS[s.slice(i, i + 2)];
    if (v === undefined) return null;
    m |= v;
  }
  return m >>> 0;
}
/** Strict SDDL parser: any ACE type, field or token it does not understand returns null (the caller fails closed). A missing DACL (everyone full control) is null too. */
export function parseSddl(sddl: string): { owner: string; aces: Ace[] } | null {
  const m = /^O:(S-[\d-]+|[A-Z]{2})(?:G:(?:S-[\d-]+|[A-Z]{2}))?D:([A-Z]*)((?:\([^()]*\))*)$/.exec(sddl.trim());
  if (!m) return null;
  const aces: Ace[] = [];
  for (const a of m[3].matchAll(/\(([^()]*)\)/g)) {
    const f = a[1].split(";");
    if (f.length !== 6 || (f[0] !== "A" && f[0] !== "D") || f[4] !== "" || f[3] !== "" || !/^(?:OI|CI|IO|NP|ID|SA|FA)*$/.test(f[1])) return null;
    const mask = maskOf(f[2]);
    if (mask === null || !/^(S-[\d-]+|[A-Z]{2})$/.test(f[5])) return null;
    aces.push({ type: f[0], mask, sid: sidOf(f[5]) });
  }
  return { owner: sidOf(m[1]), aces };
}

const ADMINISH = new Set([SID_ADMINS, SID_SYSTEM]);
/** Every reason this one object is not acceptable for `role`. Empty = acceptable. DENY ACEs are ignored (a grant a deny cancels is still reported). */
export function entryViolations(e: TreeEntry, role: AclRole, who: Who): string[] {
  const out: string[] = [];
  if (e.kind === "link") return [`${e.path}: is a link or reparse point`];
  const p = parseSddl(e.sddl);
  if (!p) return [`${e.path}: security descriptor not understood or has no DACL (fail closed)`];
  const owners = new Set<string>([...ADMINISH, ...(role === "locked" ? [] : [who.runAsSid]), ...(role === "inbox" ? [who.ownerSid] : [])]);
  if (!owners.has(p.owner)) out.push(`${e.path}: owned by ${p.owner} (an object's owner can rewrite its permissions; only ${[...owners].join(", ")} may own it)`);
  const writers = new Set<string>([...ADMINISH, ...(role === "state" || role === "evidence" ? [who.runAsSid] : [])]);
  for (const a of p.aces) {
    if (a.type !== "A") continue;
    if (role === "secret") {
      if (![...ADMINISH, who.runAsSid].includes(a.sid)) out.push(`${e.path}: ${a.sid} holds access mask 0x${a.mask.toString(16)} on the credential area (only ${who.runAsSid} may)`);
      continue;
    }
    if (role === "inbox" && a.sid === who.ownerSid) {
      const extra = a.mask & ~(READ_BITS | CREATE_BITS) & WRITE_BITS;
      if (extra !== 0) out.push(`${e.path}: owner has more than create rights on the inbox (0x${extra.toString(16)})`);
      continue;
    }
    if ((a.mask & WRITE_BITS) !== 0 && !writers.has(a.sid)) out.push(`${e.path}: ${a.sid} holds write-class access 0x${(a.mask & WRITE_BITS).toString(16)}`);
  }
  if (role !== "secret" && !p.aces.some((a) => a.type === "A" && ADMINISH.has(a.sid) && (a.mask & 0x1f01ff) === 0x1f01ff)) out.push(`${e.path}: no full-control entry for Administrators/SYSTEM (descriptor not as installed)`);
  return out;
}

/** Role of a path inside the root: by its first segment under the root. */
export function roleOfPath(l: Layout, path: string): AclRole {
  const rel = relative(l.root, path).split(sep)[0];
  return rel === "state" ? "state" : rel === "cred" ? "secret" : rel === "inbox" ? "inbox" : rel === "evidence" ? "evidence" : "locked";
}

export async function aclGate(l: Layout, reader: AclReader, who: Who): Promise<Gate> {
  let entries: TreeEntry[];
  try {
    entries = await reader.readTree(l.root, true);
  } catch {
    return { id: "install-root-acl", ok: false, detail: "the security descriptors under the install root could not be read" };
  }
  const norm = (p: string) => resolve(p).toLowerCase();
  const have = new Set(entries.map((e) => norm(e.path)));
  const problems: string[] = [];
  for (const e of entries) problems.push(...entryViolations(e, roleOfPath(l, e.path), who));
  for (const need of [l.root, l.release, l.releaseJson, l.policyJson, l.anchorJson, l.state, l.cred, l.inbox, l.evidence]) if (!have.has(norm(need))) problems.push(`${need}: missing from the security-descriptor listing`);
  return { id: "install-root-acl", ok: problems.length === 0, detail: problems.length === 0 ? `owner and DACL of ${entries.length} directories and files under the root match their roles` : `${problems.length} problem(s): ${problems.slice(0, 5).join(" | ")}` };
}

/** Owner/DACL check of an arbitrary tree or single file that must be administrator-only (the elevated installer's source clone, node.exe). */
export async function lockedTreeGate(id: string, path: string, recurse: boolean, reader: AclReader, who: Who): Promise<Gate> {
  let entries: TreeEntry[];
  try {
    entries = await reader.readTree(path, recurse);
  } catch {
    return { id, ok: false, detail: `${path}: security descriptors could not be read` };
  }
  if (entries.length === 0) return { id, ok: false, detail: `${path}: nothing was listed` };
  const problems = entries.flatMap((e) => entryViolations(e, "locked", who));
  return { id, ok: problems.length === 0, detail: problems.length === 0 ? `${entries.length} object(s) under ${path} are administrator-owned and not writable by anyone else` : `${problems.length} problem(s): ${problems.slice(0, 4).join(" | ")}` };
}

const norm = (p: string) => resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** The root is the real path (no junction/symlink anywhere on it) and the RUNNING code lives inside <root>/release. */
export function rootPathGate(l: Layout, runningFile: string, realpath: (p: string) => string = realpathSync, isLink: (p: string) => boolean = (p) => lstatSync(p).isSymbolicLink()): Gate {
  try {
    if (!existsSync(l.root)) return { id: "install-root", ok: false, detail: "the install root does not exist" };
    const real = norm(realpath(l.root));
    if (real !== norm(l.root)) return { id: "install-root", ok: false, detail: "the install root path resolves elsewhere (junction or symlink)" };
    for (const p of [l.root, l.release, l.state, l.cred, l.inbox, l.evidence]) if (isLink(p)) return { id: "install-root", ok: false, detail: `${p} is a link` };
    const code = norm(realpath(runningFile));
    const ok = code.startsWith(`${norm(l.release)}/`);
    return { id: "install-root", ok, detail: ok ? "the running code is inside the real install root" : "the running code is NOT inside <install root>/release (a copy elsewhere cannot run live)" };
  } catch {
    return { id: "install-root", ok: false, detail: "the install root could not be resolved" };
  }
}

export const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

// ---------------------------------------------------------------- the verified-install brand (minted only by execinbox via installmint.ts)
export type InstalledRun = {
  layout: Layout;
  release: Release;
  anchorPath: string;
  statePath: string;
  ledgerDir: string;
  ledgerAnchorFile: string;
  /** re-verifies the installed tree from disk (used again just before the key is released) */
  verifyTree: () => Gate;
};
export const isVerifiedInstalled = (i: unknown): i is InstalledRun => typeof i === "object" && i !== null && verifiedInstalledSet.has(i);
