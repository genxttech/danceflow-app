import { createAdminClient } from "@/lib/supabase/admin";
import { getCronAuthFailure } from "@/lib/security/cron";
import { ProviderFeeLifecycleStore, runProviderFeeLifecycleScan } from "@/lib/sms/providerFeeLifecycle";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * TW-4F recurring provider-fee lifecycle scan (providerFeeLifecycle.ts): exposure and upcoming-charge alerts, inventory gaps. NOT registered in vercel.json:
 * nothing calls it on a schedule until a release owner adds it deliberately (suggested daily). Answered 404 unless SMS_FEE_LIFECYCLE_SCAN=on; then CRON_SECRET is
 * required (Bearer or x-cron-secret). Every step is idempotent in the database (per-business account lock, de-duplicated alerts), so overlapping invocations are
 * harmless. It returns counts only (no business, number, SID or amount). Alert DELIVERY needs an owner decision (channel and recipients): until a sink is wired
 * here the alerts stay pending in the outbox and are counted in the platform overview. Nothing in this route calls Twilio or changes an authorization.
 */
async function run(request: Request) {
  if (String(process.env.SMS_FEE_LIFECYCLE_SCAN ?? "").trim().toLowerCase() !== "on") return new Response(null, { status: 404 });
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;
  const headers = { "Cache-Control": "no-store" };
  try {
    const summary = await runProviderFeeLifecycleScan(new ProviderFeeLifecycleStore(createAdminClient()), null);
    return Response.json({ ok: summary.errors === 0, ...summary }, { status: summary.errors === 0 ? 200 : 500, headers });
  } catch {
    console.error("sms_provider_fee_lifecycle_failed");
    return Response.json({ ok: false }, { status: 500, headers });
  }
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
