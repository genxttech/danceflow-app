import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCronAuthFailure } from "@/lib/security/cron";
import { usageEvidenceProviderFromEnv } from "@/lib/sms/usageProvider";
import { runScheduledUsageReconciliation } from "@/lib/sms/usageReconciler";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * TW-4F scheduled SMS usage reconciliation: stale-reservation release, evidence settlement, escalation and inbound recovery (usageReconciler.ts).
 * NOT registered in vercel.json: nothing calls it on a schedule until a release owner adds it deliberately (suggested "*\/5 * * * *"). Answered 404 unless
 * SMS_USAGE_RECONCILER=on; then CRON_SECRET is required (Bearer or x-cron-secret). It takes the database's single run lease, so overlapping invocations are
 * harmless ("busy"), and it returns counts only (no business, message, number or SID). Evidence is read only where SMS_USAGE_EVIDENCE_READS allows it
 * (production) or in local fake mode; without it the run still releases never-sent reservations and escalates, and reads nothing.
 */
async function run(request: Request) {
  if (String(process.env.SMS_USAGE_RECONCILER ?? "").trim().toLowerCase() !== "on") return new Response(null, { status: 404 });
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;
  const headers = { "Cache-Control": "no-store" };
  try {
    const outcome = await runScheduledUsageReconciliation(createAdminClient(), usageEvidenceProviderFromEnv(process.env), { runner: `cron:${randomUUID().slice(0, 8)}` });
    if (!outcome.ran) return Response.json({ ok: outcome.reason === "busy", ran: false, reason: outcome.reason }, { status: outcome.reason === "busy" ? 200 : 503, headers });
    const ok = !outcome.failed && outcome.summary.errors === 0;
    return Response.json({ ok, ran: true, ...outcome.summary }, { status: outcome.failed ? 500 : 200, headers });
  } catch {
    console.error("sms_usage_reconcile_failed");
    return Response.json({ ok: false }, { status: 500, headers });
  }
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
