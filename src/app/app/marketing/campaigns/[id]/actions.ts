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

  let query = supabase
    .from("clients")
    .select("id, first_name, last_name, email, status")
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

  const seen = new Set<string>();
  const recipients: RecipientPreview[] = [];

  for (const row of data ?? []) {
    const email = normalizeEmail(row.email);

    if (!email || seen.has(email)) {
      continue;
    }

    seen.add(email);
    recipients.push({
      clientId: row.id,
      email,
      name: buildName(row.first_name, row.last_name),
      source: "CRM",
      unsubscribed: unsubscribedEmails.has(email),
    });
  }

  return recipients;
}

async function getEventRecipients(params: {
  supabase: SupabaseClient;
  studioId: string;
  unsubscribedEmails: Set<string>;
}) {
  const { supabase, studioId, unsubscribedEmails } = params;

  const { data, error } = await supabase
    .from("event_registrations")
    .select("attendee_first_name, attendee_last_name, attendee_email, status")
    .eq("studio_id", studioId)
    .not("attendee_email", "is", null)
    .limit(5000);

  if (error) {
    console.error("Failed to load event campaign audience", error);
    return [];
  }

  const seen = new Set<string>();
  const recipients: RecipientPreview[] = [];

  for (const row of data ?? []) {
    if (String(row.status ?? "").toLowerCase() === "cancelled") {
      continue;
    }

    const email = normalizeEmail(row.attendee_email);

    if (!email || seen.has(email)) {
      continue;
    }

    seen.add(email);
    recipients.push({
      clientId: null,
      email,
      name: buildName(row.attendee_first_name, row.attendee_last_name),
      source: "Event registration",
      unsubscribed: unsubscribedEmails.has(email),
    });
  }

  return recipients;
}

async function getRecipientPreview(params: {
  supabase: SupabaseClient;
  studioId: string;
  audienceType: string;
}) {
  const { supabase, studioId, audienceType } = params;
  const unsubscribedEmails = await getUnsubscribedEmails({
    supabase,
    studioId,
  });

  if (audienceType === "event_attendees") {
    return getEventRecipients({ supabase, studioId, unsubscribedEmails });
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
          .select("name, public_name, public_logo_url, email")
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
    const resend = new Resend(process.env.RESEND_API_KEY);
    const replyTo =
      process.env.MARKETING_REPLY_TO_EMAIL || userResult.user.email;

    const html = buildCampaignEmailHtml({
      studioName,
      studioLogoUrl,
      subject: `[TEST] ${campaign.subject}`,
      previewText: campaign.preview_text,
      bodyText: campaign.body_text,
      ctaLabel: campaign.cta_label,
      ctaUrl: campaign.cta_url,
      footerNote:
        "This is a DanceFlow test email. No campaign recipients were contacted.",
    });

    const text = buildCampaignEmailText({
      studioName,
      studioLogoUrl,
      subject: `[TEST] ${campaign.subject}`,
      previewText: campaign.preview_text,
      bodyText: campaign.body_text,
      ctaLabel: campaign.cta_label,
      ctaUrl: campaign.cta_url,
      footerNote:
        "This is a DanceFlow test email. No campaign recipients were contacted.",
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
      .select("id, studio_id, audience_type, status")
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
          .select("name, public_name, public_logo_url, email")
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
    const replyTo =
      process.env.MARKETING_REPLY_TO_EMAIL || userResult.user.email;
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
        footerNote: "Sent with DanceFlow.",
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
