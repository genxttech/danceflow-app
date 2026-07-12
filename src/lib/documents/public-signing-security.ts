import { createHash } from "node:crypto";
import { headers } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

export type PublicSigningRateLimitAction =
  | "page_view"
  | "source_pdf"
  | "signed_pdf"
  | "complete"
  | "decline";

const LIMITS: Record<PublicSigningRateLimitAction, { limit: number; windowSeconds: number }> = {
  page_view: { limit: 120, windowSeconds: 60 },
  source_pdf: { limit: 60, windowSeconds: 60 },
  signed_pdf: { limit: 30, windowSeconds: 60 },
  complete: { limit: 8, windowSeconds: 15 * 60 },
  decline: { limit: 5, windowSeconds: 15 * 60 },
};

function normalizeIp(value: string | null) {
  return String(value ?? "unknown")
    .split(",")[0]
    .trim()
    .slice(0, 128) || "unknown";
}

export function requestIp(request: Request) {
  return normalizeIp(
    request.headers.get("x-forwarded-for") ??
      request.headers.get("x-real-ip") ??
      request.headers.get("cf-connecting-ip") ??
      request.headers.get("x-vercel-forwarded-for"),
  );
}

export async function serverActionIp() {
  const store = await headers();
  return normalizeIp(
    store.get("x-forwarded-for") ??
      store.get("x-real-ip") ??
      store.get("cf-connecting-ip") ??
      store.get("x-vercel-forwarded-for"),
  );
}

export function privacyKey(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function consumePublicSigningRateLimit(
  admin: SupabaseClient,
  args: {
    action: PublicSigningRateLimitAction;
    tokenHash: string;
    ip: string;
  },
) {
  const config = LIMITS[args.action];
  const { data, error } = await admin.rpc("consume_document_sign_rate_limit", {
    p_scope: args.action,
    p_key_hash: privacyKey(`${args.tokenHash}:${args.ip}`),
    p_limit: config.limit,
    p_window_seconds: config.windowSeconds,
  });

  if (error) {
    console.error("Document signing rate limit check failed", {
      action: args.action,
      message: error.message,
    });
    return { allowed: false, retryAfterSeconds: 60 };
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: Boolean(row?.allowed),
    retryAfterSeconds: Math.max(1, Number(row?.retry_after_seconds ?? 60)),
  };
}

export const PUBLIC_PDF_HEADERS = {
  "Content-Type": "application/pdf",
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
} as const;
