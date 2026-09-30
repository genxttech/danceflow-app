import { createAdminClient } from "@/lib/supabase/admin";
import { extractSenderAddress, formatFrom } from "@/lib/email/sender";

type QueueOutboundDeliveryParams = {
  studioId: string;
  channel: "email" | "sms";
  templateKey: string;
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  subject?: string | null;
  bodyText: string;
  bodyHtml?: string | null;
  relatedTable?: string | null;
  relatedId?: string | null;
  dedupeKey?: string | null;
  replyToEmail?: string | null;
  /**
   * PAY-DC-3 (D-G): the client sender display name resolved at queue time (organizer events), stored in the
   * delivery payload. Only honored at send time for allowlisted client-facing template keys.
   */
  senderDisplayName?: string | null;
};

/**
 * The shared outbound "From" resolution. The address keeps its environment override precedence
 * (`NOTIFICATION_FROM_EMAIL` → `OUTBOUND_EMAIL_FROM` → `notify@idanceflow.com`).
 *
 * Without a sender name the configured value is returned unchanged (staff / system / platform email stays
 * `DanceFlow`). With a client sender name (PAY-DC-3, D2) the display name is replaced by that name through
 * `formatFrom`, keeping the configured address.
 */
export function resolveOutboundFromEmail(options: { senderName?: string | null } = {}) {
  const configured =
    process.env.NOTIFICATION_FROM_EMAIL ||
    process.env.OUTBOUND_EMAIL_FROM ||
    "DanceFlow <notify@idanceflow.com>";

  const senderName = options.senderName?.trim();
  if (!senderName) return configured;

  const address = extractSenderAddress(configured);
  if (!address) return configured;

  return formatFrom(senderName, address);
}

export function normalizeEmail(value: string | null | undefined) {
  const email = value?.trim().toLowerCase() || null;
  if (!email) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function isDanceFlowSystemTemplate(templateKey: string) {
  return (
    templateKey.startsWith("platform_") ||
    templateKey.startsWith("danceflow_") ||
    templateKey === "welcome_to_danceflow" ||
    templateKey === "platform_admin_invite"
  );
}

async function resolveStudioReplyToEmail(params: {
  studioId: string;
  templateKey: string;
  explicitReplyToEmail?: string | null;
}) {
  if (isDanceFlowSystemTemplate(params.templateKey)) return null;

  const explicit = normalizeEmail(params.explicitReplyToEmail);
  if (explicit) return explicit;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("studios")
    .select("email")
    .eq("id", params.studioId)
    .maybeSingle<{ email: string | null }>();

  if (error) {
    throw new Error(`Failed to resolve studio reply address: ${error.message}`);
  }

  return normalizeEmail(data?.email);
}

export async function queueOutboundDelivery(params: QueueOutboundDeliveryParams) {
  const supabase = createAdminClient();

  const recipientEmail = params.recipientEmail?.trim() || null;
  const recipientPhone = params.recipientPhone?.trim() || null;
  const replyToEmail =
    params.channel === "email"
      ? await resolveStudioReplyToEmail({
          studioId: params.studioId,
          templateKey: params.templateKey,
          explicitReplyToEmail: params.replyToEmail,
        })
      : null;

  if (params.channel === "email" && !recipientEmail) {
    return { queued: false, skipped: true, reason: "missing_email" as const };
  }

  if (params.channel === "sms" && !recipientPhone) {
    return { queued: false, skipped: true, reason: "missing_phone" as const };
  }

  const payload = {
    studio_id: params.studioId,
    channel: params.channel,
    template_key: params.templateKey,
    recipient_email: recipientEmail,
    recipient_phone: recipientPhone,
    subject: params.subject || null,
    body_text: params.bodyText,
    body_html: params.bodyHtml ?? null,
    reply_to_email: replyToEmail,
    related_table: params.relatedTable || null,
    related_id: params.relatedId || null,
    dedupe_key: params.dedupeKey || null,
    ...(params.senderDisplayName?.trim()
      ? { payload: { senderDisplayName: params.senderDisplayName.trim() } }
      : {}),
    status: "queued" as const,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("outbound_deliveries")
    .insert(payload);

  if (error) {
    if (params.dedupeKey && error.code === "23505") {
      return { queued: false, skipped: true, reason: "duplicate" as const };
    }

    throw new Error(`Failed to queue outbound delivery: ${error.message}`);
  }

  return { queued: true, skipped: false };
}