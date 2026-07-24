import { createAdminClient } from "@/lib/supabase/admin";

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
};


function normalizeEmail(value: string | null | undefined) {
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