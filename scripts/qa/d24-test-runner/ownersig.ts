// OWNER-ONLY key operations: generate the keypair, sign an envelope hash, write/replace the trust file. Imported ONLY by ownercli.ts / ownermain.ts and
// by tests (a test scans every other source file's imports). The runner and runner CLI import ownerverify.ts, which can verify and nothing else.
//
// Private key at rest: PKCS8 DER encrypted with AES-256-GCM under a scrypt-derived key from an owner passphrase. It is deliberately NOT DPAPI:
// DPAPI CurrentUser would let any process of the same Windows user decrypt it, which would turn the signature back into a self-approval.
// Residual risk (documented): a process that can capture the owner's passphrase, or that runs in the owner's account and writes the owner directory,
// can sign or re-register; real separation needs a separate Windows account / machine or a hardware-held key (open owner decision).

import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, scryptSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { privateKeyPath, keyFingerprint, SIG_DOMAIN, signedMessage, trustPath, type OwnerTrust, type SignatureDoc } from "./ownerverify";

export const MIN_PASSPHRASE = 12;
export type EncryptedKey = { v: 1; kdf: "scrypt"; n: number; salt: string; iv: string; tag: string; ct: string };

const kdf = (pass: string, salt: Buffer, n: number) => scryptSync(pass, salt, 32, { N: n, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
function checkPass(p: string) {
  if (p.length < MIN_PASSPHRASE) throw new Error(`the owner passphrase must be at least ${MIN_PASSPHRASE} characters`);
}

export function generateOwnerKey(passphrase: string, scryptN = 1 << 15): { publicKeySpkiDerBase64: string; publicKeyFingerprint: string; encrypted: EncryptedKey } {
  checkPass(passphrase);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kdf(passphrase, salt, scryptN), iv);
  const ct = Buffer.concat([c.update(pkcs8), c.final()]);
  return { publicKeySpkiDerBase64: spki.toString("base64"), publicKeyFingerprint: keyFingerprint(spki), encrypted: { v: 1, kdf: "scrypt", n: scryptN, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") } };
}

function openKey(enc: EncryptedKey, passphrase: string) {
  try {
    const d = createDecipheriv("aes-256-gcm", kdf(passphrase, Buffer.from(enc.salt, "base64"), enc.n), Buffer.from(enc.iv, "base64"));
    d.setAuthTag(Buffer.from(enc.tag, "base64"));
    return createPrivateKey({ key: Buffer.concat([d.update(Buffer.from(enc.ct, "base64")), d.final()]), format: "der", type: "pkcs8" });
  } catch {
    throw new Error("wrong passphrase or corrupt owner key file");
  }
}

export function signEnvelopeHash(enc: EncryptedKey, passphrase: string, envelopeSha256: string): SignatureDoc {
  if (!/^[0-9a-f]{64}$/.test(envelopeSha256)) throw new Error("envelopeSha256 must be 64 hex");
  const priv = openKey(enc, passphrase);
  const spki = createPublicKey(priv).export({ type: "spki", format: "der" });
  return { v: 1, domain: SIG_DOMAIN, envelopeSha256, publicKeyFingerprint: keyFingerprint(spki), signatureBase64: sign(null, signedMessage(envelopeSha256), priv).toString("base64") };
}

/** First registration only: refuses when a trust file exists. Replacement is `rotateTrust`, which needs the OLD key. */
export function writeTrust(ownerDir: string, t: OwnerTrust): void {
  mkdirSync(ownerDir, { recursive: true });
  const f = trustPath(ownerDir);
  if (existsSync(f)) throw new Error("an owner key is already registered; replacing it needs owner-rotate (which requires the old key's passphrase)");
  writeFileSync(f, JSON.stringify(t, null, 2), { flag: "wx", mode: 0o444 });
  try {
    chmodSync(f, 0o444);
  } catch {
    /* best effort: read-only attribute */
  }
}

export function writeEncryptedKey(ownerDir: string, enc: EncryptedKey): void {
  mkdirSync(ownerDir, { recursive: true });
  writeFileSync(privateKeyPath(ownerDir), JSON.stringify(enc), { flag: "wx", mode: 0o600 });
}
export const readEncryptedKey = (ownerDir: string): EncryptedKey => JSON.parse(readFileSync(privateKeyPath(ownerDir), "utf8")) as EncryptedKey;

/**
 * Explicit rotation / tool re-binding. Requires the OLD key (passphrase) to sign a statement binding old key -> new key + tool hash + commit.
 * `newPassphrase` given => a new keypair replaces the old one; omitted => the key is kept and only the owner-tool hash / commit are re-bound.
 */
export function rotateTrust(ownerDir: string, current: OwnerTrust, oldPassphrase: string, next: { ownerToolsSha256: string; registeredAtCommit: string; registeredBy: string; newPassphrase?: string }, nowUtc: string): OwnerTrust {
  const oldPriv = openKey(readEncryptedKey(ownerDir), oldPassphrase); // throws on the wrong passphrase
  let pub = current.publicKeySpkiDerBase64;
  let newEnc: EncryptedKey | null = null;
  if (next.newPassphrase !== undefined) {
    const k = generateOwnerKey(next.newPassphrase);
    pub = k.publicKeySpkiDerBase64;
    newEnc = k.encrypted;
  }
  const newFp = keyFingerprint(Buffer.from(pub, "base64"));
  const statement = `D24-OWNER-ROTATE-V1\nold=${current.publicKeyFingerprint}\nnew=${newFp}\ntools=${next.ownerToolsSha256}\ncommit=${next.registeredAtCommit}`;
  const rotated: OwnerTrust = { ...current, publicKeySpkiDerBase64: pub, publicKeyFingerprint: newFp, ownerToolsSha256: next.ownerToolsSha256, registeredAtCommit: next.registeredAtCommit, registeredBy: next.registeredBy, registeredUtc: nowUtc, rotation: { fromFingerprint: current.publicKeyFingerprint, statement, signatureBase64: sign(null, Buffer.from(statement, "utf8"), oldPriv).toString("base64"), atUtc: nowUtc } };
  const f = trustPath(ownerDir);
  const tmp = `${f}.new`;
  writeFileSync(tmp, JSON.stringify(rotated, null, 2), { mode: 0o444 });
  try {
    chmodSync(f, 0o644); // clear the read-only attribute so the rename can replace it
  } catch {
    /* ignore */
  }
  if (newEnc) {
    writeFileSync(`${privateKeyPath(ownerDir)}.new`, JSON.stringify(newEnc), { mode: 0o600 });
    renameSync(`${privateKeyPath(ownerDir)}.new`, privateKeyPath(ownerDir));
  }
  renameSync(tmp, f);
  return rotated;
}
