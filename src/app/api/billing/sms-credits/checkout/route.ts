import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseAdmin } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";
import { createSmsCreditCheckout, isSmsCreditPack, SmsCreditError, smsCreditPurchasesEnabled } from "@/lib/billing/smsCreditPurchases";

/**
 * TW-4F-3b-pay: starts a prepaid SMS credit purchase (one pack, one card payment, no saved payment method, no recurring charge).
 * Dark by default: it answers 404 unless SMS_CREDIT_PURCHASES=on. The studio comes from the signed-in user's own context; the database re-checks that
 * the user is an owner or administrator of that studio and that the studio belongs to a verified legal business.
 */

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase admin environment variables.");
  return createSupabaseAdmin(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const STATUS: Record<string, number> = { not_authorized: 403, no_legal_business: 409, invalid_pack: 400, ceiling: 409, unavailable: 503 };

export async function POST(request: NextRequest) {
  if (!smsCreditPurchasesEnabled()) return new NextResponse(null, { status: 404 });

  const limit = checkRateLimit(rateLimitKey("billing:sms-credit-checkout", getIpFromRequest(request)), { limit: 8, windowMs: 10 * 60 * 1000 });
  if (!limit.allowed) return rateLimitedJson(limit);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to buy SMS credit." }, { status: 401 });

  const context = await getCurrentStudioContext();
  if (!context?.studioId) return NextResponse.json({ error: "Choose a studio first." }, { status: 400 });

  let packCents: number;
  try {
    const body = (await request.json()) as { packCents?: unknown };
    packCents = Number(body.packCents);
  } catch {
    return NextResponse.json({ error: "Choose a $25, $50 or $100 pack." }, { status: 400 });
  }
  if (!isSmsCreditPack(packCents)) return NextResponse.json({ error: "Choose a $25, $50 or $100 pack." }, { status: 400 });

  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || request.nextUrl.origin;
    const session = await createSmsCreditCheckout({ admin: admin(), stripe: getStripe(), studioId: context.studioId, userId: user.id, packCents, appUrl });
    return NextResponse.json({ url: session.url, expiresAt: session.expiresAt });
  } catch (error) {
    if (error instanceof SmsCreditError) return NextResponse.json({ error: error.message, code: error.code }, { status: STATUS[error.code] ?? 400 });
    return NextResponse.json({ error: "SMS credit is not available right now." }, { status: 503 });
  }
}
