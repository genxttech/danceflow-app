import { createAdminClient } from "@/lib/supabase/admin";
import { getCronAuthFailure } from "@/lib/security/cron";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * TW-4F scheduled expiry sweep for price proposals nobody decided (migration 20270219090000, public.tw4_price_sweep_expired). It closes only 'pending' requests whose
 * expires_at has passed, exactly as the lazy expiry already does; it never approves, rejects, applies or publishes a price, and the price monitor stays detect-only.
 * Suggested schedule: hourly, well inside the monitor's 48-hour stale mark. NOT registered in vercel.json: nothing calls it on a schedule until a release owner adds it
 * deliberately. Answered 404 unless SMS_PRICE_SWEEP=on; then CRON_SECRET is required (Bearer or x-cron-secret). The body carries a count only (never request contents).
 */
async function run(request: Request) {
  if (String(process.env.SMS_PRICE_SWEEP ?? "").trim().toLowerCase() !== "on") return new Response(null, { status: 404 });
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;
  const headers = { "Cache-Control": "no-store" };
  try {
    const { data, error } = await createAdminClient().rpc("tw4_price_sweep_expired");
    if (error) {
      console.error("sms_price_sweep_rpc_failed");
      return Response.json({ ok: false }, { status: 500, headers });
    }
    const expired = typeof (data as { expired?: unknown } | null)?.expired === "number" ? (data as { expired: number }).expired : 0;
    return Response.json({ ok: true, expired }, { status: 200, headers });
  } catch {
    console.error("sms_price_sweep_failed");
    return Response.json({ ok: false }, { status: 500, headers });
  }
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
