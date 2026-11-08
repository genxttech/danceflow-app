// OWNER-ONLY key operations: generate the keypair, sign an envelope hash, write/replace the trust file. Imported ONLY by ownercli.ts / ownermain.ts and
// by tests (a test scans every other source file's imports). The runner and runner CLI import ownerverify.ts, which can verify and nothing else.
//
// Private key at rest: PKCS8 DER encrypted with AES-256-GCM (16-byte tag, 12-byte IV) under a scrypt-derived key (N >= 2^17, r = 8, p = 1, about 134 MB)
// from an owner passphrase. It is deliberately NOT DPAPI: DPAPI CurrentUser would let any process of the same Windows user decrypt it, which would turn
// the signature back into a self-approval. Residual risk (documented): a process that can capture the owner's passphrase, or that runs in the owner's
// account and writes the owner directory, can sign or re-register; real separation needs a separate Windows account / machine or a hardware-held key.

import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, scryptSync, sign } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { keyFingerprint, privateKeyPath, SIG_DOMAIN, signedMessage, trustPath, type OwnerTrust, type SignatureDoc } from "./ownerverify";

export const MIN_PASSPHRASE = 16;
export const MIN_SCRYPT_N = 1 << 17;
export const DEFAULT_SCRYPT_N = 1 << 17;
export type EncryptedKey = { v: 1; kdf: "scrypt"; n: number; salt: string; iv: string; tag: string; ct: string };

const kdf = (pass: string, salt: Buffer, n: number) => scryptSync(pass, salt, 32, { N: n, r: 8, p: 1, maxmem: 512 * 1024 * 1024 });

/** Length and a basic sanity check (not a strength meter): not one repeated character, not only digits, at least 6 distinct characters. */
export function passphraseProblem(p: string): string | null {
  if (p.length < MIN_PASSPHRASE) return `the owner passphrase must be at least ${MIN_PASSPHRASE} characters`;
  if (new Set(p).size < 6) return "the owner passphrase needs at least 6 distinct characters";
  if (/^\d+$/.test(p)) return "the owner passphrase cannot be only digits";
  if (/^(.{1,4})\1+$/.test(p)) return "the owner passphrase cannot be a short pattern repeated";
  return null;
}

export function generateOwnerKey(passphrase: string, scryptN = DEFAULT_SCRYPT_N): { publicKeySpkiDerBase64: string; publicKeyFingerprint: string; encrypted: EncryptedKey } {
  const problem = passphraseProblem(passphrase);
  if (problem) throw new Error(problem);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kdf(passphrase, salt, scryptN), iv, { authTagLength: 16 });
  const ct = Buffer.concat([c.update(pkcs8), c.final()]);
  return { publicKeySpkiDerBase64: spki.toString("base64"), publicKeyFingerprint: keyFingerprint(spki), encrypted: { v: 1, kdf: "scrypt", n: scryptN, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") } };
}

/** Structural validation of a stored key file BEFORE any key derivation (attacker-lowered cost, truncated tag, odd IV are refused). `minN` is a test seam. */
export function checkEncryptedKey(enc: EncryptedKey, minN = MIN_SCRYPT_N): void {
  const len = (b64: string) => Buffer.from(b64, "base64").length;
  if (!enc || enc.v !== 1 || enc.kdf !== "scrypt" || !Number.isInteger(enc.n) || enc.n < minN || (enc.n & (enc.n - 1)) !== 0) throw new Error("owner key file: weak or malformed key-derivation parameters");
  if (typeof enc.salt !== "string" || typeof enc.iv !== "string" || typeof enc.tag !== "string" || typeof enc.ct !== "string") throw new Error("owner key file is malformed");
  if (len(enc.salt) !== 16 || len(enc.iv) !== 12 || len(enc.tag) !== 16) throw new Error("owner key file: unexpected salt, IV or authentication-tag length");
}

function openKey(enc: EncryptedKey, passphrase: string, minN = MIN_SCRYPT_N) {
  checkEncryptedKey(enc, minN);
  try {
    const d = createDecipheriv("aes-256-gcm", kdf(passphrase, Buffer.from(enc.salt, "base64"), enc.n), Buffer.from(enc.iv, "base64"), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(enc.tag, "base64"));
    return createPrivateKey({ key: Buffer.concat([d.update(Buffer.from(enc.ct, "base64")), d.final()]), format: "der", type: "pkcs8" });
  } catch {
    throw new Error("wrong passphrase or corrupt owner key file");
  }
}

export function signEnvelopeHash(enc: EncryptedKey, passphrase: string, envelopeSha256: string, minN = MIN_SCRYPT_N): SignatureDoc {
  if (!/^[0-9a-f]{64}$/.test(envelopeSha256)) throw new Error("envelopeSha256 must be 64 hex");
  const priv = openKey(enc, passphrase, minN);
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

export type FsOps = { copyFile: (from: string, to: string) => void; renameFile: (from: string, to: string) => void; unlink: (p: string) => void; chmod: (p: string, mode: number) => void };
const realOps: FsOps = { copyFile: copyFileSync, renameFile: renameSync, unlink: unlinkSync, chmod: chmodSync };
export type RotateHooks = {
  /** test seam: called after the new files are written and before the swap */
  beforeSwap?: () => void;
  /** test seam: fail the second rename */
  failSecondRename?: boolean;
  /** test seam: replacement file operations (e.g. a copy that fails during the restore) */
  ops?: Partial<FsOps>;
  /** test seam: scrypt floor for the EXISTING key file */
  minN?: number;
};

/** The final on-disk state must be consistent: the trust file parses and the key file decrypts to exactly the registered public key. */
function stateConsistent(ownerDir: string, passphrase: string, minN?: number): boolean {
  try {
    const t = JSON.parse(readFileSync(trustPath(ownerDir), "utf8")) as OwnerTrust;
    const priv = openKey(readEncryptedKey(ownerDir), passphrase, minN);
    return keyFingerprint(createPublicKey(priv).export({ type: "spki", format: "der" })) === t.publicKeyFingerprint;
  } catch {
    return false;
  }
}

/**
 * Explicit rotation / tool re-binding. Requires the OLD key (passphrase), checks that the decrypted old key IS the registered key, and signs a
 * statement binding old key -> new key + tool hash + commit. `newPassphrase` given => a new keypair replaces the old one; omitted => the key is kept
 * and only the owner-tool hash / commit are re-bound.
 * Safety of the swap: new files are written first (`.new`), the old ones are copied to `.bak`, both are swapped with renames, and the result is verified
 * (trust parses, key file decrypts to the registered key). Only then are the backups deleted. On any failure the old files are restored from the backups;
 * if ANY restore step fails, or the restored state cannot be verified, every `.bak` and `.new` file is KEPT and the error names them with the manual
 * recovery step. A leftover `.new` / `.bak` from an interrupted rotation makes the next rotation refuse with the same instructions (never a silent overwrite).
 */
export function rotateTrust(ownerDir: string, current: OwnerTrust, oldPassphrase: string, next: { ownerToolsSha256: string; registeredAtCommit: string; registeredBy: string; newPassphrase?: string }, nowUtc: string, hooks: RotateHooks = {}): OwnerTrust {
  const ops: FsOps = { ...realOps, ...hooks.ops };
  const tf = trustPath(ownerDir);
  const kf = privateKeyPath(ownerDir);
  const files = [tf, kf];
  const leftovers = files.flatMap((f) => [`${f}.new`, `${f}.bak`]).filter((f) => existsSync(f));
  if (leftovers.length > 0) throw new Error(`refusing to rotate: leftover file(s) from an interrupted rotation: ${leftovers.join(", ")}. ${RECOVERY}`);

  const oldPriv = openKey(readEncryptedKey(ownerDir), oldPassphrase, hooks.minN); // throws on the wrong passphrase
  const oldFp = keyFingerprint(createPublicKey(oldPriv).export({ type: "spki", format: "der" }));
  if (oldFp !== current.publicKeyFingerprint) throw new Error("the key file does not match the registered public key; refusing to rotate");
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

  // 1. write everything new first; nothing live has changed yet
  writeFileSync(`${tf}.new`, JSON.stringify(rotated, null, 2), { mode: 0o444 });
  if (newEnc) writeFileSync(`${kf}.new`, JSON.stringify(newEnc), { mode: 0o600 });
  // 2. back up the old files
  for (const f of files) ops.copyFile(f, `${f}.bak`);
  hooks.beforeSwap?.();
  const finalPass = next.newPassphrase ?? oldPassphrase;
  try {
    try {
      ops.chmod(tf, 0o644); // clear the read-only attribute so the rename can replace it
    } catch {
      /* ignore */
    }
    if (newEnc) ops.renameFile(`${kf}.new`, kf);
    if (hooks.failSecondRename) throw new Error("simulated failure during the swap");
    ops.renameFile(`${tf}.new`, tf);
    if (!stateConsistent(ownerDir, finalPass, newEnc ? undefined : hooks.minN)) throw new Error("the rotated trust file and key file are not consistent");
  } catch (e) {
    // 3a. restore from the backups, tracking every step
    const failed: string[] = [];
    for (const f of files) {
      try {
        ops.chmod(f, 0o644);
        ops.copyFile(`${f}.bak`, f);
      } catch {
        failed.push(f);
      }
    }
    try {
      ops.chmod(tf, 0o444); // the trust file is read-only again
    } catch {
      /* best effort */
    }
    const restoredOk = failed.length === 0 && stateConsistent(ownerDir, oldPassphrase, hooks.minN);
    if (!restoredOk) {
      const keep = files.flatMap((f) => [`${f}.bak`, `${f}.new`]).filter((f) => existsSync(f));
      throw new Error(`rotation failed (${(e as Error).message}) AND the previous state could not be restored${failed.length ? ` for ${failed.join(", ")}` : " or verified"}. KEPT: ${keep.join(", ")}. ${RECOVERY}`);
    }
    for (const f of [`${tf}.new`, `${kf}.new`, `${tf}.bak`, `${kf}.bak`]) if (existsSync(f)) ops.unlink(f);
    throw e;
  }
  // 3b. both swaps succeeded and the state is verified: drop the backups
  try {
    ops.chmod(tf, 0o444);
  } catch {
    /* best effort */
  }
  for (const f of files) if (existsSync(`${f}.bak`)) ops.unlink(`${f}.bak`);
  return rotated;
}

const RECOVERY = "Manual recovery: stop, do not delete anything; for each <file>.bak copy it over <file> (owner-trust.json / owner-key.enc.json in the owner directory) to return to the previous registration, check with owner-show, then delete the leftover .new/.bak files and retry. If you are unsure, the old private key is the .bak (or the unchanged original) and the passphrase is unchanged.";
