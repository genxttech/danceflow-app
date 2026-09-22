/**
 * BR-3B1: pure HTML rendering for `notification_deliveries` email, extracted from the notifications/send route so it
 * can be tested deterministically. `route.ts` keeps every I/O responsibility (Supabase, the Resend fetch, and the
 * cron/update loop); this module only builds strings from already-loaded data.
 */
import { buildAppUrl, resolveStudioDisplayName, sanitizeActionUrl } from "@/lib/email/brand";
import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";
import { normalizeEmail } from "@/lib/notifications/outbound";

export type NotificationDeliveryRow = {
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

export type NotificationStudioBrandingRow = {
  id: string;
  name: string;
  public_name: string | null;
  public_logo_url: string | null;
  slug: string | null;
  email?: string | null;
};

export function resolveNotificationStudioBranding(data: NotificationStudioBrandingRow | null) {
  if (!data) {
    return { name: "Your dance studio", logoUrl: null, portalUrl: null, replyToEmail: null };
  }

  return {
    name: resolveStudioDisplayName(data),
    logoUrl: data.public_logo_url,
    portalUrl: data.slug ? buildAppUrl(`/portal/${encodeURIComponent(data.slug)}`) : null,
    replyToEmail: normalizeEmail(data.email ?? null),
  };
}

/** Reply-To for client reminders only: the studio's own email, when it passes the shared validator. */
export function resolveReminderReplyTo(studioEmail: string | null | undefined) {
  return normalizeEmail(studioEmail ?? null);
}

function metadataString(metadata: Record<string, unknown> | null, key: string) {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function formatLessonDateTime(value: string, timeZone: string) {
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

export function renderNotificationHtml(params: {
  delivery: NotificationDeliveryRow;
  studioName: string;
  studioLogoUrl?: string | null;
  portalUrl?: string | null;
}) {
  const { delivery } = params;
  const metadata = delivery.metadata ?? {};
  const clientName = metadataString(metadata, "clientName");
  const startsAt = metadataString(metadata, "startsAt");
  const timeZone = metadataString(metadata, "studioTimezone") || "America/New_York";
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
    const startsLabel = startsAt ? formatLessonDateTime(startsAt, timeZone) : "your scheduled lesson time";
    const isSoon = delivery.delivery_type === "student_lesson_reminder_2h";
    const greeting = clientName ? `Hi ${clientName},` : "Hello,";
    const intro = isSoon
      ? `${params.studioName} is looking forward to seeing you soon.`
      : `${params.studioName} is sending a reminder about your upcoming lesson.`;

    // 24h only: prefer the one-click confirmation link as the primary CTA; the portal link stays
    // available as body text so existing functionality is not discarded. The 2h reminder is unchanged.
    const confirmationUrl = !isSoon
      ? sanitizeActionUrl(metadataString(metadata, "confirmationUrl") || null)
      : null;

    const bodyText = confirmationUrl
      ? [
          delivery.body || `You have an upcoming lesson scheduled for ${startsLabel}.`,
          params.portalUrl ? `You can also view this in your Student Portal: ${params.portalUrl}` : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n\n")
      : delivery.body || `You have an upcoming lesson scheduled for ${startsLabel}.`;

    return renderStudioBrandedEmail(
      { name: params.studioName, logoUrl: params.studioLogoUrl },
      {
        previewText: delivery.subject || `${appointmentTitle} reminder from ${params.studioName}`,
        eyebrow: "Lesson Reminder",
        heading: isSoon ? "Your lesson starts soon" : "Your lesson is coming up",
        greeting,
        intro,
        bodyText,
        detailRows: [
          { label: "Lesson", value: appointmentTitle },
          { label: "Date and time", value: startsLabel },
        ],
        actionLabel: confirmationUrl ? "Confirm Appointment" : params.portalUrl ? "Open Student Portal" : null,
        actionUrl: confirmationUrl || params.portalUrl,
        dedupeBodyLeadIn: true,
      },
    );
  }

  const staffPath = delivery.delivery_type === "instructor_daily_agenda" ? "/app/schedule" : "/app";
  const staffLabel = delivery.delivery_type === "instructor_daily_agenda" ? "Open Schedule" : "Open DanceFlow";
  const staffUrl = buildAppUrl(staffPath);

  return renderStudioBrandedEmail(
    { name: params.studioName, logoUrl: params.studioLogoUrl },
    {
      previewText: delivery.subject || `${params.studioName} notification`,
      heading: delivery.subject || "Studio Notification",
      bodyText: delivery.body || "You have a new notification from your dance studio.",
      actionLabel: staffLabel,
      actionUrl: staffUrl,
    },
  );
}
