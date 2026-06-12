export type SmsConsentStatus = "unknown" | "opted_in" | "opted_out";

export const SMS_CONSENT_DISCLOSURE =
  "I agree to receive text messages from my dance studio through DanceFlow, including appointment reminders, schedule updates, event reminders, ticket notifications, and client service messages. Message frequency varies. Message and data rates may apply. Reply HELP for help. Reply STOP to unsubscribe. Consent is not required to purchase or use services.";

export const SMS_CONSENT_REVIEW_URL = "https://idanceflow.com/sms-consent";

export type SmsWorkspaceRef =
  | { studioId: string; organizerId?: null }
  | { studioId?: null; organizerId: string };

export type SmsConsentInput = SmsWorkspaceRef & {
  clientId?: string | null;
  organizerContactId?: string | null;
  phoneRaw: string;
  consentStatus: SmsConsentStatus;
  consentSource?: string | null;
  consentNote?: string | null;
};

export type SmsPermissionRow = {
  id: string;
  studio_id: string | null;
  organizer_id: string | null;
  client_id: string | null;
  organizer_contact_id: string | null;
  phone_e164: string;
  consent_status: SmsConsentStatus;
  consent_source: string | null;
  consent_note: string | null;
  consent_at: string | null;
  opted_out_at: string | null;
  opted_out_source: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export function normalizeSmsPhone(phone: string): string | null {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  if (trimmed.startsWith("+") && digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`;
  }

  return null;
}

export function canSendSms(
  permission:
    | Pick<SmsPermissionRow, "consent_status" | "opted_out_at">
    | { consent_status?: string | null; opted_out_at?: string | null }
    | null
    | undefined,
): boolean {
  if (!permission) return false;

  return permission.consent_status === "opted_in" && !permission.opted_out_at;
}

export function appendSmsOptOutFooter(message: string, studioName?: string | null): string {
  const body = String(message ?? "").trim();
  const name = String(studioName ?? "").trim();

  const lowerBody = body.toLowerCase();

  if (lowerBody.includes("reply stop") || lowerBody.includes("stop to opt out")) {
    return body;
  }

  const footer = name
    ? `${name}: Reply STOP to opt out. Reply HELP for help.`
    : "Reply STOP to opt out. Reply HELP for help.";

  return `${body}\n\n${footer}`;
}

export function smsConsentLabel(status: SmsConsentStatus): string {
  if (status === "opted_in") return "SMS allowed";
  if (status === "opted_out") return "SMS opted out";
  return "SMS consent needed";
}

export function smsConsentTip(status: SmsConsentStatus): string {
  if (status === "opted_in") {
    return "This contact has agreed to receive service-related text messages from this studio through DanceFlow.";
  }

  if (status === "opted_out") {
    return "This contact has opted out of texts. Do not send SMS unless they opt back in.";
  }

  return "Use SMS only after the student has given clear permission. Consent should be optional, documented, and based on the same disclosure shown in DanceFlow.";
}

export async function upsertSmsConsent(
  supabase: any,
  input: SmsConsentInput,
): Promise<{ data: SmsPermissionRow | null; error: string | null }> {
  const phoneE164 = normalizeSmsPhone(input.phoneRaw);

  if (!phoneE164) {
    return { data: null, error: "Enter a valid phone number before saving SMS consent." };
  }

  const { data, error } = await supabase.rpc("upsert_sms_contact_permission", {
    p_studio_id: "studioId" in input ? input.studioId ?? null : null,
    p_organizer_id: "organizerId" in input ? input.organizerId ?? null : null,
    p_client_id: input.clientId ?? null,
    p_organizer_contact_id: input.organizerContactId ?? null,
    p_phone_e164: phoneE164,
    p_consent_status: input.consentStatus,
    p_consent_source: input.consentSource ?? null,
    p_consent_note: input.consentNote ?? null,
  });

  if (error) {
    return { data: null, error: error.message ?? "SMS consent could not be saved." };
  }

  return { data: data as SmsPermissionRow, error: null };
}

export async function getSmsPermissionForClient(
  supabase: any,
  studioId: string,
  clientId: string,
): Promise<{ data: SmsPermissionRow | null; error: string | null }> {
  const { data, error } = await supabase
    .from("sms_contact_permissions")
    .select("*")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return { data: null, error: error.message ?? "SMS consent could not be loaded." };
  }

  return { data: (data as SmsPermissionRow | null) ?? null, error: null };
}

export async function getSmsPermissionForOrganizerContact(
  supabase: any,
  organizerId: string,
  organizerContactId: string,
): Promise<{ data: SmsPermissionRow | null; error: string | null }> {
  const { data, error } = await supabase
    .from("sms_contact_permissions")
    .select("*")
    .eq("organizer_id", organizerId)
    .eq("organizer_contact_id", organizerContactId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return { data: null, error: error.message ?? "SMS consent could not be loaded." };
  }

  return { data: (data as SmsPermissionRow | null) ?? null, error: null };
}


export type SmsMessageLogRow = {
  id: string;
  studio_id: string | null;
  organizer_id: string | null;
  client_id: string | null;
  organizer_contact_id: string | null;
  phone_e164: string;
  direction: "outbound" | "inbound";
  message_type: string;
  body: string | null;
  segment_count: number;
  status: "draft" | "queued" | "sent" | "delivered" | "failed" | "suppressed" | "received";
  provider: string | null;
  provider_message_id: string | null;
  provider_error_code: string | null;
  provider_error_message: string | null;
  related_table: string | null;
  related_id: string | null;
  sent_by: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  created_at: string;
  updated_at: string;
};

export function smsSendStatusLabel(status: SmsMessageLogRow["status"] | string | null | undefined) {
  const normalized = String(status ?? "").toLowerCase();

  if (normalized === "delivered") return "Delivered";
  if (normalized === "sent") return "Sent";
  if (normalized === "failed") return "Failed";
  if (normalized === "suppressed") return "Not sent";
  if (normalized === "received") return "Received";

  return "Queued";
}


export type SmsPlatformStatus = "disabled" | "pending_review" | "approved" | "rejected";

export type SmsPlatformReadiness = {
  status: SmsPlatformStatus;
  label: string;
  canSend: boolean;
  studioMessage: string;
  platformMessage: string;
};

function normalizeSmsPlatformStatus(value: string | null | undefined): SmsPlatformStatus {
  const normalized = String(value ?? "").trim().toLowerCase();

  if (normalized === "approved") return "approved";
  if (normalized === "rejected") return "rejected";
  if (normalized === "disabled") return "disabled";
  if (normalized === "pending" || normalized === "pending_review" || normalized === "review") {
    return "pending_review";
  }

  return "pending_review";
}

export function getSmsPlatformReadiness(): SmsPlatformReadiness {
  const status = normalizeSmsPlatformStatus(
    process.env.DANCEFLOW_SMS_STATUS ?? process.env.SMS_PLATFORM_STATUS,
  );

  if (status === "approved") {
    return {
      status,
      label: "Approved",
      canSend: true,
      studioMessage: "Text messaging is available for opted-in students.",
      platformMessage: "Carrier approval is marked approved. Production SMS sending is enabled.",
    };
  }

  if (status === "rejected") {
    return {
      status,
      label: "Needs resubmission",
      canSend: false,
      studioMessage: "Text messaging is temporarily unavailable while carrier approval is being corrected.",
      platformMessage: "Carrier approval is marked rejected. Production SMS sending is blocked until the status is changed to approved.",
    };
  }

  if (status === "disabled") {
    return {
      status,
      label: "Disabled",
      canSend: false,
      studioMessage: "Text messaging is currently unavailable.",
      platformMessage: "Production SMS sending is disabled by platform configuration.",
    };
  }

  return {
    status,
    label: "Pending approval",
    canSend: false,
    studioMessage: "Text messaging is waiting on carrier approval before messages can be sent.",
    platformMessage: "Carrier approval is pending review. Production SMS sending is blocked until the status is changed to approved.",
  };
}

export function isSmsSendingApproved() {
  return getSmsPlatformReadiness().canSend;
}

export function getSmsSendingUnavailableMessage() {
  return getSmsPlatformReadiness().studioMessage;
}

export function getSmsOptOutFooter(studioName?: string | null) {
  const sender = studioName?.trim() ? studioName.trim() : "your studio";
  return `Reply STOP to opt out. Reply HELP for help. Msg & data rates may apply.`;
}


