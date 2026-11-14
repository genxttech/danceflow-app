import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeSmsPhone } from "@/lib/sms/compliance";

/**
 * TW-4F compliance: send-time suppression by a parked opt-out (migration 20270215100000, studio_sms_pending_opt_outs).
 *
 * A STOP whose canonical consent change failed is parked; until it is applied (or a later START supersedes it) every ORDINARY outbound text to that
 * studio + phone must be suppressed, even though sms_contact_permissions has not changed yet. The database answers `sms_pending_opt_out_blocks`, true
 * while an OPEN row (applied_at and superseded_at both null) exists for exactly that studio and number.
 *
 * Fail closed: "blocked" and "unknown" both mean DO NOT SEND. The ONLY error treated as "clear" is the function not being installed at all
 * (PostgREST PGRST202 / Postgres 42883): that is the pre-migration state, where nothing can have been parked (the webhook's park call fails the same way
 * and answers 503), so refusing every text before the SQL is applied would only break sending. Any other error, a thrown exception, a timeout, an
 * unreadable answer or an invalid number is "unknown".
 *
 * Compliance replies to the STOP itself (confirmation, HELP) are TwiML responses of the inbound webhook, not sends, and never pass through here.
 */

type Client = Pick<SupabaseClient, "rpc">;

export type PendingOptOutState = "blocked" | "clear" | "unknown";

const NOT_INSTALLED = new Set(["PGRST202", "42883"]);

/**
 * SMS_PENDING_OPT_OUT_REQUIRED=1 (set in the SAME release step that applies migration 20270215100000) means the function MUST exist: "not installed" (PGRST202 /
 * 42883, which PostgREST also returns while its schema cache is stale after the apply) is then "unknown" (fail closed). Unset, it is the knowingly-absent
 * pre-migration state and is "clear".
 */
export function pendingOptOutRequired(env: Record<string, string | undefined> = process.env): boolean {
  return ["1", "on", "true"].includes(String(env.SMS_PENDING_OPT_OUT_REQUIRED ?? "").trim().toLowerCase());
}

export async function pendingOptOutState(admin: Client, studioId: string, phone: string, env: Record<string, string | undefined> = process.env): Promise<PendingOptOutState> {
  const normalized = normalizeSmsPhone(phone);
  if (!studioId || !normalized) return "unknown";
  try {
    const { data, error } = await admin.rpc("sms_pending_opt_out_blocks", { p_studio_id: studioId, p_phone_e164: normalized });
    if (error) {
      if (NOT_INSTALLED.has(String(error.code ?? "")) && !pendingOptOutRequired(env)) return "clear";
      console.warn(`sms_pending_opt_out_check_failed:${String(error.code ?? "unknown")}`);
      return "unknown";
    }
    if (data === true) return "blocked";
    if (data === false) return "clear";
    return "unknown";
  } catch {
    console.warn("sms_pending_opt_out_check_failed:exception");
    return "unknown";
  }
}
