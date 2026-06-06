import { createAdminClient } from "@/lib/supabase/admin";
import { Resend } from "resend";
import twilio from "twilio";

type OutboundPayload = Record<string, unknown> | null;

type OutboundDeliveryRow = {
  id: string;
  studio_id: string;
  channel: "email" | "sms";
  template_key: string;
  recipient_email: string | null;
  recipient_phone: string | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  payload: OutboundPayload;
  status: "queued" | "sent" | "failed" | "skipped";
};

type DispatchResult =
  | { ok: true; providerMessageId?: string | null }
  | { ok: false; error: string };

type RenderedMessage = {
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
};

type WelcomeEmailAudience = "studio" | "organizer" | "public";

function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("Missing RESEND_API_KEY.");
  }
  return new Resend(apiKey);
}

function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    throw new Error("Missing Twilio credentials.");
  }

  return twilio(accountSid, authToken);
}

function getSiteUrl() {
  return (process.env.NEXT_PUBLIC_SITE_URL || "https://idanceflow.com").replace(
    /\/$/,
    ""
  );
}

function getOutboundFromEmail() {
  return (
    process.env.NOTIFICATION_FROM_EMAIL ||
    process.env.OUTBOUND_EMAIL_FROM ||
    "DanceFlow <notify@idanceflow.com>"
  );
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeTimeZone(value: unknown) {
  const timeZone = asString(value) || "America/New_York";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return "America/New_York";
  }
}

function formatDateTime(value: string, timeZone = "America/New_York") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function renderAppointmentMessage(row: OutboundDeliveryRow): RenderedMessage | null {
  const payload = row.payload ?? {};

  const appointmentLabel =
    asString(payload.appointmentLabel) || "Appointment";
  const startsAt = asString(payload.startsAt);
  const endsAt = asString(payload.endsAt);
  const studioTimeZone = safeTimeZone(payload.studioTimeZone);
  const clientFirstName = asString(payload.clientFirstName);
  const instructorFirstName = asString(payload.instructorFirstName);
  const instructorLastName = asString(payload.instructorLastName);
  const roomName = asString(payload.roomName);

  const whenText = startsAt
    ? formatDateTime(startsAt, studioTimeZone)
    : "your scheduled time";
  const endText = endsAt ? formatDateTime(endsAt, studioTimeZone) : "";
  const instructorText =
    instructorFirstName || instructorLastName
      ? [instructorFirstName, instructorLastName].filter(Boolean).join(" ")
      : "";
  const greetingName = clientFirstName || "there";

  let subject = "DanceFlow Appointment";
  let bodyText = `Hi ${greetingName},\n\nThis is an update about your appointment.`;

  if (row.template_key === "appointment_confirmed") {
    subject = `${appointmentLabel} Confirmed`;
    bodyText = [
      `Hi ${greetingName},`,
      "",
      `Your ${appointmentLabel.toLowerCase()} is confirmed for ${whenText}.`,
      endText ? `It is scheduled to end at ${endText}.` : "",
      instructorText ? `Instructor: ${instructorText}.` : "",
      roomName ? `Location: ${roomName}.` : "",
      "",
      "We look forward to seeing you.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (row.template_key === "appointment_rescheduled") {
    subject = `${appointmentLabel} Rescheduled`;
    bodyText = [
      `Hi ${greetingName},`,
      "",
      `Your ${appointmentLabel.toLowerCase()} has been rescheduled to ${whenText}.`,
      endText ? `It is scheduled to end at ${endText}.` : "",
      instructorText ? `Instructor: ${instructorText}.` : "",
      roomName ? `Location: ${roomName}.` : "",
      "",
      "Please contact the studio if you have any questions.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (row.template_key === "appointment_cancelled") {
    subject = `${appointmentLabel} Cancelled`;
    bodyText = [
      `Hi ${greetingName},`,
      "",
      `Your ${appointmentLabel.toLowerCase()} scheduled for ${whenText} has been cancelled.`,
      instructorText ? `Instructor: ${instructorText}.` : "",
      roomName ? `Location: ${roomName}.` : "",
      "",
      "Please contact the studio if you would like to reschedule.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (
    row.template_key !== "appointment_confirmed" &&
    row.template_key !== "appointment_rescheduled" &&
    row.template_key !== "appointment_cancelled"
  ) {
    return null;
  }

  return { subject, bodyText };
}

function renderMessage(row: OutboundDeliveryRow): RenderedMessage {
  if (row.subject && row.body_text) {
    return {
      subject: row.subject,
      bodyText: row.body_text,
      bodyHtml: row.body_html,
    };
  }

  const appointmentMessage = renderAppointmentMessage(row);
  if (appointmentMessage) {
    return appointmentMessage;
  }

  return {
    subject: row.subject ?? "DanceFlow Notification",
    bodyText: row.body_text ?? "You have a new notification from DanceFlow.",
  };
}

function getWelcomeEmailContent(params: {
  fullName?: string | null;
  workspaceName?: string | null;
  audience: WelcomeEmailAudience;
}) {
  const siteUrl = getSiteUrl();
  const firstName =
    params.fullName?.trim().split(/\s+/)[0] ||
    params.workspaceName?.trim() ||
    "there";
  const safeFirstName = escapeHtml(firstName);

  const isOrganizer = params.audience === "organizer";
  const isStudio = params.audience === "studio";

  const subject = isOrganizer
    ? "Welcome to DanceFlow — your organizer workspace is ready"
    : isStudio
      ? "Welcome to DanceFlow — your studio workspace is ready"
      : "Welcome to DanceFlow";

  const dashboardUrl = params.audience === "public" ? `${siteUrl}/account` : `${siteUrl}/app`;
  const knowledgebaseUrl = `${siteUrl}/knowledgebase`;
  const whatIsDanceFlowUrl = `${siteUrl}/knowledgebase/what-is-danceflow`;
  const studioGettingStartedUrl = `${siteUrl}/knowledgebase/getting-started-checklist-for-studios`;
  const publicProfileUrl = `${siteUrl}/knowledgebase/setting-up-your-public-studio-profile`;
  const publicDiscoveryUrl = `${siteUrl}/knowledgebase/making-your-studio-visible-in-public-discovery`;
  const introRequestsUrl = `${siteUrl}/knowledgebase/setting-up-intro-lesson-requests`;
  const portalLinkingUrl = `${siteUrl}/knowledgebase/client-portal-linking-invites-vs-existing-accounts`;
  const payoutsUrl = `${siteUrl}/knowledgebase/billing-payments-and-payouts`;
  const supportUrl = `${siteUrl}/app/support`;

  const introLine = isOrganizer
    ? "DanceFlow helps organizers promote events, manage registrations, and connect dancers with places to dance."
    : isStudio
      ? "DanceFlow helps studios manage clients, scheduling, packages, memberships, payments, leads, and public discovery in one connected platform."
      : "DanceFlow helps dancers discover studios, events, and dance opportunities while keeping their favorite places easier to find.";

  const nextSteps = isOrganizer
    ? [
        "Open your organizer workspace.",
        "Review your billing and payout setup when you are ready to take paid registrations.",
        "Create your first event and preview the public event page.",
        "Review the Getting Started articles in the knowledgebase.",
      ]
    : isStudio
      ? [
          "Open your studio workspace.",
          "Complete your public studio profile with your logo, hero image, description, and contact details.",
          "Turn on public discovery so dancers can find your studio.",
          "Set up your public lead form and intro lesson request options.",
          "Add your first clients, instructors, rooms, packages, or memberships.",
          "Review the Getting Started articles in the knowledgebase.",
        ]
      : [
          "Open your account.",
          "Explore studios and events.",
          "Save favorites so they are easier to find later.",
        ];

  const links = isOrganizer
    ? [
        { label: "What is DanceFlow?", url: whatIsDanceFlowUrl },
        { label: "Billing, Payments, and Payouts", url: payoutsUrl },
        { label: "Knowledgebase", url: knowledgebaseUrl },
      ]
    : isStudio
      ? [
          { label: "Getting Started Checklist for Studios", url: studioGettingStartedUrl },
          { label: "Setting Up Your Public Studio Profile", url: publicProfileUrl },
          { label: "Making Your Studio Visible in Public Discovery", url: publicDiscoveryUrl },
          { label: "Setting Up Intro Lesson Requests", url: introRequestsUrl },
          { label: "Client Portal Linking: Invites vs Existing Accounts", url: portalLinkingUrl },
          { label: "Billing, Payments, and Payouts", url: payoutsUrl },
        ]
      : [
          { label: "What is DanceFlow?", url: whatIsDanceFlowUrl },
          { label: "Knowledgebase", url: knowledgebaseUrl },
        ];

  const text = [
    `Hi ${firstName},`,
    "",
    "Welcome to DanceFlow. We are excited to have you in the DanceFlow community.",
    "",
    introLine,
    "",
    "Recommended next steps:",
    ...nextSteps.map((step) => `- ${step}`),
    "",
    `Open your dashboard: ${dashboardUrl}`,
    "",
    "Helpful articles:",
    ...links.map((link) => `- ${link.label}: ${link.url}`),
    "",
    `Support: ${supportUrl}`,
    "",
    "Thanks for being part of DanceFlow.",
    "",
    "The DanceFlow Team",
  ].join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; color: #0f172a; line-height: 1.6; max-width: 680px;">
      <h1 style="color: #4c1d95; margin-bottom: 12px;">Welcome to DanceFlow</h1>

      <p>Hi ${safeFirstName},</p>

      <p>Welcome to DanceFlow. We are excited to have you in the DanceFlow community.</p>

      <p>${escapeHtml(introLine)}</p>

      <h2 style="font-size: 18px; margin-top: 24px;">Recommended next steps</h2>
      <ul>
        ${nextSteps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}
      </ul>

      <p style="margin-top: 24px;">
        <a href="${dashboardUrl}" style="display: inline-block; background: #4c1d95; color: #ffffff; padding: 12px 18px; border-radius: 12px; text-decoration: none; font-weight: 700;">
          Open your dashboard
        </a>
      </p>

      <h2 style="font-size: 18px; margin-top: 24px;">Helpful Getting Started articles</h2>
      <ul>
        ${links
          .map(
            (link) =>
              `<li><a href="${link.url}" style="color: #4c1d95;">${escapeHtml(
                link.label
              )}</a></li>`
          )
          .join("")}
      </ul>

      <p style="margin-top: 24px;">
        Need help? Visit <a href="${supportUrl}" style="color: #4c1d95;">Support</a> or reply to this email.
      </p>

      <p style="margin-top: 28px;">
        Thanks for being part of DanceFlow.<br />
        The DanceFlow Team
      </p>
    </div>
  `;

  return { subject, text, html };
}

export async function sendWelcomeToDanceFlowEmail(params: {
  to: string | null | undefined;
  fullName?: string | null;
  workspaceName?: string | null;
  audience: WelcomeEmailAudience;
}): Promise<DispatchResult> {
  const to = params.to?.trim();

  if (!to) {
    return { ok: false, error: "Missing welcome email recipient." };
  }

  const rendered = getWelcomeEmailContent(params);
  const from = getOutboundFromEmail();

  try {
    const resend = getResendClient();

    const response = await resend.emails.send({
      from,
      to: [to],
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });

    if (response.error) {
      return {
        ok: false,
        error: response.error.message || "Welcome email send failed.",
      };
    }

    return {
      ok: true,
      providerMessageId: response.data?.id ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Unknown welcome email send error.",
    };
  }
}

async function sendEmail(row: OutboundDeliveryRow): Promise<DispatchResult> {
  if (!row.recipient_email) {
    return { ok: false, error: "Missing recipient email." };
  }

  const from = getOutboundFromEmail();
  if (!from) {
    return { ok: false, error: "Missing outbound from email." };
  }

  const rendered = renderMessage(row);

  try {
    const resend = getResendClient();

    const response = await resend.emails.send({
      from,
      to: [row.recipient_email],
      subject: rendered.subject,
      text: rendered.bodyText,
      html: rendered.bodyHtml || undefined,
    });

    if (response.error) {
      return {
        ok: false,
        error: response.error.message || "Resend send failed.",
      };
    }

    return {
      ok: true,
      providerMessageId: response.data?.id ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown email send error",
    };
  }
}

async function sendSms(row: OutboundDeliveryRow): Promise<DispatchResult> {
  if (!row.recipient_phone) {
    return { ok: false, error: "Missing recipient phone." };
  }

  const from = process.env.TWILIO_FROM_NUMBER;
  if (!from) {
    return { ok: false, error: "Missing TWILIO_FROM_NUMBER." };
  }

  const rendered = renderMessage(row);

  try {
    const client = getTwilioClient();

    const message = await client.messages.create({
      to: row.recipient_phone,
      from,
      body: rendered.bodyText,
    });

    return {
      ok: true,
      providerMessageId: message.sid ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown SMS send error",
    };
  }
}

async function markSent(id: string, providerMessageId?: string | null) {
  const supabase = createAdminClient();

  const { error } = await supabase
    .from("outbound_deliveries")
    .update({
      status: "sent",
      provider_message_id: providerMessageId ?? null,
      sent_at: new Date().toISOString(),
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to mark outbound delivery sent: ${error.message}`);
  }
}

async function markFailed(id: string, errorMessage: string) {
  const supabase = createAdminClient();

  const { error } = await supabase
    .from("outbound_deliveries")
    .update({
      status: "failed",
      error_message: errorMessage,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to mark outbound delivery failed: ${error.message}`);
  }
}

export async function dispatchQueuedOutboundDeliveries(limit = 25) {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("outbound_deliveries")
    .select(`
      id,
      studio_id,
      channel,
      template_key,
      recipient_email,
      recipient_phone,
      subject,
      body_text,
      body_html,
      payload,
      status
    `)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load queued outbound deliveries: ${error.message}`);
  }

  const rows = (data ?? []) as OutboundDeliveryRow[];

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const result =
        row.channel === "email" ? await sendEmail(row) : await sendSms(row);

      if (!result.ok) {
        failed += 1;
        await markFailed(row.id, result.error);
        continue;
      }

      sent += 1;
      await markSent(row.id, result.providerMessageId ?? null);
    } catch (error) {
      failed += 1;
      await markFailed(
        row.id,
        error instanceof Error ? error.message : "Unknown outbound dispatch error"
      );
    }
  }

  return {
    processed: rows.length,
    sent,
    failed,
  };
}



