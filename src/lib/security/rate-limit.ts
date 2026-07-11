import { headers } from "next/headers";
import { NextResponse } from "next/server";

type RateLimitBucket = { count: number; resetAt: number };
type HeaderReader = { get(name: string): string | null };

type RateLimitOptions = {
  limit: number;
  windowMs: number;
};

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
  headers: Record<string, string>;
};

const MAX_BUCKETS = 5000;
const DEFAULT_LIMIT_MESSAGE = "Too many requests. Please wait a moment and try again.";

function getStore(): Map<string, RateLimitBucket> {
  const globalStore = globalThis as typeof globalThis & {
    __danceflowRateLimitBuckets?: Map<string, RateLimitBucket>;
  };

  if (!globalStore.__danceflowRateLimitBuckets) {
    globalStore.__danceflowRateLimitBuckets = new Map();
  }

  return globalStore.__danceflowRateLimitBuckets;
}

function sanitizeKeyPart(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9@._:-]/g, "_")
    .slice(0, 160);
}

export function rateLimitKey(...parts: Array<unknown>) {
  return parts.map(sanitizeKeyPart).filter(Boolean).join(":");
}

function cleanupExpiredBuckets(now: number) {
  const store = getStore();
  if (store.size < MAX_BUCKETS) return;

  for (const [key, bucket] of store.entries()) {
    if (bucket.resetAt <= now) store.delete(key);
  }

  if (store.size < MAX_BUCKETS) return;

  let removed = 0;
  const extraCount = store.size - MAX_BUCKETS;
  for (const key of store.keys()) {
    store.delete(key);
    removed += 1;
    if (removed >= extraCount) break;
  }
}

export function checkRateLimit(key: string, options: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const limit = Math.max(1, Math.trunc(options.limit));
  const windowMs = Math.max(1000, Math.trunc(options.windowMs));
  const store = getStore();
  cleanupExpiredBuckets(now);

  const current = store.get(key);
  const bucket = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : current;

  bucket.count += 1;
  store.set(key, bucket);

  const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  const remaining = Math.max(0, limit - bucket.count);

  return {
    allowed: bucket.count <= limit,
    limit,
    remaining,
    resetAt: bucket.resetAt,
    retryAfterSeconds,
    headers: {
      "Retry-After": String(retryAfterSeconds),
      "X-RateLimit-Limit": String(limit),
      "X-RateLimit-Remaining": String(remaining),
      "X-RateLimit-Reset": String(Math.ceil(bucket.resetAt / 1000)),
    },
  };
}

export function getIpFromHeaders(headerReader: HeaderReader) {
  const forwardedFor = headerReader.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = headerReader.get("x-real-ip")?.trim();
  const vercelIp = headerReader.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  const cfIp = headerReader.get("cf-connecting-ip")?.trim();
  return forwardedFor || realIp || vercelIp || cfIp || "unknown-ip";
}

export function getIpFromRequest(request: Request) {
  return getIpFromHeaders(request.headers);
}

export async function getServerActionRateLimitKey(scope: string, parts: Array<unknown> = []) {
  const headerStore = await headers();
  return rateLimitKey(scope, getIpFromHeaders(headerStore), ...parts);
}

export function rateLimitedJson(result: RateLimitResult, message = DEFAULT_LIMIT_MESSAGE) {
  return NextResponse.json(
    { error: message, retryAfterSeconds: result.retryAfterSeconds },
    { status: 429, headers: result.headers },
  );
}

export function rateLimitedRedirect(request: Request, path: string, result: RateLimitResult) {
  return NextResponse.redirect(new URL(path, request.url), {
    status: 303,
    headers: result.headers,
  });
}

export function rateLimitErrorMessage(result: RateLimitResult) {
  const minutes = Math.ceil(result.retryAfterSeconds / 60);
  const waitLabel = result.retryAfterSeconds >= 60
    ? `${minutes} minute${minutes === 1 ? "" : "s"}`
    : `${result.retryAfterSeconds} second${result.retryAfterSeconds === 1 ? "" : "s"}`;
  return `Too many requests. Please wait ${waitLabel} and try again.`;
}
