import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * H1: the support-context cookie is a signed, user-bound, time-bounded token, not a bare studio id. A hand-set, stale or other-admin cookie therefore
 * never resolves to a studio, so the audited `enterStudioContextAction` is the only way to obtain one.
 * Format: v2.<studioId>.<issuedAtSeconds>.<nonce 32 hex>.<hmac-sha256 hex over "v2|userId|studioId|issuedAt|nonce">, keyed from SUPABASE_SERVICE_ROLE_KEY.
 *
 * The nonce is the token's identity. It is written to the entry/switch audit row, and the token is only honoured while that row is the admin's most
 * recent support event (see platform-support-audit.ts), so an exit or a switch revokes every earlier token even though it is still authentic and unexpired.
 */
export const SUPPORT_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE = /^[0-9a-f]{32}$/;

export type SupportCookieClaims = { studioId: string; nonce: string };

function sign(userId: string, studioId: string, issuedAt: number, nonce: string): string | null {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return null;
  const key = createHmac("sha256", secret).update("platform-support-cookie-v2").digest();
  return createHmac("sha256", key).update(`v2|${userId.toLowerCase()}|${studioId}|${issuedAt}|${nonce}`).digest("hex");
}

export function newSupportNonce(): string {
  return randomBytes(16).toString("hex");
}

export function signSupportCookie(userId: string, studioId: string, nonce: string = newSupportNonce(), nowSeconds = Math.floor(Date.now() / 1000)): string | null {
  const id = studioId.toLowerCase();
  if (!NONCE.test(nonce)) return null;
  const mac = sign(userId, id, nowSeconds, nonce);
  return mac ? `v2.${id}.${nowSeconds}.${nonce}.${mac}` : null;
}

/** The studio id and nonce when the token is authentic, bound to `userId` and not older than the max age; otherwise null. Never throws. Authenticity only:
 *  whether the token is still the admin's CURRENT context is decided against the audit trail by the caller. */
export function parseSupportCookie(value: string | null | undefined, userId: string, nowSeconds = Math.floor(Date.now() / 1000)): SupportCookieClaims | null {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 5 || parts[0] !== "v2") return null;
  const [, studioId, issuedRaw, nonce, mac] = parts;
  if (!UUID.test(studioId) || !/^\d{1,12}$/.test(issuedRaw) || !NONCE.test(nonce)) return null;
  const issuedAt = Number(issuedRaw);
  if (issuedAt > nowSeconds + 60 || nowSeconds - issuedAt > SUPPORT_COOKIE_MAX_AGE_SECONDS) return null;
  const expected = sign(userId, studioId, issuedAt, nonce);
  if (!expected || !/^[0-9a-f]{64}$/.test(mac)) return null;
  return timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(expected, "hex")) ? { studioId, nonce } : null;
}

/** Studio id of an authentic token (no currency check). */
export function verifySupportCookie(value: string | null | undefined, userId: string, nowSeconds = Math.floor(Date.now() / 1000)): string | null {
  return parseSupportCookie(value, userId, nowSeconds)?.studioId ?? null;
}
