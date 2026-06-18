"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { Resend } from "resend";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

const AUDIENCE_TYPES = new Set([
  "all_organizer_contacts",
  "specific_event_registrants",
  "specific_event_ticket_buyers",
  "specific_event_unpaid_pending",
  "specific_event_checked_in",
  "specific_event_no_shows",
  "specific_event_registered_not_checked_in",
  "specific_event_refunded",
  "paid_registration_contacts",
]);

const EVENT_REQUIRED_AUDIENCES = new Set([
  "specific_event_registrants",
  "specific_event_ticket_buyers",
  "specific_event_unpaid_pending",
  "specific_event_checked_in",
  "specific_event_no_shows",
  "specific_event_registered_not_checked_in",
  "specific_event_refunded",
]);

const MAX_ORGANIZER_CAMPAIGN_SENDS_PER_ACTION = 500;

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

type OrganizerCampaignEmailParams = {
  organizerName: string;
  subject: string;
  previewText: string | null;
  bodyText: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
  footerNote: string;
  unsubscribeUrl?: string | null;
};

type OrganizerRecipientPreview = {
  organizerContactId: string | null;
  email: string;
  name: string;
  unsubscribed: boolean;
};

type OrganizerContactRow = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: string | null;
  total_paid_registrations: number | null;
};

type ContactRegistrationRow = {
  organizer_contact_id: string | null;
  payment_status: string | null;
  checked_in_at: string | null;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function appendQuery(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

function normalizeUrl(url: string) {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `https://${url}`;
}

function getSiteUrl() {
  return (process.env.NEXT_PUBLIC_SITE_URL || "https://idanceflow.com").replace(
    /\/$/,
    "",
  );
}

function normalizeEmail(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function buildName(firstName: unknown, lastName: unknown) {
  return `${String(firstName ?? "").trim()} ${String(lastName ?? "").trim()}`.trim();
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

function buildOrganizerCampaignEmailHtml(params: OrganizerCampaignEmailParams) {
  const safeOrganizerName = escapeHtml(
    params.organizerName || "DanceFlow Organizer",
  );
  const safeSubject = escapeHtml(params.subject);
  const safePreview = params.previewText ? escapeHtml(params.previewText) : "";
  const bodyHtml = plainTextToHtml(params.bodyText);
  const safeFooter = escapeHtml(params.footerNote);

  const cta =
    params.ctaLabel && params.ctaUrl
      ? `<div style="margin:28px 0 8px;"><a href="${escapeHtml(params.ctaUrl)}" style="display:inline-block;border-radius:14px;background:#4D1F47;color:#ffffff;font-weight:700;text-decoration:none;padding:13px 18px;">${escapeHtml(params.ctaLabel)}</a></div>`
      : "";

  const unsubscribe = params.unsubscribeUrl
    ? `<div style="margin-top:10px;">You are receiving this because you registered for or shared your email with ${safeOrganizerName}. <a href="${escapeHtml(params.unsubscribeUrl)}" style="color:#4D1F47;text-decoration:underline;">Unsubscribe</a>.</div>`
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
              <td style="background:linear-gradient(135deg,#241432,#4D1F47,#E85D2A);padding:28px;color:#ffffff;">
                <div style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.75);font-weight:700;">DanceFlow Organizer Message</div>
                <h1 style="margin:10px 0 0;font-size:28px;line-height:1.15;">${safeOrganizerName}</h1>
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
                ${unsubscribe}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildOrganizerCampaignEmailText(params: OrganizerCampaignEmailParams) {
  const cta =
    params.ctaLabel && params.ctaUrl
      ? `\n\n${params.ctaLabel}: ${params.ctaUrl}`
      : "";
  const unsubscribe = params.unsubscribeUrl
    ? `\n\nUnsubscribe: ${params.unsubscribeUrl}`
    : "";
  return `${params.organizerName}\n\n${params.bodyText}${cta}\n\n${params.footerNote}${unsubscribe}`;
}

function canManageOrganizerMarketing(
  role: string | null | undefined,
  isPlatformAdminRole: boolean,
) {
  if (isPlatformAdminRole) return true;
  return [
    "studio_owner",
    "studio_admin",
    "front_desk",
    "organizer_owner",
    "organizer_admin",
    "organizer_staff",
  ].includes(role ?? "");
}

async function requireOrganizerAccess(
  supabase: SupabaseClient,
  organizerId: string,
) {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();

  const [
    { data: organizer, error: organizerError },
    { data: organizerUser, error: organizerUserError },
    { data: platformAdmin },
  ] = await Promise.all([
    supabase
      .from("organizers")
      .select("id, studio_id")
      .eq("id", organizerId)
      .maybeSingle(),
    supabase
      .from("organizer_users")
      .select("organizer_id, role, active")
      .eq("organizer_id", organizerId)
      .eq("user_id", user.id)
      .eq("active", true)
      .maybeSingle(),
    supabase
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  if (organizerError || organizerUserError || !organizer) {
    console.error("Failed to check organizer campaign access", {
      organizerError,
      organizerUserError,
    });
    redirect("/app/organizer-campaigns?campaign_error=access_check_failed");
  }

  const hasStudioScopedAccess =
    organizer.studio_id === context.studioId &&
    canManageOrganizerMarketing(context.studioRole, context.isPlatformAdmin);

  if (!organizerUser && !platformAdmin && !hasStudioScopedAccess) {
    redirect("/app/organizer-campaigns?campaign_error=not_allowed");
  }

  return { user };
}

async function getCampaignForAction(
  supabase: SupabaseClient,
  campaignId: string,
) {
  const { data: campaign, error } = await supabase
    .from("organizer_marketing_campaigns")
    .select(
      "id, organizer_id, name, subject, preview_text, body_text, cta_label, cta_url, audience_type, audience_event_id, status",
    )
    .eq("id", campaignId)
    .maybeSingle();

  if (error || !campaign) {
    console.error("Organizer campaign lookup failed", error);
    redirect("/app/organizer-campaigns?campaign_error=not_found");
  }

  return campaign;
}

async function getOrganizerUnsubscribedEmails(params: {
  supabase: SupabaseClient;
  organizerId: string;
}) {
  const { supabase, organizerId } = params;

  const { data, error } = await supabase
    .from("organizer_marketing_unsubscribes")
    .select("email")
    .eq("organizer_id", organizerId);

  if (error) {
    console.error("Failed to load organizer marketing unsubscribes", error);
    return new Set<string>();
  }

  return new Set(
    (data ?? []).map((row) => normalizeEmail(row.email)).filter(Boolean),
  );
}

function contactName(contact: OrganizerContactRow) {
  return buildName(contact.first_name, contact.last_name) || contact.email;
}

function uniqueOrganizerContacts(contacts: OrganizerContactRow[]) {
  const seen = new Set<string>();
  const unique: OrganizerContactRow[] = [];

  for (const contact of contacts) {
    const email = normalizeEmail(contact.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    unique.push(contact);
  }

  return unique;
}

function normalizedRegistrationStatus(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function isPaidRegistrationStatus(value: string | null | undefined) {
  const status = normalizedRegistrationStatus(value);
  return ["paid", "succeeded", "complete", "completed"].includes(status);
}

function isUnpaidOrPendingRegistrationStatus(value: string | null | undefined) {
  const status = normalizedRegistrationStatus(value);
  return [
    "",
    "unpaid",
    "pending",
    "open",
    "requires_payment",
    "requires_payment_method",
    "processing",
    "incomplete",
  ].includes(status);
}

function isRefundedRegistrationStatus(value: string | null | undefined) {
  const status = normalizedRegistrationStatus(value);
  return ["refunded", "partially_refunded", "refund_pending"].includes(status);
}

function registrationMatchesAudience(
  registration: ContactRegistrationRow,
  audienceType: string,
) {
  switch (audienceType) {
    case "specific_event_ticket_buyers":
      return isPaidRegistrationStatus(registration.payment_status);
    case "specific_event_unpaid_pending":
      return isUnpaidOrPendingRegistrationStatus(registration.payment_status);
    case "specific_event_checked_in":
      return Boolean(registration.checked_in_at);
    case "specific_event_no_shows":
      return (
        isPaidRegistrationStatus(registration.payment_status) &&
        !registration.checked_in_at
      );
    case "specific_event_registered_not_checked_in":
      return !registration.checked_in_at;
    case "specific_event_refunded":
      return isRefundedRegistrationStatus(registration.payment_status);
    default:
      return true;
  }
}

async function getOrganizerCampaignRecipients(params: {
  supabase: SupabaseClient;
  organizerId: string;
  audienceType: string;
  eventId: string | null;
}) {
  const { supabase, organizerId, audienceType, eventId } = params;
  const unsubscribedEmails = await getOrganizerUnsubscribedEmails({
    supabase,
    organizerId,
  });
  let contacts: OrganizerContactRow[] = [];

  if (EVENT_REQUIRED_AUDIENCES.has(audienceType) && !eventId) {
    return [];
  }

  if (audienceType === "all_organizer_contacts") {
    const { data, error } = await supabase
      .from("organizer_contacts")
      .select(
        "id, email, first_name, last_name, status, total_paid_registrations",
      )
      .eq("organizer_id", organizerId)
      .eq("status", "active")
      .order("last_seen_at", { ascending: false })
      .limit(5000);

    if (error) {
      console.error("Failed to load all organizer campaign contacts", error);
      return [];
    }

    contacts = (data ?? []) as OrganizerContactRow[];
  } else if (audienceType === "paid_registration_contacts") {
    const { data, error } = await supabase
      .from("organizer_contacts")
      .select(
        "id, email, first_name, last_name, status, total_paid_registrations",
      )
      .eq("organizer_id", organizerId)
      .eq("status", "active")
      .gt("total_paid_registrations", 0)
      .order("last_seen_at", { ascending: false })
      .limit(5000);

    if (error) {
      console.error("Failed to load paid organizer campaign contacts", error);
      return [];
    }

    contacts = (data ?? []) as OrganizerContactRow[];
  } else if (eventId) {
    let registrationsQuery = supabase
      .from("organizer_contact_registrations")
      .select("organizer_contact_id, payment_status, checked_in_at")
      .eq("organizer_id", organizerId)
      .eq("event_id", eventId)
      .limit(10000);

    const { data: registrations, error: registrationsError } =
      await registrationsQuery;

    if (registrationsError) {
      console.error(
        "Failed to load organizer event campaign registrations",
        registrationsError,
      );
      return [];
    }

    const matchingRegistrations = ((registrations ?? []) as ContactRegistrationRow[])
      .filter((registration) => registrationMatchesAudience(registration, audienceType));

    const contactIds = Array.from(
      new Set(
        matchingRegistrations
          .map((row) => row.organizer_contact_id)
          .filter(Boolean),
      ),
    ) as string[];

    if (contactIds.length > 0) {
      const { data, error } = await supabase
        .from("organizer_contacts")
        .select(
          "id, email, first_name, last_name, status, total_paid_registrations",
        )
        .eq("organizer_id", organizerId)
        .eq("status", "active")
        .in("id", contactIds)
        .limit(5000);

      if (error) {
        console.error(
          "Failed to load organizer event campaign contacts",
          error,
        );
        return [];
      }

      contacts = (data ?? []) as OrganizerContactRow[];
    }
  }

  return uniqueOrganizerContacts(contacts).map((contact) => {
    const email = normalizeEmail(contact.email);
    return {
      organizerContactId: contact.id,
      email,
      name: contactName(contact),
      unsubscribed: unsubscribedEmails.has(email),
    } satisfies OrganizerRecipientPreview;
  });
}

export async function updateOrganizerCampaignDraftAction(formData: FormData) {
  const campaignId = getString(formData, "campaignId");
  const fallback = campaignId
    ? `/app/organizer-campaigns/${campaignId}`
    : "/app/organizer-campaigns";

  const name = getString(formData, "name");
  const subject = getString(formData, "subject");
  const previewText = getString(formData, "previewText");
  const bodyText = getString(formData, "bodyText");
  const ctaLabel = getString(formData, "ctaLabel");
  const ctaUrl = normalizeUrl(getString(formData, "ctaUrl"));
  const audienceType =
    getString(formData, "audienceType") || "all_organizer_contacts";
  const audienceEventId = getString(formData, "audienceEventId");

  if (!campaignId || !name || !subject || !bodyText) {
    redirect(
      appendQuery(fallback, "campaign_error", "missing_required_fields"),
    );
  }

  if (!AUDIENCE_TYPES.has(audienceType)) {
    redirect(appendQuery(fallback, "campaign_error", "invalid_audience"));
  }

  if (EVENT_REQUIRED_AUDIENCES.has(audienceType) && !audienceEventId) {
    redirect(appendQuery(fallback, "campaign_error", "event_required"));
  }

  const supabase = await createClient();
  const campaign = await getCampaignForAction(supabase, campaignId);
  await requireOrganizerAccess(supabase, campaign.organizer_id);

  if (campaign.status !== "draft") {
    redirect(appendQuery(fallback, "campaign_error", "campaign_locked"));
  }

  if (audienceEventId) {
    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id, organizer_id")
      .eq("id", audienceEventId)
      .eq("organizer_id", campaign.organizer_id)
      .maybeSingle();

    if (eventError || !event) {
      console.error("Organizer campaign event access check failed", eventError);
      redirect(appendQuery(fallback, "campaign_error", "invalid_event"));
    }
  }

  const { error } = await supabase
    .from("organizer_marketing_campaigns")
    .update({
      name,
      subject,
      preview_text: previewText || null,
      body_text: bodyText,
      cta_label: ctaLabel || null,
      cta_url: ctaUrl || null,
      audience_type: audienceType,
      audience_event_id: audienceEventId || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaign.id)
    .eq("organizer_id", campaign.organizer_id);

  if (error) {
    console.error("Failed to update organizer campaign draft", error);
    redirect(appendQuery(fallback, "campaign_error", "save_failed"));
  }

  redirect(appendQuery(fallback, "campaign_saved", "1"));
}

export async function sendOrganizerCampaignTestEmailAction(formData: FormData) {
  const campaignId = getString(formData, "campaignId");
  const fallback = campaignId
    ? `/app/organizer-campaigns/${campaignId}`
    : "/app/organizer-campaigns";

  if (!campaignId) {
    redirect(appendQuery(fallback, "campaign_error", "missing_campaign"));
  }

  if (!process.env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not configured");
    redirect(appendQuery(fallback, "campaign_error", "missing_resend_key"));
  }

  const fromEmail = process.env.MARKETING_FROM_EMAIL;

  if (!fromEmail) {
    console.error("MARKETING_FROM_EMAIL is not configured");
    redirect(appendQuery(fallback, "campaign_error", "missing_from_email"));
  }

  const supabase = await createClient();
  const campaign = await getCampaignForAction(supabase, campaignId);
  const { user } = await requireOrganizerAccess(
    supabase,
    campaign.organizer_id,
  );
  const testEmail = getString(formData, "testEmail") || user.email;

  if (!testEmail) {
    redirect(appendQuery(fallback, "campaign_error", "missing_test_email"));
  }

  if (!campaign.subject || !campaign.body_text) {
    redirect(appendQuery(fallback, "campaign_error", "missing_content"));
  }

  if (!String(campaign.preview_text ?? "").trim()) {
    redirect(appendQuery(fallback, "campaign_error", "missing_preview_text"));
  }

  const { data: organizer } = await supabase
    .from("organizers")
    .select("name")
    .eq("id", campaign.organizer_id)
    .maybeSingle();

  const organizerName = String(organizer?.name ?? "DanceFlow Organizer");
  const resend = new Resend(process.env.RESEND_API_KEY);
  const replyTo =
    process.env.MARKETING_REPLY_TO_EMAIL || user.email || undefined;

  const html = buildOrganizerCampaignEmailHtml({
    organizerName,
    subject: `[TEST] ${campaign.subject}`,
    previewText: campaign.preview_text,
    bodyText: campaign.body_text,
    ctaLabel: campaign.cta_label,
    ctaUrl: campaign.cta_url,
    footerNote:
      "This is a DanceFlow organizer campaign test email. No campaign recipients were contacted.",
  });

  const text = buildOrganizerCampaignEmailText({
    organizerName,
    subject: `[TEST] ${campaign.subject}`,
    previewText: campaign.preview_text,
    bodyText: campaign.body_text,
    ctaLabel: campaign.cta_label,
    ctaUrl: campaign.cta_url,
    footerNote:
      "This is a DanceFlow organizer campaign test email. No campaign recipients were contacted.",
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
    console.error("send organizer campaign test failed", sendError);
    redirect(appendQuery(fallback, "campaign_error", "test_send_failed"));
  }

  redirect(appendQuery(fallback, "test_sent", "1"));
}

export async function generateOrganizerCampaignRecipientsAction(
  formData: FormData,
) {
  const campaignId = getString(formData, "campaignId");
  const fallback = campaignId
    ? `/app/organizer-campaigns/${campaignId}`
    : "/app/organizer-campaigns";

  if (!campaignId) {
    redirect(appendQuery(fallback, "campaign_error", "missing_campaign"));
  }

  const supabase = await createClient();
  const campaign = await getCampaignForAction(supabase, campaignId);
  await requireOrganizerAccess(supabase, campaign.organizer_id);

  if (campaign.status === "sent" || campaign.status === "sending") {
    redirect(appendQuery(fallback, "campaign_error", "campaign_locked"));
  }

  const recipients = await getOrganizerCampaignRecipients({
    supabase,
    organizerId: campaign.organizer_id,
    audienceType: String(campaign.audience_type ?? "all_organizer_contacts"),
    eventId: campaign.audience_event_id,
  });

  const rows = recipients.map((recipient) => ({
    campaign_id: campaign.id,
    organizer_id: campaign.organizer_id,
    organizer_contact_id: recipient.organizerContactId,
    email: recipient.email,
    name: recipient.name || null,
    status: recipient.unsubscribed ? "unsubscribed" : "pending",
    unsubscribe_token: randomUUID(),
    error_message: recipient.unsubscribed
      ? "Suppressed by organizer unsubscribe list"
      : null,
  }));

  const { error: deleteError } = await supabase
    .from("organizer_marketing_campaign_recipients")
    .delete()
    .eq("campaign_id", campaign.id)
    .eq("organizer_id", campaign.organizer_id);

  if (deleteError) {
    console.error(
      "delete existing organizer campaign recipients failed",
      deleteError,
    );
    redirect(
      appendQuery(fallback, "campaign_error", "recipient_generate_failed"),
    );
  }

  if (rows.length > 0) {
    const { error: insertError } = await supabase
      .from("organizer_marketing_campaign_recipients")
      .insert(rows);

    if (insertError) {
      console.error("insert organizer campaign recipients failed", insertError);
      redirect(
        appendQuery(fallback, "campaign_error", "recipient_generate_failed"),
      );
    }
  }

  await supabase
    .from("organizer_marketing_campaigns")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", campaign.id)
    .eq("organizer_id", campaign.organizer_id);

  redirect(appendQuery(fallback, "recipients_generated", "1"));
}

export async function sendOrganizerCampaignAction(formData: FormData) {
  const campaignId = getString(formData, "campaignId");
  const fallback = campaignId
    ? `/app/organizer-campaigns/${campaignId}`
    : "/app/organizer-campaigns";

  if (!campaignId) {
    redirect(appendQuery(fallback, "campaign_error", "missing_campaign"));
  }

  if (!process.env.RESEND_API_KEY) {
    redirect(appendQuery(fallback, "campaign_error", "missing_resend_key"));
  }

  const fromEmail = process.env.MARKETING_FROM_EMAIL;

  if (!fromEmail) {
    redirect(appendQuery(fallback, "campaign_error", "missing_from_email"));
  }

  if (getString(formData, "confirmSend") !== "yes") {
    redirect(appendQuery(fallback, "campaign_error", "send_not_confirmed"));
  }

  const expectedPendingCountRaw = getString(formData, "expectedPendingCount");
  const expectedPendingCount = expectedPendingCountRaw
    ? Number(expectedPendingCountRaw)
    : null;
  const confirmSendPhrase = getString(formData, "confirmSendPhrase").toUpperCase();

  const supabase = await createClient();
  const campaign = await getCampaignForAction(supabase, campaignId);
  const { user } = await requireOrganizerAccess(
    supabase,
    campaign.organizer_id,
  );

  if (!campaign.subject || !campaign.body_text) {
    redirect(appendQuery(fallback, "campaign_error", "missing_content"));
  }

  if (!String(campaign.preview_text ?? "").trim()) {
    redirect(appendQuery(fallback, "campaign_error", "missing_preview_text"));
  }

  if (campaign.status === "sent") {
    redirect(appendQuery(fallback, "campaign_error", "campaign_already_sent"));
  }

  if (campaign.status === "sending") {
    redirect(appendQuery(fallback, "campaign_error", "campaign_locked"));
  }

  const [
    { data: organizer },
    { data: pendingRecipients, error: recipientsError },
  ] = await Promise.all([
    supabase
      .from("organizers")
      .select("name")
      .eq("id", campaign.organizer_id)
      .maybeSingle(),
    supabase
      .from("organizer_marketing_campaign_recipients")
      .select("id, email, name, unsubscribe_token")
      .eq("campaign_id", campaign.id)
      .eq("organizer_id", campaign.organizer_id)
      .eq("status", "pending")
      .limit(MAX_ORGANIZER_CAMPAIGN_SENDS_PER_ACTION),
  ]);

  if (recipientsError) {
    console.error(
      "load pending organizer campaign recipients failed",
      recipientsError,
    );
    redirect(appendQuery(fallback, "campaign_error", "send_failed"));
  }

  if (!pendingRecipients || pendingRecipients.length === 0) {
    redirect(appendQuery(fallback, "campaign_error", "no_pending_recipients"));
  }

  if (
    expectedPendingCount !== null &&
    Number.isFinite(expectedPendingCount) &&
    expectedPendingCount !== pendingRecipients.length
  ) {
    redirect(appendQuery(fallback, "campaign_error", "recipient_count_changed"));
  }

  if (confirmSendPhrase !== `SEND ${pendingRecipients.length}`) {
    redirect(appendQuery(fallback, "campaign_error", "final_confirmation_required"));
  }

  await supabase
    .from("organizer_marketing_campaigns")
    .update({ status: "sending", updated_at: new Date().toISOString() })
    .eq("id", campaign.id)
    .eq("organizer_id", campaign.organizer_id);

  const organizerName = String(organizer?.name ?? "DanceFlow Organizer");
  const replyTo =
    process.env.MARKETING_REPLY_TO_EMAIL || user.email || undefined;
  const resend = new Resend(process.env.RESEND_API_KEY);

  for (const recipient of pendingRecipients) {
    const token = String(recipient.unsubscribe_token ?? "").trim();
    const unsubscribeUrl = token
      ? `${getSiteUrl()}/unsubscribe/organizer-marketing/${token}`
      : null;

    const emailParams: OrganizerCampaignEmailParams = {
      organizerName,
      subject: campaign.subject,
      previewText: campaign.preview_text,
      bodyText: campaign.body_text,
      ctaLabel: campaign.cta_label,
      ctaUrl: campaign.cta_url,
      footerNote: "Sent with DanceFlow.",
      unsubscribeUrl,
    };

    const html = buildOrganizerCampaignEmailHtml(emailParams);
    const text = buildOrganizerCampaignEmailText(emailParams);

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
        .from("organizer_marketing_campaign_recipients")
        .update({
          status: "sent",
          provider_message_id: messageId,
          error_message: null,
          sent_at: new Date().toISOString(),
        })
        .eq("id", recipient.id)
        .eq("organizer_id", campaign.organizer_id);
    } catch (error) {
      console.error("send organizer campaign recipient failed", {
        campaignId: campaign.id,
        recipientId: recipient.id,
        error,
      });

      await supabase
        .from("organizer_marketing_campaign_recipients")
        .update({
          status: "failed",
          error_message: error instanceof Error ? error.message : "Send failed",
        })
        .eq("id", recipient.id)
        .eq("organizer_id", campaign.organizer_id);
    }
  }

  const { count: remainingPendingCount } = await supabase
    .from("organizer_marketing_campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaign.id)
    .eq("organizer_id", campaign.organizer_id)
    .eq("status", "pending");

  if (Number(remainingPendingCount ?? 0) === 0) {
    await supabase
      .from("organizer_marketing_campaigns")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", campaign.id)
      .eq("organizer_id", campaign.organizer_id);
  } else {
    await supabase
      .from("organizer_marketing_campaigns")
      .update({
        status: "draft",
        updated_at: new Date().toISOString(),
      })
      .eq("id", campaign.id)
      .eq("organizer_id", campaign.organizer_id);
  }

  redirect(appendQuery(fallback, "campaign_sent", "1"));
}

