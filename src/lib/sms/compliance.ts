export type SmsConsentStatus = "unknown" | "opted_in" | "opted_out";

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
  permission: Pick<SmsPermissionRow, "consent_status"> | null | undefined,
): boolean {
  return permission?.consent_status === "opted_in";
}

export function smsConsentLabel(status: SmsConsentStatus): string {
  if (status === "opted_in") return "SMS allowed";
  if (status === "opted_out") return "SMS opted out";
  return "SMS consent needed";
}

export function smsConsentTip(status: SmsConsentStatus): string {
  if (status === "opted_in") {
    return "This contact has agreed to receive texts from this workspace.";
  }

  if (status === "opted_out") {
    return "This contact has opted out of texts. Do not send SMS unless they opt back in.";
  }

  return "Get permission before texting this contact. Email or call first if consent is unclear.";
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

export function getSmsOptOutFooter(studioName?: string | null) {
  const sender = studioName?.trim() ? studioName.trim() : "your studio";
  return `Reply STOP to opt out. Msg & data rates may apply.`;
}

export function appendSmsOptOutFooter(message: string, studioName?: string | null) {
  const trimmed = message.trim();
  const footer = getSmsOptOutFooter(studioName);

  if (!trimmed) return footer;
  if (trimmed.toLowerCase().includes("reply stop")) return trimmed;

  return `${trimmed}\n\n${footer}`;
}
