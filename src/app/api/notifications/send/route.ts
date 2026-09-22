import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchQueuedOutboundDeliveries } from "@/lib/notifications/dispatch";
import { getCronAuthFailure } from "@/lib/security/cron";
import { sanitizeEmailSubject } from "@/lib/email/brand";
import {
  renderNotificationHtml,
  resolveNotificationStudioBranding,
  resolveReminderReplyTo,
  type NotificationDeliveryRow,
  type NotificationStudioBrandingRow,
} from "@/lib/notifications/notification-html";

type DeliveryRow = NotificationDeliveryRow;

async function getStudioBranding(
  supabase: ReturnType<typeof createAdminClient>,
  studioId: string,
) {
  const { data } = await supabase
    .from("studios")
    .select("id, name, public_name, public_logo_url, slug, email")
    .eq("id", studioId)
    .maybeSingle<NotificationStudioBrandingRow>();

  return resolveNotificationStudioBranding(data);
}

const CLIENT_REMINDER_TYPES = new Set([
  "student_lesson_reminder_24h",
  "student_lesson_reminder_2h",
]);

async function resolveRecipientEmail(
  supabase: ReturnType<typeof createAdminClient>,
  delivery: DeliveryRow
) {
  const metadata = delivery.metadata ?? {};

  if (delivery.client_id) {
    const metadataEmail =
      typeof metadata.clientEmail === "string" ? metadata.clientEmail : null;

    if (metadataEmail) {
      return metadataEmail;
    }

    const { data: client } = await supabase
      .from("clients")
      .select("email")
      .eq("id", delivery.client_id)
      .single();

    return client?.email ?? null;
  }

  if (delivery.user_id) {
    const { data, error } = await supabase.auth.admin.getUserById(delivery.user_id);

    if (!error && data?.user?.email) {
      return data.user.email;
    }
  }

  return null;
}

async function sendEmail(params: {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string | null;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from =
    process.env.NOTIFICATION_FROM_EMAIL ||
    process.env.RESEND_FROM_EMAIL ||
    "DanceFlow <notifications@danceflow.app>";

  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [params.to],
      subject: sanitizeEmailSubject(params.subject),
      text: params.text,
      html: params.html,
      ...(params.replyTo ? { reply_to: params.replyTo } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Email send failed: ${errorText}`);
  }

  return response.json();
}

async function processPendingNotificationDeliveries(request: NextRequest) {
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;

  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();

  const { data: deliveries, error: fetchError } = await supabase
    .from("notification_deliveries")
    .select(
      `
      id,
      studio_id,
      user_id,
      client_id,
      delivery_type,
      channel,
      status,
      subject,
      body,
      metadata,
      scheduled_for
    `
    )
    .eq("status", "pending")
    .lte("scheduled_for", nowIso)
    .order("scheduled_for", { ascending: true })
    .limit(100);

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  const pending = (deliveries ?? []) as DeliveryRow[];

  let notificationSent = 0;
  let notificationFailed = 0;

  if (!pending.length) {
    const outbound = await dispatchQueuedOutboundDeliveries(100);

    return NextResponse.json({
      ok: true,
      notifications: {
        processed: 0,
        sent: 0,
        failed: 0,
      },
      outbound,
      message:
        outbound.processed > 0
          ? "Processed queued outbound deliveries."
          : "No pending notification or outbound deliveries were due.",
    });
  }


  for (const delivery of pending) {
    try {
      if (delivery.channel !== "email") {
        await supabase
          .from("notification_deliveries")
          .update({
            status: "failed",
            failed_at: new Date().toISOString(),
            failure_reason: `Unsupported channel: ${delivery.channel}`,
          })
          .eq("id", delivery.id);

        notificationFailed += 1;
        continue;
      }

      const recipientEmail = await resolveRecipientEmail(supabase, delivery);

      if (!recipientEmail) {
        await supabase
          .from("notification_deliveries")
          .update({
            status: "failed",
            failed_at: new Date().toISOString(),
            failure_reason: "No recipient email could be resolved.",
          })
          .eq("id", delivery.id);

        notificationFailed += 1;
        continue;
      }

      const studioBranding = await getStudioBranding(
        supabase,
        delivery.studio_id,
      );

      // Reply-To is set only for client reminders, and only when the studio's own email is valid.
      // Internal staff notifications (owner digest, instructor agenda) keep no Reply-To, as before.
      const replyTo = CLIENT_REMINDER_TYPES.has(delivery.delivery_type)
        ? resolveReminderReplyTo(studioBranding.replyToEmail)
        : null;

      await sendEmail({
        to: recipientEmail,
        subject: delivery.subject || `${studioBranding.name} notification`,
        text:
          delivery.body ||
          `You have a new notification from ${studioBranding.name}.`,
        html: renderNotificationHtml({
          delivery,
          studioName: studioBranding.name,
          studioLogoUrl: studioBranding.logoUrl,
          portalUrl: studioBranding.portalUrl,
        }),
        replyTo,
      });

      await supabase
        .from("notification_deliveries")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          failure_reason: null,
        })
        .eq("id", delivery.id);

      notificationSent += 1;
    } catch (error) {
      await supabase
        .from("notification_deliveries")
        .update({
          status: "failed",
          failed_at: new Date().toISOString(),
          failure_reason:
            error instanceof Error ? error.message : "Unknown send failure",
        })
        .eq("id", delivery.id);

      notificationFailed += 1;
    }
  }

  const outbound = await dispatchQueuedOutboundDeliveries(100);

  return NextResponse.json({
    ok: true,
    notifications: {
      processed: pending.length,
      sent: notificationSent,
      failed: notificationFailed,
    },
    outbound,
  });
}

export async function GET(request: NextRequest) {
  return processPendingNotificationDeliveries(request);
}

export async function POST(request: NextRequest) {
  return processPendingNotificationDeliveries(request);
}

