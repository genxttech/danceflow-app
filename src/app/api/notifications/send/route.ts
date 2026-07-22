import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchQueuedOutboundDeliveries } from "@/lib/notifications/dispatch";
import { getCronAuthFailure } from "@/lib/security/cron";
import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";

type DeliveryRow = {
  id: string;
  studio_id: string;
  user_id: string | null;
  client_id: string | null;
  delivery_type: string;
  channel: "email" | "sms" | "in_app";
  status: "pending" | "sent" | "failed" | "cancelled";
  subject: string | null;
  body: string | null;
  metadata: Record<string, unknown> | null;
  scheduled_for: string;
};

type StudioBrandingRow = {
  id: string;
  name: string;
  public_name: string | null;
  public_logo_url: string | null;
  slug: string | null;
};

function metadataString(
  metadata: Record<string, unknown> | null,
  key: string,
) {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function formatLessonDateTime(
  value: string,
  timeZone: string,
) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

async function getStudioBranding(
  supabase: ReturnType<typeof createAdminClient>,
  studioId: string,
) {
  const { data, error } = await supabase
    .from("studios")
    .select("id, name, public_name, public_logo_url, slug")
    .eq("id", studioId)
    .maybeSingle<StudioBrandingRow>();

  if (error || !data) {
    return {
      name: "Your dance studio",
      logoUrl: null,
      portalUrl: null,
    };
  }

  const siteUrl = (
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "https://idanceflow.com"
  ).replace(/\/$/, "");

  return {
    name: data.public_name?.trim() || data.name || "Your dance studio",
    logoUrl: data.public_logo_url,
    portalUrl: data.slug
      ? `${siteUrl}/portal/${encodeURIComponent(data.slug)}`
      : null,
  };
}

function renderNotificationHtml(params: {
  delivery: DeliveryRow;
  studioName: string;
  studioLogoUrl?: string | null;
  portalUrl?: string | null;
}) {
  const { delivery } = params;
  const metadata = delivery.metadata ?? {};
  const clientName = metadataString(metadata, "clientName");
  const startsAt = metadataString(metadata, "startsAt");
  const timeZone =
    metadataString(metadata, "studioTimezone") || "America/New_York";
  const appointmentTitle =
    metadataString(metadata, "appointmentTitle") ||
    metadataString(metadata, "appointmentType")
      .replaceAll("_", " ")
      .replace(/\b\w/g, (character) => character.toUpperCase()) ||
    "Lesson";

  if (
    delivery.delivery_type === "student_lesson_reminder_24h" ||
    delivery.delivery_type === "student_lesson_reminder_2h"
  ) {
    const startsLabel = startsAt
      ? formatLessonDateTime(startsAt, timeZone)
      : "your scheduled lesson time";
    const isSoon = delivery.delivery_type === "student_lesson_reminder_2h";

    return renderStudioBrandedEmail(
      {
        name: params.studioName,
        logoUrl: params.studioLogoUrl,
      },
      {
        previewText:
          delivery.subject ||
          `${appointmentTitle} reminder from ${params.studioName}`,
        eyebrow: "Lesson Reminder",
        heading: isSoon ? "Your lesson starts soon" : "Your lesson is coming up",
        greeting: clientName ? `Hi ${clientName},` : "Hello,",
        intro: isSoon
          ? `${params.studioName} is looking forward to seeing you soon.`
          : `${params.studioName} is sending a reminder about your upcoming lesson.`,
        bodyText:
          delivery.body ||
          `You have an upcoming lesson scheduled for ${startsLabel}.`,
        detailRows: [
          { label: "Lesson", value: appointmentTitle },
          { label: "Date and time", value: startsLabel },
        ],
        actionLabel: params.portalUrl ? "Open Student Portal" : null,
        actionUrl: params.portalUrl,
        footerText: `Sent by ${params.studioName} through DanceFlow.`,
      },
    );
  }

  return renderStudioBrandedEmail(
    {
      name: params.studioName,
      logoUrl: params.studioLogoUrl,
    },
    {
      previewText: delivery.subject || `${params.studioName} notification`,
      heading: delivery.subject || "Studio Notification",
      bodyText:
        delivery.body || "You have a new notification from your dance studio.",
      actionLabel: params.portalUrl ? "Open DanceFlow" : null,
      actionUrl: params.portalUrl,
      footerText: `Sent by ${params.studioName} through DanceFlow.`,
    },
  );
}

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
      subject: params.subject,
      text: params.text,
      html: params.html,
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

