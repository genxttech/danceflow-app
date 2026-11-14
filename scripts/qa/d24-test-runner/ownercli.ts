// OWNER-SIDE commands, run by the owner on the owner's machine via ownermain.ts. Nothing in the runner path imports this file.
//
//   owner-keygen --commit SHA [--ledger-dir L]      create the keypair, register the PUBLIC key, pinned ledger location and the hash of these owner tools
//   owner-sign --envelope E --commit SHA [--out S]  show the full terms (escaped), recompute the hash independently, sign it
//   owner-rotate --commit SHA [--new-key]           re-bind tools (or replace the key); needs the OLD passphrase and signs a rotation statement
//   owner-show                                      print the registered public key fingerprint and the pinned ledger location
//
// Hardening (review N-2, N-3): the commands refuse a non-TTY stdin; they refuse unless run from a pristine checkout at the commit the owner names
// (git clean, HEAD == --commit); owner-sign refuses if the owner-tool files no longer hash to the value recorded at keygen; the canonical hash that is
// signed is recomputed here with a local canonicaliser, never taken from the file; every printed value is JSON-escaped and non-ASCII is \u-escaped.
// Residual (open owner decision): a TTY does not prove a human, and an agent with a pty in the same Windows account can do what the owner can do;
// the real separation is a separate Windows account / machine or a hardware-held key.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateEnvelope, type Envelope } from "./envelope";
import type { Exec } from "./exec";
import { pristineGates } from "./gitverify";
import { generateOwnerKey, passphraseProblem, readEncryptedKey, rotateTrust, signEnvelopeHash, writeEncryptedKey, writeTrust } from "./ownersig";
import { defaultOwnerDir, loadTrust, privateKeyPath, resolveOwnerPaths, trustPath } from "./ownerverify";

export type OwnerIo = { out: (s: string) => void; err: (s: string) => void };
export type Prompter = { isTty: boolean; line: (prompt: string) => Promise<string>; hidden: (prompt: string) => Promise<string> };
/** How the owner commands prove they run from a pristine, reviewed checkout. */
export type Pristine = { repoDir: string; commitSha: string; exec: Exec; env: Record<string, string>; gitBin?: string; toolsDir?: string };

const HERE = dirname(fileURLToPath(import.meta.url));
/** Files OUTSIDE this folder that the owner tools import (envelope.ts -> identity.ts -> redact.ts, config.ts): part of the owner-tool hash too. */
export const OWNER_EXTERNAL_FILES = ["config.ts", "identity.ts", "redact.ts"] as const;
export const OWNER_TOOL_FILES = ["bins.ts", "canon.ts", "envelope.ts", "exec.ts", "gitverify.ts", "ownercli.ts", "ownermain.ts", "ownersig.ts", "ownerverify.ts", "childenv.ts", "secretprompt.ts"] as const;

/** Hash of the files the owner commands execute (CRLF-normalised). Recorded in the trust file at keygen; owner-sign refuses if it changed. */
export function ownerToolsSha256(dir: string = HERE, proofDir: string = join(HERE, "..", "d24-m3d-proof")): string {
  const roll = createHash("sha256");
  const h = (p: string) => createHash("sha256").update(readFileSync(p, "utf8").replace(/\r\n/g, "\n")).digest("hex");
  for (const f of OWNER_TOOL_FILES) roll.update(`${f}\0${h(join(dir, f))}\n`);
  for (const f of OWNER_EXTERNAL_FILES) roll.update(`../d24-m3d-proof/${f}\0${h(join(proofDir, f))}\n`);
  return roll.digest("hex");
}

/** A local, independent canonical-JSON hash (same algorithm as the runner's, deliberately not imported from canon.ts). */
export function ownerCanonicalHash(envelope: Record<string, unknown>): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, norm(o[k])]));
    }
    return x;
  };
  const rest: Record<string, unknown> = { ...envelope };
  delete rest.envelopeSha256;
  return createHash("sha256").update(JSON.stringify(norm(rest))).digest("hex");
}

/** JSON-escape a value for display and \u-escape every non-ASCII character, so no raw escape/CR/bidi byte can reach the owner's terminal. */
export const show = (v: unknown): string => JSON.stringify(v).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** Human-readable rendering of EVERY material term the signature will cover; every dynamic value goes through show(). */
export function renderTerms(e: Envelope): string[] {
  return [
    `envelope ${show(e.envelopeId)}`,
    `valid ${show(e.createdUtc)} -> ${show(e.expiresUtc)}; at most ${show(e.maxRuns)} run(s); ceiling ${show(e.apiCallCeiling)} calls (cleanup reserve ${show(e.cleanupReserve)})`,
    `code commit ${show(e.code.commitSha)}; package-lock sha256 ${show(e.code.lockfileSha256)}`,
    `proof manifest ${show(e.proof.manifestSha256)} (${show(e.proof.fileCount)} files); RUNNER manifest ${show(e.runner.manifestSha256)} (${show(e.runner.fileCount)} files)`,
    `hardware anchor pin: ${show(e.hardwareAnchorFingerprintSha256)}`,
    `Stripe TEST accounts: platform ${show(e.accounts.platformAcct)}, connected ${show(e.accounts.connectedAcct)}`,
    `credential: ${show(e.credential.store)} label ${show(e.credential.label)}, fingerprint ${show(e.credential.keyFingerprintSha256Prefix)}, key expires ${show(e.credential.keyExpiresUtc)}`,
    `permitted operations: ${e.permittedRuleIds.map(show).join(", ")}`,
    `evidence root: ${show(e.evidenceRoot)}`,
    `forbidden: fee-bearing operations, financial mutations, LIVE mode; stop on: ${e.stopConditions.map(show).join(", ")}`,
    ...Object.entries(e.manualAttestations).map(([id, a]) => `manual attestation ${show(id)}: ${show(a.statement)} (by ${show(a.attestedBy)}, ref ${show(a.reference)})`),
  ];
}

async function requirePristine(io: OwnerIo, p: Pristine): Promise<boolean> {
  const gates = await pristineGates({ repoDir: p.repoDir, commitSha: p.commitSha, env: p.env, exec: p.exec, gitBin: p.gitBin });
  const bad = gates.filter((g) => !g.ok);
  if (bad.length > 0) {
    io.err(`refused: this command must run from a pristine checkout at the commit you named (${bad.map((g) => `${g.id}: ${g.detail}`).join("; ")})`);
    return false;
  }
  return true;
}

export async function ownerKeygen(io: OwnerIo, pr: Prompter, pristine: Pristine, ownerDir = defaultOwnerDir(), ledgerDir?: string): Promise<number> {
  if (!pr.isTty) {
    io.err("refused: owner-keygen needs an interactive terminal (the passphrase must be typed by the owner, never piped)");
    return 2;
  }
  if (existsSync(trustPath(ownerDir)) || existsSync(privateKeyPath(ownerDir))) {
    io.err("refused: an owner key already exists here; there is no silent re-registration (use owner-rotate, which needs the old key)");
    return 2;
  }
  if (!(await requirePristine(io, pristine))) return 2;
  const a = await pr.hidden("Choose an owner passphrase (at least 16 characters; it protects the signing key): ");
  const weak = passphraseProblem(a);
  if (weak) {
    io.err(`refused: ${weak}`);
    return 2;
  }
  const b = await pr.hidden("Repeat the passphrase: ");
  if (a !== b) {
    io.err("refused: the passphrases differ");
    return 2;
  }
  const k = generateOwnerKey(a);
  const paths = resolveOwnerPaths(ownerDir, ledgerDir);
  writeEncryptedKey(ownerDir, k.encrypted);
  writeTrust(ownerDir, { v: 1, publicKeySpkiDerBase64: k.publicKeySpkiDerBase64, publicKeyFingerprint: k.publicKeyFingerprint, ledgerDir: paths.ledgerDir, anchorFile: paths.anchorFile, registeredUtc: new Date().toISOString(), registeredBy: userInfo().username, ownerToolsSha256: ownerToolsSha256(pristine.toolsDir), registeredAtCommit: pristine.commitSha });
  io.out(`owner public key registered. fingerprint ${k.publicKeyFingerprint}`);
  io.out(`pinned ledger directory ${paths.ledgerDir}; anchor ${paths.anchorFile}; owner tools recorded at commit ${pristine.commitSha.slice(0, 12)}`);
  io.out("The private key is only in the encrypted key file on this machine. Never send it or the passphrase to anyone (including the coordinator or any agent).");
  return 0;
}

export async function ownerSign(io: OwnerIo, pr: Prompter, pristine: Pristine, envelopePath: string, outPath: string, ownerDir = defaultOwnerDir()): Promise<number> {
  if (!pr.isTty) {
    io.err("refused: owner-sign needs an interactive terminal (the owner types the confirmation and the passphrase)");
    return 2;
  }
  const trust = loadTrust(ownerDir);
  if (!trust || !existsSync(privateKeyPath(ownerDir))) {
    io.err("refused: no owner key here (run owner-keygen first)");
    return 2;
  }
  if (!(await requirePristine(io, pristine))) return 2;
  if (ownerToolsSha256(pristine.toolsDir) !== trust.ownerToolsSha256) {
    io.err("refused: the owner-tool files differ from the ones recorded when the key was registered (modified tooling); review them and run owner-rotate to re-bind");
    return 2;
  }
  const raw = JSON.parse(readFileSync(envelopePath, "utf8")) as Record<string, unknown>;
  const v = validateEnvelope(raw);
  if (!v.ok) {
    for (const i of v.issues) io.err(`${i.code}: ${i.detail.replace(/[^\x20-\x7e]/g, "?")}`);
    return 2;
  }
  const e = v.envelope;
  const recomputed = ownerCanonicalHash(raw); // independent of the runner's canon.ts; this is what gets signed
  if (recomputed !== e.envelopeSha256) {
    io.err("refused: the independently recomputed canonical hash differs from the one in the file");
    return 2;
  }
  io.out("You are about to AUTHORISE a Stripe TEST run with exactly these terms (every value is shown escaped):");
  io.out(`owner approval text on record (read this first): ${show(e.ownerApproval.text)}`);
  io.out(`canonical hash recomputed by this tool: ${recomputed}`);
  for (const l of renderTerms(e)) io.out(`  - ${l}`);
  const want = `SIGN ${recomputed.slice(0, 12)}`;
  const typed = await pr.line(`Type exactly "${want}" to continue: `);
  if (typed.trim() !== want) {
    io.err("refused: confirmation text did not match; nothing was signed");
    return 2;
  }
  const pass = await pr.hidden("Owner passphrase: ");
  const doc = signEnvelopeHash(readEncryptedKey(ownerDir), pass, recomputed);
  if (doc.publicKeyFingerprint !== trust.publicKeyFingerprint) {
    io.err("refused: the key file does not match the registered public key");
    return 2;
  }
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(outPath, JSON.stringify(doc, null, 2), { flag: "wx" });
  io.out(`signature written to ${outPath} (key ${doc.publicKeyFingerprint.slice(0, 16)}, envelope ${recomputed.slice(0, 16)}). Give the engineer this file; it contains no secret.`);
  return 0;
}

/** Explicit, old-key-authorised change of the registration: re-bind the tool hash/commit, or (newKey) replace the key. */
export async function ownerRotate(io: OwnerIo, pr: Prompter, pristine: Pristine, ownerDir = defaultOwnerDir(), newKey = false): Promise<number> {
  if (!pr.isTty) {
    io.err("refused: owner-rotate needs an interactive terminal");
    return 2;
  }
  const trust = loadTrust(ownerDir);
  if (!trust) {
    io.err("refused: no owner key registered (use owner-keygen)");
    return 2;
  }
  if (!(await requirePristine(io, pristine))) return 2;
  const old = await pr.hidden("OLD owner passphrase: ");
  let fresh: string | undefined;
  if (newKey) {
    fresh = await pr.hidden("NEW owner passphrase (at least 16 characters): ");
    const weakNew = passphraseProblem(fresh);
    if (weakNew) {
      io.err(`refused: ${weakNew}`);
      return 2;
    }
    if (fresh !== (await pr.hidden("Repeat the NEW passphrase: "))) {
      io.err("refused: the new passphrases differ");
      return 2;
    }
  }
  const t = rotateTrust(ownerDir, trust, old, { ownerToolsSha256: ownerToolsSha256(pristine.toolsDir), registeredAtCommit: pristine.commitSha, registeredBy: userInfo().username, newPassphrase: fresh }, new Date().toISOString());
  io.out(`owner registration updated (signed by the previous key). fingerprint ${t.publicKeyFingerprint}; tools recorded at commit ${pristine.commitSha.slice(0, 12)}`);
  return 0;
}

export function ownerShow(io: OwnerIo, ownerDir = defaultOwnerDir()): number {
  const t = loadTrust(ownerDir);
  if (!t) {
    io.out("no owner key registered: live runs are refused");
    return 1;
  }
  io.out(`owner public key fingerprint ${t.publicKeyFingerprint}`);
  io.out(`pinned ledger directory ${show(t.ledgerDir)}; anchor ${show(t.anchorFile)}; registered ${show(t.registeredUtc)} by ${show(t.registeredBy)} at commit ${t.registeredAtCommit.slice(0, 12)}`);
  return 0;
}
