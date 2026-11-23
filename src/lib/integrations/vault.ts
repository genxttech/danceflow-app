import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Integration secret vault (S0-g1).
 *
 *   v1.<iv>.<tag>.<ct>            legacy: single key from INTEGRATION_TOKEN_ENCRYPTION_KEY, no key id, no context binding.
 *   v2.<kid>.<iv>.<tag>.<ct>      key id in the clear; optional context string bound as AES-GCM additional authenticated data.
 *
 * Keys: INTEGRATION_TOKEN_ENCRYPTION_KEY is key id "k1" (32 bytes, hex or base64). INTEGRATION_TOKEN_ENCRYPTION_KEYS is an optional
 * JSON object {"<kid>": "<32 byte hex|base64>"} for rotation; INTEGRATION_TOKEN_ACTIVE_KEY_ID picks the key new v2 secrets use (default "k1").
 * Decrypt accepts v1 and v2. encryptIntegrationSecret keeps emitting v1 until every running instance can read v2 (plan decision D-S0-2).
 */
export const LEGACY_KEY_ID = "k1";
const KID_PATTERN = /^[a-z0-9_-]{1,32}$/;

function parseKey(raw: string, label: string) {
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`${label} must encode exactly 32 bytes.`);
  return key;
}

/** Only the requested key is parsed, so a typo in the rotation keyring can never break decryption of "k1" (legacy) secrets. "k1" always means INTEGRATION_TOKEN_ENCRYPTION_KEY; an entry named k1 in the JSON is ignored. */
function keyFor(kid: string) {
  if (!KID_PATTERN.test(kid)) throw new Error("Invalid integration key id.");
  if (kid === LEGACY_KEY_ID) {
    const legacy = process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY;
    if (!legacy) throw new Error(`Integration encryption key "${kid}" is not configured.`);
    return parseKey(legacy, "INTEGRATION_TOKEN_ENCRYPTION_KEY");
  }
  const extra = process.env.INTEGRATION_TOKEN_ENCRYPTION_KEYS;
  if (!extra) throw new Error(`Integration encryption key "${kid}" is not configured.`);
  let parsed: unknown;
  try { parsed = JSON.parse(extra); } catch { throw new Error("INTEGRATION_TOKEN_ENCRYPTION_KEYS must be a JSON object."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INTEGRATION_TOKEN_ENCRYPTION_KEYS must be a JSON object.");
  const value = Object.prototype.hasOwnProperty.call(parsed, kid) ? (parsed as Record<string, unknown>)[kid] : undefined;
  if (value === undefined) throw new Error(`Integration encryption key "${kid}" is not configured.`);
  if (typeof value !== "string") throw new Error("Invalid integration key value.");
  return parseKey(value, `Integration key ${kid}`);
}

/** The key id is part of the authenticated data, so a swapped header fails authentication. */
function v2Aad(kid: string, context: string) { return Buffer.from(`v2.${kid}\n${context}`, "utf8"); }

export function activeIntegrationKeyId() {
  const kid = process.env.INTEGRATION_TOKEN_ACTIVE_KEY_ID || LEGACY_KEY_ID;
  if (!KID_PATTERN.test(kid)) throw new Error("Invalid integration key id.");
  return kid;
}

/** Legacy v1 output. */
export function encryptIntegrationSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(LEGACY_KEY_ID), iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** v2 output under the active key id; `context` (for example "google_calendar:access") must be supplied again to decrypt. */
export function encryptIntegrationSecretV2(value: string, context = "") {
  const kid = activeIntegrationKeyId();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(kid), iv, { authTagLength: 16 });
  cipher.setAAD(v2Aad(kid, context));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v2", kid, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptIntegrationSecret(value: string, context = "") {
  const parts = value.split(".");
  let kid: string;
  let ivValue: string | undefined;
  let tagValue: string | undefined;
  let ciphertextValue: string | undefined;
  let aad: Buffer | null = null;
  if (parts[0] === "v1" && parts.length === 4) {
    kid = LEGACY_KEY_ID;
    [, ivValue, tagValue, ciphertextValue] = parts;
  } else if (parts[0] === "v2" && parts.length === 5 && KID_PATTERN.test(parts[1])) {
    kid = parts[1];
    [, , ivValue, tagValue, ciphertextValue] = parts;
    aad = v2Aad(kid, context);
  } else {
    throw new Error("Unsupported encrypted integration secret.");
  }
  if (!ivValue || !tagValue || !ciphertextValue) throw new Error("Unsupported encrypted integration secret.");
  const iv = Buffer.from(ivValue, "base64url");
  const tag = Buffer.from(tagValue, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Unsupported encrypted integration secret.");
  const decipher = createDecipheriv("aes-256-gcm", keyFor(kid), iv, { authTagLength: 16 });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
}

/** Which key id a stored secret needs (for rotation reports); null when the format is not recognised. Never decrypts. */
export function integrationSecretKeyId(value: string) {
  const parts = value.split(".");
  if (parts[0] === "v1" && parts.length === 4) return LEGACY_KEY_ID;
  if (parts[0] === "v2" && parts.length === 5 && KID_PATTERN.test(parts[1])) return parts[1];
  return null;
}
