import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { EMAIL_TOKENS, appendEmailLegalText, buildAppUrl, escapeHtml, resolveStudioDisplayName, sanitizeEmailSubject } from "@/lib/email/brand";
import {
  isClientFacingTemplateKey,
  resolveClientSenderDisplayName,
} from "@/lib/notifications/senderIdentity";
import { Resend } from "resend";
import {
  appendSmsOptOutFooter,
  isAutomatedSmsTemplatePermitted,
  normalizeSmsPhone,
  resolveEffectiveSmsConsent,
  sanitizedSmsProviderError,
  type SmsSkipReason,
} from "@/lib/sms/compliance";
import { resolveStudioSmsSender } from "@/lib/sms/studioSender";
import { estimateSmsSegments, sendTwilioSms } from "@/lib/sms/twilio";
import { replayMeaning, sendBilledSms, smsUsageBillingEnabled, type BilledSendRefusal } from "@/lib/sms/usageBilling";
import { billedSmsProviderFromEnv } from "@/lib/sms/usageProvider";
import {
  renderDanceFlowSystemEmail,
  renderPlainTextAsStudioEmail,
} from "@/lib/notifications/email-branding";
import { normalizeEmail, resolveOutboundFromEmail } from "@/lib/notifications/outbound";
import { classifyOutboundEmail } from "@/lib/marketing/compliance/messageClassification";
import {
  prepareCommercialOutboundEmail,
  type MarketingSkipReason,
  type StudioPostalSettings,
} from "@/lib/marketing/compliance/outboundCompliance";
import {
  getAriaOutcomeExpectation,
  verifyPendingAriaOutcomes,
} from "@/lib/aria/outcome-verification";
import {
  classifyAriaDigestFailure,
  logAriaDigestError,
  logAriaDigestLifecycleEvent,
  recordTerminalAriaDigestFailure,
  sanitizeAriaDigestError,
} from "@/lib/aria/digest-observability";
import {
  DISPATCHER_TIMEOUT_ERROR_NAME,
  DISPATCH_LEASE_SECONDS,
  DISPATCH_RUN_BUDGET_MS,
  PROVIDER_CALL_TIMEOUT_MS,
  classifyEmailProviderError,
  isRequeueSafeFailure,
  PROVIDER_ATTEMPT_STARTED,
  isRetryWindowExhausted,
  nextRetryMarker,
  parseRetryMarker,
  retryWindowExhaustedCode,
  terminalCodeAfterRetries,
  sanitizeDeliveryErrorCode,
} from "@/lib/notifications/deliveryOutcome";

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
  reply_to_email: string | null;
  payload: OutboundPayload;
  status: "queued" | "sent" | "failed" | "skipped";
  related_table: string | null;
  related_id: string | null;
  /** Holds a T2 retry marker while a row is queued for an idempotent retry; otherwise a fixed reason code. */
  error_message?: string | null;
};

/** `error` is a terminal failure; only its sanitized code is stored. */
type DispatchResult =
  | { ok: true; providerMessageId?: string | null }
  | { ok: false; error: string };

/** T2: no renderer exists for this row, so nothing is sent (never a generic fallback message). */
type DispatchSkipReason = SmsSkipReason | MarketingSkipReason | "outbound_template_unsupported";

type SkippedDispatchResult = { ok: false; skipped: true; reason: DispatchSkipReason };

/** T2: the provider may or may not have accepted the message; keep the row queued and retry with the same key. */
type RetryDispatchResult = { ok: false; retry: true; code: string };

/**
 * T2: the email was not handed to the provider because the attempt could not be recorded first: the claim was lost to
 * another worker, or the database write failed. Nothing is written; the row keeps its state until its lease expires.
 */
type NotStartedDispatchResult = { ok: false; notStarted: true; reason: "claim_lost" | "attempt_marker_unavailable" };

type SmsDispatchResult = DispatchResult | SkippedDispatchResult | RetryDispatchResult | NotStartedDispatchResult;

function isSkippedDispatchResult(
  result: SmsDispatchResult,
): result is SkippedDispatchResult {
  return !result.ok && "skipped" in result && result.skipped === true;
}

function isNotStartedDispatchResult(result: SmsDispatchResult): result is NotStartedDispatchResult {
  return !result.ok && "notStarted" in result && result.notStarted === true;
}

function isRetryDispatchResult(result: SmsDispatchResult): result is RetryDispatchResult {
  return !result.ok && "retry" in result && result.retry === true;
}

/**
 * T2: template keys that must never be sent from a stored body or a generic fallback. Intake email is rendered only
 * by its own send-time renderer (NSI spec §22); until that renderer exists every `intake_*` row is skipped.
 *
 * ROLLBACK HAZARD: application versions before T2 have no such guard. They send any queued row that has a subject and
 * body as stored, and fall back to a generic "DanceFlow Notification" email for a row without content. Never queue an
 * `intake_*` row while a pre-T2 version could still be promoted or rolled back to, and drain or cancel queued `intake_*`
 * rows before any rollback below T2. Also, pre-T2 staff pages show a still-queued row that carries a T2 retry marker in
 * `error_message` as failed (or show the raw marker), which could prompt a manual resend with a new idempotency key.
 */
function isRendererOnlyTemplateKey(templateKey: string) {
  return templateKey.startsWith("intake_");
}

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

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
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
    .select("name, public_name, public_logo_url, email")
    .eq("id", studioId)
    .maybeSingle<{
      name: string;
      public_name: string | null;
      public_logo_url: string | null;
      email: string | null;
    }>();

  if (error || !data) {
    return {
      name: "Your dance studio",
      logoUrl: null,
      replyToEmail: null,
      senderDisplayName: null,
    };
  }

  return {
    name: resolveStudioDisplayName(data),
    logoUrl: data.public_logo_url,
    replyToEmail: normalizeEmail(data.email),
    senderDisplayName: resolveClientSenderDisplayName({ studio: data }),
  };
}

/**
 * PAY-DC-3 (D2): allowlisted client-facing email is sent as `"{name} via DanceFlow"`. Event emails carry the
 * organizer/studio display name resolved at queue time; every other allowlisted key uses the studio's name.
 * Everything else keeps the configured `DanceFlow` sender.
 */
async function resolveDeliveryFrom(row: OutboundDeliveryRow) {
  if (!isClientFacingTemplateKey(row.template_key)) return resolveOutboundFromEmail();

  const queuedSenderName = asString(row.payload?.senderDisplayName).trim();
  if (queuedSenderName) return resolveOutboundFromEmail({ senderName: queuedSenderName });

  const branding = await getStudioEmailBranding(row.studio_id);
  return resolveOutboundFromEmail({ senderName: branding.senderDisplayName });
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

/**
 * Returns the message to send, or null when the row has no real content. T2 (S1): a row without a stored text body
 * and without a dedicated renderer is never sent as a generic "You have a new notification" message; the caller skips
 * it with `outbound_template_unsupported`. Rows with stored content and the appointment templates are unchanged.
 */
function renderMessage(row: OutboundDeliveryRow): RenderedMessage | null {
  if (isRendererOnlyTemplateKey(row.template_key)) return null;

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

  // A stored text body without a subject keeps its previous behaviour (existing contract): real content, default subject.
  if (row.body_text) {
    return { subject: row.subject ?? "DanceFlow Notification", bodyText: row.body_text };
  }

  return null;
}

function getWelcomeEmailContent(params: {
  fullName?: string | null;
  workspaceName?: string | null;
  audience: WelcomeEmailAudience;
}) {
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

  const dashboardUrl = buildAppUrl(params.audience === "public" ? "/account" : "/app");
  const knowledgebaseUrl = buildAppUrl("/knowledgebase");
  const whatIsDanceFlowUrl = buildAppUrl("/knowledgebase/what-is-danceflow");
  const studioGettingStartedUrl = buildAppUrl("/knowledgebase/getting-started-checklist-for-studios");
  const publicProfileUrl = buildAppUrl("/knowledgebase/setting-up-your-public-studio-profile");
  const publicDiscoveryUrl = buildAppUrl("/knowledgebase/making-your-studio-visible-in-public-discovery");
  const introRequestsUrl = buildAppUrl("/knowledgebase/setting-up-intro-lesson-requests");
  const portalLinkingUrl = buildAppUrl("/knowledgebase/client-portal-linking-invites-vs-existing-accounts");
  const payoutsUrl = buildAppUrl("/knowledgebase/billing-payments-and-payouts");
  const supportUrl = buildAppUrl("/app/support");
  const termsUrl = buildAppUrl("/terms");
  const privacyUrl = buildAppUrl("/privacy");
  const securityUrl = buildAppUrl("/security");

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

  const htmlBodyText = [
    introLine,
    "",
    "Recommended next steps:",
    ...nextSteps.map((step) => `• ${step}`),
    "",
    "Helpful articles:",
    ...links.map((link) => `• ${link.label}: ${link.url}`),
    "",
    `Support: ${supportUrl}`,
  ].join("\n");

  // BR-3C owner-QA revision: the "Helpful articles" list's knowledgebase URLs are long, unbroken
  // tokens that inflate the shell's table intrinsic width past small viewports even with the shell's
  // standard overflow-wrap (same underlying table-auto-layout behavior as BR-3B2's portal-invite fix).
  // Rendered here via the shell's existing `contentHtml` capability (no new shell field) so only the
  // visible URL text in each knowledgebase link can carry the stronger, narrowly scoped
  // word-break:break-all -- greeting/intro/CTA/footer are unaffected, and the plain-text `text` output
  // above is untouched.
  const paragraphStyle = `margin:0 0 16px;font-size:15px;line-height:1.7;color:${EMAIL_TOKENS.text};overflow-wrap:break-word;word-wrap:break-word;`;
  const nextStepsHtml = nextSteps.map((step) => `• ${escapeHtml(step)}`).join("<br />");
  const linksHtml = links
    .map(
      (link) =>
        `• ${escapeHtml(link.label)}: <span style="word-break:break-all;overflow-wrap:break-word;">${escapeHtml(link.url)}</span>`,
    )
    .join("<br />");
  const contentHtml = [
    `<p style="${paragraphStyle}">${escapeHtml(introLine)}</p>`,
    `<p style="${paragraphStyle}">Recommended next steps:<br />${nextStepsHtml}</p>`,
    `<p style="${paragraphStyle}">Helpful articles:<br />${linksHtml}</p>`,
    `<p style="${paragraphStyle}">Support: ${escapeHtml(supportUrl)}</p>`,
  ].join("");

  const html = renderDanceFlowSystemEmail({
    previewText: subject,
    eyebrow: "DanceFlow",
    heading: "Welcome to DanceFlow",
    greeting: `Hi ${firstName},`,
    intro: "We are excited to have you in the DanceFlow community.",
    bodyText: htmlBodyText,
    contentHtml,
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
  const from = resolveOutboundFromEmail();

  try {
    const resend = getResendClient();

    const response = await resend.emails.send({
      from,
      to: [to],
      subject: sanitizeEmailSubject(rendered.subject),
      text: appendEmailLegalText(rendered.text),
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

async function resolveReplyToEmail(row: OutboundDeliveryRow) {
  if (isDanceFlowSystemTemplate(row.template_key)) return null;

  const persisted = normalizeEmail(row.reply_to_email);
  if (persisted) return persisted;

  const branding = await getStudioEmailBranding(row.studio_id);
  const fallback = branding.replyToEmail;
  if (!fallback) return null;

  const admin = createAdminClient();
  const { error } = await admin
    .from("outbound_deliveries")
    .update({
      reply_to_email: fallback,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("studio_id", row.studio_id);

  if (error) {
    console.warn("Could not persist outbound reply address", {
      deliveryId: row.id,
      studioId: row.studio_id,
      error: error.message,
    });
  }

  return fallback;
}

async function sendEmail(
  row: OutboundDeliveryRow,
  options: {
    /** Records the attempt; called only when the provider is about to be called. Returns false if the claim was lost. */
    beforeProviderCall?: () => Promise<boolean>;
  } = {},
): Promise<SmsDispatchResult> {
  const rendered = renderMessage(row);
  if (!rendered) {
    return { ok: false, skipped: true, reason: "outbound_template_unsupported" };
  }

  if (!row.recipient_email) {
    return { ok: false, error: "missing_recipient_email" };
  }

  const from = await resolveDeliveryFrom(row);
  if (!from) {
    return { ok: false, error: "missing_sender_address" };
  }

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

  const replyTo = await resolveReplyToEmail(row);

  // Marketing M-0 (D1): a commercial ARIA / automation email passes the marketing compliance controls here, at the
  // dispatch boundary: suppression (fail closed), marketing sender, postal address, unsubscribe link and RFC 8058
  // headers. Operational messages are sent exactly as before.
  let sendFrom = from;
  let sendHtml = bodyHtml;
  let sendText = rendered.bodyText;
  let sendHeaders: Record<string, string> | undefined;
  if (classifyOutboundEmail(row.template_key, row.payload) === "commercial") {
    const admin = createAdminClient();
    const { data: studio, error: studioError } = await admin
      .from("studios")
      .select("name, public_name, address_line_1, address_line_2, city, state, postal_code, country")
      .eq("id", row.studio_id)
      .maybeSingle<StudioPostalSettings & { public_name: string | null }>();
    if (studioError) return { ok: false, error: "marketing_studio_lookup_failed" };
    const decision = await prepareCommercialOutboundEmail({
      admin,
      deliveryId: row.id,
      studioId: row.studio_id,
      recipientEmail: row.recipient_email,
      senderDisplayName: studio ? resolveClientSenderDisplayName({ studio }) : null,
      studio: studio ?? null,
      studioDisplayName: resolveStudioDisplayName(studio),
      html: bodyHtml,
      text: rendered.bodyText,
    });
    if (decision.action === "skip") return { ok: false, skipped: true, reason: decision.reason };
    if (decision.action === "fail") return { ok: false, error: decision.error };
    sendFrom = decision.from;
    sendHtml = decision.html;
    sendText = decision.text;
    sendHeaders = decision.headers;
  }

  let resend: Resend;
  try {
    resend = getResendClient();
  } catch {
    // Nothing was sent; retried until configured or until the retry window ends.
    return { ok: false, retry: true, code: "provider_not_configured" };
  }

  // T2: every check that can stop the send has passed; record the attempt before the provider can accept anything.
  if (options.beforeProviderCall) {
    let started: boolean;
    try {
      started = await options.beforeProviderCall();
    } catch {
      return { ok: false, notStarted: true, reason: "attempt_marker_unavailable" };
    }
    if (!started) return { ok: false, notStarted: true, reason: "claim_lost" };
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<{ data: null; error: { name: string; statusCode: null } }>((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve({ data: null, error: { name: DISPATCHER_TIMEOUT_ERROR_NAME, statusCode: null } }),
        PROVIDER_CALL_TIMEOUT_MS,
      );
    });

    const response = await Promise.race([
      resend.emails.send(
        {
          from: sendFrom,
          to: [row.recipient_email],
          subject: sanitizeEmailSubject(rendered.subject),
          text: appendEmailLegalText(sendText),
          html: sendHtml,
          ...(replyTo ? { replyTo } : {}),
          ...(sendHeaders ? { headers: sendHeaders } : {}),
        },
        // PAY-WH-1: a resend after an uncertain acknowledgement (worker interrupted after the provider accepted the
        // message) is de-duplicated by the provider for this delivery row. T2: every retry of this row uses this same
        // key. Content is re-rendered per attempt; if it changed, the provider rejects the key (idempotency mismatch).
        { idempotencyKey: `outbound-delivery:${row.id}` },
      ),
      timeout,
    ]);

    if (response.error) {
      // T2 (S3/S4): never store provider text; classify into a fixed code and decide retry vs terminal.
      const outcome = classifyEmailProviderError(response.error);
      return outcome.kind === "retry"
        ? { ok: false, retry: true, code: outcome.code }
        : { ok: false, error: outcome.code };
    }

    return {
      ok: true,
      providerMessageId: response.data?.id ?? null,
    };
  } catch {
    // The SDK reports HTTP and network failures as `response.error`; a throw here is unexpected and its outcome
    // unknown, so it is retried with the same idempotency key rather than recorded as a definite failure.
    return { ok: false, retry: true, code: "provider_unreachable" };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function skipSms(reason: SmsSkipReason): SkippedDispatchResult {
  return { ok: false, skipped: true, reason };
}

function buildSmsStatusCallbackUrl(origin: string | null | undefined) {
  const callbackSecret = String(process.env.TWILIO_STATUS_CALLBACK_SECRET ?? "").trim();
  if (!origin || !callbackSecret) return null;

  return `${origin}/api/sms/twilio/status?secret=${encodeURIComponent(callbackSecret)}`;
}

/**
 * A2P-1A: automated SMS fails closed. The first failing condition marks the delivery
 * skipped with a non-PII reason code and Twilio is never called. Sends go only through
 * the approved Messaging Service abstraction (`sendTwilioSms`), with the studio STOP/HELP
 * footer and an `sms_message_logs` row, exactly like manual studio sends.
 */
async function sendSms(
  row: OutboundDeliveryRow,
  options: { origin?: string | null } = {},
): Promise<SmsDispatchResult> {
  if (!isAutomatedSmsTemplatePermitted(row.template_key)) {
    return skipSms("sms_template_not_permitted");
  }

  const supabase = createAdminClient();

  // SMS-A2P-2: the studio's own approved registration supplies the Messaging Service;
  // the global platform status is only the emergency master switch inside the resolver.
  const senderResult = await resolveStudioSmsSender(supabase, row.studio_id);
  // TW-4F: a studio of a verified legal business texts only through the billed path (below, after the consent checks)
  const billed = !senderResult.ok && senderResult.reason === "sms_billed_studio";
  if (!senderResult.ok && !billed) {
    if (
      senderResult.reason === "sms_registration_lookup_failed" ||
      senderResult.reason === "sms_service_check_failed" ||
      senderResult.reason === "sms_billing_check_failed"
    ) {
      return { ok: false, error: senderResult.reason };
    }
    return skipSms(senderResult.reason as SmsSkipReason);
  }

  const phoneE164 = normalizeSmsPhone(row.recipient_phone ?? "");
  if (!phoneE164) {
    return skipSms("sms_invalid_phone");
  }

  const recipientClientId = asString(row.payload?.recipientClientId);
  if (!UUID_PATTERN.test(recipientClientId)) {
    return skipSms("sms_no_consent");
  }

  const { data: permissions, error: permissionError } = await supabase
    .from("sms_contact_permissions")
    .select("client_id, consent_status, opted_out_at, opted_out_source, updated_at")
    .eq("studio_id", row.studio_id)
    .eq("phone_e164", phoneE164)
    .order("updated_at", { ascending: false });

  if (permissionError) {
    return { ok: false, error: "sms_consent_lookup_failed" };
  }

  const permissionRows = (permissions ?? []) as Array<{
    client_id: string | null;
    consent_status: string | null;
    opted_out_at: string | null;
    opted_out_source: string | null;
  }>;

  const clientPermission =
    permissionRows.find((permission) => permission.client_id === recipientClientId) ?? null;

  // TW-2: shared precedence -- any studio+phone opt-out (consumer STOP first) beats the
  // client's own opt-in.
  const consentState = resolveEffectiveSmsConsent(clientPermission, permissionRows);

  if (consentState === "blocked_by_text_stop" || consentState === "opted_out") {
    return skipSms("sms_opted_out");
  }

  if (consentState !== "allowed") {
    return skipSms("sms_no_consent");
  }

  const { data: studio } = await supabase
    .from("studios")
    .select("name")
    .eq("id", row.studio_id)
    .maybeSingle<{ name: string | null }>();

  const rendered = renderMessage(row);
  if (!rendered) {
    return { ok: false, skipped: true, reason: "outbound_template_unsupported" };
  }
  const finalBody = appendSmsOptOutFooter(rendered.bodyText, studio?.name ?? null);

  if (billed || !senderResult.ok) {
    return sendBilledDelivery(row, { phoneE164, recipientClientId, finalBody, origin: options.origin ?? null });
  }

  const { data: logRow, error: logError } = await supabase
    .from("sms_message_logs")
    .insert({
      studio_id: row.studio_id,
      client_id: recipientClientId,
      phone_e164: phoneE164,
      direction: "outbound",
      message_type: row.template_key,
      body: finalBody,
      segment_count: Math.max(1, estimateSmsSegments(finalBody)),
      status: "queued",
      provider: "twilio",
      related_table: row.related_table,
      related_id: row.related_id,
      sent_at: new Date().toISOString(),
    })
    .select("id")
    .single<{ id: string }>();

  if (logError || !logRow) {
    return { ok: false, error: "sms_log_insert_failed" };
  }

  const sendResult = await sendTwilioSms({
    to: phoneE164,
    body: finalBody,
    messagingServiceSid: senderResult.sender.messagingServiceSid,
    statusCallbackUrl: buildSmsStatusCallbackUrl(options.origin),
  });

  if (!sendResult.ok) {
    // Never persist Twilio's raw message text: it can echo request values (phone,
    // callback URL). This field is shown to studio staff and in platform digests.
    await supabase
      .from("sms_message_logs")
      .update({
        status: "failed",
        provider_error_code: sendResult.errorCode ?? null,
        provider_error_message: sanitizedSmsProviderError(sendResult.errorCode),
        failed_at: new Date().toISOString(),
      })
      .eq("id", logRow.id);

    return {
      ok: false,
      error: sendResult.errorCode ? `sms_send_failed:${sendResult.errorCode}` : "sms_send_failed",
    };
  }

  await supabase
    .from("sms_message_logs")
    .update({
      provider_message_id: sendResult.sid ?? null,
      status: sendResult.status === "sent" ? "sent" : "queued",
    })
    .eq("id", logRow.id);

  return {
    ok: true,
    providerMessageId: sendResult.sid ?? null,
  };
}

const BILLED_SKIP: Partial<Record<BilledSendRefusal, SmsSkipReason>> = {
  insufficient_credit: "sms_insufficient_credit",
  monthly_limit: "sms_monthly_limit",
  no_billed_sender: "sms_no_billed_sender",
  not_billed: "sms_no_billed_sender",
  suspended: "sms_service_suspended",
  switched_off: "sms_billing_unavailable",
  no_price: "sms_billing_unavailable",
};

/**
 * TW-4F: the billed send of an automated text. The delivery row is the source, so a reclaimed or retried delivery is a replay in the database and can never
 * text twice. A refusal before any provider call is a skip (nothing sent, nothing reserved); a database outage before the call is retried (still nothing
 * sent); an uncertain provider answer is a terminal failure that is never resent (the reconciler or an admin settles its money).
 */
async function sendBilledDelivery(
  row: OutboundDeliveryRow,
  input: { phoneE164: string; recipientClientId: string; finalBody: string; origin: string | null },
): Promise<SmsDispatchResult> {
  if (!smsUsageBillingEnabled()) return skipSms("sms_billing_unavailable");
  const provider = billedSmsProviderFromEnv();
  if (!provider) return skipSms("sms_billing_unavailable");

  const result = await sendBilledSms(createAdminClient(), provider, {
    source: { kind: "delivery", id: row.id },
    studioId: row.studio_id,
    clientId: input.recipientClientId,
    phoneE164: input.phoneE164,
    body: input.finalBody,
    messageType: row.template_key,
    relatedTable: row.related_table,
    relatedId: row.related_id,
    sentBy: null,
    statusCallbackBase: buildSmsStatusCallbackUrl(input.origin),
  });

  switch (result.outcome) {
    case "sent":
      return { ok: true, providerMessageId: result.providerSid };
    case "replay": {
      const meaning = replayMeaning(result.state);
      if (meaning === "accepted") return { ok: true, providerMessageId: result.providerSid };
      // not handed to the provider yet: keep the row queued; the next claim replays and sees how it ended (nothing can be sent twice)
      if (meaning === "not_yet") return { ok: false, retry: true, code: "sms_not_dispatched" };
      return { ok: false, error: meaning === "not_sent" ? "sms_not_sent" : "sms_outcome_unknown" };
    }
    case "uncertain":
      return { ok: false, error: "sms_outcome_unknown" };
    case "rejected":
      return { ok: false, error: `sms_send_failed:${result.code}` };
    case "refused": {
      if (result.reason === "unavailable") return { ok: false, retry: true, code: "sms_billing_unavailable" };
      const skip = BILLED_SKIP[result.reason];
      return skip ? skipSms(skip) : { ok: false, error: `sms_billed_${result.reason}` };
    }
  }
}

/**
 * T2 (S2): every state change made after a send attempt applies only while the row is still `queued` AND still leased
 * to this dispatcher run (`claim_owner`). A run whose lease expired and was reclaimed by another worker can therefore
 * never overwrite that worker's final state. `claimOwner` is null only on the legacy unleased path (claim function
 * missing), where the `queued` condition alone applies. Returns whether the row was updated. Throws only on a database
 * error, with a fixed message (no driver text).
 */
async function updateClaimedDelivery(
  id: string,
  claimOwner: string | null,
  values: Record<string, unknown>,
): Promise<boolean> {
  const supabase = createAdminClient();
  let query = supabase
    .from("outbound_deliveries")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "queued");
  if (claimOwner) query = query.eq("claim_owner", claimOwner);

  const { data, error } = await query.select("id");
  if (error) {
    throw new Error("outbound_delivery_state_update_failed");
  }
  return Array.isArray(data) && data.length > 0;
}

async function markSent(id: string, claimOwner: string | null, providerMessageId?: string | null) {
  return updateClaimedDelivery(id, claimOwner, {
    status: "sent",
    provider_message_id: providerMessageId ?? null,
    sent_at: new Date().toISOString(),
    error_message: null,
  });
}

/** Records an intentional non-send. `reason` is a fixed code: never a phone, body or consent detail. */
async function markSkipped(id: string, claimOwner: string | null, reason: DispatchSkipReason) {
  return updateClaimedDelivery(id, claimOwner, {
    status: "skipped",
    error_message: sanitizeDeliveryErrorCode(reason),
  });
}

/** Terminal failure. Only a sanitized reason code is stored (T2 S4). */
async function markFailed(id: string, claimOwner: string | null, errorCode: string) {
  return updateClaimedDelivery(id, claimOwner, {
    status: "failed",
    error_message: sanitizeDeliveryErrorCode(errorCode),
  });
}

/**
 * Keeps the row queued for an idempotent retry and records the reason and the first failed attempt. The lease is left
 * to expire, which spaces the retry by up to one lease period; the next claim re-sends with the same idempotency key.
 */
async function markRetry(row: OutboundDeliveryRow, claimOwner: string | null, code: string, nowMs: number) {
  return updateClaimedDelivery(row.id, claimOwner, {
    error_message: nextRetryMarker(row.error_message, code, nowMs),
  });
}

/** Rows claimed by this run but not attempted before the run budget ran out become claimable again immediately. */
async function releaseUnattemptedClaims(ids: string[], claimOwner: string | null) {
  if (!claimOwner || ids.length === 0) return;
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("outbound_deliveries")
    .update({ claim_expires_at: new Date().toISOString() })
    .in("id", ids)
    .eq("status", "queued")
    .eq("claim_owner", claimOwner);
  if (error) {
    // Harmless: the lease simply expires on its own.
    console.warn("[outbound] could not release unattempted claims", { count: ids.length });
  }
}

/** Post-completion bookkeeping (ARIA run/action state) must never change the delivery row's own outcome. */
async function runPostCompletion(label: string, deliveryId: string, task: () => Promise<void>) {
  try {
    await task();
  } catch {
    console.warn("[outbound] post-completion bookkeeping failed", { deliveryId, step: label });
  }
}

async function syncAriaDigestRunStatus(params: {
  deliveryId: string;
  status: "sent" | "failed" | "queued";
  errorMessage?: string | null;
  /** T2: false when the failure does not prove non-delivery; the run is then terminal and never retried. */
  requeueSafe?: boolean;
}) {
  const supabase = createAdminClient();
  const now = new Date();
  const sanitizedErrorMessage = params.errorMessage
    ? sanitizeAriaDigestError(new Error(params.errorMessage)).message
    : null;
  const payload: Record<string, unknown> = {
    status: params.status,
    error_message: sanitizedErrorMessage,
    last_attempt_at: now.toISOString(),
  };

  if (params.status === "sent") {
    payload.sent_at = now.toISOString();
    payload.processed_at = now.toISOString();
    payload.next_attempt_at = null;
  } else if (params.status === "failed") {
    payload.processed_at = now.toISOString();
    payload.next_attempt_at =
      params.requeueSafe === false ? null : new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  } else {
    payload.next_attempt_at = now.toISOString();
  }

  const { data: updatedRun, error } = await supabase
    .from("aria_digest_runs")
    .update(payload)
    .eq("delivery_id", params.deliveryId)
    .select("id, studio_id, digest_type, digest_date, retry_count, delivery_id")
    .maybeSingle<{
      id: string;
      studio_id: string;
      digest_type: "morning" | "end_of_day";
      digest_date: string;
      retry_count: number;
      delivery_id: string | null;
    }>();

  if (error) {
    console.warn("[aria_digest] Failed to synchronize ARIA digest run status", {
      deliveryId: params.deliveryId,
      status: params.status,
      error: error.message,
    });
    return;
  }

  if (!updatedRun) return;

  if (params.status === "sent") {
    logAriaDigestLifecycleEvent({
      stage: "run_sent",
      studioId: updatedRun.studio_id,
      digestType: updatedRun.digest_type,
      digestDate: updatedRun.digest_date,
      runId: updatedRun.id,
      retryCount: updatedRun.retry_count,
    });
    return;
  }

  if (params.status !== "failed") return;

  const failureError = new Error(params.errorMessage ?? "ARIA digest delivery failed");
  const classification =
    params.requeueSafe === false
      ? "terminal"
      : classifyAriaDigestFailure({
          retryCount: updatedRun.retry_count,
          hasDeliveryId: updatedRun.delivery_id !== null,
        });

  logAriaDigestError(
    {
      studioId: updatedRun.studio_id,
      digestType: updatedRun.digest_type,
      digestDate: updatedRun.digest_date,
      runId: updatedRun.id,
      retryCount: updatedRun.retry_count,
    },
    failureError,
  );

  logAriaDigestLifecycleEvent({
    stage: classification === "terminal" ? "run_terminal" : "run_retry_scheduled",
    studioId: updatedRun.studio_id,
    digestType: updatedRun.digest_type,
    digestDate: updatedRun.digest_date,
    runId: updatedRun.id,
    retryCount: updatedRun.retry_count,
  });

  if (classification === "terminal") {
    await recordTerminalAriaDigestFailure(supabase, {
      runId: updatedRun.id,
      studioId: updatedRun.studio_id,
      digestType: updatedRun.digest_type,
      digestDate: updatedRun.digest_date,
      deliveryId: updatedRun.delivery_id,
      retryCount: updatedRun.retry_count,
      error: failureError,
    });
  }
}

/**
 * Review note for a skipped ARIA follow-up. A marketing skip keeps its existing wording; another skip reason (for example
 * an unsupported template) is not described as a marketing-eligibility decision. When an earlier attempt of the same
 * delivery may already have been accepted by the provider, the note says so instead of claiming nothing was sent.
 */
function ariaSkipReviewNote(reason: string | null | undefined, earlierAttemptUncertain: boolean) {
  if (earlierAttemptUncertain) {
    return "ARIA stopped this follow-up, but an earlier delivery attempt may already have reached the client. Check before contacting them again.";
  }
  if (reason?.startsWith("marketing_")) {
    return "ARIA did not send this follow-up: the client is not eligible for marketing email from this studio.";
  }
  return "ARIA did not send this follow-up.";
}

async function recordAriaActionDeliveryEvent(params: {
  studioId: string;
  actionId: string;
  eventType: "delivery_sent" | "delivery_failed" | "delivery_requeued" | "delivery_exhausted" | "execution_skipped";
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
  status: "sent" | "failed" | "skipped";
  errorMessage?: string | null;
  providerMessageId?: string | null;
  /** T2: on a skip, an earlier attempt of this delivery may already have been delivered. */
  earlierAttemptUncertain?: boolean;
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

  if (params.status === "skipped") {
    // Marketing M-0: an intentional non-send (for example the client unsubscribed from the studio's marketing email).
    // Terminal, never retried.
    const { error } = await supabase
      .from("automation_actions")
      .update({
        status: "skipped",
        execution_delivery_id: params.row.id,
        execution_status: "skipped",
        execution_last_attempt_at: nowIso,
        execution_next_attempt_at: null,
        execution_error_message: params.errorMessage?.slice(0, 1000) ?? null,
        outcome_status: "not_applicable",
        updated_at: nowIso,
        review_note: ariaSkipReviewNote(params.errorMessage, params.earlierAttemptUncertain === true),
      })
      .eq("id", action.id)
      .eq("studio_id", action.studio_id);
    if (error) throw new Error(`Failed to synchronize ARIA action skipped state: ${error.message}`);
    await recordAriaActionDeliveryEvent({
      studioId: action.studio_id,
      actionId: action.id,
      eventType: "execution_skipped",
      previousStatus: action.status,
      newStatus: "skipped",
      note: params.errorMessage ?? "Not sent.",
      metadata: {
        delivery_id: params.row.id,
        ...(params.earlierAttemptUncertain ? { earlier_attempt_uncertain: true } : {}),
      },
    });
    return;
  }

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

  // T2: a failure that does not prove non-delivery is never retried automatically, whatever the attempt count.
  const requeueSafe = isRequeueSafeFailure(params.errorMessage, params.row.channel);
  const exhausted = attemptCount >= 3 || !requeueSafe;
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
      review_note: !requeueSafe
        ? UNCERTAIN_ARIA_DELIVERY_NOTE
        : exhausted
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

const UNCERTAIN_ARIA_DELIVERY_NOTE =
  "ARIA could not confirm whether this follow-up was delivered, so it will not retry it automatically. Check with the client before resending.";

type FailedAriaDelivery = { id: string; channel: string | null; error_message: string | null };

/**
 * T2: a failed ARIA action whose delivery failure does not prove non-delivery (see isRequeueSafeFailure) is closed
 * for staff attention instead of being requeued. Guarded on the action still being `failed`, so a concurrent change wins.
 */
async function closeUncertainAriaActionDelivery(
  action: { id: string; studio_id: string; status: string | null; execution_attempt_count: number | null },
  delivery: FailedAriaDelivery,
) {
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const code = sanitizeDeliveryErrorCode(delivery.error_message);
  const { data: closed, error } = await supabase
    .from("automation_actions")
    .update({
      status: "failed",
      execution_status: "exhausted",
      execution_next_attempt_at: null,
      execution_error_message: code,
      review_note: UNCERTAIN_ARIA_DELIVERY_NOTE,
      updated_at: now,
    })
    .eq("id", action.id)
    .eq("studio_id", action.studio_id)
    .eq("execution_status", "failed")
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error || !closed) {
    if (error) console.warn("Failed to close uncertain ARIA action delivery", { actionId: action.id });
    return;
  }

  await recordAriaActionDeliveryEvent({
    studioId: action.studio_id,
    actionId: action.id,
    eventType: "delivery_exhausted",
    previousStatus: action.status,
    newStatus: "failed",
    note: UNCERTAIN_ARIA_DELIVERY_NOTE,
    metadata: {
      delivery_id: delivery.id,
      attempt_count: Number(action.execution_attempt_count ?? 0),
      reason: code,
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

    // T2: read the failure first; only a failure that proves non-delivery is requeued.
    const { data: failedDelivery, error: lookupError } = await supabase
      .from("outbound_deliveries")
      .select("id, channel, error_message")
      .eq("id", action.execution_delivery_id)
      .eq("studio_id", action.studio_id)
      .eq("related_table", "automation_actions")
      .eq("related_id", action.id)
      .eq("status", "failed")
      .maybeSingle<FailedAriaDelivery>();

    if (lookupError) {
      console.warn("Failed to load ARIA action delivery for requeue", { actionId: action.id });
      continue;
    }
    if (!failedDelivery) continue;

    if (!isRequeueSafeFailure(failedDelivery.error_message, failedDelivery.channel)) {
      await closeUncertainAriaActionDelivery(action, failedDelivery);
      continue;
    }

    const { data: delivery, error: deliveryError } = await supabase
      .from("outbound_deliveries")
      .update({ status: "queued", error_message: null, updated_at: now })
      .eq("id", action.execution_delivery_id)
      .eq("studio_id", action.studio_id)
      .eq("related_table", "automation_actions")
      .eq("related_id", action.id)
      .eq("status", "failed")
      // Compare-and-set: the failure that was judged safe is the one being requeued.
      .eq("error_message", failedDelivery.error_message as string)
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
    .select("id, studio_id, digest_type, digest_date, delivery_id, retry_count")
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

    // T2: read the failure first; only a failure that proves non-delivery is requeued.
    const { data: failedDelivery, error: lookupError } = await supabase
      .from("outbound_deliveries")
      .select("id, channel, error_message")
      .eq("id", run.delivery_id)
      .eq("status", "failed")
      .maybeSingle<FailedAriaDelivery>();

    if (lookupError) {
      console.warn("[aria_digest] Failed to load digest delivery for requeue", { run_id: run.id });
      continue;
    }
    if (!failedDelivery) continue;

    if (!isRequeueSafeFailure(failedDelivery.error_message, failedDelivery.channel)) {
      // Terminal: stop retrying (no next attempt) and raise the usual terminal digest alert.
      const code = sanitizeDeliveryErrorCode(failedDelivery.error_message);
      const { data: closed, error: closeError } = await supabase
        .from("aria_digest_runs")
        .update({ next_attempt_at: null, error_message: code })
        .eq("id", run.id)
        .eq("status", "failed")
        .select("id")
        .maybeSingle<{ id: string }>();
      if (closeError) {
        console.warn("[aria_digest] Failed to close uncertain digest delivery", { run_id: run.id });
      } else if (closed) {
        await recordTerminalAriaDigestFailure(supabase, {
          runId: run.id,
          studioId: run.studio_id,
          digestType: run.digest_type,
          digestDate: run.digest_date,
          deliveryId: run.delivery_id,
          retryCount: Number(run.retry_count ?? 0),
          error: new Error(code),
        });
      }
      continue;
    }

    const { data: delivery, error: deliveryError } = await supabase
      .from("outbound_deliveries")
      .update({
        status: "queued",
        error_message: null,
        updated_at: now,
      })
      .eq("id", run.delivery_id)
      .eq("status", "failed")
      // Compare-and-set: the failure that was judged safe is the one being requeued.
      .eq("error_message", failedDelivery.error_message as string)
      .select("id")
      .maybeSingle<{ id: string }>();

    if (deliveryError) {
      console.warn("Failed to requeue ARIA digest delivery", deliveryError);
      continue;
    }

    if (!delivery) continue;

    const { error: runUpdateError } = await supabase
      .from("aria_digest_runs")
      .update({
        status: "queued",
        retry_count: Number(run.retry_count ?? 0) + 1,
        last_attempt_at: now,
        next_attempt_at: now,
        error_message: null,
      })
      .eq("id", run.id);

    if (runUpdateError) {
      console.warn("[aria_digest] Failed to persist digest retry state", {
        run_id: run.id,
        error: runUpdateError.message,
      });
    }

    requeued += 1;
  }

  return requeued;
}

export async function dispatchQueuedOutboundDeliveries(
  limit = 25,
  options: { origin?: string | null } = {},
) {
  const supabase = createAdminClient();
  const digestRequeued = await requeueFailedAriaDigestDeliveries(limit);
  const actionRequeued = await requeueFailedAriaActionDeliveries(limit);
  const requeued = digestRequeued + actionRequeued;

  // PAY-WH-1: lease the queued rows to this dispatcher so overlapping runs cannot send the same message twice.
  // Status values are unchanged for every other producer/reader. Before the claim function exists (database not yet
  // migrated) the previous unleased selection is used.
  let claimOwner: string | null = randomUUID();
  let { data, error } = await supabase.rpc("claim_outbound_deliveries", {
    p_owner: claimOwner,
    p_limit: limit,
    p_lease_seconds: DISPATCH_LEASE_SECONDS,
  });
  if (error && (error.code === "PGRST202" || error.code === "42883")) {
    claimOwner = null;
    ({ data, error } = await supabase
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
        reply_to_email,
        payload,
        status,
        related_table,
        related_id,
        error_message
      `)
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(limit));
  }

  if (error) {
    throw new Error(`Failed to load queued outbound deliveries: ${error.message}`);
  }

  const rows = (data ?? []) as OutboundDeliveryRow[];

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let retrying = 0;
  let unconfirmed = 0;
  let lostClaims = 0;
  let deferred = 0;

  const runStartedMs = Date.now();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];

    // T2 (S5): never start a send late in the run, so no claimed row can outlive this run's lease.
    if (Date.now() - runStartedMs > DISPATCH_RUN_BUDGET_MS) {
      const remaining = rows.slice(index).map((pending) => pending.id);
      deferred = remaining.length;
      await releaseUnattemptedClaims(remaining, claimOwner);
      break;
    }

    try {
      // T2: a row that has been retrying for longer than the window ends without another provider call. If any
      // attempt may have been accepted the outcome is unknown and it is never re-sent automatically (staff can resend as
      // a new delivery); if every attempt was definitely refused, it ends as definitely not sent (retryable).
      const retryMarker = parseRetryMarker(row.error_message);
      if (retryMarker && isRetryWindowExhausted(retryMarker, Date.now())) {
        const exhaustedCode = retryWindowExhaustedCode(retryMarker);
        const applied = await markFailed(row.id, claimOwner, exhaustedCode);
        if (!applied) {
          lostClaims += 1;
          continue;
        }
        failed += 1;
        await syncFailedDelivery(row, exhaustedCode);
        continue;
      }

      // T2 (re-review MAJOR 1): immediately before an email is handed to the provider (after every check that can stop
      // it), record that an attempt is starting. The marker has no "definitely unsent" flag, so if this run dies or its
      // outcome write is lost, the row is treated as possibly accepted (fail closed). The outcome write below replaces it
      // with the accurate history, computed from the state loaded at claim time (`row.error_message`), so a
      // definitely-refused attempt keeps its flag. If this write fails or the claim was lost, the provider is not called.
      const recordAttemptStarted = () =>
        updateClaimedDelivery(row.id, claimOwner, {
          error_message: nextRetryMarker(row.error_message, PROVIDER_ATTEMPT_STARTED, Date.now()),
        });

      let result: SmsDispatchResult;
      try {
        result =
          row.channel === "email"
            ? await sendEmail(row, { beforeProviderCall: recordAttemptStarted })
            : await sendSms(row, { origin: options.origin });
      } catch {
        // Unexpected exception. For email the provider call cannot throw (its outcome is classified above), so this is a
        // lookup or rendering failure. For SMS the Twilio request itself can throw after Twilio received it, so the
        // outcome may be unknown; either way the row ends as a terminal failure and is never re-sent automatically.
        result = { ok: false, error: "dispatch_exception" };
      }

      if (isNotStartedDispatchResult(result)) {
        if (result.reason === "claim_lost") lostClaims += 1;
        else console.warn("[outbound] attempt could not be recorded; not sent", { deliveryId: row.id });
        continue;
      }

      if (isSkippedDispatchResult(result)) {
        const applied = await markSkipped(row.id, claimOwner, result.reason);
        if (!applied) {
          lostClaims += 1;
          continue;
        }
        skipped += 1;
        const skipReason = result.reason;
        // An earlier attempt of this row may already have been delivered: the skip must not claim nothing was sent.
        const earlierAttemptUncertain = Boolean(retryMarker && !retryMarker.unsentOnly);
        await runPostCompletion("aria_action_skipped", row.id, () =>
          syncAriaActionDeliveryStatus({ row, status: "skipped", errorMessage: skipReason, earlierAttemptUncertain }),
        );
        continue;
      }

      if (isRetryDispatchResult(result)) {
        // Unknown or transient outcome: keep queued; the next claim retries with the same idempotency key.
        const applied = await markRetry(row, claimOwner, result.code, Date.now());
        if (!applied) lostClaims += 1;
        else retrying += 1;
        continue;
      }

      if (!result.ok) {
        // M1: after an attempt that may have been accepted, even a rejection does not prove non-delivery.
        const code = terminalCodeAfterRetries(row.error_message, sanitizeDeliveryErrorCode(result.error), row.channel);
        const applied = await markFailed(row.id, claimOwner, code);
        if (!applied) {
          lostClaims += 1;
          continue;
        }
        failed += 1;
        await syncFailedDelivery(row, code);
        continue;
      }

      // T2 (S3): the provider accepted the message. A failure to record that is NOT a delivery failure.
      let applied: boolean;
      try {
        applied = await markSent(row.id, claimOwner, result.providerMessageId ?? null);
      } catch {
        unconfirmed += 1;
        if (row.channel === "sms") {
          // SMS has no provider idempotency key: a retry would send a second text. Close the row instead.
          try {
            await markFailed(row.id, claimOwner, "sms_sent_outcome_unrecorded");
          } catch {
            console.warn("[outbound] sms sent but its outcome could not be recorded", { deliveryId: row.id });
          }
        } else {
          // Email: leave the row queued. After the lease expires it is re-claimed and re-sent with the same idempotency
          // key; the provider returns the original message id without sending again, and the row is then marked sent.
          // Best effort: record that an attempt was accepted, so a later failure of this row is treated as uncertain.
          try {
            await markRetry(row, claimOwner, "provider_accepted_unrecorded", Date.now());
          } catch {
            // The database is still unavailable; the row stays queued as it is.
          }
          console.warn("[outbound] email accepted but not yet recorded; will reconcile on retry", { deliveryId: row.id });
        }
        continue;
      }

      if (!applied) {
        // Another worker owns or has finished this row; its record stands.
        lostClaims += 1;
        continue;
      }

      sent += 1;
      const providerMessageId = result.providerMessageId ?? null;
      if (row.template_key.startsWith("aria_digest_")) {
        await runPostCompletion("aria_digest_sent", row.id, () =>
          syncAriaDigestRunStatus({ deliveryId: row.id, status: "sent" }),
        );
      }
      await runPostCompletion("aria_action_sent", row.id, () =>
        syncAriaActionDeliveryStatus({ row, status: "sent", providerMessageId }),
      );
    } catch {
      // A state update itself failed (database unavailable). The row keeps its current state; nothing is guessed.
      console.warn("[outbound] delivery state could not be updated", { deliveryId: row.id });
    }
  }

  const outcomes = await verifyPendingAriaOutcomes(Math.max(limit * 2, 50));

  return {
    processed: rows.length,
    requeued,
    sent,
    failed,
    skipped,
    retrying,
    unconfirmed,
    lostClaims,
    deferred,
    outcomes,
  };
}

async function syncFailedDelivery(row: OutboundDeliveryRow, code: string) {
  if (row.template_key.startsWith("aria_digest_")) {
    await runPostCompletion("aria_digest_failed", row.id, () =>
      syncAriaDigestRunStatus({
        deliveryId: row.id,
        status: "failed",
        errorMessage: code,
        requeueSafe: isRequeueSafeFailure(code, row.channel),
      }),
    );
  }
  await runPostCompletion("aria_action_failed", row.id, () =>
    syncAriaActionDeliveryStatus({ row, status: "failed", errorMessage: code }),
  );
}



