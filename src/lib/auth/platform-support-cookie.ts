import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * H1: the support-context cookie is a signed, user-bound, time-bounded token, not a bare studio id. A hand-set, stale or other-admin cookie therefore
 * never resolves to a studio, so the audited `enterStudioContextAction` is the only way to obtain one.
 * Format: v1.<studioId>.<issuedAtSeconds>.<hmac-sha256 hex over "v1|userId|studioId|issuedAt">, keyed from SUPABASE_SERVICE_ROLE_KEY (server only).
 */
export const SUPPORT_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sign(userId: string, studioId: string, issuedAt: number): string | null {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return null;
  const key = createHmac("sha256", secret).update("platform-support-cookie-v1").digest();
  return createHmac("sha256", key).update(`v1|${userId.toLowerCase()}|${studioId}|${issuedAt}`).digest("hex");
}

export function signSupportCookie(userId: string, studioId: string, nowSeconds = Math.floor(Date.now() / 1000)): string | null {
  const id = studioId.toLowerCase();
  const mac = sign(userId, id, nowSeconds);
  return mac ? `v1.${id}.${nowSeconds}.${mac}` : null;
}

/** The studio id when the token is authentic, bound to `userId` and not older than the max age; otherwise null. Never throws. */
export function verifySupportCookie(value: string | null | undefined, userId: string, nowSeconds = Math.floor(Date.now() / 1000)): string | null {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [, studioId, issuedRaw, mac] = parts;
  if (!UUID.test(studioId) || !/^\d{1,12}$/.test(issuedRaw)) return null;
  const issuedAt = Number(issuedRaw);
  if (issuedAt > nowSeconds + 60 || nowSeconds - issuedAt > SUPPORT_COOKIE_MAX_AGE_SECONDS) return null;
  const expected = sign(userId, studioId, issuedAt);
  if (!expected || !/^[0-9a-f]{64}$/.test(mac)) return null;
  return timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(expected, "hex")) ? studioId : null;
}
