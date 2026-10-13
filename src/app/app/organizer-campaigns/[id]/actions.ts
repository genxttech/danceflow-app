"use server";

import { redirect } from "next/navigation";
import { Resend } from "resend";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  MarketingComplianceError,
  countOpenCampaignRecipients,
  deliverCampaignBatch,
  emptyDeliverySummary,
  isAbandonedSendingCampaign,
  loadCampaignSendBatch,
  syncCampaignRecipients,
} from "@/lib/marketing/compliance/campaignDelivery";
import { createResendMarketingTransport } from "@/lib/marketing/compliance/provider";
import { authorizeCampaignTestSend, testSendRefusalCode } from "@/lib/marketing/compliance/testSend";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { reserveCampaignSendAllowance, settleCampaignBatch } from "@/lib/usage/campaignAllowance";
import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";

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
  organizerLogoUrl?: string | null;
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

type OrganizerEmailSettings = {
  name?: string | null;
  studio_id?: string | null;
};

type LinkedStudioEmailSettings = {
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

function appendQuery(url: string, key: string, value: string) {
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

function cleanFooterPart(value: unknown) {
  return String(value ?? "").trim();
}

function buildLinkedStudioAddress(
  studio: LinkedStudioEmailSettings | null | undefined,
) {
  const parts = [
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

  return parts.join(" · ");
}

function getOrganizerFooterNote(params: {
  organizerName: string;
  linkedStudio?: LinkedStudioEmailSettings | null;
  isTest?: boolean;
}) {
  const address =
    buildLinkedStudioAddress(params.linkedStudio) ||
    cleanFooterPart(process.env.MARKETING_POSTAL_ADDRESS);

  const base = address
    ? `${params.organizerName} · ${address} · Sent through DanceFlow.`
    : `${params.organizerName} · Sent through DanceFlow.`;

  return params.isTest
    ? `${base} This is a test email. No campaign recipients were contacted.`
    : base;
}

function hasOrganizerMarketingAddress(
  studio: LinkedStudioEmailSettings | null | undefined,
) {
  return Boolean(
    buildLinkedStudioAddress(studio) ||
      cleanFooterPart(process.env.MARKETING_POSTAL_ADDRESS),
  );
}

function getOrganizerReplyToEmail(params: {
  linkedStudio?: LinkedStudioEmailSettings | null;
  fallbackEmail?: string | null;
}) {
  return (
    cleanFooterPart(params.linkedStudio?.email) ||
    cleanFooterPart(process.env.MARKETING_REPLY_TO_EMAIL) ||
    cleanFooterPart(params.fallbackEmail) ||
    undefined
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
  const unsubscribeHtml = params.unsubscribeUrl
    ? `<div style="margin-top:18px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.6;color:#64748b;">You are receiving this because you registered for or shared your email with ${escapeHtml(
        params.organizerName,
      )}. <a href="${escapeHtml(
        params.unsubscribeUrl,
      )}" style="color:#6d28d9;text-decoration:underline;">Unsubscribe</a>.</div>`
    : "";

  return renderStudioBrandedEmail(
    {
      name: params.organizerName,
      logoUrl: params.organizerLogoUrl ?? null,
    },
    {
      previewText: params.previewText || params.subject,
      eyebrow: "Event Organizer Update",
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
      "id, organizer_id, name, subject, preview_text, body_text, cta_label, cta_url, audience_type, audience_event_id, status, updated_at",
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
    // Marketing M-0 (C4): never treat a failed suppression lookup as "nobody unsubscribed".
    console.error("Failed to load organizer marketing unsubscribes", error);
    throw new MarketingComplianceError("sync_failed", "Organizer unsubscribe list unavailable.");
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
    const registrationsQuery = supabase
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
  const rawCtaUrl = getString(formData, "ctaUrl");
  const ctaUrl = normalizeUrl(rawCtaUrl);
  const audienceType =
    getString(formData, "audienceType") || "all_organizer_contacts";
  const audienceEventId = getString(formData, "audienceEventId");

  if (!campaignId || !name || !subject || !bodyText) {
    redirect(
      appendQuery(fallback, "campaign_error", "missing_required_fields"),
    );
  }

  if (rawCtaUrl && !ctaUrl) {
    redirect(appendQuery(fallback, "campaign_error", "invalid_cta_url"));
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

  // Marketing M-0: once delivery has started, the remaining recipients must receive the same message the others got
  // (and a retried uncertain send must carry the identical payload), so the content is locked.
  const { count: startedCount, error: startedError } = await supabase
    .from("organizer_marketing_campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaign.id)
    .eq("organizer_id", campaign.organizer_id)
    .in("status", ["sent", "sending", "failed", "delivery_unknown"]);

  if (startedError || startedCount === null || startedCount === undefined) {
    redirect(appendQuery(fallback, "campaign_error", "save_failed"));
  }

  if (Number(startedCount) > 0) {
    redirect(appendQuery(fallback, "campaign_error", "campaign_started"));
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

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
    redirect(appendQuery(fallback, "campaign_error", "invalid_test_email"));
  }

  // Marketing M-0 (D3): test sends only to a verified address of this organizer's staff, rate limited and recorded.
  const testDecision = await authorizeCampaignTestSend(createAdminClient(), {
    kind: "organizer",
    scopeId: campaign.organizer_id,
    campaignId: campaign.id,
    requestedBy: user.id,
    email: testEmail,
  });
  if (!testDecision.allowed) {
    redirect(appendQuery(fallback, "campaign_error", testSendRefusalCode(testDecision.reason)));
  }

  if (!campaign.subject || !campaign.body_text) {
    redirect(appendQuery(fallback, "campaign_error", "missing_content"));
  }

  if (!String(campaign.preview_text ?? "").trim()) {
    redirect(appendQuery(fallback, "campaign_error", "missing_preview_text"));
  }

  const { data: organizer } = await supabase
    .from("organizers")
    .select("name, studio_id")
    .eq("id", campaign.organizer_id)
    .maybeSingle<OrganizerEmailSettings>();

  const { data: linkedStudio } = organizer?.studio_id
    ? await supabase
        .from("studios")
        .select(
          "public_logo_url, email, address_line_1, address_line_2, city, state, postal_code, country",
        )
        .eq("id", organizer.studio_id)
        .maybeSingle<LinkedStudioEmailSettings>()
    : { data: null };

  const organizerName = String(organizer?.name ?? "DanceFlow Organizer");
  const organizerLogoUrl = linkedStudio?.public_logo_url ?? null;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const replyTo = getOrganizerReplyToEmail({
    linkedStudio,
    fallbackEmail: user.email,
  });

  const html = buildOrganizerCampaignEmailHtml({
    organizerName,
    organizerLogoUrl,
    subject: `[TEST] ${campaign.subject}`,
    previewText: campaign.preview_text,
    bodyText: campaign.body_text,
    ctaLabel: campaign.cta_label,
    ctaUrl: campaign.cta_url,
    footerNote: getOrganizerFooterNote({
      organizerName,
      linkedStudio,
      isTest: true,
    }),
  });

  const text = buildOrganizerCampaignEmailText({
    organizerName,
    organizerLogoUrl,
    subject: `[TEST] ${campaign.subject}`,
    previewText: campaign.preview_text,
    bodyText: campaign.body_text,
    ctaLabel: campaign.cta_label,
    ctaUrl: campaign.cta_url,
    footerNote: getOrganizerFooterNote({
      organizerName,
      linkedStudio,
      isTest: true,
    }),
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

  // Marketing M-0 (C2): one atomic database step replaces only never-mailed rows. Recipients already handed to the
  // provider keep their status, provider id and delivered unsubscribe token, and are never mailed again; eligibility
  // (organizer unsubscribes, unsubscribed contacts, platform suppressions) is decided there, not here.
  let syncOutcome: string;
  try {
    const recipients = await getOrganizerCampaignRecipients({
      supabase,
      organizerId: campaign.organizer_id,
      audienceType: String(campaign.audience_type ?? "all_organizer_contacts"),
      eventId: campaign.audience_event_id,
    });

    const synced = await syncCampaignRecipients(createAdminClient(), {
      kind: "organizer",
      scopeId: campaign.organizer_id,
      campaignId: campaign.id,
      recipients: recipients.map((recipient) => ({
        email: recipient.email,
        name: recipient.name || null,
        refId: recipient.organizerContactId,
      })),
    });
    syncOutcome = synced.outcome;
  } catch (error) {
    console.error("generate organizer campaign recipients failed", error);
    syncOutcome = "error";
  }

  if (syncOutcome === "campaign_locked" || syncOutcome === "delivery_in_progress") {
    redirect(appendQuery(fallback, "campaign_error", syncOutcome));
  }
  if (syncOutcome !== "synced") {
    redirect(appendQuery(fallback, "campaign_error", syncOutcome === "not_found" ? "not_found" : "recipient_generate_failed"));
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

  if (
    campaign.status === "sending" &&
    !(await isAbandonedSendingCampaign(createAdminClient(), {
      kind: "organizer",
      scopeId: campaign.organizer_id,
      campaignId: campaign.id,
      updatedAt: campaign.updated_at,
    }))
  ) {
    redirect(appendQuery(fallback, "campaign_error", "campaign_locked"));
  }

  const { data: organizer } = await supabase
    .from("organizers")
    .select("name, studio_id")
    .eq("id", campaign.organizer_id)
    .maybeSingle<OrganizerEmailSettings>();

  // Marketing M-0: every recipient goes through the shared send boundary: final eligibility check + claim in the
  // database (fail closed), provider call with a per-recipient idempotency key and RFC 8058 one-click headers, then
  // completion. Recipients left claimed by an uncertain outcome are retried first, with the same idempotency key.
  const admin = createAdminClient();
  const scope = { kind: "organizer" as const, scopeId: campaign.organizer_id, campaignId: campaign.id };
  let batch: Awaited<ReturnType<typeof loadCampaignSendBatch>>;
  let openCount: number;
  try {
    batch = await loadCampaignSendBatch(admin, { ...scope, limit: MAX_ORGANIZER_CAMPAIGN_SENDS_PER_ACTION });
    openCount = await countOpenCampaignRecipients(admin, scope);
  } catch (error) {
    console.error("load organizer campaign recipients failed", error);
    redirect(appendQuery(fallback, "campaign_error", "send_failed"));
  }

  if (batch.ids.length === 0) {
    redirect(appendQuery(fallback, "campaign_error", "no_pending_recipients"));
  }

  // The confirmation covers the never-attempted (pending) recipients shown on the page; retries of uncertain sends
  // were confirmed when they were first attempted.
  const pendingInBatch = batch.pendingIds.length;

  if (
    expectedPendingCount !== null &&
    Number.isFinite(expectedPendingCount) &&
    expectedPendingCount !== pendingInBatch
  ) {
    redirect(appendQuery(fallback, "campaign_error", "recipient_count_changed"));
  }

  if (confirmSendPhrase !== `SEND ${pendingInBatch}`) {
    redirect(appendQuery(fallback, "campaign_error", "final_confirmation_required"));
  }

  // ENT-1: monthly recipient allowance. The eligible count is every recipient of this campaign still owed an attempt
  // (not just this action's batch): if it does not fit the remaining allowance NOTHING is sent. The reservation is atomic
  // in the database, so concurrent sends cannot overshoot; it is settled below with the recipients the provider accepted
  // (and any whose earlier uncertain attempt aged out: counted as consumed, conservatively).
  const reservation = await reserveCampaignSendAllowance({
    workspace: { type: "organizer", organizerId: campaign.organizer_id },
    campaignId: campaign.id,
    eligibleTotal: Math.max(openCount, batch.ids.length),
    batchRecipientIds: batch.ids,
    userId: user.id,
    source: "organizer_campaign_send",
    relatedTable: "organizer_marketing_campaigns",
  });

  if (!reservation.ok) {
    let blockedUrl = fallback;
    for (const [key, value] of Object.entries(reservation.query)) {
      blockedUrl = appendQuery(blockedUrl, key, String(value));
    }
    redirect(blockedUrl);
  }

  const summary = emptyDeliverySummary();
  let stopCode: string | null = null;

  try {
    await supabase
      .from("organizer_marketing_campaigns")
      .update({ status: "sending", updated_at: new Date().toISOString() })
      .eq("id", campaign.id)
      .eq("organizer_id", campaign.organizer_id);

    const { data: linkedStudio } = organizer?.studio_id
      ? await supabase
          .from("studios")
          .select(
            "public_logo_url, email, address_line_1, address_line_2, city, state, postal_code, country",
          )
          .eq("id", organizer.studio_id)
          .maybeSingle<LinkedStudioEmailSettings>()
      : { data: null };

    if (!hasOrganizerMarketingAddress(linkedStudio)) {
      stopCode = "missing_marketing_footer";
    } else {
      const organizerName = String(organizer?.name ?? "DanceFlow Organizer");
      const organizerLogoUrl = linkedStudio?.public_logo_url ?? null;
      const replyTo = getOrganizerReplyToEmail({
        linkedStudio,
        fallbackEmail: user.email,
      });
      const footerNote = getOrganizerFooterNote({
        organizerName,
        linkedStudio,
      });

      try {
        await deliverCampaignBatch({
          summary,
          admin,
          transport: createResendMarketingTransport(),
          ...scope,
          recipientIds: batch.ids,
          from: fromEmail,
          replyTo,
          render: ({ unsubscribeUrl }) => {
            const emailParams: OrganizerCampaignEmailParams = {
              organizerName,
              organizerLogoUrl,
              subject: campaign.subject,
              previewText: campaign.preview_text,
              bodyText: campaign.body_text,
              ctaLabel: campaign.cta_label,
              ctaUrl: campaign.cta_url,
              footerNote,
              unsubscribeUrl,
            };
            return {
              subject: campaign.subject,
              html: buildOrganizerCampaignEmailHtml(emailParams),
              text: buildOrganizerCampaignEmailText(emailParams),
            };
          },
        });
        if (summary.stoppedReason) stopCode = "send_paused_provider";
      } catch (error) {
        console.error("organizer campaign send stopped", error instanceof MarketingComplianceError ? error.code : error);
        stopCode = error instanceof MarketingComplianceError ? "eligibility_check_failed" : "send_failed";
      }
    }
  } finally {
    // Accepted recipients become usage and the commitment shrinks to what is still owed an attempt (also when this block
    // is left early). If settling fails the capacity stays held and the batch is reconciled later: a successful send is
    // never left uncounted. The campaign status is always restored, so a failed batch cannot leave it stuck.
    let openAfter: number | null = null;
    try {
      openAfter = await countOpenCampaignRecipients(admin, scope);
    } catch (error) {
      console.error("open recipient count failed after send", error);
    }
    await settleCampaignBatch({
      reservationId: reservation.reservationId,
      sentCount: summary.sent + summary.unknown,
      pendingRemaining: openAfter,
      metadata: {
        campaign_id: campaign.id,
        attempted: summary.attempted,
        failed: summary.failed,
        uncertain: summary.uncertain,
        suppressed: summary.suppressed,
        unknown: summary.unknown,
      },
    });
    const nowIso = new Date().toISOString();
    await supabase
      .from("organizer_marketing_campaigns")
      .update(
        openAfter === 0
          ? { status: "sent", sent_at: nowIso, updated_at: nowIso }
          : { status: "draft", updated_at: nowIso },
      )
      .eq("id", campaign.id)
      .eq("organizer_id", campaign.organizer_id);
  }

  if (stopCode) {
    redirect(appendQuery(fallback, "campaign_error", stopCode));
  }

  redirect(appendQuery(fallback, "campaign_sent", "1"));
}

