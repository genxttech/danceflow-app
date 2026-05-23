"use server";

import { redirect } from "next/navigation";
import { Resend } from "resend";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

const AUDIENCE_TYPES = new Set([
  "manual",
  "all_active_clients",
  "new_leads",
  "inactive_clients",
  "event_attendees",
]);

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

function normalizeUrl(url: string) {
  if (!url) {
    return "";
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }

  return `https://${url}`;
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
    .map((paragraph) => `<p style="margin:0 0 16px;line-height:1.6;">${paragraph.replaceAll("\n", "<br />")}</p>`)
    .join("\n");
}

function buildCampaignEmailHtml(params: {
  studioName: string;
  subject: string;
  previewText: string | null;
  bodyText: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
  footerNote: string;
}) {
  const { studioName, subject, previewText, bodyText, ctaLabel, ctaUrl, footerNote } = params;
  const safeStudioName = escapeHtml(studioName || "DanceFlow Studio");
  const safeSubject = escapeHtml(subject);
  const safePreview = previewText ? escapeHtml(previewText) : "";
  const bodyHtml = plainTextToHtml(bodyText);
  const safeFooter = escapeHtml(footerNote);

  const cta = ctaLabel && ctaUrl
    ? `<div style="margin:28px 0 8px;"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;border-radius:14px;background:#4D1F47;color:#ffffff;font-weight:700;text-decoration:none;padding:13px 18px;">${escapeHtml(ctaLabel)}</a></div>`
    : "";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeSubject}</title>
  </head>
  <body style="margin:0;background:#f8f5f2;color:#241432;font-family:Arial,Helvetica,sans-serif;">
    ${safePreview ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${safePreview}</div>` : ""}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8f5f2;margin:0;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #eadfd7;border-radius:24px;overflow:hidden;">
            <tr>
              <td style="background:linear-gradient(135deg,#241432,#4D1F47,#E85D2A);padding:28px 28px;color:#ffffff;">
                <div style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.75);font-weight:700;">DanceFlow Message</div>
                <h1 style="margin:10px 0 0;font-size:28px;line-height:1.15;">${safeStudioName}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;font-size:16px;line-height:1.6;color:#241432;">
                ${bodyHtml}
                ${cta}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px;background:#fbfaf8;border-top:1px solid #eadfd7;font-size:12px;line-height:1.5;color:#6b5d66;">
                ${safeFooter}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export async function createMarketingCampaignDraftAction(formData: FormData) {
  const fallback = "/app/marketing/campaigns";

  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;

    if (!studioId) {
      redirect("/login");
    }

    const { data: userResult, error: userError } = await supabase.auth.getUser();

    if (userError || !userResult.user) {
      redirect("/login");
    }

    const name = getString(formData, "name");
    const audienceType = getString(formData, "audienceType") || "all_active_clients";
    const subject = getString(formData, "subject");
    const previewText = getString(formData, "previewText");
    const bodyText = getString(formData, "bodyText");
    const ctaLabel = getString(formData, "ctaLabel");
    const ctaUrl = normalizeUrl(getString(formData, "ctaUrl"));

    if (!name) {
      redirect(appendQueryParam(fallback, "campaign_error", "missing_name"));
    }

    if (!AUDIENCE_TYPES.has(audienceType)) {
      redirect(appendQueryParam(fallback, "campaign_error", "invalid_audience"));
    }

    if (!subject) {
      redirect(appendQueryParam(fallback, "campaign_error", "missing_subject"));
    }

    if (!bodyText) {
      redirect(appendQueryParam(fallback, "campaign_error", "missing_body"));
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
  const campaignId = getString(formData, "campaignId");
  const fallback = campaignId
    ? `/app/marketing/campaigns/${campaignId}`
    : "/app/marketing/campaigns";

  try {
    if (!process.env.RESEND_API_KEY) {
      console.error("RESEND_API_KEY is not configured");
      redirect(appendQueryParam(fallback, "campaign_error", "missing_resend_key"));
    }

    const fromEmail = process.env.MARKETING_FROM_EMAIL;

    if (!fromEmail) {
      console.error("MARKETING_FROM_EMAIL is not configured");
      redirect(appendQueryParam(fallback, "campaign_error", "missing_from_email"));
    }

    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;

    if (!studioId) {
      redirect("/login");
    }

    const { data: userResult, error: userError } = await supabase.auth.getUser();

    if (userError || !userResult.user?.email) {
      redirect("/login");
    }

    const testEmail = getString(formData, "testEmail") || userResult.user.email;

    const [{ data: campaign, error: campaignError }, { data: studio }] = await Promise.all([
      supabase
        .from("marketing_campaigns")
        .select("id, studio_id, name, subject, preview_text, body_text, cta_label, cta_url, status")
        .eq("id", campaignId)
        .eq("studio_id", studioId)
        .maybeSingle(),
      supabase.from("studios").select("name").eq("id", studioId).maybeSingle(),
    ]);

    if (campaignError || !campaign) {
      console.error("marketing campaign test lookup failed", campaignError);
      redirect(appendQueryParam(fallback, "campaign_error", "not_found"));
    }

    if (!campaign.subject || !campaign.body_text) {
      redirect(appendQueryParam(fallback, "campaign_error", "missing_content"));
    }

    const studioName = String(studio?.name ?? "DanceFlow Studio");
    const resend = new Resend(process.env.RESEND_API_KEY);
    const replyTo = process.env.MARKETING_REPLY_TO_EMAIL || userResult.user.email;

    const html = buildCampaignEmailHtml({
      studioName,
      subject: `[TEST] ${campaign.subject}`,
      previewText: campaign.preview_text,
      bodyText: campaign.body_text,
      ctaLabel: campaign.cta_label,
      ctaUrl: campaign.cta_url,
      footerNote:
        "This is a DanceFlow test email. No campaign recipients were contacted, and unsubscribe links will be added before live campaign sending.",
    });

    const text = `${studioName}\n\n${campaign.body_text}\n\n${campaign.cta_label && campaign.cta_url ? `${campaign.cta_label}: ${campaign.cta_url}\n\n` : ""}This is a DanceFlow test email. No campaign recipients were contacted.`;

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
      redirect(appendQueryParam(fallback, "campaign_error", "test_send_failed"));
    }
  } catch (error) {
    console.error("sendMarketingCampaignTestEmailAction failed", error);
    redirect(appendQueryParam(fallback, "campaign_error", "test_send_failed"));
  }

  redirect(appendQueryParam(fallback, "test_sent", "1"));
}

