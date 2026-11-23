/**
 * New Student Intake -- invitation token, session token, email code and rate-limit key helpers (spec 5.1, 5.3, 4.3).
 *
 * Pure functions over Node crypto; no I/O, no database, no email. The signing secret is read from the environment variable
 * NAMED `INTAKE_ROOT_SECRET` (and, during rotation, `INTAKE_ROOT_SECRET_PREVIOUS`) by `loadIntakeKeyring`; this file never
 * contains or logs a secret value, and no default exists: a missing or weak secret throws.
 *
 * Token = `{kid}.{base64url(HMAC-SHA256(subkey, domain || invitation_id(16B) || generation(u32 BE) || token_salt(16B)))}`.
 * The database stores only `sha256(token)` and the salt. A database leak cannot mint tokens without the secret; a secret leak
 * cannot mint tokens without the salts. Tokens are re-derivable (a retry produces identical bytes) and are never persisted.
 */
import { createHash, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const INTAKE_ROOT_SECRET_ENV = "INTAKE_ROOT_SECRET";
export const INTAKE_ROOT_SECRET_PREVIOUS_ENV = "INTAKE_ROOT_SECRET_PREVIOUS";

/** The signing secret must decode to exactly 32 random bytes: 64 hex characters, or 43/44 base64 or base64url characters. */
export const SECRET_BYTES = 32;
export const TOKEN_SALT_BYTES = 16;
const SESSION_TOKEN_BYTES = 32;
const KID_BYTES = 6;

type KeyPurpose = "invitation" | "otp" | "ratelimit";
const SUBKEY_INFO: Record<KeyPurpose, string> = { invitation: "intake/invitation/v1", otp: "intake/otp/v1", ratelimit: "intake/ratelimit/v1" };
const KID_INFO = "intake/kid/v1";
/** Fixed domain separators (fixed length, so concatenation is unambiguous). */
const INVITATION_DOMAIN = Buffer.from("intake/invitation-token/v1\0", "utf8");
const OTP_DOMAIN = Buffer.from("intake/email-code/v1\0", "utf8");

/** Never carries the secret in its message. */
export class IntakeSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeSecretError";
  }
}

export type IntakeKey = { kid: string; secret: Buffer };
export type IntakeKeyring = { current: IntakeKey; previous: IntakeKey[] };

function hkdf(secret: Buffer, info: string, length: number): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), Buffer.from(info, "utf8"), length));
}

/** Key id: a short, non-reversible label derived with HKDF so it can be stored and compared without revealing the secret. */
export function keyIdOf(secret: Buffer): string {
  return hkdf(secret, KID_INFO, KID_BYTES).toString("base64url");
}

/** Decodes a configured secret to its raw bytes, or null when it is not exactly SECRET_BYTES of encoded random data. */
export function decodeSecret(value: string): Buffer | null {
  const t = value.trim();
  let bytes: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(t)) bytes = Buffer.from(t, "hex");
  else if (/^[A-Za-z0-9+/]{43}=?$/.test(t)) bytes = Buffer.from(t, "base64");
  else if (/^[A-Za-z0-9_-]{43}$/.test(t)) bytes = Buffer.from(t, "base64url");
  if (!bytes || bytes.length !== SECRET_BYTES) return null;
  // a degenerate value (all bytes equal) is a placeholder, not random data
  if (bytes.every((b) => b === bytes![0])) return null;
  return bytes;
}

function toKey(value: string, name: string): IntakeKey {
  const secret = decodeSecret(value);
  if (!secret) throw new IntakeSecretError(`${name} must be ${SECRET_BYTES} random bytes (64 hex or 43-44 base64 characters)`);
  return { kid: keyIdOf(secret), secret };
}

/**
 * Reads the current key (INTAKE_ROOT_SECRET) and any previous keys (INTAKE_ROOT_SECRET_PREVIOUS, comma separated). Previous keys
 * only re-derive tokens for in-flight deliveries during a rotation; new invitations always use the current key. Throws
 * IntakeSecretError, without ever echoing a secret, when the current key is missing or weak or two keys collide.
 */
export function loadIntakeKeyring(env: Record<string, string | undefined> = process.env): IntakeKeyring {
  const rawCurrent = env[INTAKE_ROOT_SECRET_ENV];
  if (!rawCurrent || !rawCurrent.trim()) throw new IntakeSecretError(`${INTAKE_ROOT_SECRET_ENV} is not configured`);
  const current = toKey(rawCurrent, INTAKE_ROOT_SECRET_ENV);
  const previous = (env[INTAKE_ROOT_SECRET_PREVIOUS_ENV] ?? "")
    .split(",")
    .filter((v) => v.trim())
    .map((v) => toKey(v, INTAKE_ROOT_SECRET_PREVIOUS_ENV));
  const kids = [current.kid, ...previous.map((k) => k.kid)];
  if (new Set(kids).size !== kids.length) throw new IntakeSecretError("intake signing keys must be distinct");
  return { current, previous };
}

function keyFor(ring: IntakeKeyring, kid: string): IntakeKey | null {
  if (ring.current.kid === kid) return ring.current;
  return ring.previous.find((k) => k.kid === kid) ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidBytes(id: string): Buffer {
  if (!UUID_RE.test(id)) throw new TypeError("not a uuid");
  return Buffer.from(id.replace(/-/g, ""), "hex");
}
function u32(n: number): Buffer {
  if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) throw new RangeError("generation must be an integer between 1 and 2^32-1");
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

export type InvitationMaterial = { invitationId: string; tokenSalt: Buffer };
/** Fresh identifiers for a new invitation: generated in the app, passed to the database next to `sha256(token)`. */
export function newInvitationMaterial(): InvitationMaterial {
  return { invitationId: randomUUID(), tokenSalt: randomBytes(TOKEN_SALT_BYTES) };
}

export type InvitationParts = { invitationId: string; generation: number; tokenSalt: Buffer };

/** Derives the invitation token. `kid` defaults to the current key; pass a stored kid to re-derive with a previous key. */
export function deriveInvitationToken(ring: IntakeKeyring, parts: InvitationParts, kid: string = ring.current.kid): string {
  const key = keyFor(ring, kid);
  if (!key) throw new IntakeSecretError("no signing key for this key id");
  if (parts.tokenSalt.length !== TOKEN_SALT_BYTES) throw new RangeError(`token salt must be ${TOKEN_SALT_BYTES} bytes`);
  const sub = hkdf(key.secret, SUBKEY_INFO.invitation, 32);
  const mac = createHmac("sha256", sub).update(INVITATION_DOMAIN).update(uuidBytes(parts.invitationId)).update(u32(parts.generation)).update(parts.tokenSalt).digest();
  return `${key.kid}.${mac.toString("base64url")}`;
}

const TOKEN_RE = /^([A-Za-z0-9_-]{8})\.([A-Za-z0-9_-]{43})$/;
/** Strict shape check. Anything else is "not a token" and must get the same generic response as an unknown token. */
export function parseInvitationToken(token: unknown): { kid: string; mac: string } | null {
  if (typeof token !== "string") return null;
  const m = TOKEN_RE.exec(token);
  return m ? { kid: m[1], mac: m[2] } : null;
}

/** The value the database stores and looks up by. */
export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** PostgREST/Postgres `bytea` hex input form (`\x...`). */
export function toPgBytea(bytes: Buffer): string {
  return `\\x${bytes.toString("hex")}`;
}

/** Reads the token from a link fragment such as `#t=<token>`; returns null for anything else. */
export function tokenFromFragment(fragment: string): string | null {
  const m = /^#?t=([A-Za-z0-9_.-]{1,128})$/.exec(fragment);
  return m && parseInvitationToken(m[1]) ? m[1] : null;
}

export function safeEqualBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Session cookie value: 256 random bits. Only `hashToken(value)` is passed to the database. */
export function newSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}
export function sessionHash(sessionToken: string): Buffer {
  return hashToken(sessionToken);
}

/**
 * Six-digit guardian email code, derived from the challenge id (never stored; a retry re-sends the same code). Rejection sampling
 * keeps the digits uniform.
 */
export function deriveEmailCode(ring: IntakeKeyring, challengeId: string, kid: string = ring.current.kid): string {
  const key = keyFor(ring, kid);
  if (!key) throw new IntakeSecretError("no signing key for this key id");
  const sub = hkdf(key.secret, SUBKEY_INFO.otp, 32);
  for (let counter = 0; counter < 255; counter += 1) {
    const mac = createHmac("sha256", sub).update(OTP_DOMAIN).update(uuidBytes(challengeId)).update(Buffer.from([counter])).digest();
    const n = mac.readUInt32BE(0);
    if (n < 4_294_000_000) return String(n % 1_000_000).padStart(6, "0"); // largest multiple of 10^6 below 2^32
  }
  throw new Error("unreachable: rejection sampling exhausted");
}

export type RateLimitKind = "token" | "ip" | "email" | "request";
/**
 * Keyed bucket key: HMAC-SHA256(HKDF subkey "intake/ratelimit/v1", kind || window_seconds || value). The database never sees an
 * email address, IP address or token in clear, and without the secret a stored key cannot be tested against a guessed value
 * (the keys are pseudonymous, not anonymous). The window length is part of the key, so different windows never share a counter.
 */
export function rateLimitBucket(ring: IntakeKeyring, kind: RateLimitKind, windowSeconds: number, value: string): Buffer {
  const normalized = kind === "email" ? value.trim().toLowerCase() : value.trim();
  if (!normalized) throw new RangeError("rate-limit key is empty");
  if (!Number.isInteger(windowSeconds) || windowSeconds < 10 || windowSeconds > 86400) throw new RangeError("window must be 10 to 86400 seconds");
  const sub = hkdf(ring.current.secret, SUBKEY_INFO.ratelimit, 32);
  const w = Buffer.alloc(4);
  w.writeUInt32BE(windowSeconds, 0);
  return createHmac("sha256", sub).update(Buffer.from(`${kind}\0`, "utf8")).update(w).update(Buffer.from(normalized, "utf8")).digest();
}
