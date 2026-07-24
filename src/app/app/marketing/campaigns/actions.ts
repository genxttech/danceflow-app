"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { Resend } from "resend";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { requireStudioFeature } from "@/lib/billing/access";
import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";

const AUDIENCE_TYPES = new Set([
  "manual",
  "all_active_clients",
  "new_leads",
  "inactive_clients",
  "event_attendees",
  "specific_event_registrants",
  "specific_event_checked_in",
  "clients_no_upcoming_lesson",
  "low_package_credits",
]);

const MAX_CAMPAIGN_SENDS_PER_ACTION = 500;

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

type RecipientPreview = {
  clientId: string | null;
  email: string;
  name: string;
  source: string;
  unsubscribed: boolean;
};

type CampaignEmailParams = {
  studioName: string;
  studioLogoUrl?: string | null;
  subject: string;
  previewText: string | null;
  bodyText: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
  footerNote: string;
  unsubscribeUrl?: string | null;
};

type StudioMarketingFooterSettings = {
  name?: string | null;
  public_name?: string | null;
  public_logo_url?: string | null;
  email?: string | null;
  address_line_1?: string | null;
  address_line_2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

function normalizeUrl(url: string) {
  const value = url.trim();
  if (!value) return "";

  try {
    const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : "";
  } catch {
    return "";
  }
}

function normalizeEmail(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function buildName(firstName: unknown, lastName: unknown) {
  return `${String(firstName ?? "").trim()} ${String(lastName ?? "").trim()}`.trim();
}

function isSpecificEventAudience(audienceType: string) {
  return (
    audienceType === "specific_event_registrants" ||
    audienceType === "specific_event_checked_in"
  );
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function plainTextToHtml(value: string) {
  return escapeHtml(value)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;line-height:1.6;">${paragraph.replaceAll("\n", "<br />")}</p>`,
    )
    .join("\n");
}

function getSiteUrl() {
  return (process.env.NEXT_PUBLIC_SITE_URL || "https://idanceflow.com").replace(
    /\/$/,
    "",
  );
}

function cleanFooterPart(value: unknown) {
  return String(value ?? "").trim();
}

function hasMarketingFooterAddress(
  studio: StudioMarketingFooterSettings | null | undefined,
) {
  return Boolean(
    cleanFooterPart(studio?.name) &&
    cleanFooterPart(studio?.address_line_1) &&
    cleanFooterPart(studio?.city) &&
    cleanFooterPart(studio?.state) &&
    cleanFooterPart(studio?.postal_code) &&
    cleanFooterPart(studio?.country),
  );
}

function buildStudioMarketingFooterNote(
  studio: StudioMarketingFooterSettings | null | undefined,
) {
  const studioName = cleanFooterPart(studio?.name) || "DanceFlow Studio";
  const addressParts = [
    cleanFooterPart(studio?.address_line_1),
    cleanFooterPart(studio?.address_line_2),
    [
      cleanFooterPart(studio?.city),
      cleanFooterPart(studio?.state),
      cleanFooterPart(studio?.postal_code),
    ]
      .filter(Boolean)
      .join(", "),
    cleanFooterPart(studio?.country),
  ].filter(Boolean);

  if (addressParts.length === 0) {
    return `${studioName} · Sent with DanceFlow.`;
  }

  return `${studioName} · ${addressParts.join(" · ")} · Sent with DanceFlow.`;
}

function getStudioReplyToEmail(
  studio: StudioMarketingFooterSettings | null | undefined,
  fallbackEmail: string,
) {
  return (
    cleanFooterPart(studio?.email) ||
    process.env.MARKETING_REPLY_TO_EMAIL ||
    fallbackEmail
  );
}

function buildCampaignEmailHtml(params: CampaignEmailParams) {
  const unsubscribeHtml = params.unsubscribeUrl
    ? `<div style="margin-top:18px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.6;color:#64748b;">You are receiving this because you shared your email with ${escapeHtml(
        params.studioName,
      )}. <a href="${escapeHtml(
        params.unsubscribeUrl,
      )}" style="color:#6d28d9;text-decoration:underline;">Unsubscribe</a>.</div>`
    : "";

  return renderStudioBrandedEmail(
    {
      name: params.studioName,
      logoUrl: params.studioLogoUrl ?? null,
    },
    {
      previewText: params.previewText || params.subject,
      eyebrow: "Studio Update",
      heading: params.subject,
      bodyText: params.bodyText,
      contentHtml: unsubscribeHtml || undefined,
      actionLabel:
        params.ctaLabel && params.ctaUrl ? params.ctaLabel : null,
      actionUrl:
        params.ctaLabel && params.ctaUrl ? params.ctaUrl : null,
      footerText: params.footerNote,
    },
  );
}

function buildCampaignEmailText(params: CampaignEmailParams) {
  const cta =
    params.ctaLabel && params.ctaUrl
      ? `\n\n${params.ctaLabel}: ${params.ctaUrl}`
      : "";
  const unsubscribe = params.unsubscribeUrl
    ? `\n\nUnsubscribe: ${params.unsubscribeUrl}`
    : "";

  return `${params.studioName}\n\n${params.bodyText}${cta}\n\n${params.footerNote}${unsubscribe}`;
}

async function getUnsubscribedEmails(params: {
  supabase: SupabaseClient;
  studioId: string;
}) {
  const { supabase, studioId } = params;

  const { data, error } = await supabase
    .from("marketing_unsubscribes")
    .select("email")
    .eq("studio_id", studioId);

  if (error) {
    console.error("Failed to load marketing unsubscribes", error);
    return new Set<string>();
  }

  return new Set(
    (data ?? []).map((row) => normalizeEmail(row.email)).filter(Boolean),
  );
}

async function getClientRecipients(params: {
  supabase: SupabaseClient;
  studioId: string;
  audienceType: string;
  unsubscribedEmails: Set<string>;
}) {
  const { supabase, studioId, audienceType, unsubscribedEmails } = params;

  const baseClientSelect = "id, first_name, last_name, email, status";

  if (audienceType === "clients_no_upcoming_lesson") {
    const [
      { data: clients, error: clientsError },
      { data: appointments, error: appointmentsError },
    ] = await Promise.all([
      supabase
        .from("clients")
        .select(baseClientSelect)
        .eq("studio_id", studioId)
        .eq("status", "active")
        .not("email", "is", null)
        .limit(5000),
      supabase
        .from("appointments")
        .select("client_id")
        .eq("studio_id", studioId)
        .eq("status", "scheduled")
        .gte("starts_at", new Date().toISOString())
        .not("client_id", "is", null)
        .limit(10000),
    ]);

    if (clientsError || appointmentsError) {
      console.error("Failed to load no-upcoming-lesson campaign audience", {
        clientsError,
        appointmentsError,
      });
      return [];
    }

    const clientsWithUpcomingLessons = new Set(
      (appointments ?? [])
        .map((appointment) => String(appointment.client_id ?? ""))
        .filter(Boolean),
    );

    return buildUniqueClientRecipients({
      clients: (clients ?? []).filter(
        (client) => !clientsWithUpcomingLessons.has(String(client.id)),
      ),
      source: "No upcoming lesson",
      unsubscribedEmails,
    });
  }

  if (audienceType === "low_package_credits") {
    const { data: packages, error: packagesError } = await supabase
      .from("client_packages")
      .select("client_id, lessons_remaining, active")
      .eq("studio_id", studioId)
      .eq("active", true)
      .lte("lessons_remaining", 2)
      .not("client_id", "is", null)
      .limit(10000);

    if (packagesError) {
      console.error(
        "Failed to load low-credit package audience",
        packagesError,
      );
      return [];
    }

    const lowCreditClientIds = Array.from(
      new Set(
        (packages ?? [])
          .map((pkg) => String(pkg.client_id ?? ""))
          .filter(Boolean),
      ),
    );

    if (lowCreditClientIds.length === 0) {
      return [];
    }

    const { data: clients, error: clientsError } = await supabase
      .from("clients")
      .select(baseClientSelect)
      .eq("studio_id", studioId)
      .in("id", lowCreditClientIds)
      .not("email", "is", null)
      .limit(5000);

    if (clientsError) {
      console.error("Failed to load low-credit clients audience", clientsError);
      return [];
    }

    return buildUniqueClientRecipients({
      clients: clients ?? [],
      source: "Low package credits",
      unsubscribedEmails,
    });
  }

  let query = supabase
    .from("clients")
    .select(baseClientSelect)
    .eq("studio_id", studioId)
    .not("email", "is", null)
    .limit(5000);

  if (audienceType === "all_active_clients") {
    query = query.eq("status", "active");
  }

  if (audienceType === "new_leads") {
    query = query.eq("status", "lead");
  }

  if (audienceType === "inactive_clients") {
    query = query.eq("status", "inactive");
  }

  const { data, error } = await query;

  if (error) {
    console.error(`Failed to load campaign audience ${audienceType}`, error);
    return [];
  }

  return buildUniqueClientRecipients({
    clients: data ?? [],
    source: "CRM",
    unsubscribedEmails,
  });
}

function buildUniqueClientRecipients(params: {
  clients: Array<{
    id: string;
    first_name: unknown;
    last_name: unknown;
    email: unknown;
  }>;
  source: string;
  unsubscribedEmails: Set<string>;
}) {
  const { clients, source, unsubscribedEmails } = params;
  const seen = new Set<string>();
  const recipients: RecipientPreview[] = [];

  for (const row of clients) {
    const email = normalizeEmail(row.email);

    if (!email || seen.has(email)) {
      continue;
    }

    seen.add(email);
    recipients.push({
      clientId: row.id,
      email,
      name: buildName(row.first_name, row.last_name),
      source,
      unsubscribed: unsubscribedEmails.has(email),
    });
  }

  return recipients;
}

async function getEventRecipients(params: {
  supabase: SupabaseClient;
  studioId: string;
  unsubscribedEmails: Set<string>;
  audienceType?: string;
  audienceEventId?: string | null;
}) {
  const {
    supabase,
    studioId,
    unsubscribedEmails,
    audienceType = "event_attendees",
    audienceEventId,
  } = params;

  const seen = new Set<string>();
  const recipients: RecipientPreview[] = [];

  function addRecipient(row: {
    client_id?: unknown;
    first_name?: unknown;
    last_name?: unknown;
    email?: unknown;
    source: string;
  }) {
    const email = normalizeEmail(row.email);

    if (!email || seen.has(email)) {
      return;
    }

    seen.add(email);
    recipients.push({
      clientId: typeof row.client_id === "string" ? row.client_id : null,
      email,
      name: buildName(row.first_name, row.last_name),
      source: row.source,
      unsubscribed: unsubscribedEmails.has(email),
    });
  }

  if (isSpecificEventAudience(audienceType)) {
    if (!audienceEventId) {
      return [];
    }

    const { data: registrations, error: registrationsError } = await supabase
      .from("event_registrations")
      .select(
        "id, client_id, attendee_first_name, attendee_last_name, attendee_email, status, event_id",
      )
      .eq("studio_id", studioId)
      .eq("event_id", audienceEventId)
      .not("attendee_email", "is", null)
      .limit(5000);

    if (registrationsError) {
      console.error(
        "Failed to load specific event campaign registrations",
        registrationsError,
      );
      return [];
    }

    const activeRegistrations = (registrations ?? []).filter(
      (registration) =>
        String(registration.status ?? "").toLowerCase() !== "cancelled",
    );

    const activeRegistrationIds = activeRegistrations
      .map((registration) => String(registration.id ?? ""))
      .filter(Boolean);

    let attendees: Array<{
      first_name: unknown;
      last_name: unknown;
      email: unknown;
      checked_in_at: string | null;
      registration_id: string;
    }> = [];

    if (activeRegistrationIds.length > 0) {
      const { data: attendeeRows, error: attendeesError } = await supabase
        .from("event_registration_attendees")
        .select("registration_id, first_name, last_name, email, checked_in_at")
        .in("registration_id", activeRegistrationIds)
        .not("email", "is", null)
        .limit(5000);

      if (attendeesError) {
        console.error(
          "Failed to load specific event campaign attendees",
          attendeesError,
        );
        return [];
      }

      attendees = attendeeRows ?? [];
    }

    for (const row of attendees) {
      if (audienceType === "specific_event_checked_in" && !row.checked_in_at) {
        continue;
      }

      addRecipient({
        first_name: row.first_name,
        last_name: row.last_name,
        email: row.email,
        source:
          audienceType === "specific_event_checked_in"
            ? "Checked-in event attendee"
            : "Event attendee",
      });
    }

    if (audienceType === "specific_event_registrants") {
      for (const row of activeRegistrations) {
        addRecipient({
          client_id: row.client_id,
          first_name: row.attendee_first_name,
          last_name: row.attendee_last_name,
          email: row.attendee_email,
          source: "Event registration",
        });
      }
    }

    return recipients;
  }

  const { data, error } = await supabase
    .from("event_registrations")
    .select(
      "client_id, attendee_first_name, attendee_last_name, attendee_email, status",
    )
    .eq("studio_id", studioId)
    .not("attendee_email", "is", null)
    .limit(5000);

  if (error) {
    console.error("Failed to load event campaign audience", error);
    return [];
  }

  for (const row of data ?? []) {
    if (String(row.status ?? "").toLowerCase() === "cancelled") {
      continue;
    }

    addRecipient({
      client_id: row.client_id,
      first_name: row.attendee_first_name,
      last_name: row.attendee_last_name,
      email: row.attendee_email,
      source: "Event registration",
    });
  }

  return recipients;
}

async function getRecipientPreview(params: {
  supabase: SupabaseClient;
  studioId: string;
  audienceType: string;
  audienceEventId?: string | null;
}) {
  const { supabase, studioId, audienceType, audienceEventId } = params;
  const unsubscribedEmails = await getUnsubscribedEmails({
    supabase,
    studioId,
  });

  if (
    audienceType === "event_attendees" ||
    isSpecificEventAudience(audienceType)
  ) {
    return getEventRecipients({
      supabase,
      studioId,
      unsubscribedEmails,
      audienceType,
      audienceEventId,
    });
  }

  if (audienceType === "manual") {
    return [];
  }

  return getClientRecipients({
    supabase,
    studioId,
    audienceType,
    unsubscribedEmails,
  });
}

export async function createMarketingCampaignDraftAction(formData: FormData) {
  const fallback = "/app/marketing/campaigns";
  const requestedAudienceType =
    getString(formData, "audienceType") || "all_active_clients";

  await requireStudioFeature("marketing_campaigns");

  if (
    requestedAudienceType === "event_attendees" ||
    isSpecificEventAudience(requestedAudienceType)
  ) {
    await requireStudioFeature("marketing_event_audiences");
  }

  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;

    if (!studioId) {
      redirect("/login");
    }

    const { data: userResult, error: userError } =
      await supabase.auth.getUser();

    if (userError || !userResult.user) {
      redirect("/login");
    }

    const name = getString(formData, "name");
    const audienceType =
      getString(formData, "audienceType") || "all_active_clients";
    const audienceEventId = getString(formData, "audienceEventId");
    const subject = getString(formData, "subject");
    const previewText = getString(formData, "previewText");
    const bodyText = getString(formData, "bodyText");
    const ctaLabel = getString(formData, "ctaLabel");
    const rawCtaUrl = getString(formData, "ctaUrl");
    const ctaUrl = normalizeUrl(rawCtaUrl);

    if (!name) {
      redirect(appendQueryParam(fallback, "campaign_error", "missing_name"));
    }

    if (!AUDIENCE_TYPES.has(audienceType)) {
      redirect(
        appendQueryParam(fallback, "campaign_error", "invalid_audience"),
      );
    }

    if (isSpecificEventAudience(audienceType) && !audienceEventId) {
      redirect(appendQueryParam(fallback, "campaign_error", "missing_event"));
    }

    if (isSpecificEventAudience(audienceType) && audienceEventId) {
      const { data: event, error: eventError } = await supabase
        .from("events")
        .select("id")
        .eq("id", audienceEventId)
        .eq("studio_id", studioId)
        .maybeSingle();

      if (eventError || !event) {
        redirect(appendQueryParam(fallback, "campaign_error", "invalid_event"));
      }
    }

    if (!subject) {
      redirect(appendQueryParam(fallback, "campaign_error", "missing_subject"));
    }

    if (!bodyText) {
      redirect(appendQueryParam(fallback, "campaign_error", "missing_body"));
    }

    if (rawCtaUrl && !ctaUrl) {
      redirect(appendQueryParam(fallback, "campaign_error", "invalid_cta_url"));
    }

    const { error } = await supabase.from("marketing_campaigns").insert({
      studio_id: studioId,
      name,
      audience_type: audienceType,
      audience_event_id: isSpecificEventAudience(audienceType)
        ? audienceEventId
        : null,
      subject,
      preview_text: previewText || null,
      body_text: bodyText,
      body_html: null,
      cta_label: ctaLabel || null,
      cta_url: ctaUrl || null,
      status: "draft",
      created_by: userResult.user.id,
      updated_at: new Date().toISOString(),
    });

    if (error) {
      console.error("create marketing campaign draft failed", error);
      redirect(appendQueryParam(fallback, "campaign_error", "save_failed"));
    }
  } catch (error) {
    console.error("createMarketingCampaignDraftAction failed", error);
    redirect(appendQueryParam(fallback, "campaign_error", "save_failed"));
  }

  redirect(appendQueryParam(fallback, "campaign_saved", "1"));
}

export async function sendMarketingCampaignTestEmailAction(formData: FormData) {
  await requireStudioFeature("marketing_campaigns");
  const campaignId = getString(formData, "campaignId");
  const fallback = campaignId
    ? `/app/marketing/campaigns/${campaignId}`
    : "/app/marketing/campaigns";

  try {
    if (!process.env.RESEND_API_KEY) {
      console.error("RESEND_API_KEY is not configured");
      redirect(
        appendQueryParam(fallback, "campaign_error", "missing_resend_key"),
      );
    }

    const fromEmail = process.env.MARKETING_FROM_EMAIL;

    if (!fromEmail) {
      console.error("MARKETING_FROM_EMAIL is not configured");
      redirect(
        appendQueryParam(fallback, "campaign_error", "missing_from_email"),
      );
    }

    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;

    if (!studioId) {
      redirect("/login");
    }

    const { data: userResult, error: userError } =
      await supabase.auth.getUser();

    if (userError || !userResult.user?.email) {
      redirect("/login");
    }

    const testEmail = getString(formData, "testEmail") || userResult.user.email;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
      redirect(appendQueryParam(fallback, "campaign_error", "invalid_test_email"));
    }

    const [{ data: campaign, error: campaignError }, { data: studio }] =
      await Promise.all([
        supabase
          .from("marketing_campaigns")
          .select(
            "id, studio_id, name, subject, preview_text, body_text, cta_label, cta_url, status",
          )
          .eq("id", campaignId)
          .eq("studio_id", studioId)
          .maybeSingle(),
        supabase
          .from("studios")
          .select(
            "name, public_name, public_logo_url, email, address_line_1, address_line_2, city, state, postal_code, country",
          )
          .eq("id", studioId)
          .maybeSingle(),
      ]);

    if (campaignError || !campaign) {
      console.error("marketing campaign test lookup failed", campaignError);
      redirect(appendQueryParam(fallback, "campaign_error", "not_found"));
    }

    if (!campaign.subject || !campaign.body_text) {
      redirect(appendQueryParam(fallback, "campaign_error", "missing_content"));
    }

    const studioName = String(studio?.public_name?.trim() || studio?.name || "Your dance studio");
    const studioLogoUrl = studio?.public_logo_url ?? null;
    const footerNote = hasMarketingFooterAddress(studio)
      ? `${buildStudioMarketingFooterNote(studio)} This is a DanceFlow test email. No campaign recipients were contacted.`
      : "This is a DanceFlow test email. No campaign recipients were contacted. Add a marketing footer address in Settings before sending live campaigns.";
    const resend = new Resend(process.env.RESEND_API_KEY);
    const replyTo = getStudioReplyToEmail(studio, userResult.user.email);

    const html = buildCampaignEmailHtml({
      studioName,
      studioLogoUrl,
      subject: `[TEST] ${campaign.subject}`,
      previewText: campaign.preview_text,
      bodyText: campaign.body_text,
      ctaLabel: campaign.cta_label,
      ctaUrl: campaign.cta_url,
      footerNote,
    });

    const text = buildCampaignEmailText({
      studioName,
      studioLogoUrl,
      subject: `[TEST] ${campaign.subject}`,
      previewText: campaign.preview_text,
      bodyText: campaign.body_text,
      ctaLabel: campaign.cta_label,
      ctaUrl: campaign.cta_url,
      footerNote,
    });

    const { error: sendError } = await resend.emails.send({
      from: fromEmail,
      to: [testEmail],
      subject: `[TEST] ${campaign.subject}`,
      html,
      text,
      replyTo,
    });

    if (sendError) {
      console.error("send marketing campaign test failed", sendError);
      redirect(
        appendQueryParam(fallback, "campaign_error", "test_send_failed"),
      );
    }
  } catch (error) {
    console.error("sendMarketingCampaignTestEmailAction failed", error);
    redirect(appendQueryParam(fallback, "campaign_error", "test_send_failed"));
  }

  redirect(appendQueryParam(fallback, "test_sent", "1"));
}

export async function generateMarketingCampaignRecipientsAction(
  formData: FormData,
) {
  await requireStudioFeature("marketing_campaigns");
  const campaignId = getString(formData, "campaignId");
  const fallback = campaignId
    ? `/app/marketing/campaigns/${campaignId}`
    : "/app/marketing/campaigns";

  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;

    if (!studioId) {
      redirect("/login");
    }

    const { data: campaign, error: campaignError } = await supabase
      .from("marketing_campaigns")
      .select("id, studio_id, audience_type, audience_event_id, status")
      .eq("id", campaignId)
      .eq("studio_id", studioId)
      .maybeSingle();

    if (campaignError || !campaign) {
      console.error(
        "generate recipients campaign lookup failed",
        campaignError,
      );
      redirect(appendQueryParam(fallback, "campaign_error", "not_found"));
    }

    if (campaign.status === "sent" || campaign.status === "sending") {
      redirect(appendQueryParam(fallback, "campaign_error", "campaign_locked"));
    }

    const recipients = await getRecipientPreview({
      supabase,
      studioId,
      audienceType: String(campaign.audience_type ?? "manual"),
      audienceEventId:
        typeof campaign.audience_event_id === "string"
          ? campaign.audience_event_id
          : null,
    });

    const rows = recipients.map((recipient) => ({
      campaign_id: campaign.id,
      studio_id: studioId,
      client_id: recipient.clientId,
      email: recipient.email,
      name: recipient.name || null,
      status: recipient.unsubscribed ? "unsubscribed" : "pending",
      unsubscribe_token: randomUUID(),
      error_message: recipient.unsubscribed
        ? "Suppressed by unsubscribe list"
        : null,
    }));

    const { error: deleteError } = await supabase
      .from("marketing_campaign_recipients")
      .delete()
      .eq("campaign_id", campaign.id)
      .eq("studio_id", studioId);

    if (deleteError) {
      console.error("delete existing campaign recipients failed", deleteError);
      redirect(
        appendQueryParam(
          fallback,
          "campaign_error",
          "recipient_generate_failed",
        ),
      );
    }

    if (rows.length > 0) {
      const { error: insertError } = await supabase
        .from("marketing_campaign_recipients")
        .insert(rows);

      if (insertError) {
        console.error("insert campaign recipients failed", insertError);
        redirect(
          appendQueryParam(
            fallback,
            "campaign_error",
            "recipient_generate_failed",
          ),
        );
      }
    }

    await supabase
      .from("marketing_campaigns")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", campaign.id)
      .eq("studio_id", studioId);
  } catch (error) {
    console.error("generateMarketingCampaignRecipientsAction failed", error);
    redirect(
      appendQueryParam(fallback, "campaign_error", "recipient_generate_failed"),
    );
  }

  redirect(appendQueryParam(fallback, "recipients_generated", "1"));
}

export async function sendMarketingCampaignAction(formData: FormData) {
  await requireStudioFeature("marketing_campaigns");
  const campaignId = getString(formData, "campaignId");
  const fallback = campaignId
    ? `/app/marketing/campaigns/${campaignId}`
    : "/app/marketing/campaigns";

  try {
    if (!process.env.RESEND_API_KEY) {
      redirect(
        appendQueryParam(fallback, "campaign_error", "missing_resend_key"),
      );
    }

    const fromEmail = process.env.MARKETING_FROM_EMAIL;

    if (!fromEmail) {
      redirect(
        appendQueryParam(fallback, "campaign_error", "missing_from_email"),
      );
    }

    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;

    if (!studioId) {
      redirect("/login");
    }

    const { data: userResult, error: userError } =
      await supabase.auth.getUser();

    if (userError || !userResult.user?.email) {
      redirect("/login");
    }

    const [{ data: campaign, error: campaignError }, { data: studio }] =
      await Promise.all([
        supabase
          .from("marketing_campaigns")
          .select(
            "id, studio_id, name, subject, preview_text, body_text, cta_label, cta_url, status",
          )
          .eq("id", campaignId)
          .eq("studio_id", studioId)
          .maybeSingle(),
        supabase
          .from("studios")
          .select(
            "name, public_name, public_logo_url, email, address_line_1, address_line_2, city, state, postal_code, country",
          )
          .eq("id", studioId)
          .maybeSingle(),
      ]);

    if (campaignError || !campaign) {
      console.error("send campaign lookup failed", campaignError);
      redirect(appendQueryParam(fallback, "campaign_error", "not_found"));
    }

    if (!campaign.subject || !campaign.body_text) {
      redirect(appendQueryParam(fallback, "campaign_error", "missing_content"));
    }

    if (campaign.status === "sent") {
      redirect(
        appendQueryParam(fallback, "campaign_error", "campaign_already_sent"),
      );
    }

    if (campaign.status === "sending") {
      redirect(appendQueryParam(fallback, "campaign_error", "campaign_locked"));
    }

    if (getString(formData, "confirmSend") !== "yes") {
      redirect(
        appendQueryParam(fallback, "campaign_error", "send_not_confirmed"),
      );
    }

    if (!hasMarketingFooterAddress(studio)) {
      redirect(
        appendQueryParam(
          fallback,
          "campaign_error",
          "missing_marketing_footer",
        ),
      );
    }

    const { data: pendingRecipients, error: recipientsError } = await supabase
      .from("marketing_campaign_recipients")
      .select("id, email, name, unsubscribe_token")
      .eq("campaign_id", campaign.id)
      .eq("studio_id", studioId)
      .eq("status", "pending")
      .limit(MAX_CAMPAIGN_SENDS_PER_ACTION);

    if (recipientsError) {
      console.error("load pending campaign recipients failed", recipientsError);
      redirect(appendQueryParam(fallback, "campaign_error", "send_failed"));
    }

    if (!pendingRecipients || pendingRecipients.length === 0) {
      redirect(
        appendQueryParam(fallback, "campaign_error", "no_pending_recipients"),
      );
    }

    await supabase
      .from("marketing_campaigns")
      .update({ status: "sending", updated_at: new Date().toISOString() })
      .eq("id", campaign.id)
      .eq("studio_id", studioId);

    const studioName = String(studio?.public_name?.trim() || studio?.name || "Your dance studio");
    const studioLogoUrl = studio?.public_logo_url ?? null;
    const footerNote = buildStudioMarketingFooterNote(studio);
    const replyTo = getStudioReplyToEmail(studio, userResult.user.email);
    const resend = new Resend(process.env.RESEND_API_KEY);

    for (const recipient of pendingRecipients) {
      const unsubscribeUrl = `${getSiteUrl()}/unsubscribe/marketing/${recipient.unsubscribe_token}`;

      const emailParams: CampaignEmailParams = {
        studioName,
        studioLogoUrl,
        subject: campaign.subject,
        previewText: campaign.preview_text,
        bodyText: campaign.body_text,
        ctaLabel: campaign.cta_label,
        ctaUrl: campaign.cta_url,
        footerNote,
        unsubscribeUrl,
      };

      const html = buildCampaignEmailHtml(emailParams);
      const text = buildCampaignEmailText(emailParams);

      try {
        const result = await resend.emails.send({
          from: fromEmail,
          to: [recipient.email],
          subject: campaign.subject,
          html,
          text,
          replyTo,
        });

        const messageId =
          typeof result.data?.id === "string" ? result.data.id : null;

        await supabase
          .from("marketing_campaign_recipients")
          .update({
            status: "sent",
            provider_message_id: messageId,
            error_message: null,
            sent_at: new Date().toISOString(),
          })
          .eq("id", recipient.id)
          .eq("studio_id", studioId);
      } catch (error) {
        console.error("send campaign recipient failed", {
          campaignId: campaign.id,
          recipientId: recipient.id,
          error,
        });

        await supabase
          .from("marketing_campaign_recipients")
          .update({
            status: "failed",
            error_message:
              error instanceof Error ? error.message : "Send failed",
          })
          .eq("id", recipient.id)
          .eq("studio_id", studioId);
      }
    }

    const { count: remainingPendingCount } = await supabase
      .from("marketing_campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaign.id)
      .eq("studio_id", studioId)
      .eq("status", "pending");

    if (Number(remainingPendingCount ?? 0) === 0) {
      await supabase
        .from("marketing_campaigns")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", campaign.id)
        .eq("studio_id", studioId);
    } else {
      await supabase
        .from("marketing_campaigns")
        .update({
          status: "draft",
          updated_at: new Date().toISOString(),
        })
        .eq("id", campaign.id)
        .eq("studio_id", studioId);
    }
  } catch (error) {
    console.error("sendMarketingCampaignAction failed", error);
    redirect(appendQueryParam(fallback, "campaign_error", "send_failed"));
  }

  redirect(appendQueryParam(fallback, "campaign_sent", "1"));
}
