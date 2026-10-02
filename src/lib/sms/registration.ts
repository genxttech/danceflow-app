import { normalizeSmsPhone } from "@/lib/sms/compliance";

/**
 * SMS-A2P-1: per-studio A2P registration (non-secret Twilio identifiers + status).
 * Mirrors the constraints on `studio_sms_registrations`. Nothing here is a secret:
 * Twilio auth tokens, account secrets and API keys never belong in this model.
 * This slice records registration state only; it does not route or enable sending.
 */

export const SMS_REGISTRATION_STATUSES = [
  "not_registered",
  "in_review",
  "approved",
  "rejected",
  "suspended",
] as const;

export type SmsRegistrationStatus = (typeof SMS_REGISTRATION_STATUSES)[number];

export const SMS_REGISTRATION_STATUS_LABELS: Record<SmsRegistrationStatus, string> = {
  not_registered: "Not registered",
  in_review: "In carrier review",
  approved: "Approved",
  rejected: "Needs resubmission",
  suspended: "Suspended",
};

const MESSAGING_SERVICE_SID_PATTERN = /^MG[0-9a-fA-F]{32}$/;
const CAMPAIGN_SID_PATTERN = /^QE[0-9a-fA-F]{32}$/;

export function normalizeMessagingServiceSid(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return { ok: true as const, value: null };
  if (!MESSAGING_SERVICE_SID_PATTERN.test(trimmed)) {
    return {
      ok: false as const,
      error: "Messaging Service SID must start with MG followed by 32 hex characters.",
    };
  }
  return { ok: true as const, value: trimmed };
}

export function normalizeCampaignSid(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return { ok: true as const, value: null };
  if (!CAMPAIGN_SID_PATTERN.test(trimmed)) {
    return {
      ok: false as const,
      error: "Campaign SID must start with QE followed by 32 hex characters.",
    };
  }
  return { ok: true as const, value: trimmed };
}

export function normalizeSenderE164(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return { ok: true as const, value: null };
  const normalized = normalizeSmsPhone(trimmed);
  if (!normalized) {
    return { ok: false as const, error: "Sender number must be a valid phone number." };
  }
  return { ok: true as const, value: normalized };
}

/** An approved registration must carry every identifier later sends will need. */
export function missingApprovalIdentifiers(input: {
  messagingServiceSid: string | null;
  campaignSid: string | null;
  senderE164: string | null;
}) {
  const missing: string[] = [];
  if (!input.messagingServiceSid) missing.push("Messaging Service SID");
  if (!input.campaignSid) missing.push("Campaign SID");
  if (!input.senderE164) missing.push("Sender number");
  return missing;
}
