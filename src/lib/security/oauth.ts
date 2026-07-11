import "server-only";

import { randomBytes, timingSafeEqual } from "node:crypto";

export type OAuthStateCookieValue = {
  state: string;
  studioId: string;
  userId: string;
  createdAt: number;
};

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;

function safeString(value: unknown, maxLength = 256) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim().slice(0, maxLength)
    : "";
}

function isSafeId(value: unknown) {
  return ID_PATTERN.test(safeString(value, 64));
}

function hasValidTokenMatch(left: string | null | undefined, right: string | null | undefined) {
  const normalizedLeft = safeString(left, 256);
  const normalizedRight = safeString(right, 256);

  if (!TOKEN_PATTERN.test(normalizedLeft) || !TOKEN_PATTERN.test(normalizedRight)) return false;

  const leftBuffer = Buffer.from(normalizedLeft);
  const rightBuffer = Buffer.from(normalizedRight);

  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function oauthStateCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 10 * 60,
  };
}

export function createOAuthStateCookieValue(params: { studioId: string; userId: string }) {
  if (!isSafeId(params.studioId) || !isSafeId(params.userId)) {
    throw new Error("OAuth state could not be created for this workspace.");
  }

  const state = randomBytes(32).toString("base64url");
  const cookieValue = JSON.stringify({
    state,
    studioId: params.studioId,
    userId: params.userId,
    createdAt: Date.now(),
  } satisfies OAuthStateCookieValue);

  return { state, cookieValue };
}

export function parseOAuthStateCookie(value: string | null | undefined) {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Partial<OAuthStateCookieValue>;
    const state = safeString(parsed.state, 256);
    const studioId = safeString(parsed.studioId, 64);
    const userId = safeString(parsed.userId, 64);
    const createdAt = Number(parsed.createdAt);

    if (!TOKEN_PATTERN.test(state) || !isSafeId(studioId) || !isSafeId(userId)) return null;
    if (!Number.isFinite(createdAt) || createdAt <= 0) return null;

    return { state, studioId, userId, createdAt } satisfies OAuthStateCookieValue;
  } catch {
    return null;
  }
}

export function isValidOAuthState(params: {
  expected: OAuthStateCookieValue | null;
  returnedState: string | null | undefined;
  studioId: string;
  userId: string;
  maxAgeMs?: number;
}) {
  const maxAgeMs = params.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const expected = params.expected;

  if (!expected) return false;
  if (expected.studioId !== params.studioId || expected.userId !== params.userId) return false;
  if (Date.now() - expected.createdAt > maxAgeMs) return false;

  return hasValidTokenMatch(expected.state, params.returnedState);
}

export function safeOAuthErrorCode(value: string | null | undefined) {
  const code = safeString(value, 80).replace(/[^A-Za-z0-9_-]/g, "_");
  return code || "oauth_error";
}
