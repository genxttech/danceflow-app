import { createHash, randomBytes } from "node:crypto";

/**
 * Calendar feed secrets. The plaintext secret exists only in the HTTP response that creates or rotates a feed; the
 * database stores only its SHA-256 (see calendar_feed_tokens). 32 random bytes encode to exactly 43 base64url chars.
 */
export const FEED_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashFeedSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function generateFeedSecret(): { secret: string; hash: string; prefix: string } {
  const secret = randomBytes(32).toString("base64url");
  return { secret, hash: hashFeedSecret(secret), prefix: secret.slice(0, 6) };
}

/** Returns the secret if `raw` (a path segment, optionally ending in .ics) has exactly the shape we issue, else null. */
export function parseFeedSecret(raw: string | null | undefined): string | null {
  const candidate = String(raw ?? "").trim().replace(/\.ics$/i, "");
  return FEED_SECRET_PATTERN.test(candidate) ? candidate : null;
}
