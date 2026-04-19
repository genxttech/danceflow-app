import { createAdminClient } from "@/lib/supabase/admin";

type QueueOutboundDeliveryParams = {
  studioId: string;
  channel: "email" | "sms";
  templateKey: string;
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  subject?: string | null;
  bodyText: string;
  relatedTable?: string | null;
  relatedId?: string | null;
  dedupeKey?: string | null;
};

export async function queueOutboundDelivery(params: QueueOutboundDeliveryParams) {
  const supabase = createAdminClient();

  const recipientEmail = params.recipientEmail?.trim() || null;
  const recipientPhone = params.recipientPhone?.trim() || null;

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