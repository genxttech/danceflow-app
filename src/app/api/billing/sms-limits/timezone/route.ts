import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseAdmin } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";
import { MonthlyLimitError, setEntityTimezone, smsMonthlyLimitsEnabled } from "@/lib/billing/smsMonthlyLimits";

/** Studio owner changes the legal business's timezone for spending months. Takes effect from the NEXT calendar month (the database decides), audited. Dark by default. */
function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase admin environment variables.");
  return createSupabaseAdmin(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const STATUS: Record<string, number> = { not_authorized: 403, no_legal_business: 409, invalid: 400, above_ceiling: 409, blocked: 409, reauth_required: 403, unavailable: 503 };

export async function POST(request: NextRequest) {
  if (!smsMonthlyLimitsEnabled()) return new NextResponse(null, { status: 404 });

  const limit = checkRateLimit(rateLimitKey("billing:sms-limit-timezone", getIpFromRequest(request)), { limit: 6, windowMs: 10 * 60 * 1000 });
  if (!limit.allowed) return rateLimitedJson(limit);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to change the timezone." }, { status: 401 });
  const context = await getCurrentStudioContext();
  if (!context?.studioId) return NextResponse.json({ error: "Choose a studio first." }, { status: 400 });

  let body: { timezone?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Choose a timezone." }, { status: 400 });
  }
  const timezone = typeof body?.timezone === "string" ? body.timezone.trim() : "";
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!timezone || timezone.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(timezone) || reason.length < 3 || reason.length > 300) {
    return NextResponse.json({ error: "Choose a timezone and say why it is changing." }, { status: 400 });
  }

  try {
    return NextResponse.json(await setEntityTimezone(admin(), { studioId: context.studioId, userId: user.id, timezone, reason }));
  } catch (error) {
    if (error instanceof MonthlyLimitError) return NextResponse.json({ error: error.message, code: error.code }, { status: STATUS[error.code] ?? 400 });
    return NextResponse.json({ error: "Spending limits are not available right now." }, { status: 503 });
  }
}
