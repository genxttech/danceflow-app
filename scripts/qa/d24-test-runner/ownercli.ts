// OWNER-SIDE commands. These run on the owner's machine, interactively. The private key never leaves the owner's encrypted key file; these
// commands print only the public key fingerprint and the signature. The runner path (runner.ts, cli `run`) imports verification only.
//
//   owner-keygen [--owner-dir D] [--ledger-dir L]   create the keypair (passphrase prompt), register the PUBLIC key + the pinned ledger location
//   owner-sign --envelope E.json [--out S.json]     show the full terms, require the typed confirmation + passphrase, write the detached signature
//   owner-show                                      print the registered public key fingerprint and the pinned ledger location
//
// Both interactive commands refuse a non-TTY stdin: piping a passphrase or the confirmation defeats the purpose.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { validateEnvelope, type Envelope } from "./envelope";
import { defaultOwnerDir, generateOwnerKey, loadTrust, privateKeyPath, readEncryptedKey, resolveOwnerPaths, signEnvelopeHash, trustPath, writeEncryptedKey, writeTrust } from "./ownersig";

export type OwnerIo = { out: (s: string) => void; err: (s: string) => void };
export type Prompter = { isTty: boolean; line: (prompt: string) => Promise<string>; hidden: (prompt: string) => Promise<string> };

/** Human-readable rendering of EVERY material term the signature will cover. */
export function renderTerms(e: Envelope): string[] {
  return [
    `envelope ${e.envelopeId}  (hash ${e.envelopeSha256})`,
    `valid ${e.createdUtc} -> ${e.expiresUtc}; at most ${e.maxRuns} run(s); ceiling ${e.apiCallCeiling} calls (cleanup reserve ${e.cleanupReserve})`,
    `code commit ${e.code.commitSha}; package-lock sha256 ${e.code.lockfileSha256}`,
    `proof manifest ${e.proof.manifestSha256} (${e.proof.fileCount} files); RUNNER manifest ${e.runner.manifestSha256} (${e.runner.fileCount} files)`,
    `Stripe TEST accounts: platform ${e.accounts.platformAcct}, connected ${e.accounts.connectedAcct}`,
    `credential: ${e.credential.store} label ${e.credential.label}, fingerprint ${e.credential.keyFingerprintSha256Prefix}, key expires ${e.credential.keyExpiresUtc}`,
    `permitted operations: ${e.permittedRuleIds.join(", ")}`,
    `evidence root: ${e.evidenceRoot}`,
    `forbidden: fee-bearing operations, financial mutations, LIVE mode; stop on: ${e.stopConditions.join(", ")}`,
    ...Object.entries(e.manualAttestations).map(([id, a]) => `manual attestation ${id}: "${a.statement}" (by ${a.attestedBy}, ref ${a.reference})`),
  ];
}

export async function ownerKeygen(io: OwnerIo, p: Prompter, ownerDir = defaultOwnerDir(), ledgerDir?: string): Promise<number> {
  if (!p.isTty) {
    io.err("refused: owner-keygen needs an interactive terminal (the passphrase must be typed by the owner, never piped)");
    return 2;
  }
  if (existsSync(trustPath(ownerDir)) || existsSync(privateKeyPath(ownerDir))) {
    io.err("refused: an owner key already exists here; replacing it is a deliberate manual act");
    return 2;
  }
  const a = await p.hidden("Choose an owner passphrase (at least 12 characters; it protects the signing key): ");
  const b = await p.hidden("Repeat the passphrase: ");
  if (a !== b) {
    io.err("refused: the passphrases differ");
    return 2;
  }
  const k = generateOwnerKey(a);
  const paths = resolveOwnerPaths(ownerDir, ledgerDir);
  writeEncryptedKey(ownerDir, k.encrypted);
  writeTrust(ownerDir, { v: 1, publicKeySpkiDerBase64: k.publicKeySpkiDerBase64, publicKeyFingerprint: k.publicKeyFingerprint, ledgerDir: paths.ledgerDir, anchorFile: paths.anchorFile, registeredUtc: new Date().toISOString() });
  io.out(`owner public key registered. fingerprint ${k.publicKeyFingerprint}`);
  io.out(`pinned ledger directory ${paths.ledgerDir}; anchor ${paths.anchorFile}`);
  io.out("The private key is only in the encrypted key file on this machine. Never send it or the passphrase to anyone (including the coordinator or any agent).");
  return 0;
}

export async function ownerSign(io: OwnerIo, p: Prompter, envelopePath: string, outPath: string, ownerDir = defaultOwnerDir()): Promise<number> {
  if (!p.isTty) {
    io.err("refused: owner-sign needs an interactive terminal (the owner types the confirmation and the passphrase)");
    return 2;
  }
  const trust = loadTrust(ownerDir);
  if (!trust || !existsSync(privateKeyPath(ownerDir))) {
    io.err("refused: no owner key here (run owner-keygen first)");
    return 2;
  }
  const v = validateEnvelope(JSON.parse(readFileSync(envelopePath, "utf8")));
  if (!v.ok) {
    for (const i of v.issues) io.err(`${i.code}: ${i.detail}`);
    return 2;
  }
  const e = v.envelope;
  io.out("You are about to AUTHORISE a Stripe TEST run with exactly these terms:");
  for (const l of renderTerms(e)) io.out(`  - ${l}`);
  io.out(`owner approval text on record: ${e.ownerApproval.text}`);
  const want = `SIGN ${e.envelopeSha256.slice(0, 12)}`;
  const typed = await p.line(`Type exactly "${want}" to continue: `);
  if (typed.trim() !== want) {
    io.err("refused: confirmation text did not match; nothing was signed");
    return 2;
  }
  const pass = await p.hidden("Owner passphrase: ");
  const doc = signEnvelopeHash(readEncryptedKey(ownerDir), pass, e.envelopeSha256);
  if (doc.publicKeyFingerprint !== trust.publicKeyFingerprint) {
    io.err("refused: the key file does not match the registered public key");
    return 2;
  }
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(outPath, JSON.stringify(doc, null, 2), { flag: "wx" });
  io.out(`signature written to ${outPath} (key ${doc.publicKeyFingerprint.slice(0, 16)}, envelope ${e.envelopeSha256.slice(0, 16)}). Give the engineer this file; it contains no secret.`);
  return 0;
}

export function ownerShow(io: OwnerIo, ownerDir = defaultOwnerDir()): number {
  const t = loadTrust(ownerDir);
  if (!t) {
    io.out("no owner key registered: live runs are refused");
    return 1;
  }
  io.out(`owner public key fingerprint ${t.publicKeyFingerprint}`);
  io.out(`pinned ledger directory ${t.ledgerDir}; anchor ${t.anchorFile}; registered ${t.registeredUtc}`);
  return 0;
}
