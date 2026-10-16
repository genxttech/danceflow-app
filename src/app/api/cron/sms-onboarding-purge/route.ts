import { createAdminClient } from "@/lib/supabase/admin";
import { getCronAuthFailure } from "@/lib/security/cron";
import { purgeDueEins } from "@/lib/sms/onboarding/client";

export const dynamic = "force-dynamic";

/**
 * TW-4A: daily sweep that removes the encrypted EIN from onboardings that ended (cancelled or blocked) or were left in `exception`
 * more than 30 days ago. Vercel Cron calls routes with GET (registered in vercel.json); POST is kept for manual triggering with the
 * same CRON_SECRET check. Returns a count only: no studio, no value.
 */
async function sweep(request: Request) {
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;
  try {
    const purged = await purgeDueEins(createAdminClient());
    return Response.json({ ok: true, purged }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("sms_onboarding_purge_failed");
    return Response.json({ ok: false }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

export async function GET(request: Request) {
  return sweep(request);
}

export async function POST(request: Request) {
  return sweep(request);
}
