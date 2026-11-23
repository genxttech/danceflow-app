/* eslint-disable @typescript-eslint/no-explicit-any -- loose PostgREST client shape */
import { createHash } from "node:crypto";
import { etagFor, renderCalendar } from "./ics";
import { loadFeedEvents, type FeedSubject, type SupabaseLike } from "./events";
import { hashFeedSecret, parseFeedSecret } from "./token";

/**
 * Public ICS feed handler (docs/integrations/Calendar_Feeds_Design.md).
 * Order: kill switch -> token shape -> resolve -> (miss: per-IP enumeration limit, uniform 404) / (hit: per-token limit) -> render -> ETag/304.
 * The per-IP bucket counts only MISSES: calendar providers fetch subscribed feeds from a small pool of shared IPs, so counting
 * successful fetches would throttle healthy subscribers. Every failure that is not a rate limit or a server fault is the SAME 404;
 * no DB text is ever returned. Limiter errors fail closed (503) in normal mode.
 */

export const IP_MISS_LIMIT = { limit: 300, windowSeconds: 3600 };
export const TOKEN_LIMIT = { limit: 60, windowSeconds: 3600 };

export type FeedHandlerDeps = {
  admin: SupabaseLike;
  now: () => Date;
  enabled: boolean;
};

const BASE_HEADERS: Record<string, string> = {
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
};

export function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" },
  });
}

export function unavailable(status: 429 | 503, retryAfter: number): Response {
  return new Response(status === 429 ? "Too many requests" : "Temporarily unavailable", {
    status,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Retry-After": String(Math.max(1, Math.trunc(retryAfter))),
    },
  });
}

/** Platform-set headers first (not client-appendable); IPv6 addresses are bucketed by /64 so rotating within a prefix does not bypass the limit. */
export function clientIp(request: Request): string {
  const raw =
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ||
    "unknown";
  if (raw.includes(":")) {
    const groups = raw.split(":");
    if (!raw.includes("::") && groups.length === 8) return groups.slice(0, 4).join(":") + "::/64";
    const head = raw.split("::")[0];
    return head.split(":").slice(0, 4).join(":") + "::/64";
  }
  return raw;
}

async function rateCheck(admin: SupabaseLike, key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfter: number } | null> {
  try {
    const { data, error } = await (admin as any).rpc("calendar_feed_rate_check", { p_key: key, p_limit: limit, p_window_seconds: windowSeconds });
    if (error) return null;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.allowed !== "boolean") return null;
    return { allowed: row.allowed, retryAfter: Number(row.retry_after_seconds) || 60 };
  } catch {
    return null; // the limiter is unavailable: callers fail closed
  }
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const candidate = part.trim().replace(/^W\//, "");
    return candidate === "*" || candidate === etag;
  });
}

/**
 * Fall-through mode is for legacy routes that must keep serving existing subscribers while the new feeds are dark:
 * any condition that would be a 404 or a server fault returns null so the caller continues with its legacy path, and
 * misses are NOT counted against the IP bucket (legacy tokens are misses by definition). A token this feature owns is
 * still rate limited per token. In normal mode nothing is ever null.
 */
async function run(request: Request, rawToken: string, deps: FeedHandlerDeps, fallthrough: boolean): Promise<Response | null> {
  const miss = () => (fallthrough ? null : notFound());
  const fault = () => (fallthrough ? null : unavailable(503, 60));
  if (!deps.enabled) return miss();

  const secret = parseFeedSecret(rawToken);
  if (!secret) return miss();
  const tokenHash = hashFeedSecret(secret);

  let subject: FeedSubject | null = null;
  try {
    const { data, error } = await (deps.admin as any).rpc("calendar_feed_resolve", { p_token_hash: tokenHash });
    if (error) return fault();
    const row = Array.isArray(data) ? data[0] : data;
    if (row) {
      subject = {
        studioId: row.studio_id,
        subjectKind: row.subject_kind,
        subjectUserId: row.subject_user_id,
        detailLevel: row.detail_level === "standard" ? "standard" : "minimal",
        includeClientIds: Array.isArray(row.include_client_ids) ? row.include_client_ids : null,
      };
    }
  } catch {
    return fault();
  }

  if (!subject) {
    if (fallthrough) return null;
    // Enumeration guard: only misses count against the IP bucket.
    const ip = await rateCheck(deps.admin, `ipmiss:${shortHash(clientIp(request))}`, IP_MISS_LIMIT.limit, IP_MISS_LIMIT.windowSeconds);
    if (!ip) return unavailable(503, 60);
    if (!ip.allowed) return unavailable(429, ip.retryAfter);
    return notFound();
  }

  const tok = await rateCheck(deps.admin, `tok:${tokenHash.slice(0, 24)}`, TOKEN_LIMIT.limit, TOKEN_LIMIT.windowSeconds);
  if (!tok) return fault();
  if (!tok.allowed) return unavailable(429, tok.retryAfter);

  let body: string;
  try {
    const { calendarName, events } = await loadFeedEvents(deps.admin, subject, deps.now());
    body = renderCalendar({ calendarName, events });
  } catch {
    return fault();
  }

  const etag = etagFor(body);
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    ETag: etag,
    "Cache-Control": "private, max-age=0, must-revalidate",
  };
  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, {
    status: 200,
    headers: {
      ...headers,
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="danceflow.ics"',
    },
  });
}

export async function handleFeedRequest(request: Request, rawToken: string, deps: FeedHandlerDeps): Promise<Response> {
  return (await run(request, rawToken, deps, false)) ?? notFound();
}

export function tryHandleFeedRequest(request: Request, rawToken: string, deps: FeedHandlerDeps): Promise<Response | null> {
  return run(request, rawToken, deps, true);
}
