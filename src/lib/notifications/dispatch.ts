import { createAdminClient } from "@/lib/supabase/admin";
import { Resend } from "resend";
import twilio from "twilio";
import {
  renderDanceFlowSystemEmail,
  renderPlainTextAsStudioEmail,
} from "@/lib/notifications/email-branding";
import {
  getAriaOutcomeExpectation,
  verifyPendingAriaOutcomes,
} from "@/lib/aria/outcome-verification";

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
  related_table: string | null;
  related_id: string | null;
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

async function getStudioEmailBranding(studioId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("studios")
    .select("name, public_name, public_logo_url")
    .eq("id", studioId)
    .maybeSingle<{
      name: string;
      public_name: string | null;
      public_logo_url: string | null;
    }>();

  if (error || !data) {
    return {
      name: "Your dance studio",
      logoUrl: null,
    };
  }

  return {
    name: data.public_name?.trim() || data.name || "Your dance studio",
    logoUrl: data.public_logo_url,
  };
}

function isDanceFlowSystemTemplate(templateKey: string) {
  return (
    templateKey.startsWith("platform_") ||
    templateKey.startsWith("danceflow_") ||
    templateKey === "welcome_to_danceflow" ||
    templateKey === "platform_admin_invite"
  );
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
  const termsUrl = `${siteUrl}/terms`;
  const privacyUrl = `${siteUrl}/privacy`;
  const securityUrl = `${siteUrl}/security`;

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
    `SaaS Terms: ${termsUrl}`,
    `Privacy Policy: ${privacyUrl}`,
    `Security: ${securityUrl}`,
    "",
    "Thanks for being part of DanceFlow.",
    "",
    "The DanceFlow Team",
  ].join("\n");

  const html = renderDanceFlowSystemEmail({
    previewText: subject,
    eyebrow: "DanceFlow",
    heading: "Welcome to DanceFlow",
    greeting: `Hi ${firstName},`,
    intro: "We are excited to have you in the DanceFlow community.",
    bodyText: [
      introLine,
      "",
      "Recommended next steps:",
      ...nextSteps.map((step) => `• ${step}`),
      "",
      "Helpful articles:",
      ...links.map((link) => `• ${link.label}: ${link.url}`),
      "",
      `Support: ${supportUrl}`,
    ].join("\n"),
    actionLabel: "Open your dashboard",
    actionUrl: dashboardUrl,
    footerText: "This welcome message was sent by DanceFlow.",
  });

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
  let bodyHtml = rendered.bodyHtml ?? null;

  if (!bodyHtml) {
    if (isDanceFlowSystemTemplate(row.template_key)) {
      bodyHtml = renderDanceFlowSystemEmail({
        previewText: rendered.subject,
        heading: rendered.subject,
        bodyText: rendered.bodyText,
      });
    } else {
      const studioBranding = await getStudioEmailBranding(row.studio_id);
      bodyHtml = renderPlainTextAsStudioEmail({
        studioName: studioBranding.name,
        studioLogoUrl: studioBranding.logoUrl,
        subject: rendered.subject,
        bodyText: rendered.bodyText,
      });
    }
  }

  try {
    const resend = getResendClient();

    const response = await resend.emails.send({
      from,
      to: [row.recipient_email],
      subject: rendered.subject,
      text: rendered.bodyText,
      html: bodyHtml,
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

async function syncAriaDigestRunStatus(params: {
  deliveryId: string;
  status: "sent" | "failed" | "queued";
  errorMessage?: string | null;
}) {
  const supabase = createAdminClient();
  const now = new Date();
  const payload: Record<string, unknown> = {
    status: params.status,
    error_message: params.errorMessage?.slice(0, 1000) ?? null,
    last_attempt_at: now.toISOString(),
  };

  if (params.status === "sent") {
    payload.sent_at = now.toISOString();
    payload.processed_at = now.toISOString();
    payload.next_attempt_at = null;
  } else if (params.status === "failed") {
    payload.processed_at = now.toISOString();
    payload.next_attempt_at = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  } else {
    payload.next_attempt_at = now.toISOString();
  }

  const { error } = await supabase
    .from("aria_digest_runs")
    .update(payload)
    .eq("delivery_id", params.deliveryId);

  if (error) {
    console.warn("Failed to synchronize ARIA digest run status", {
      deliveryId: params.deliveryId,
      status: params.status,
      error,
    });
  }
}

async function recordAriaActionDeliveryEvent(params: {
  studioId: string;
  actionId: string;
  eventType: "delivery_sent" | "delivery_failed" | "delivery_requeued" | "delivery_exhausted";
  previousStatus: string | null;
  newStatus: string | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const supabase = createAdminClient();
  const { error } = await supabase.from("automation_action_events").insert({
    studio_id: params.studioId,
    automation_action_id: params.actionId,
    event_type: params.eventType,
    previous_status: params.previousStatus,
    new_status: params.newStatus,
    note: params.note?.slice(0, 1000) ?? null,
    metadata: params.metadata ?? {},
    created_by: null,
  });

  if (error) {
    console.warn("Failed to record ARIA action delivery event", {
      actionId: params.actionId,
      eventType: params.eventType,
      error,
    });
  }
}

async function syncAriaActionDeliveryStatus(params: {
  row: OutboundDeliveryRow;
  status: "sent" | "failed";
  errorMessage?: string | null;
  providerMessageId?: string | null;
}) {
  if (
    params.row.related_table !== "automation_actions" ||
    !params.row.related_id ||
    !params.row.template_key.startsWith("aria_execution_")
  ) {
    return;
  }

  const supabase = createAdminClient();
  const now = new Date();
  const nowIso = now.toISOString();
  const { data: action, error: lookupError } = await supabase
    .from("automation_actions")
    .select("id, studio_id, rule_key, status, execution_attempt_count")
    .eq("id", params.row.related_id)
    .eq("studio_id", params.row.studio_id)
    .maybeSingle<{
      id: string;
      studio_id: string;
      rule_key: string | null;
      status: string | null;
      execution_attempt_count: number | null;
    }>();

  if (lookupError || !action) {
    console.warn("Failed to load ARIA action for delivery synchronization", {
      deliveryId: params.row.id,
      actionId: params.row.related_id,
      lookupError,
    });
    return;
  }

  const attemptCount = Number(action.execution_attempt_count ?? 0) + 1;

  if (params.status === "sent") {
    const outcomeExpectation = getAriaOutcomeExpectation(action.rule_key);
    const outcomeExpectedBy = outcomeExpectation
      ? new Date(now.getTime() + outcomeExpectation.windowDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
    const nextStatus = outcomeExpectation ? "awaiting_outcome" : "completed";

    const { error } = await supabase
      .from("automation_actions")
      .update({
        status: nextStatus,
        execution_delivery_id: params.row.id,
        execution_status: "sent",
        execution_attempt_count: attemptCount,
        execution_last_attempt_at: nowIso,
        execution_next_attempt_at: null,
        execution_error_message: null,
        execution_sent_at: nowIso,
        completed_at: outcomeExpectation ? null : nowIso,
        outcome_status: outcomeExpectation ? "pending" : "not_applicable",
        outcome_type: outcomeExpectation?.type ?? null,
        outcome_expected_by: outcomeExpectedBy,
        outcome_verified_at: null,
        outcome_related_table: null,
        outcome_related_id: null,
        outcome_evidence: {},
        outcome_last_checked_at: null,
        updated_at: nowIso,
        review_note: outcomeExpectation
          ? "ARIA verified delivery and is monitoring for the expected outcome."
          : "ARIA verified that the approved follow-up was sent.",
      })
      .eq("id", action.id)
      .eq("studio_id", action.studio_id);

    if (error) throw new Error(`Failed to synchronize ARIA action sent state: ${error.message}`);

    await recordAriaActionDeliveryEvent({
      studioId: action.studio_id,
      actionId: action.id,
      eventType: "delivery_sent",
      previousStatus: action.status,
      newStatus: nextStatus,
      note: outcomeExpectation
        ? "ARIA verified outbound delivery and started outcome monitoring."
        : "ARIA verified outbound delivery.",
      metadata: {
        delivery_id: params.row.id,
        provider_message_id: params.providerMessageId ?? null,
        attempt_count: attemptCount,
        outcome_type: outcomeExpectation?.type ?? null,
        outcome_expected_by: outcomeExpectedBy,
      },
    });

    if (outcomeExpectation) {
      const { error: eventError } = await supabase.from("automation_action_events").insert({
        studio_id: action.studio_id,
        automation_action_id: action.id,
        event_type: "outcome_pending",
        previous_status: nextStatus,
        new_status: nextStatus,
        note: "ARIA is monitoring the authoritative record for the expected outcome.",
        metadata: {
          outcome_type: outcomeExpectation.type,
          outcome_expected_by: outcomeExpectedBy,
        },
        created_by: null,
      });
      if (eventError) {
        console.warn("Failed to record ARIA outcome pending event", { actionId: action.id, eventError });
      }
    }
    return;
  }

  const exhausted = attemptCount >= 3;
  const nextAttemptAt = exhausted
    ? null
    : new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  const nextStatus = exhausted ? "failed" : "queued";
  const executionStatus = exhausted ? "exhausted" : "failed";

  const { error } = await supabase
    .from("automation_actions")
    .update({
      status: nextStatus,
      execution_delivery_id: params.row.id,
      execution_status: executionStatus,
      execution_attempt_count: attemptCount,
      execution_last_attempt_at: nowIso,
      execution_next_attempt_at: nextAttemptAt,
      execution_error_message: params.errorMessage?.slice(0, 1000) ?? "Outbound delivery failed.",
      updated_at: nowIso,
      review_note: exhausted
        ? "ARIA delivery failed after three attempts and needs staff attention."
        : "ARIA delivery failed and is scheduled for retry.",
    })
    .eq("id", action.id)
    .eq("studio_id", action.studio_id);

  if (error) throw new Error(`Failed to synchronize ARIA action failure state: ${error.message}`);

  await recordAriaActionDeliveryEvent({
    studioId: action.studio_id,
    actionId: action.id,
    eventType: exhausted ? "delivery_exhausted" : "delivery_failed",
    previousStatus: action.status,
    newStatus: nextStatus,
    note: params.errorMessage ?? "Outbound delivery failed.",
    metadata: {
      delivery_id: params.row.id,
      attempt_count: attemptCount,
      next_attempt_at: nextAttemptAt,
    },
  });
}

async function requeueFailedAriaActionDeliveries(limit = 25) {
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const { data: actions, error } = await supabase
    .from("automation_actions")
    .select("id, studio_id, status, execution_delivery_id, execution_attempt_count")
    .eq("execution_status", "failed")
    .not("execution_delivery_id", "is", null)
    .lt("execution_attempt_count", 3)
    .lte("execution_next_attempt_at", now)
    .order("execution_next_attempt_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load retryable ARIA action deliveries: ${error.message}`);
  }

  let requeued = 0;
  for (const action of actions ?? []) {
    if (!action.execution_delivery_id) continue;

    const { data: delivery, error: deliveryError } = await supabase
      .from("outbound_deliveries")
      .update({ status: "queued", error_message: null, updated_at: now })
      .eq("id", action.execution_delivery_id)
      .eq("studio_id", action.studio_id)
      .eq("related_table", "automation_actions")
      .eq("related_id", action.id)
      .eq("status", "failed")
      .select("id")
      .maybeSingle<{ id: string }>();

    if (deliveryError || !delivery) {
      if (deliveryError) console.warn("Failed to requeue ARIA action delivery", deliveryError);
      continue;
    }

    await supabase
      .from("automation_actions")
      .update({
        status: "queued",
        execution_status: "retrying",
        execution_next_attempt_at: now,
        execution_error_message: null,
        updated_at: now,
      })
      .eq("id", action.id)
      .eq("studio_id", action.studio_id);

    await recordAriaActionDeliveryEvent({
      studioId: action.studio_id,
      actionId: action.id,
      eventType: "delivery_requeued",
      previousStatus: action.status,
      newStatus: "queued",
      note: "ARIA automatically requeued the failed delivery.",
      metadata: {
        delivery_id: action.execution_delivery_id,
        attempt_count: Number(action.execution_attempt_count ?? 0),
      },
    });
    requeued += 1;
  }

  return requeued;
}

async function requeueFailedAriaDigestDeliveries(limit = 25) {
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const { data: runs, error } = await supabase
    .from("aria_digest_runs")
    .select("id, delivery_id, retry_count")
    .eq("status", "failed")
    .not("delivery_id", "is", null)
    .lt("retry_count", 3)
    .lte("next_attempt_at", now)
    .order("next_attempt_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load retryable ARIA digests: ${error.message}`);
  }

  let requeued = 0;
  for (const run of runs ?? []) {
    if (!run.delivery_id) continue;

    const { data: delivery, error: deliveryError } = await supabase
      .from("outbound_deliveries")
      .update({
        status: "queued",
        error_message: null,
        updated_at: now,
      })
      .eq("id", run.delivery_id)
      .eq("status", "failed")
      .select("id")
      .maybeSingle<{ id: string }>();

    if (deliveryError) {
      console.warn("Failed to requeue ARIA digest delivery", deliveryError);
      continue;
    }

    if (!delivery) continue;

    await supabase
      .from("aria_digest_runs")
      .update({
        status: "queued",
        retry_count: Number(run.retry_count ?? 0) + 1,
        last_attempt_at: now,
        next_attempt_at: now,
        error_message: null,
      })
      .eq("id", run.id);

    requeued += 1;
  }

  return requeued;
}

export async function dispatchQueuedOutboundDeliveries(limit = 25) {
  const supabase = createAdminClient();
  const digestRequeued = await requeueFailedAriaDigestDeliveries(limit);
  const actionRequeued = await requeueFailedAriaActionDeliveries(limit);
  const requeued = digestRequeued + actionRequeued;

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
      status,
      related_table,
      related_id
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
        if (row.template_key.startsWith("aria_digest_")) {
          await syncAriaDigestRunStatus({
            deliveryId: row.id,
            status: "failed",
            errorMessage: result.error,
          });
        }
        await syncAriaActionDeliveryStatus({
          row,
          status: "failed",
          errorMessage: result.error,
        });
        continue;
      }

      sent += 1;
      await markSent(row.id, result.providerMessageId ?? null);
      if (row.template_key.startsWith("aria_digest_")) {
        await syncAriaDigestRunStatus({ deliveryId: row.id, status: "sent" });
      }
      await syncAriaActionDeliveryStatus({
        row,
        status: "sent",
        providerMessageId: result.providerMessageId ?? null,
      });
    } catch (error) {
      failed += 1;
      const message =
        error instanceof Error ? error.message : "Unknown outbound dispatch error";
      await markFailed(row.id, message);
      if (row.template_key.startsWith("aria_digest_")) {
        await syncAriaDigestRunStatus({
          deliveryId: row.id,
          status: "failed",
          errorMessage: message,
        });
      }
      await syncAriaActionDeliveryStatus({
        row,
        status: "failed",
        errorMessage: message,
      });
    }
  }

  const outcomes = await verifyPendingAriaOutcomes(Math.max(limit * 2, 50));

  return {
    processed: rows.length,
    requeued,
    sent,
    failed,
    outcomes,
  };
}



