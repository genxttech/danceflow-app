import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCronAuthFailure } from "@/lib/security/cron";
import { runScheduledSenderReverify, senderReadProviderFromEnv } from "@/lib/sms/senderVerification";
import { messagingTokenProvider } from "@/lib/sms/twilioIsv/real";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * TW-4F scheduled sender re-verification (senderVerification.ts runScheduledSenderReverify): read-only Twilio reads of each approved sender that is due,
 * judged by the database, so a sender that stopped being valid stops sending and one that stays valid keeps its 24-hour trust.
 * NOT registered in vercel.json: nothing calls it on a schedule until a release owner adds it deliberately (suggested every 15 minutes, "*\/15 * * * *":
 * every approved sender is then re-read soon after 20 hours, with retries before its 24-hour trust ends). Answered 404 unless SMS_SENDER_REVERIFY=on; then
 * CRON_SECRET is required (Bearer or x-cron-secret). One run at a time (the database lease; an overlapping call answers "busy"), counts only.
 * Reads happen only where SMS_SENDER_VERIFY_READS allows them (production) or in local fake mode, always with the SUBACCOUNT's own token.
 */
async function run(request: Request) {
  if (String(process.env.SMS_SENDER_REVERIFY ?? "").trim().toLowerCase() !== "on") return new Response(null, { status: 404 });
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;
  const headers = { "Cache-Control": "no-store" };
  try {
    const provider = senderReadProviderFromEnv(process.env, messagingTokenProvider(process.env));
    const outcome = await runScheduledSenderReverify(createAdminClient(), provider, { runner: `cron:${randomUUID().slice(0, 8)}` });
    if (!outcome.ran) return Response.json({ ok: outcome.reason === "busy", ran: false, reason: outcome.reason }, { status: outcome.reason === "busy" ? 200 : 503, headers });
    const ok = !outcome.failed && outcome.summary.errors === 0;
    return Response.json({ ok, ran: true, ...outcome.summary }, { status: outcome.failed ? 500 : 200, headers });
  } catch {
    console.error("sms_sender_reverify_failed");
    return Response.json({ ok: false }, { status: 500, headers });
  }
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
