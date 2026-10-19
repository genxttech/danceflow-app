import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCronAuthFailure } from "@/lib/security/cron";
import { runScheduledRecurringCharges } from "@/lib/billing/smsRecurring";

export const dynamic = "force-dynamic";

/**
 * Recurring SMS service charges. NOT registered in vercel.json: nothing calls it on a schedule until a release owner adds it deliberately. Even when called it does
 * nothing unless BOTH switches are on: the environment (SMS_RECURRING_SCHEDULER=on, answered 404 otherwise) and the database kill switch (default off; the database
 * refuses to start a run). It takes the database's single run lease, so overlapping invocations are harmless, and returns counts only (no business, no amount).
 */
async function run(request: Request) {
  if (String(process.env.SMS_RECURRING_SCHEDULER ?? "").trim().toLowerCase() !== "on") return new Response(null, { status: 404 });
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;
  try {
    const outcome = await runScheduledRecurringCharges(createAdminClient(), { runner: `cron:${randomUUID().slice(0, 8)}` });
    if (!outcome.ran) return Response.json({ ok: true, ran: false, reason: outcome.reason }, { headers: { "Cache-Control": "no-store" } });
    const { due, charged, unfunded, held, refused, replayed, errors } = outcome.summary;
    return Response.json({ ok: errors === 0, ran: true, due, charged, unfunded, held, refused, replayed, errors }, { status: errors === 0 ? 200 : 500, headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("sms_recurring_run_failed");
    return Response.json({ ok: false }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
