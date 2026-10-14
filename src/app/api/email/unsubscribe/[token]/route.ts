import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, getIpFromRequest, rateLimitKey } from "@/lib/security/rate-limit";
import { isUnsubscribeToken, marketingSiteOrigin } from "@/lib/marketing/compliance/unsubscribeLinks";

/**
 * Marketing M-0: the single marketing unsubscribe endpoint for every token kind (studio campaigns, organizer campaigns,
 * commercial ARIA / automation messages).
 *
 * POST (RFC 8058 one-click, sent by mailbox providers from the List-Unsubscribe-Post header, or the confirmation page's
 * form): no login, no cookies; the per-recipient token is the only credential. Idempotent and recorded with its method.
 * The response never reveals whether the token exists or whose it is.
 * GET never changes anything (mail scanners and link prefetchers follow links): it redirects to the confirmation page.
 */

export const dynamic = "force-dynamic";

const LIMIT = { limit: 30, windowMs: 60_000 };

function confirmationPath(kind: string | null, token: string) {
  const base = kind === "organizer" ? "/unsubscribe/organizer-marketing/" : "/unsubscribe/marketing/";
  return `${base}${encodeURIComponent(token)}`;
}

function redirectTo(path: string, status: 303) {
  return NextResponse.redirect(`${marketingSiteOrigin()}${path}`, status);
}

async function readForm(request: Request) {
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/x-www-form-urlencoded") && !type.includes("multipart/form-data")) return null;
  try {
    return await request.formData();
  } catch {
    return null;
  }
}

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const safe = isUnsubscribeToken(token) ? token.trim().toLowerCase() : "invalid";
  return redirectTo(confirmationPath(null, safe), 303);
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const form = await readForm(request);
  const fromPage = form?.get("df_source") === "page";
  const kindValue = form?.get("df_kind");
  const kind = typeof kindValue === "string" ? kindValue : null;
  const tokenValue = isUnsubscribeToken(token) ? token.trim().toLowerCase() : null;

  const limited = !checkRateLimit(rateLimitKey("email-unsubscribe", getIpFromRequest(request)), LIMIT).allowed;
  if (limited) {
    if (fromPage && tokenValue) return redirectTo(`${confirmationPath(kind, tokenValue)}?error=rate_limited`, 303);
    return new NextResponse("Too many requests.", { status: 429, headers: { "Retry-After": "60" } });
  }

  if (!tokenValue) {
    // Generic: an invalid token looks exactly like a processed one.
    if (fromPage) return redirectTo(`${confirmationPath(kind, "invalid")}?done=1`, 303);
    return new NextResponse("Unsubscribe request received.", { status: 200 });
  }

  let failed = false;
  try {
    const admin = createAdminClient();
    const { error } = await admin.rpc("marketing_unsubscribe_by_token", {
      p_token: tokenValue,
      p_method: fromPage ? "page_form" : "one_click",
    });
    failed = Boolean(error);
    if (error) console.error("marketing unsubscribe failed", { code: error.code });
  } catch {
    failed = true;
    console.error("marketing unsubscribe failed");
  }

  if (fromPage) {
    return redirectTo(`${confirmationPath(kind, tokenValue)}?${failed ? "error=unavailable" : "done=1"}`, 303);
  }
  if (failed) {
    // Not recorded: tell the mailbox provider to try again rather than claiming success.
    return new NextResponse("Unsubscribe is temporarily unavailable.", { status: 503, headers: { "Retry-After": "120" } });
  }
  return new NextResponse("Unsubscribe request received.", { status: 200 });
}
