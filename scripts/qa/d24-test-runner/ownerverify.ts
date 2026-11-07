// VERIFY-ONLY half of the owner authorization. This is the only owner-related module the runner and the runner CLI import: it can read the pinned
// trust file and check a detached Ed25519 signature, and nothing else. Key generation, signing and trust-file writing live in ownersig.ts, which
// only the owner entry point (ownermain.ts / ownercli.ts) imports (a test scans the imports to keep it so).
//
// The owner directory is a FIXED location derived from the operating-system user record (os.userInfo().homedir, i.e. getpwuid/the user profile API),
// never from LOCALAPPDATA / HOME / USERPROFILE: environment variables cannot redirect which trust file the runner believes.

import { createHash, createPublicKey, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { icaclsExe, system32 } from "./bins";

export const SIG_DOMAIN = "D24-TEST-ENVELOPE-V1";

export type OwnerTrust = {
  v: 1;
  publicKeySpkiDerBase64: string;
  publicKeyFingerprint: string;
  ledgerDir: string;
  anchorFile: string;
  registeredUtc: string;
  /** Windows account that ran owner-keygen (used for the "same account" warning). */
  registeredBy: string;
  /** Hash of the owner-side tool files at keygen/rotation; owner-sign refuses if they differ. */
  ownerToolsSha256: string;
  /** Commit the owner tooling was verified at when registered. */
  registeredAtCommit: string;
  rotation?: { fromFingerprint: string; statement: string; signatureBase64: string; atUtc: string };
};
export type SignatureDoc = { v: 1; domain: typeof SIG_DOMAIN; envelopeSha256: string; publicKeyFingerprint: string; signatureBase64: string };

/** Fixed owner directory. Ignores every environment variable. */
export function defaultOwnerDir(home: string = userInfo().homedir): string {
  return join(home, "AppData", "Local", "DanceFlow", "d24-owner");
}
/** Fixed runner home (credential files, never the ledger for live runs). Ignores the environment too. */
export function defaultRunnerHome(home: string = userInfo().homedir): string {
  return join(home, "AppData", "Local", "DanceFlow", "d24-runner");
}
export const trustPath = (ownerDir: string) => join(ownerDir, "owner-trust.json");
export const privateKeyPath = (ownerDir: string) => join(ownerDir, "owner-key.enc.json");

export const keyFingerprint = (spkiDer: Buffer) => createHash("sha256").update(spkiDer).digest("hex");
export const signedMessage = (envelopeSha256: string) => Buffer.from(`${SIG_DOMAIN}\n${envelopeSha256}`, "utf8");

export function parseTrust(raw: unknown): OwnerTrust {
  const t = raw as Partial<OwnerTrust> | null;
  const str = (k: keyof OwnerTrust) => typeof t?.[k] === "string";
  if (!t || t.v !== 1 || !str("publicKeySpkiDerBase64") || !str("publicKeyFingerprint") || !str("ledgerDir") || !str("anchorFile") || !str("registeredUtc") || !str("registeredBy") || !str("ownerToolsSha256") || !str("registeredAtCommit")) throw new Error("owner trust file is malformed");
  if (keyFingerprint(Buffer.from(t.publicKeySpkiDerBase64 as string, "base64")) !== t.publicKeyFingerprint) throw new Error("owner trust file: public key does not match its fingerprint");
  return t as OwnerTrust;
}

/** Reads the pinned trust file. Returns null when no owner key was ever registered (live runs are then refused). */
export function loadTrust(ownerDir: string): OwnerTrust | null {
  const f = trustPath(ownerDir);
  if (!existsSync(f)) return null;
  return parseTrust(JSON.parse(readFileSync(f, "utf8")));
}

export function verifyOwnerSignature(envelopeSha256: string, doc: unknown, trust: OwnerTrust | null): { ok: boolean; reason: string } {
  if (!trust) return { ok: false, reason: "no owner public key is registered: live runs are refused (run owner-keygen on the owner's machine)" };
  const d = doc as Partial<SignatureDoc> | null;
  if (!d || d.v !== 1 || d.domain !== SIG_DOMAIN || typeof d.signatureBase64 !== "string" || typeof d.envelopeSha256 !== "string") return { ok: false, reason: "signature file missing or malformed" };
  if (d.envelopeSha256 !== envelopeSha256) return { ok: false, reason: "the signature is for a different envelope hash" };
  if (d.publicKeyFingerprint !== trust.publicKeyFingerprint) return { ok: false, reason: "the signature was made by a key that is not the registered owner key" };
  try {
    const pub = createPublicKey({ key: Buffer.from(trust.publicKeySpkiDerBase64, "base64"), format: "der", type: "spki" });
    return verify(null, signedMessage(envelopeSha256), pub, Buffer.from(d.signatureBase64, "base64")) ? { ok: true, reason: `valid owner signature (key ${trust.publicKeyFingerprint.slice(0, 16)})` } : { ok: false, reason: "the owner signature does not verify" };
  } catch {
    return { ok: false, reason: "the owner signature does not verify" };
  }
}

export const resolveOwnerPaths = (ownerDir: string, ledgerDir?: string) => {
  const ld = resolve(ledgerDir ?? join(ownerDir, "..", "d24-runner", "ledger"));
  return { ledgerDir: ld, anchorFile: join(resolve(ownerDir), "ledger-anchor.json") };
};

const WRITE_TOKENS = new Set(["F", "M", "W", "WD", "AD", "WA", "GA", "GW", "DC", "WDAC", "WO"]);
const BROAD_GROUPS = /(^|\\)(Users|Everyone|Authenticated Users|INTERACTIVE)$/i;

/**
 * Parses `icacls <dir>` output: does `me` (or a group that every interactive user belongs to) hold a write-class right (F, M, W, WD, AD, WA, DC)
 * that is not a DENY entry? Pure and exported so it is testable on any platform.
 */
export function icaclsGrantsWrite(output: string, dir: string, me: string): boolean {
  for (const raw of output.split(/\r?\n/)) {
    let line = raw.trim();
    if (line.toLowerCase().startsWith(dir.toLowerCase())) line = line.slice(dir.length).trim();
    const at = line.indexOf(":(");
    if (at < 0) continue;
    const principal = line.slice(0, at).trim();
    const tokens = [...line.slice(at).matchAll(/\(([A-Za-z,]+)\)/g)].flatMap((m) => m[1].split(","));
    if (tokens.includes("DENY")) continue;
    const short = principal.split("\\").pop() ?? principal;
    const isMe = short.toLowerCase() === me.toLowerCase();
    if ((isMe || BROAD_GROUPS.test(principal)) && tokens.some((t) => WRITE_TOKENS.has(t))) return true;
  }
  return false;
}

/** Windows: ask icacls (absolute path, neutral cwd). Elsewhere: the permission bits. Never throws: an error means "assume writable" so the warning errs on the loud side. */
export function writableByAccount(dir: string, me: string): boolean {
  try {
    if (process.platform === "win32") {
      const r = spawnSync(icaclsExe(), [dir], { encoding: "utf8", windowsHide: true, cwd: system32(), timeout: 15_000 });
      if (r.status !== 0) return true;
      return icaclsGrantsWrite(r.stdout ?? "", dir, me);
    }
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return process.platform === "win32";
  }
}

/**
 * Loud-warning check (never refuses). The signature only separates the owner from the machine's tooling when the tooling cannot write the owner
 * directory, so: no warning when the key was registered by a DIFFERENT account and this account has no write right (the separate-account marker);
 * otherwise one warning line per run.
 */
export function ownerSeparationWarning(ownerDir: string, trust: OwnerTrust, me: string = userInfo().username, access: (p: string, me: string) => boolean = writableByAccount): string | null {
  const sameAccount = trust.registeredBy.toLowerCase() === me.toLowerCase();
  const writable = sameAccount || access(ownerDir, me);
  if (!sameAccount && !writable) return null;
  return `WARNING: the owner trust directory ${ownerDir} ${sameAccount ? "was registered by this same Windows account" : "is writable by the current account"}: a process running as this user can replace the owner key, so the signature does NOT separate the owner from this machine's tooling. Run owner-keygen/owner-sign from a separate Windows account (or a hardware-held key) and grant this account read-only access.`;
}
