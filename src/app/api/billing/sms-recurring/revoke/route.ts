import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseAdmin } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";
import { RecurringError, revokeRecurring, smsRecurringAuthorizationEnabled } from "@/lib/billing/smsRecurring";

/** Studio owner revokes a recurring authorization. Takes effect immediately: nothing is charged after it commits. Phone numbers are never released by this. */
function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase admin environment variables.");
  return createSupabaseAdmin(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS: Record<string, number> = { not_authorized: 403, unavailable: 503 };

export async function POST(request: NextRequest) {
  if (!smsRecurringAuthorizationEnabled()) return new NextResponse(null, { status: 404 });

  const limit = checkRateLimit(rateLimitKey("billing:sms-recurring-revoke", getIpFromRequest(request)), { limit: 20, windowMs: 10 * 60 * 1000 });
  if (!limit.allowed) return rateLimitedJson(limit);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  let id: unknown;
  try {
    id = ((await request.json()) as { authorizationId?: unknown })?.authorizationId;
  } catch {
    return NextResponse.json({ error: "Choose an authorization." }, { status: 400 });
  }
  if (typeof id !== "string" || !UUID.test(id)) return NextResponse.json({ error: "Choose an authorization." }, { status: 400 });

  try {
    await revokeRecurring(admin(), id, user.id);
    return NextResponse.json({ status: "revoked" });
  } catch (error) {
    if (error instanceof RecurringError) return NextResponse.json({ error: error.message, code: error.code }, { status: STATUS[error.code] ?? 400 });
    return NextResponse.json({ error: "Recurring charges are not available right now." }, { status: 503 });
  }
}
