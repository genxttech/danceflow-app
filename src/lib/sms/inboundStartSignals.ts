import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * TW-4F compliance: START signals (migration 20270218090000).
 *
 * The webhook records every START it handles by MessageSid (studio + number only, no body), including a custom Advanced Opt-Out opt-in keyword from a texter
 * with no client or contact row, which otherwise leaves no DanceFlow record. The usage reconciler then orders a recovered STOP against those STARTs by
 * Twilio's own message times (tw4_inbound_start_sids), never by when the webhook processed them. Best effort: never throws. A START whose signal could not be
 * recorded is only unknown to recovery, which then applies an older recovered STOP (fail closed).
 */
type Client = Pick<SupabaseClient, "rpc">;

export async function recordInboundStartSignal(admin: Client, input: { studioId: string; phone: string; messageSid: string }): Promise<boolean> {
  if (!/^(SM|MM)[0-9a-fA-F]{32}$/.test(input.messageSid)) return false;
  try {
    const { data, error } = await admin.rpc("sms_inbound_start_signal_record", {
      p_studio_id: input.studioId,
      p_phone_e164: input.phone,
      p_message_sid: input.messageSid,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}
