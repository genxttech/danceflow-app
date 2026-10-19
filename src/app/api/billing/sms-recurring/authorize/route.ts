import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseAdmin } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";
import { authorizeRecurring, isRecurringKind, RECURRING_TERMS, RecurringError, smsRecurringAuthorizationEnabled } from "@/lib/billing/smsRecurring";

/**
 * Studio owner authorizes a recurring SMS service charge (number rent or campaign monthly fee) for THIS studio. Dark by default (404 unless
 * SMS_RECURRING_AUTHORIZATION=on), and the database function behind it is service-role only, so this route is the only way in. The studio comes from the
 * signed-in user's own context; the database re-checks that user is an OWNER of it and writes the acknowledgement text itself. Authorizing charges nothing:
 * charges are taken later, from settled prepaid credit only.
 */
function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase admin environment variables.");
  return createSupabaseAdmin(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const STATUS: Record<string, number> = { not_authorized: 403, no_legal_business: 409, price_changed: 409, already_authorized: 409, invalid: 400, unavailable: 503 };

export async function POST(request: NextRequest) {
  if (!smsRecurringAuthorizationEnabled()) return new NextResponse(null, { status: 404 });

  const limit = checkRateLimit(rateLimitKey("billing:sms-recurring-authorize", getIpFromRequest(request)), { limit: 10, windowMs: 10 * 60 * 1000 });
  if (!limit.allowed) return rateLimitedJson(limit);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to authorize recurring charges." }, { status: 401 });
  const context = await getCurrentStudioContext();
  if (!context?.studioId) return NextResponse.json({ error: "Choose a studio first." }, { status: 400 });

  let body: { kind?: unknown; acknowledgedPriceCents?: unknown; termMonths?: unknown; totalLimitCents?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Check the term and limit and try again." }, { status: 400 });
  }
  const price = Number(body?.acknowledgedPriceCents);
  const term = Number(body?.termMonths);
  const limitCents = Number(body?.totalLimitCents);
  if (!isRecurringKind(body?.kind) || !Number.isInteger(price) || price <= 0 || !(RECURRING_TERMS as readonly number[]).includes(term) || limitCents !== price * term) {
    return NextResponse.json({ error: "Check the term and limit and try again." }, { status: 400 });
  }

  try {
    const result = await authorizeRecurring(admin(), { studioId: context.studioId, userId: user.id, kind: body.kind, acknowledgedPriceCents: price, termMonths: term, totalLimitCents: limitCents });
    return NextResponse.json({ authorizationId: result.authorizationId });
  } catch (error) {
    if (error instanceof RecurringError) return NextResponse.json({ error: error.message, code: error.code }, { status: STATUS[error.code] ?? 400 });
    return NextResponse.json({ error: "Recurring charges are not available right now." }, { status: 503 });
  }
}
