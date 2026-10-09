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

/* ------------------------------------------------------------------------- */
/* TW-3: registration metadata (non-secret) + one readiness calculation       */
/* ------------------------------------------------------------------------- */

/** Only the use case the product supports: transactional appointments + staff 1:1 operational. */
export const SMS_CAMPAIGN_USE_CASES = ["mixed"] as const;
export type SmsCampaignUseCase = (typeof SMS_CAMPAIGN_USE_CASES)[number];
export const SMS_CAMPAIGN_USE_CASE_LABELS: Record<SmsCampaignUseCase, string> = {
  mixed: "Mixed (appointments + staff 1:1, no marketing)",
};

/** Brand / Campaign review state mirrored from the Twilio Console. */
export const SMS_PROVIDER_REVIEW_STATUSES = [
  "not_started",
  "in_review",
  "approved",
  "rejected",
  "suspended",
] as const;
export type SmsProviderReviewStatus = (typeof SMS_PROVIDER_REVIEW_STATUSES)[number];
export const SMS_PROVIDER_REVIEW_STATUS_LABELS: Record<SmsProviderReviewStatus, string> = {
  not_started: "Not started",
  in_review: "In review",
  approved: "Approved",
  rejected: "Rejected",
  suspended: "Suspended",
};

const CUSTOMER_PROFILE_SID_PATTERN = /^BU[0-9a-fA-F]{32}$/;
const BRAND_SID_PATTERN = /^BN[0-9a-fA-F]{32}$/;
const PHONE_NUMBER_SID_PATTERN = /^PN[0-9a-fA-F]{32}$/;

function normalizePrefixedSid(
  value: string | null | undefined,
  pattern: RegExp,
  label: string,
  prefix: string,
) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return { ok: true as const, value: null };
  if (!pattern.test(trimmed)) {
    return {
      ok: false as const,
      error: `${label} must start with ${prefix} followed by 32 hex characters.`,
    };
  }
  return { ok: true as const, value: trimmed };
}

export const normalizeCustomerProfileSid = (value: string | null | undefined) =>
  normalizePrefixedSid(value, CUSTOMER_PROFILE_SID_PATTERN, "Customer Profile SID", "BU");
export const normalizeBrandSid = (value: string | null | undefined) =>
  normalizePrefixedSid(value, BRAND_SID_PATTERN, "Brand SID", "BN");
export const normalizePhoneNumberSid = (value: string | null | undefined) =>
  normalizePrefixedSid(value, PHONE_NUMBER_SID_PATTERN, "Phone Number SID", "PN");

export type SmsRegistrationMetadata = {
  registrationStatus: SmsRegistrationStatus;
  customerProfileSid: string | null;
  brandSid: string | null;
  brandStatus: SmsProviderReviewStatus;
  messagingServiceSid: string | null;
  campaignSid: string | null;
  campaignStatus: SmsProviderReviewStatus;
  campaignUseCase: SmsCampaignUseCase | null;
  phoneNumberSid: string | null;
  senderE164: string | null;
};

/** Everything an approved registration must carry, in setup order (mirrors the DB constraints). */
export function missingRegistrationItems(input: SmsRegistrationMetadata): string[] {
  const missing: string[] = [];
  if (!input.customerProfileSid) missing.push("Customer Profile SID");
  if (!input.brandSid) missing.push("Brand SID");
  if (input.brandStatus !== "approved") missing.push("Brand status approved");
  if (!input.messagingServiceSid) missing.push("Messaging Service SID");
  if (!input.campaignSid) missing.push("Campaign SID");
  if (!input.campaignUseCase) missing.push("Campaign use case");
  if (input.campaignStatus !== "approved") missing.push("Campaign status approved");
  if (!input.phoneNumberSid) missing.push("Phone Number SID");
  if (!input.senderE164) missing.push("Sender number");
  return missing;
}

/** Cross-field contradictions the database would also reject. */
export function registrationContradictions(input: SmsRegistrationMetadata): string[] {
  const problems: string[] = [];
  if (input.brandStatus === "approved" && !input.brandSid) {
    problems.push("Brand status cannot be approved without a Brand SID.");
  }
  if (input.campaignStatus === "approved" && !input.campaignSid) {
    problems.push("Campaign status cannot be approved without a Campaign SID.");
  }
  if (input.campaignStatus === "approved" && !input.campaignUseCase) {
    problems.push("Campaign status cannot be approved without a use case.");
  }
  if (input.phoneNumberSid && !input.senderE164) {
    problems.push("A Phone Number SID needs the sender number it belongs to.");
  }
  if (input.registrationStatus === "approved") {
    const missing = missingRegistrationItems(input);
    if (missing.length > 0) problems.push(`To mark a studio approved, add: ${missing.join(", ")}.`);
  }
  return problems;
}

export type SmsRegistrationReadinessState =
  | "incomplete"
  | "waiting_review"
  | "ready"
  | "action_needed"
  | "blocked";

export type SmsRegistrationReadiness = {
  state: SmsRegistrationReadinessState;
  label: string;
  /** App sending is allowed for this studio's registration (still subject to the platform master switch). */
  canSend: boolean;
  missing: string[];
  guidance: string;
};

/**
 * The one readiness answer for a studio registration. Only an `approved` aggregate with every
 * required identifier and both Brand and Campaign approved is `ready`; everything else blocks sends.
 */
export function evaluateSmsRegistrationReadiness(input: SmsRegistrationMetadata): SmsRegistrationReadiness {
  const missing = missingRegistrationItems(input);

  if (
    input.registrationStatus === "suspended" ||
    input.brandStatus === "suspended" ||
    input.campaignStatus === "suspended"
  ) {
    return {
      state: "blocked",
      label: "Suspended / blocked",
      canSend: false,
      missing,
      guidance: "Sending is blocked. Resolve the suspension in the Twilio Console, then update the status here.",
    };
  }

  if (
    input.registrationStatus === "rejected" ||
    input.brandStatus === "rejected" ||
    input.campaignStatus === "rejected"
  ) {
    return {
      state: "action_needed",
      label: "Action needed",
      canSend: false,
      missing,
      guidance:
        "A carrier or Twilio review was rejected. Fix and resubmit in the Twilio Console, then update the statuses and note here.",
    };
  }

  if (input.registrationStatus === "approved") {
    if (missing.length === 0) {
      return {
        state: "ready",
        label: "Approved / ready",
        canSend: true,
        missing,
        guidance: "Registration is complete. Studio texting is allowed while the platform SMS switch is on.",
      };
    }
    return {
      state: "incomplete",
      label: "Setup incomplete",
      canSend: false,
      missing,
      guidance: `Marked approved but not sendable. Missing: ${missing.join(", ")}.`,
    };
  }

  if (input.registrationStatus === "in_review") {
    return {
      state: "waiting_review",
      label: "Waiting for review",
      canSend: false,
      missing,
      guidance: "Submitted. Sending stays off until Brand and Campaign are approved and the registration is marked approved.",
    };
  }

  return {
    state: "incomplete",
    label: "Setup incomplete",
    canSend: false,
    missing,
    guidance: missing.length > 0 ? `Still to add: ${missing.join(", ")}.` : "Mark the registration in review or approved.",
  };
}
