import { createAdminClient } from "@/lib/supabase/admin";
import { getCronAuthFailure } from "@/lib/security/cron";
import { ProviderFeeLifecycleStore, runProviderFeeLifecycleScan } from "@/lib/sms/providerFeeLifecycle";
import { ProviderFeeOpsRpc, createProviderFeeAlertSink, deliveryByDedupeKeyFromAdmin, studioNameFromAdmin } from "@/lib/sms/providerFeeAlerts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * TW-4F recurring provider-fee lifecycle scan (providerFeeLifecycle.ts): exposure and upcoming-charge alerts, inventory gaps, escalation of exhausted alert
 * deliveries, and (optionally) delivery of alerts as operational email. NOT registered in vercel.json: nothing calls it on a schedule until a release owner adds
 * it deliberately (suggested daily). Answered 404 unless SMS_FEE_LIFECYCLE_SCAN=on; then CRON_SECRET is required (Bearer or x-cron-secret). The database scan
 * switch and heartbeat additionally decide whether a pass runs at all (fail closed). Alert delivery needs BOTH the env flag SMS_FEE_LIFECYCLE_DELIVERY being
 * exactly `on` AND the database `delivery` switch being on; otherwise no sink is built and alerts stay pending. It returns counts only (no business, number,
 * SID, address or amount). Nothing in this route calls Twilio or changes an authorization.
 */
async function deliverySinkOrNull(ops: ProviderFeeOpsRpc, admin: ReturnType<typeof createAdminClient>) {
  if (process.env.SMS_FEE_LIFECYCLE_DELIVERY !== "on") return null;
  try {
    if (!(await ops.switchEnabled("delivery"))) return null;
  } catch {
    return null;   // fail closed
  }
  return createProviderFeeAlertSink({ ops, studioName: studioNameFromAdmin(admin), lookupDelivery: deliveryByDedupeKeyFromAdmin(admin) });
}

async function run(request: Request) {
  if (String(process.env.SMS_FEE_LIFECYCLE_SCAN ?? "").trim().toLowerCase() !== "on") return new Response(null, { status: 404 });
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;
  const headers = { "Cache-Control": "no-store" };
  try {
    const admin = createAdminClient();
    const ops = new ProviderFeeOpsRpc(admin);
    const sink = await deliverySinkOrNull(ops, admin);
    const summary = await runProviderFeeLifecycleScan(new ProviderFeeLifecycleStore(admin), sink, ops);
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
