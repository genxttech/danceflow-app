import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCronAuthFailure } from "@/lib/security/cron";
import { buildNumberRuntime } from "@/lib/sms/twilioIsv/factory";
import { runScheduledInventoryReconcile } from "@/lib/sms/twilioIsv/inventoryReconcileRun";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * TW-4F A9 scheduled number-inventory reconciliation (inventoryReconcileRun.ts -> numberRunner.reconcileInventories): a read-only, free listing of each due
 * business subaccount, judged by the database, so provider inventory health stays fresh (sending is held once it is stale for 24 hours, unknown or critical).
 * NOT registered in vercel.json: nothing calls it on a schedule until a release owner adds it deliberately (suggested hourly, "0 * * * *": targets are due after
 * 6 hours, well inside the 24-hour health window). Answered 404 unless SMS_INVENTORY_RECONCILE=on; then CRON_SECRET is required (Bearer or x-cron-secret).
 * One run at a time (the shared run lease, job 'inventory_reconcile'; an overlapping call answers "busy"), a 45-second budget under maxDuration, counts only.
 * Listings use the SUBACCOUNT's own token and only where the number gates allow real calls (production) or in local fake mode; with the gates off nothing is
 * called and the run is recorded as failed, so health stays visibly stale.
 */
async function run(request: Request) {
  if (String(process.env.SMS_INVENTORY_RECONCILE ?? "").trim().toLowerCase() !== "on") return new Response(null, { status: 404 });
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;
  const headers = { "Cache-Control": "no-store" };
  try {
    const outcome = await runScheduledInventoryReconcile(createAdminClient(), buildNumberRuntime(process.env), { runner: `cron:${randomUUID().slice(0, 8)}` });
    if (!outcome.ran) return Response.json({ ok: outcome.reason === "busy", ran: false, reason: outcome.reason }, { status: outcome.reason === "busy" ? 200 : 503, headers });
    const ok = !outcome.failed && outcome.summary.errors === 0;
    return Response.json({ ok, ran: true, ...outcome.summary }, { status: outcome.failed ? 500 : 200, headers });
  } catch {
    console.error("sms_inventory_reconcile_failed");
    return Response.json({ ok: false }, { status: 500, headers });
  }
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
