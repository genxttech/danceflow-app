import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseAdmin } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";
import { MonthlyLimitError, setMonthlyLimit, smsMonthlyLimitsEnabled } from "@/lib/billing/smsMonthlyLimits";

/**
 * Studio owner sets the monthly spending limit for routine messaging costs. Dark by default (404 unless SMS_MONTHLY_LIMITS=on). The studio and the user come from the
 * signed-in session, never the body; the database function behind it is service-role only, re-checks that the user is an OWNER, requires the explicit confirmation, keeps
 * the limit within the platform safety ceiling, and for an increase also requires a recent sign-in, no hold and a non-negative balance. Setting a limit moves no money.
 */
function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase admin environment variables.");
  return createSupabaseAdmin(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const STATUS: Record<string, number> = { not_authorized: 403, no_legal_business: 409, invalid: 400, above_ceiling: 409, blocked: 409, reauth_required: 403, unavailable: 503 };

export async function POST(request: NextRequest) {
  if (!smsMonthlyLimitsEnabled()) return new NextResponse(null, { status: 404 });

  const limit = checkRateLimit(rateLimitKey("billing:sms-limit-set", getIpFromRequest(request)), { limit: 10, windowMs: 10 * 60 * 1000 });
  if (!limit.allowed) return rateLimitedJson(limit);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to change the limit." }, { status: 401 });
  const context = await getCurrentStudioContext();
  if (!context?.studioId) return NextResponse.json({ error: "Choose a studio first." }, { status: 400 });

  let body: { limitCents?: unknown; confirmed?: unknown; effectiveMonth?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Check the amount and try again." }, { status: 400 });
  }
  const limitCents = Number(body?.limitCents);
  const effectiveMonth = body?.effectiveMonth == null ? null : String(body.effectiveMonth);
  if (!Number.isInteger(limitCents) || limitCents < 0 || limitCents > 1_000_000 || body?.confirmed !== true || (effectiveMonth !== null && !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(effectiveMonth))) {
    return NextResponse.json({ error: "Check the amount, then confirm the change." }, { status: 400 });
  }
  const reason = typeof body?.reason === "string" ? body.reason.slice(0, 300) : null;

  try {
    const result = await setMonthlyLimit(admin(), { studioId: context.studioId, userId: user.id, limitCents, confirmed: true, effectiveMonth, reason });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof MonthlyLimitError) return NextResponse.json({ error: error.message, code: error.code }, { status: STATUS[error.code] ?? 400 });
    return NextResponse.json({ error: "Spending limits are not available right now." }, { status: 503 });
  }
}
