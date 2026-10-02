import type { SupabaseClient } from "@supabase/supabase-js";
import { isSmsSendingApproved, normalizeSmsPhone } from "@/lib/sms/compliance";

/**
 * SMS-A2P-2: per-studio sender resolution.
 *
 * Studio -> approved registration -> messaging service / sender. Studio SMS is sent only
 * through the studio's own approved Messaging Service; there is no global fallback.
 * `studio_sms_registrations` is platform-admin-only under RLS, so callers pass a
 * trusted server (service-role) client. Registration identifiers never leave the server.
 * The platform status flag (`DANCEFLOW_SMS_STATUS`) is only an emergency master switch.
 */

export type StudioSmsSender = {
  studioId: string;
  messagingServiceSid: string;
  senderE164: string;
  campaignSid: string;
};

export type StudioSmsSenderResult =
  | { ok: true; sender: StudioSmsSender }
  | {
      ok: false;
      reason: "sms_not_approved" | "sms_studio_not_approved" | "sms_registration_lookup_failed";
    };

const MESSAGING_SERVICE_SID_PATTERN = /^MG[0-9a-fA-F]{32}$/;
const CAMPAIGN_SID_PATTERN = /^QE[0-9a-fA-F]{32}$/;

type RegistrationRow = {
  studio_id: string;
  messaging_service_sid: string | null;
  campaign_sid: string | null;
  sender_e164: string | null;
  registration_status: string | null;
};

const REGISTRATION_COLUMNS =
  "studio_id, messaging_service_sid, campaign_sid, sender_e164, registration_status";

export async function resolveStudioSmsSender(
  supabase: SupabaseClient,
  studioId: string,
): Promise<StudioSmsSenderResult> {
  if (!isSmsSendingApproved()) {
    return { ok: false, reason: "sms_not_approved" };
  }

  const { data, error } = await supabase
    .from("studio_sms_registrations")
    .select(REGISTRATION_COLUMNS)
    .eq("studio_id", studioId)
    .maybeSingle<RegistrationRow>();

  if (error) {
    return { ok: false, reason: "sms_registration_lookup_failed" };
  }

  if (
    !data ||
    data.studio_id !== studioId ||
    data.registration_status !== "approved" ||
    !data.messaging_service_sid ||
    !MESSAGING_SERVICE_SID_PATTERN.test(data.messaging_service_sid) ||
    !data.campaign_sid ||
    !CAMPAIGN_SID_PATTERN.test(data.campaign_sid) ||
    !data.sender_e164
  ) {
    return { ok: false, reason: "sms_studio_not_approved" };
  }

  return {
    ok: true,
    sender: {
      studioId,
      messagingServiceSid: data.messaging_service_sid,
      senderE164: data.sender_e164,
      campaignSid: data.campaign_sid,
    },
  };
}

export type InboundStudioResolution =
  | { ok: true; studioId: string }
  | { ok: false; reason: "no_sender" | "unknown_sender" | "ambiguous_sender" | "lookup_failed" };

/**
 * Maps an inbound/status webhook back to the studio that owns the receiving sender.
 * Uses `MessagingServiceSid` and/or `To` (the studio's sender number) and requires every
 * field present to agree. Registration status is deliberately ignored: STOP/START/HELP
 * must still reach a suspended or rejected studio's recipients.
 */
export async function resolveStudioFromInboundSender(
  supabase: SupabaseClient,
  input: { messagingServiceSid?: string | null; to?: string | null },
): Promise<InboundStudioResolution> {
  const serviceSid = String(input.messagingServiceSid ?? "").trim();
  const toE164 = normalizeSmsPhone(String(input.to ?? ""));
  const candidates = new Set<string>();
  let queried = 0;

  if (serviceSid && MESSAGING_SERVICE_SID_PATTERN.test(serviceSid)) {
    queried += 1;
    const { data, error } = await supabase
      .from("studio_sms_registrations")
      .select("studio_id")
      .eq("messaging_service_sid", serviceSid)
      .limit(2);

    if (error) return { ok: false, reason: "lookup_failed" };
    const found = (data ?? []) as Array<{ studio_id: string }>;
    if (found.length !== 1) return { ok: false, reason: found.length === 0 ? "unknown_sender" : "ambiguous_sender" };
    candidates.add(found[0].studio_id);
  }

  if (toE164) {
    queried += 1;
    const { data, error } = await supabase
      .from("studio_sms_registrations")
      .select("studio_id")
      .eq("sender_e164", toE164)
      .limit(2);

    if (error) return { ok: false, reason: "lookup_failed" };
    const found = (data ?? []) as Array<{ studio_id: string }>;
    if (found.length !== 1) return { ok: false, reason: found.length === 0 ? "unknown_sender" : "ambiguous_sender" };
    candidates.add(found[0].studio_id);
  }

  if (queried === 0) return { ok: false, reason: "no_sender" };
  if (candidates.size !== 1) return { ok: false, reason: "ambiguous_sender" };

  return { ok: true, studioId: [...candidates][0] };
}
