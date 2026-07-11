import { createHash, timingSafeEqual } from "crypto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;

const PUBLIC_TOKEN_PATTERN = /^[A-Za-z0-9._~=-]+$/;

type NormalizePublicTokenOptions = {
  minLength?: number;
  maxLength?: number;
  allowUuid?: boolean;
};

export function normalizeUuidToken(value: string | null | undefined) {
  const token = String(value ?? "").trim();
  return UUID_PATTERN.test(token) ? token.toLowerCase() : null;
}

export function normalizePublicToken(
  value: string | null | undefined,
  options: NormalizePublicTokenOptions = {},
) {
  const token = String(value ?? "").trim();
  const minLength = options.minLength ?? 16;
  const maxLength = options.maxLength ?? 256;

  if (!token || token.length < minLength || token.length > maxLength) {
    return null;
  }

  if (options.allowUuid !== false && UUID_PATTERN.test(token)) {
    return token.toLowerCase();
  }

  if (!PUBLIC_TOKEN_PATTERN.test(token)) {
    return null;
  }

  return token;
}

export function sha256TokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function safeTokenEquals(a: string | null | undefined, b: string | null | undefined) {
  const left = String(a ?? "");
  const right = String(b ?? "");

  if (!left || !right) return false;

  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) return false;

  return timingSafeEqual(leftBuffer, rightBuffer);
}
