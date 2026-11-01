import { createAdminClient } from "@/lib/supabase/admin";
import { getCronAuthFailure } from "@/lib/security/cron";
import { createPriceMonitorDb } from "@/lib/sms/pricing/db";
import { runPriceWatchdog } from "@/lib/sms/pricing/monitor";
import { loadMonitorConfig } from "@/lib/sms/pricing/transport";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * TW-4F / D4-2 monitor watchdog (runPriceWatchdog): alerts when no monitor run was recorded within PRICE_MONITOR_MAX_AGE_MINUTES (default 45), when the evidence chain is broken
 * or when alerts stay undelivered. Schedule it SEPARATELY from the monitor (suggested hourly); the external dead-man heartbeat is the independent backstop.
 * NOT registered in vercel.json: nothing calls it on a schedule until a release owner adds it deliberately. Answered 404 unless SMS_PRICE_MONITOR=on; then CRON_SECRET is required
 * (Bearer or x-cron-secret). It only DETECTS and ALERTS: it never publishes, repairs, rolls back or overwrites a price. Alert destinations come from PRICE_MONITOR_* environment
 * values only (src/lib/sms/pricing/transport.ts). Answers 500 whenever anything is wrong (a finding, an undelivered alert, a missing destination) so the scheduler also flags it;
 * the body carries codes and counts only.
 */
async function run(request: Request) {
  if (String(process.env.SMS_PRICE_MONITOR ?? "").trim().toLowerCase() !== "on") return new Response(null, { status: 404 });
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;
  const headers = { "Cache-Control": "no-store" };
  try {
    const out = await runPriceWatchdog({ db: createPriceMonitorDb(createAdminClient()), config: loadMonitorConfig(process.env) });
    return Response.json({
      ok: out.ok, findings: out.findings.map((f) => ({ code: f.code, severity: f.severity })), chain: out.chain, alertRequired: out.alertRequired, alertDelivered: out.alertDelivered,
      redelivered: out.redelivered, evidenceRecorded: out.evidenceRecorded, destinationConfigured: out.destinationConfigured, errors: out.errors,
    }, { status: out.ok ? 200 : 500, headers });
  } catch {
    console.error("sms_price_monitor_failed");
    return Response.json({ ok: false }, { status: 500, headers });
  }
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
