import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * TW-4A: EIN protection (design 18.6). SERVER ONLY: never import this from a client component.
 *
 * AES-256-GCM with a key held in an environment secret (`SMS_EIN_ENCRYPTION_KEY`, base64 of 32 random bytes) that never
 * reaches the database. The studio id is bound as additional authenticated data, so a ciphertext copied to another
 * studio's row cannot be decrypted there. Token format: `<keyId>.<iv>.<tag>.<ciphertext>` (base64url parts). The plaintext
 * exists only inside `encryptEin` (right after the owner submits it) and, later, inside the one orchestrator step that
 * creates the Twilio EndUser. It is never logged, audited, or returned to a browser; the database keeps the ciphertext and
 * the last four digits only, and purges the ciphertext (see `purge_sms_onboarding_ein`).
 *
 * Key rotation: a new `SMS_EIN_ENCRYPTION_KEY_ID` + key encrypt new values; decrypting an old value needs its old key
 * (`SMS_EIN_ENCRYPTION_KEY_<ID>`), which is retained only until old ciphertexts are purged.
 */

const KEY_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;
const ALGORITHM = "aes-256-gcm";

export class EinCryptoError extends Error {
  constructor(public readonly code: "key_missing" | "key_invalid" | "format_invalid" | "decrypt_failed") {
    super(`EIN crypto failure: ${code}`);
    this.name = "EinCryptoError";
  }
}

type Env = Record<string, string | undefined>;

function keyIdFrom(env: Env): string {
  const id = String(env.SMS_EIN_ENCRYPTION_KEY_ID ?? "v1").trim();
  if (!KEY_ID_PATTERN.test(id)) throw new EinCryptoError("key_invalid");
  return id;
}

function readKey(raw: string | undefined): Buffer {
  const text = String(raw ?? "").trim();
  if (!text) throw new EinCryptoError("key_missing");
  const key = Buffer.from(text, "base64");
  if (key.length !== 32) throw new EinCryptoError("key_invalid");
  return key;
}

function aad(studioId: string) {
  return Buffer.from(`sms-onboarding-ein:${studioId}`, "utf8");
}

const b64 = (buffer: Buffer) => buffer.toString("base64url");

export function einEncryptionConfigured(env: Env = process.env): boolean {
  try {
    readKey(env.SMS_EIN_ENCRYPTION_KEY);
    keyIdFrom(env);
    return true;
  } catch {
    return false;
  }
}

export function encryptEin(studioId: string, ein: { digits: string; last4: string }, env: Env = process.env) {
  const keyId = keyIdFrom(env);
  const key = readKey(env.SMS_EIN_ENCRYPTION_KEY);
  if (!/^\d{9}$/.test(ein.digits) || ein.digits.slice(5) !== ein.last4) throw new EinCryptoError("format_invalid");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad(studioId));
  const ciphertext = Buffer.concat([cipher.update(ein.digits, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { keyId, ciphertext: `${keyId}.${b64(iv)}.${b64(tag)}.${b64(ciphertext)}`, last4: ein.last4 };
}

/** For the orchestrator (slice 4C). Returns the 9 digits; the caller must not log them. */
export function decryptEin(studioId: string, token: string, env: Env = process.env): string {
  const parts = String(token).split(".");
  if (parts.length !== 4 || !KEY_ID_PATTERN.test(parts[0])) throw new EinCryptoError("format_invalid");
  const [keyId, ivPart, tagPart, ctPart] = parts;
  const currentId = keyIdFrom(env);
  const rawKey = keyId === currentId ? env.SMS_EIN_ENCRYPTION_KEY : env[`SMS_EIN_ENCRYPTION_KEY_${keyId.toUpperCase().replace(/-/g, "_")}`];
  const key = readKey(rawKey);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, "base64url"));
    decipher.setAAD(aad(studioId));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    const plain = Buffer.concat([decipher.update(Buffer.from(ctPart, "base64url")), decipher.final()]).toString("utf8");
    if (!/^\d{9}$/.test(plain)) throw new EinCryptoError("decrypt_failed");
    return plain;
  } catch (error) {
    if (error instanceof EinCryptoError) throw error;
    throw new EinCryptoError("decrypt_failed");
  }
}
