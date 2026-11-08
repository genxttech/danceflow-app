// The admin-owned install root (see docs/billing/D24-TEST-RUNNER-TRUST-ANCHOR.md). Everything that decides whether a live run may happen lives under
// INSTALL_ROOT, a CONSTANT here (never read from an environment variable, argument or config). This module is pure apart from the injected providers:
// it parses `icacls` output, evaluates it against a per-directory role (fail closed), and verifies the installed tree against the release record.
//
// What it can prove offline: the parsing and the decision rules, with captured/crafted icacls text. What it cannot: that the real OS enforces those
// ACLs against a non-admin process (Windows test plan T7/T8/T13).

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { manifest } from "../d24-m3d-proof/manifest";
import { canonicalJson } from "./canon";
import { runnerManifest } from "./runnerpin";

export const INSTALL_ROOT = String.raw`C:\ProgramData\d24-runner`;
export const RUN_AS_ACCOUNT = "d24run";
export const INSTALLER_VERSION = 1;
export const RUNNER_REL = "scripts/qa/d24-test-runner";
export const PROOF_REL = "scripts/qa/d24-m3d-proof";

export type Layout = ReturnType<typeof layout>;
export const layout = (root: string) => ({
  root,
  release: join(root, "release"),
  releaseJson: join(root, "release.json"),
  policyJson: join(root, "policy.json"),
  anchorJson: join(root, "anchor.json"),
  state: join(root, "state"),
  cred: join(root, "cred"),
  inbox: join(root, "inbox"),
  evidence: join(root, "evidence"),
  runnerDir: join(root, "release", ...RUNNER_REL.split("/")),
  proofDir: join(root, "release", ...PROOF_REL.split("/")),
});

export type Gate = { id: string; ok: boolean; detail: string };

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
  policySha256: string;
  anchorSha256: string;
  installerVersion: number;
  installedAtUtc: string;
};
const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);
export function parseRelease(raw: unknown): { ok: true; release: Release } | { ok: false; problem: string } {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, problem: "release.json is not an object" };
  const keys = ["v", "commit", "prNumber", "treeSha256", "treeFileCount", "proofManifestSha256", "proofFileCount", "lockfileSha256", "policySha256", "anchorSha256", "installerVersion", "installedAtUtc"];
  if (Object.keys(r).length !== keys.length || !keys.every((k) => k in r)) return { ok: false, problem: "release.json has missing or unknown fields" };
  const sha = (k: string) => typeof r[k] === "string" && HEX(64).test(r[k] as string);
  const int = (k: string) => Number.isInteger(r[k]) && (r[k] as number) > 0;
  const bad =
    r.v !== 1 || typeof r.commit !== "string" || !HEX(40).test(r.commit) || !int("prNumber") || !sha("treeSha256") || !int("treeFileCount") || !sha("proofManifestSha256") || !int("proofFileCount") || !sha("lockfileSha256") || !sha("policySha256") || !sha("anchorSha256") || r.installerVersion !== INSTALLER_VERSION || typeof r.installedAtUtc !== "string" || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(r.installedAtUtc);
  return bad ? { ok: false, problem: "release.json has an invalid field" } : { ok: true, release: r as unknown as Release };
}
export const releaseText = (r: Release) => `${JSON.stringify(r, null, 2)}\n`;

/** CRLF-normalised sha256 of a file's text (the same normalisation as the folder manifests). */
export const fileSha256 = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
export const jsonSha256 = (v: unknown) => createHash("sha256").update(canonicalJson(v)).digest("hex");

/** Re-hashes the installed runner + proof folders from disk and compares them with the release record. */
export function verifyInstalledTree(l: Layout, rel: Release): Gate {
  try {
    const rm = runnerManifest(l.runnerDir);
    const pm = manifest(l.proofDir);
    const ok = rm.sha256 === rel.treeSha256 && rm.files.length === rel.treeFileCount && pm.sha256 === rel.proofManifestSha256 && pm.files.length === rel.proofFileCount;
    return { id: "tree-hash", ok, detail: ok ? `installed runner ${rm.sha256.slice(0, 12)} (${rm.files.length} files) and proof ${pm.sha256.slice(0, 12)} (${pm.files.length} files) equal the release record` : `installed tree differs from release.json (runner ${rm.sha256.slice(0, 12)} vs ${rel.treeSha256.slice(0, 12)}, proof ${pm.sha256.slice(0, 12)} vs ${rel.proofManifestSha256.slice(0, 12)})` };
  } catch {
    return { id: "tree-hash", ok: false, detail: "the installed tree could not be read and hashed" };
  }
}

// ---------------------------------------------------------------- ACL parsing and rules
export type AclEntry = { principal: string; rights: string[]; deny: boolean };
/** Reads the ACL text (icacls output) of one path. The real provider spawns icacls by absolute path; tests inject text. */
export interface AclReader {
  read(path: string): Promise<string>;
}
/** Applies the install-time ACLs. Used only by the elevated installer. */
export interface AclApplier extends AclReader {
  apply(path: string, role: AclRole, who: Who): Promise<void>;
}
export type Who = { runAs: string; owner: string };
export type AclRole = "locked" | "state" | "secret" | "inbox" | "evidence";

const FLAGS = new Set(["I", "OI", "CI", "IO", "NP"]);
/** Parses `icacls <path>` output. Returns null when no entry can be read (the caller fails closed). */
export function parseIcacls(output: string, path: string): AclEntry[] | null {
  const out: AclEntry[] = [];
  for (const raw of output.split(/\r?\n/)) {
    let line = raw.trim();
    if (/^successfully processed/i.test(line)) continue;
    if (line.toLowerCase().startsWith(path.toLowerCase())) line = line.slice(path.length).trim();
    const at = line.indexOf(":(");
    if (at <= 0) continue;
    const principal = line.slice(0, at).trim();
    const groups = [...line.slice(at).matchAll(/\(([A-Za-z0-9,]+)\)/g)].map((m) => m[1]);
    const deny = groups.includes("DENY");
    const rights = groups.flatMap((g) => g.split(",")).filter((t) => t !== "DENY" && !FLAGS.has(t));
    if (rights.length === 0) continue;
    out.push({ principal, rights, deny });
  }
  return out.length > 0 ? out : null;
}

const WRITE = new Set(["F", "M", "W", "D", "DE", "WD", "AD", "WA", "WEA", "DC", "WDAC", "WO", "GA", "GW", "MA"]);
const CREATE_ONLY_OK = new Set(["WD", "AD"]);
const short = (p: string) => (p.split("\\").pop() ?? p).toLowerCase();
const isAdminish = (p: string) => ["administrators", "system"].includes(short(p));

/** Every reason the entries are not acceptable for `role`. Empty = acceptable. Deny entries are ignored (a grant that a deny cancels is still reported). */
export function aclViolations(entries: AclEntry[], role: AclRole, who: Who): string[] {
  const out: string[] = [];
  const runAs = who.runAs.toLowerCase();
  const owner = who.owner.toLowerCase();
  for (const e of entries) {
    if (e.deny) continue;
    const p = short(e.principal);
    const writes = e.rights.filter((t) => WRITE.has(t));
    const name = e.principal;
    if (isAdminish(e.principal)) continue;
    if (role === "locked" && writes.length > 0) out.push(`${name} has write-class right(s) ${writes.join(",")} on a locked path`);
    if ((role === "state" || role === "evidence") && writes.length > 0 && p !== runAs) out.push(`${name} has write-class right(s) ${writes.join(",")} (only ${who.runAs} may write here)`);
    if (role === "secret" && p !== runAs) out.push(`${name} has any right (${e.rights.join(",")}) on the credential directory (only ${who.runAs} may read it)`);
    if (role === "inbox") {
      if (p === owner) {
        const extra = writes.filter((t) => !CREATE_ONLY_OK.has(t));
        if (extra.length > 0) out.push(`${name} has more than create rights (${extra.join(",")}) on the inbox`);
      } else if (writes.length > 0) out.push(`${name} has write-class right(s) ${writes.join(",")} on the inbox`);
    }
  }
  return out;
}

/** The role of each protected path. */
export function roles(l: Layout): Array<{ path: string; role: AclRole }> {
  return [
    { path: l.root, role: "locked" },
    { path: l.release, role: "locked" },
    { path: join(l.root, "release", "scripts"), role: "locked" },
    { path: join(l.root, "release", "scripts", "qa"), role: "locked" },
    { path: l.runnerDir, role: "locked" },
    { path: l.proofDir, role: "locked" },
    { path: l.releaseJson, role: "locked" },
    { path: l.policyJson, role: "locked" },
    { path: l.anchorJson, role: "locked" },
    { path: l.state, role: "state" },
    { path: l.cred, role: "secret" },
    { path: l.inbox, role: "inbox" },
    { path: l.evidence, role: "evidence" },
  ];
}

export async function aclGate(l: Layout, reader: AclReader, who: Who): Promise<Gate> {
  const problems: string[] = [];
  for (const { path, role } of roles(l)) {
    let text: string;
    try {
      text = await reader.read(path);
    } catch {
      problems.push(`${path}: ACL could not be read`);
      continue;
    }
    const entries = parseIcacls(text, path);
    if (!entries) {
      problems.push(`${path}: ACL output not understood (fail closed)`);
      continue;
    }
    if (!entries.some((e) => !e.deny && isAdminish(e.principal))) problems.push(`${path}: no Administrators/SYSTEM entry (output not understood)`);
    for (const v of aclViolations(entries, role, who)) problems.push(`${path}: ${v}`);
  }
  return { id: "install-root-acl", ok: problems.length === 0, detail: problems.length === 0 ? `ACLs on ${roles(l).length} protected paths match their roles` : problems.slice(0, 6).join(" | ") };
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

// ---------------------------------------------------------------- the verified-install brand
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
const verified = new WeakSet<object>();
/** Only code in the hashed runner folder can reach this; the brand says "execinbox's gates passed for this object". */
export function markVerifiedInstalled(i: InstalledRun): InstalledRun {
  verified.add(i);
  return i;
}
export const isVerifiedInstalled = (i: unknown): i is InstalledRun => typeof i === "object" && i !== null && verified.has(i);
