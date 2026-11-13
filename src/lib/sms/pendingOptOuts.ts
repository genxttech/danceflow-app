import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * TW-4F compliance: durable pending opt-outs (migration 20270215100000).
 *
 * When the canonical consent function fails twice for an inbound STOP (the replay ledger already holds its MessageSid, and Twilio does not retry a 5xx),
 * the intent is parked in a separate table and applied later by `applyPendingOptOuts`, which the scheduled notification sender runs first on every
 * invocation (every 15 minutes) and therefore BEFORE it can send anything. A later START for the same studio + phone supersedes the pending opt-out
 * (the texter's latest intent wins), so a recovered STOP can never undo a START. Every function here is best effort and never throws.
 */
type Client = Pick<SupabaseClient, "rpc">;

export async function recordPendingOptOut(admin: Client, input: { studioId: string; phone: string; messageSid: string | null }): Promise<boolean> {
  try {
    const { data, error } = await admin.rpc("sms_pending_opt_out_record", {
      p_studio_id: input.studioId,
      p_phone_e164: input.phone,
      p_message_sid: input.messageSid,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}

/** A START: the texter's newer intent supersedes any opt-out still waiting to be applied. Returns false when it could not be recorded (logged by the caller). */
export async function supersedePendingOptOuts(admin: Client, input: { studioId: string; phone: string }): Promise<boolean> {
  try {
    const { error } = await admin.rpc("sms_pending_opt_out_supersede", { p_studio_id: input.studioId, p_phone_e164: input.phone });
    return !error;
  } catch {
    return false;
  }
}

export type PendingOptOutRun = { applied: number; failed: number };

export async function applyPendingOptOuts(admin: Client, limit = 50): Promise<PendingOptOutRun | null> {
  try {
    const { data, error } = await admin.rpc("sms_pending_opt_out_apply", { p_limit: limit });
    if (error) {
      console.warn(`sms_pending_opt_out_apply_failed:${String(error.code ?? "unknown")}`);
      return null;
    }
    const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    return { applied: Number(d.applied ?? 0) || 0, failed: Number(d.failed ?? 0) || 0 };
  } catch {
    console.warn("sms_pending_opt_out_apply_failed:exception");
    return null;
  }
}
