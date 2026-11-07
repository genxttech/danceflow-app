// Owner authorization: a detached Ed25519 signature over the envelope's canonical hash, made with a key that only the OWNER holds.
// The runner (and the coordinator/engineering tooling) can VERIFY against a pinned public key but contains no code path that signs, and no code
// path outside `ownercli.ts` that writes the trust file. This is the control that stops the tooling from minting and approving its own envelope.
//
// Private key at rest: PKCS8 DER encrypted with AES-256-GCM under a scrypt-derived key from an owner passphrase. It is deliberately NOT DPAPI:
// DPAPI CurrentUser would let any process of the same Windows user decrypt it, which would turn the signature back into a self-approval.
// Residual risk (documented): on a single-user machine, a process that can capture the owner's passphrase (keylogger, a shared terminal) can sign.

import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, scryptSync, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const SIG_DOMAIN = "D24-TEST-ENVELOPE-V1";
export const MIN_PASSPHRASE = 12;

export type OwnerTrust = { v: 1; publicKeySpkiDerBase64: string; publicKeyFingerprint: string; ledgerDir: string; anchorFile: string; registeredUtc: string };
export type SignatureDoc = { v: 1; domain: typeof SIG_DOMAIN; envelopeSha256: string; publicKeyFingerprint: string; signatureBase64: string };
export type EncryptedKey = { v: 1; kdf: "scrypt"; n: number; salt: string; iv: string; tag: string; ct: string };

export const defaultOwnerDir = () => join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "DanceFlow", "d24-owner");
export const trustPath = (ownerDir: string) => join(ownerDir, "owner-trust.json");
export const privateKeyPath = (ownerDir: string) => join(ownerDir, "owner-key.enc.json");

const fp = (spkiDer: Buffer) => createHash("sha256").update(spkiDer).digest("hex");
const message = (envelopeSha256: string) => Buffer.from(`${SIG_DOMAIN}\n${envelopeSha256}`, "utf8");
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
  return { publicKeySpkiDerBase64: spki.toString("base64"), publicKeyFingerprint: fp(spki), encrypted: { v: 1, kdf: "scrypt", n: scryptN, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") } };
}

export function signEnvelopeHash(enc: EncryptedKey, passphrase: string, envelopeSha256: string): SignatureDoc {
  if (!/^[0-9a-f]{64}$/.test(envelopeSha256)) throw new Error("envelopeSha256 must be 64 hex");
  let pkcs8: Buffer;
  try {
    const d = createDecipheriv("aes-256-gcm", kdf(passphrase, Buffer.from(enc.salt, "base64"), enc.n), Buffer.from(enc.iv, "base64"));
    d.setAuthTag(Buffer.from(enc.tag, "base64"));
    pkcs8 = Buffer.concat([d.update(Buffer.from(enc.ct, "base64")), d.final()]);
  } catch {
    throw new Error("wrong passphrase or corrupt owner key file");
  }
  const priv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ type: "spki", format: "der" });
  return { v: 1, domain: SIG_DOMAIN, envelopeSha256, publicKeyFingerprint: fp(spki), signatureBase64: sign(null, message(envelopeSha256), priv).toString("base64") };
}

export function parseTrust(raw: unknown): OwnerTrust {
  const t = raw as Partial<OwnerTrust> | null;
  if (!t || t.v !== 1 || typeof t.publicKeySpkiDerBase64 !== "string" || typeof t.publicKeyFingerprint !== "string" || typeof t.ledgerDir !== "string" || typeof t.anchorFile !== "string" || typeof t.registeredUtc !== "string") throw new Error("owner trust file is malformed");
  if (fp(Buffer.from(t.publicKeySpkiDerBase64, "base64")) !== t.publicKeyFingerprint) throw new Error("owner trust file: public key does not match its fingerprint");
  return t as OwnerTrust;
}

/** Reads the pinned trust file. Returns null when no owner key was ever registered (live runs are then refused). */
export function loadTrust(ownerDir: string): OwnerTrust | null {
  const f = trustPath(ownerDir);
  if (!existsSync(f)) return null;
  return parseTrust(JSON.parse(readFileSync(f, "utf8")));
}

/** The only writer of the trust file. Called by `owner-keygen` (owner side) and nowhere in the runner path. Refuses to overwrite. */
export function writeTrust(ownerDir: string, t: OwnerTrust): void {
  mkdirSync(ownerDir, { recursive: true });
  const f = trustPath(ownerDir);
  if (existsSync(f)) throw new Error("an owner key is already registered; rotating it is a deliberate manual act (delete the trust file yourself)");
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

export function verifyOwnerSignature(envelopeSha256: string, doc: unknown, trust: OwnerTrust | null): { ok: boolean; reason: string } {
  if (!trust) return { ok: false, reason: "no owner public key is registered: live runs are refused (run owner-keygen on the owner's machine)" };
  const d = doc as Partial<SignatureDoc> | null;
  if (!d || d.v !== 1 || d.domain !== SIG_DOMAIN || typeof d.signatureBase64 !== "string" || typeof d.envelopeSha256 !== "string") return { ok: false, reason: "signature file missing or malformed" };
  if (d.envelopeSha256 !== envelopeSha256) return { ok: false, reason: "the signature is for a different envelope hash" };
  if (d.publicKeyFingerprint !== trust.publicKeyFingerprint) return { ok: false, reason: "the signature was made by a key that is not the registered owner key" };
  try {
    const pub = createPublicKey({ key: Buffer.from(trust.publicKeySpkiDerBase64, "base64"), format: "der", type: "spki" });
    return verify(null, message(envelopeSha256), pub, Buffer.from(d.signatureBase64, "base64")) ? { ok: true, reason: `valid owner signature (key ${trust.publicKeyFingerprint.slice(0, 16)})` } : { ok: false, reason: "the owner signature does not verify" };
  } catch {
    return { ok: false, reason: "the owner signature does not verify" };
  }
}

export const resolveOwnerPaths = (ownerDir: string, ledgerDir?: string) => {
  const ld = resolve(ledgerDir ?? join(ownerDir, "..", "d24-runner", "ledger"));
  return { ledgerDir: ld, anchorFile: join(resolve(ownerDir), "ledger-anchor.json") };
};
