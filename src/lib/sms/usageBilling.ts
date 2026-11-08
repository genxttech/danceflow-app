import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BilledSmsProvider } from "@/lib/sms/usageProvider";

/**
 * TW-4F SMS usage billing (design: docs/twilio/TW-4F_Usage_Financials_Design.md v2). SERVER ONLY.
 *
 * A text for a studio of a verified legal business is BILLED: the database reserves its estimated cost before the provider is called
 * (`tw4_usage_begin`, which also creates the message log row), the attempt is marked as dispatching immediately before the call, and the
 * provider's answer is recorded as accepted (SID), definitely refused (released) or uncertain (kept reserved). Money is charged later, from the
 * provider's own message record (the reconciler), never from this path. Each source (an outbound delivery, or a manual send's idempotency key)
 * has ONE attempt: a retry of the same source is a replay and never a second text.
 */

type Client = Pick<SupabaseClient, "rpc">;

export function smsUsageBillingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.SMS_USAGE_BILLING ?? "").trim().toLowerCase() === "on";
}

export type BilledSendRefusal =
  | "insufficient_credit"
  | "monthly_limit"
  | "no_billed_sender"
  | "suspended"
  | "switched_off"
  | "paused"
  | "no_price"
  | "not_billed"
  | "invalid"
  | "forbidden"
  | "unavailable";

const REFUSALS: Record<string, BilledSendRefusal> = {
  TW007: "insufficient_credit",
  TW012: "monthly_limit",
  TW015: "no_billed_sender",
  TW016: "suspended",
  TW018: "switched_off",
  TW024: "paused", // 20261218: the usage reconciler is not ready; nothing was reserved, so a later retry of the same source is safe
  TW008: "no_price",
  TW010: "not_billed",
  "22023": "invalid",
  "42501": "forbidden",
};

export type BilledSendOutcome =
  /** The provider accepted the text. */
  | { outcome: "sent"; logId: string; providerSid: string }
  /** This source was already handled; `state` says how far it got. Nothing was sent now. */
  | { outcome: "replay"; logId: string; state: string; providerSid: string | null }
  /** Refused before any provider call: nothing was sent and nothing reserved. */
  | { outcome: "refused"; reason: BilledSendRefusal }
  /** The provider definitely refused it: nothing was sent and the reservation was released. */
  | { outcome: "rejected"; logId: string; code: string }
  /** The provider's answer is unknown: the text may have gone out. Never resend; the reservation is kept until evidence or an admin settles it. */
  | { outcome: "uncertain"; logId: string };

export type BilledSendInput = {
  source: { kind: "delivery" | "manual"; id: string };
  studioId: string;
  clientId: string | null;
  phoneE164: string;
  body: string;
  messageType: string;
  relatedTable: string | null;
  relatedId: string | null;
  sentBy: string | null;
  /** The status callback URL WITHOUT the attempt id (it is added here), or null when callbacks are not configured. */
  statusCallbackBase: string | null;
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function withAttempt(base: string | null, attemptId: string): string | null {
  if (!base) return null;
  try {
    const url = new URL(base);
    url.searchParams.set("attempt", attemptId);
    return url.toString();
  } catch {
    return null;
  }
}

export async function sendBilledSms(admin: Client, provider: BilledSmsProvider, input: BilledSendInput): Promise<BilledSendOutcome> {
  const begun = await admin.rpc("tw4_usage_begin", {
    p_source_kind: input.source.kind,
    p_source_id: input.source.id,
    p_studio_id: input.studioId,
    p_client_id: input.clientId,
    p_phone_e164: input.phoneE164,
    p_body: input.body,
    p_message_type: input.messageType,
    p_related_table: input.relatedTable,
    p_related_id: input.relatedId,
    p_sent_by: input.sentBy,
  });
  if (begun.error) return { outcome: "refused", reason: REFUSALS[String(begun.error.code ?? "")] ?? "unavailable" };
  const b = obj(begun.data);
  const attemptId = str(b.attempt_id);
  const logId = str(b.message_log_id);
  const accountSid = str(b.account_sid);
  const serviceSid = str(b.messaging_service_sid);
  // the body and number that are sent are the ones stored at begin: a replay of a still-reserved attempt (an earlier run stopped before its dispatch
  // marker) proceeds with the STORED message, and the marker below lets only one caller reach the provider
  let body = input.body;
  let phoneE164 = input.phoneE164;
  // the location number the attempt was reserved against (begin returns it for a new decision AND for a replay)
  const from = str(b.sender_e164);
  if (b.decision === "replay" && attemptId && logId) {
    const replay: BilledSendOutcome = { outcome: "replay", logId, state: str(b.state), providerSid: str(b.provider_sid) || null };
    if (b.state !== "reserved" || !accountSid || !serviceSid || !str(b.body) || !str(b.phone_e164)) return replay;
    body = str(b.body);
    phoneE164 = str(b.phone_e164);
  } else if (b.decision !== "send" || !attemptId || !logId || !accountSid || !serviceSid) {
    return { outcome: "refused", reason: "unavailable" };
  }
  // Nothing was marked, so nothing reached the provider. A PERMANENT reason (no sender number, real sends switched off, an invalid account) releases the
  // reservation at once (a still-reserved attempt only; one another caller already marked is untouched). A TRANSIENT one (the subaccount token could not
  // be read just now) keeps the attempt reserved: the delivery's retry replays the same source and sends it; one never retried is released by the reconciler.
  const releaseUnprepared = async (code: string): Promise<BilledSendOutcome> => {
    const released = await admin.rpc("tw4_usage_release_unprepared", { p_attempt_id: attemptId, p_code: code });
    if (released.error) console.warn("sms_usage_unprepared_release_failed", released.error.code ?? "unknown");
    return { outcome: "refused", reason: "unavailable" };
  };
  if (!from) return releaseUnprepared("no_sender_number");

  // the subaccount's credentials are obtained BEFORE the marker, so a credential failure never leaves a marked attempt behind
  const prepared = await provider.prepare(accountSid);
  if (!prepared.ok) {
    if (prepared.code === "credentials_unavailable") return { outcome: "refused", reason: "unavailable" };
    return releaseUnprepared("not_prepared");
  }

  // the marker comes first: if it cannot be written, the provider is not called (the reconciler releases an attempt that never got one)
  const marked = await admin.rpc("tw4_usage_dispatching", { p_attempt_id: attemptId });
  const markedData = obj(marked.data);
  // the sender stopped being ready after the reservation: the database released it, nothing was sent
  if (!marked.error && markedData.dispatch === false && markedData.state === "released" && markedData.reason === "sender_not_ready") {
    return { outcome: "refused", reason: "no_billed_sender" };
  }
  if (marked.error || markedData.dispatch !== true) {
    return { outcome: "replay", logId, state: str(markedData.state) || "reserved", providerSid: null };
  }
  // the database's answer names the number it checked: it is the one used
  const sender = str(markedData.sender_e164) || from;

  const result = await provider.send({
    accountSid,
    messagingServiceSid: serviceSid,
    to: phoneE164,
    body,
    statusCallbackUrl: withAttempt(input.statusCallbackBase, attemptId),
    from: sender,
  });

  if (result.kind === "accepted") {
    // If this write fails the SID is still bound by the first signed status callback (it carries the attempt id), or by an admin.
    const recorded = await admin.rpc("tw4_usage_submitted", { p_attempt_id: attemptId, p_provider_sid: result.sid });
    if (recorded.error) console.warn("sms_usage_submitted_unrecorded", recorded.error.code ?? "unknown");
    return { outcome: "sent", logId, providerSid: result.sid };
  }
  if (result.kind === "refused") {
    const released = await admin.rpc("tw4_usage_rejected", { p_attempt_id: attemptId, p_error_code: result.code });
    if (released.error) {
      // the release could not be recorded: the attempt stays 'submitting' (treated as uncertain) and is resolved by an admin; never resent
      console.warn("sms_usage_rejection_unrecorded", released.error.code ?? "unknown");
      return { outcome: "uncertain", logId };
    }
    return { outcome: "rejected", logId, code: result.code };
  }
  const kept = await admin.rpc("tw4_usage_uncertain", { p_attempt_id: attemptId, p_error_code: result.code });
  if (kept.error) console.warn("sms_usage_uncertain_unrecorded", kept.error.code ?? "unknown");
  return { outcome: "uncertain", logId };
}

/**
 * What a replayed source means for the caller: was the text accepted, may it have been, was it definitely not sent, or has it not been handed to the
 * provider YET ('reserved': before the dispatch marker, so nothing was sent; it either proceeds or is released by the reconciler).
 */
export function replayMeaning(state: string): "accepted" | "unknown" | "not_sent" | "not_yet" {
  if (state === "submitted" || state === "settled") return "accepted";
  if (state === "released") return "not_sent";
  if (state === "reserved") return "not_yet";
  return "unknown";
}

/** Plain messages for staff, by refusal. Never a provider detail. */
export const BILLED_REFUSAL_MESSAGE: Record<BilledSendRefusal, string> = {
  insufficient_credit: "Not enough prepaid texting credit. Add credit, then send again.",
  monthly_limit: "This month's texting spending limit is reached or not set. The owner can change it in Settings, Texting.",
  no_billed_sender: "Texting for your business is not set up yet. Contact DanceFlow support.",
  suspended: "Texting is paused because a monthly charge was not covered. Add credit; replies like STOP and HELP still work for your contacts.",
  switched_off: "Texting is not open yet.",
  paused: "Texting is paused for a few minutes while usage is reconciled. Nothing was sent; try again shortly.",
  no_price: "Texting is not open yet.",
  not_billed: "Texting is not set up for your studio yet.",
  invalid: "This text cannot be sent. Check the number (US and Canada only) and the message length.",
  forbidden: "This text cannot be sent from this studio.",
  unavailable: "Texting could not be verified. Please try again.",
};
