"use server";

import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
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
import { canViewCommunications } from "@/lib/auth/permissions";
import { requireStudioFeature } from "@/lib/billing/access";
import { resolveStudioDisplayName, sanitizeEmailSubject } from "@/lib/email/brand";
import {
  CampaignAllowanceBlockedError,
  reserveCampaignSendAllowance,
  settleCampaignBatch,
} from "@/lib/usage/campaignAllowance";
import {
  hasUnsuppressedPackageWarning,
  type PackageWithItems,
} from "@/lib/packages/entitlement";
import {
  buildCampaignEmailHtml,
  buildCampaignEmailText,
  type CampaignEmailParams,
} from "./campaignEmail";

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

/** Marketing M-0: a refusal with a specific page message, redirected from the action's catch (outside its try body). */
class CampaignActionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CampaignActionError";
  }
}

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

type RecipientPreview = {
  clientId: string | null;
  email: string;
  name: string;
  source: string;
  unsubscribed: boolean;
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

// FC-1B5D Phase A correction: these four exported actions read client
// names/emails (directly or via the marketing_campaign_recipients rows
// they generate/send) and are independently invokable server actions --
// the page-level canViewCommunications gate on marketing/campaigns/page.tsx
// and [id]/page.tsx does not stop a direct call to the action itself.
// Reuses the exact same, already-established permission the pages use
// (no new role array) so the page gate and the action gate agree.
function requireCommunicationsAccessOrRedirect(
  studioRole: string | null | undefined,
  fallback: string,
) {
  if (!canViewCommunications(studioRole ?? "")) {
    redirect(appendQueryParam(fallback, "campaign_error", "unauthorized"));
  }
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
    // Marketing M-0 (C4): never treat a failed suppression lookup as "nobody unsubscribed".
    console.error("Failed to load marketing unsubscribes", error);
    throw new MarketingComplianceError("sync_failed", "Marketing unsubscribe list unavailable.");
  }

  return new Set(
    (data ?? []).map((row) => normalizeEmail(row.email)).filter(Boolean),
  );
}

/**
 * Slice 1b-b canonical low-credit segmentation, shared with
 * `campaigns/page.tsx` (audience preview count) and `campaigns/[id]/page.tsx`
 * (audience re-preview), which previously each carried their own
 * byte-identical copy of this query against the deprecated, unreliably
 * populated `client_packages.lessons_remaining` column. Derives balances
 * from `client_package_items.quantity_remaining`/`is_unlimited`/`usage_type`
 * instead, and applies the same canonical warning/replacement-coverage
 * rules as every other low/depleted-package surface (portal, staff,
 * notifications, ARIA): a client is included only if at least one of their
 * packages has an unsuppressed warning-causing usage type -- a healthy
 * replacement package for the SAME usage type suppresses it, an unrelated
 * or archived/expired/inactive/depleted "replacement" does not.
 */
export async function getLowPackageCreditClientIds(
  supabase: SupabaseClient,
  studioId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("client_packages")
    .select(
      `
      id,
      client_id,
      active,
      archived_at,
      expiration_date,
      client_package_items (
        usage_type,
        quantity_remaining,
        is_unlimited
      )
    `,
    )
    .eq("studio_id", studioId)
    .not("client_id", "is", null)
    .limit(10000);

  if (error) {
    console.error("Failed to load low-credit package audience", error);
    return new Set();
  }

  const packagesByClient = new Map<string, PackageWithItems[]>();

  for (const row of data ?? []) {
    const clientId = typeof row.client_id === "string" ? row.client_id : "";
    if (!clientId) continue;

    const pkg: PackageWithItems = {
      id: String(row.id),
      active: Boolean(row.active),
      archived_at: row.archived_at ?? null,
      expiration_date: row.expiration_date ?? null,
      client_package_items: Array.isArray(row.client_package_items)
        ? row.client_package_items
        : row.client_package_items
          ? [row.client_package_items]
          : [],
    };

    const list = packagesByClient.get(clientId);
    if (list) {
      list.push(pkg);
    } else {
      packagesByClient.set(clientId, [pkg]);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const lowCreditClientIds = new Set<string>();

  for (const [clientId, packages] of packagesByClient) {
    // Only a non-archived, active, non-expired package can generate its own
    // warning -- matches the Archived > Depleted > Expired > Low > Active
    // precedence (an archived/expired package is never itself "low").
    const eligibleTargets = packages.filter(
      (pkg) =>
        !pkg.archived_at &&
        pkg.active &&
        (!pkg.expiration_date || pkg.expiration_date >= today),
    );

    const clientHasUnsuppressedWarning = eligibleTargets.some((target) =>
      hasUnsuppressedPackageWarning({ targetPackage: target, otherClientPackages: packages }),
    );

    if (clientHasUnsuppressedWarning) {
      lowCreditClientIds.add(clientId);
    }
  }

  return lowCreditClientIds;
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
    const lowCreditClientIds = Array.from(
      await getLowPackageCreditClientIds(supabase, studioId),
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

    requireCommunicationsAccessOrRedirect(context.studioRole, fallback);

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

    requireCommunicationsAccessOrRedirect(context.studioRole, fallback);

    const { data: userResult, error: userError } =
      await supabase.auth.getUser();

    if (userError || !userResult.user?.email) {
      redirect("/login");
    }

    const testEmail = getString(formData, "testEmail") || userResult.user.email;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
      redirect(appendQueryParam(fallback, "campaign_error", "invalid_test_email"));
    }

    // Marketing M-0 (D3): test sends only to a verified address of this studio's staff, rate limited and recorded.
    const testDecision = await authorizeCampaignTestSend(createAdminClient(), {
      kind: "studio",
      scopeId: studioId,
      campaignId,
      requestedBy: userResult.user.id,
      email: testEmail,
    });
    if (!testDecision.allowed) {
      throw new CampaignActionError(testSendRefusalCode(testDecision.reason));
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

    const studioName = resolveStudioDisplayName(studio);
    const studioLogoUrl = studio?.public_logo_url ?? null;
    const footerNote = hasMarketingFooterAddress(studio)
      ? `${buildStudioMarketingFooterNote(studio)} This is a DanceFlow test email. No campaign recipients were contacted.`
      : "This is a DanceFlow test email. No campaign recipients were contacted. Add a marketing footer address in Settings before sending live campaigns.";
    const resend = new Resend(process.env.RESEND_API_KEY);
    const replyTo = getStudioReplyToEmail(studio, userResult.user.email);
    const subject = sanitizeEmailSubject(`[TEST] ${campaign.subject}`);

    const html = buildCampaignEmailHtml({
      studioName,
      studioLogoUrl,
      subject,
      previewText: campaign.preview_text,
      bodyText: campaign.body_text,
      ctaLabel: campaign.cta_label,
      ctaUrl: campaign.cta_url,
      footerNote,
    });

    const text = buildCampaignEmailText({
      studioName,
      studioLogoUrl,
      subject,
      previewText: campaign.preview_text,
      bodyText: campaign.body_text,
      ctaLabel: campaign.cta_label,
      ctaUrl: campaign.cta_url,
      footerNote,
    });

    const { error: sendError } = await resend.emails.send({
      from: fromEmail,
      to: [testEmail],
      subject,
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
    // A redirect thrown inside the try (campaign_locked, campaign_already_sent, ...) is the intended response.
    if (isRedirectError(error)) throw error;
    if (error instanceof CampaignActionError) {
      redirect(appendQueryParam(fallback, "campaign_error", error.code));
    }
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

    requireCommunicationsAccessOrRedirect(context.studioRole, fallback);

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

    // Marketing M-0 (C2): one atomic database step replaces only never-mailed rows. Recipients already handed to the
    // provider keep their status, provider id and delivered unsubscribe token, and are never mailed again; eligibility
    // (scope unsubscribes + platform suppressions) is decided there, not here.
    const synced = await syncCampaignRecipients(createAdminClient(), {
      kind: "studio",
      scopeId: studioId,
      campaignId: campaign.id,
      recipients: recipients.map((recipient) => ({
        email: recipient.email,
        name: recipient.name || null,
        refId: recipient.clientId,
      })),
    });

    if (synced.outcome === "campaign_locked" || synced.outcome === "delivery_in_progress") {
      throw new CampaignActionError(synced.outcome);
    }
    if (synced.outcome !== "synced") {
      throw new CampaignActionError(synced.outcome === "not_found" ? "not_found" : "recipient_generate_failed");
    }

    await supabase
      .from("marketing_campaigns")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", campaign.id)
      .eq("studio_id", studioId);
  } catch (error) {
    // A redirect thrown inside the try (campaign_locked, campaign_already_sent, ...) is the intended response.
    if (isRedirectError(error)) throw error;
    if (error instanceof CampaignActionError) {
      redirect(appendQueryParam(fallback, "campaign_error", error.code));
    }
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

    requireCommunicationsAccessOrRedirect(context.studioRole, fallback);

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
            "id, studio_id, name, subject, preview_text, body_text, cta_label, cta_url, status, updated_at",
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

    if (
      campaign.status === "sending" &&
      !(await isAbandonedSendingCampaign(createAdminClient(), {
        kind: "studio",
        scopeId: studioId,
        campaignId: campaign.id,
        updatedAt: campaign.updated_at,
      }))
    ) {
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

    // Marketing M-0: every recipient goes through the shared send boundary: final eligibility check + claim in the
    // database (fail closed), provider call with a per-recipient idempotency key and RFC 8058 one-click headers, then
    // completion. Recipients left claimed by an uncertain outcome are retried first, with the same idempotency key.
    const admin = createAdminClient();
    const scope = { kind: "studio" as const, scopeId: studioId, campaignId: campaign.id };
    const batch = await loadCampaignSendBatch(admin, { ...scope, limit: MAX_CAMPAIGN_SENDS_PER_ACTION });

    if (batch.ids.length === 0) {
      redirect(
        appendQueryParam(fallback, "campaign_error", "no_pending_recipients"),
      );
    }

    // ENT-1: monthly recipient allowance. The eligible count is every recipient of this campaign still owed an attempt
    // (not just this action's batch): if it does not fit the remaining allowance NOTHING is sent. The reservation is
    // atomic in the database, so concurrent sends cannot overshoot; it is settled below with the recipients the
    // provider accepted (and any whose earlier uncertain attempt aged out: counted as consumed, conservatively).
    const openCount = await countOpenCampaignRecipients(admin, scope);

    const reservation = await reserveCampaignSendAllowance({
      workspace: { type: "studio", studioId },
      campaignId: campaign.id,
      eligibleTotal: Math.max(openCount, batch.ids.length),
      batchRecipientIds: batch.ids,
      userId: userResult.user.id,
      source: "marketing_campaign_send",
      relatedTable: "marketing_campaigns",
    });

    if (!reservation.ok) {
      throw new CampaignAllowanceBlockedError(reservation.query);
    }

    const summary = emptyDeliverySummary();

    try {
      await supabase
        .from("marketing_campaigns")
        .update({ status: "sending", updated_at: new Date().toISOString() })
        .eq("id", campaign.id)
        .eq("studio_id", studioId);

      const studioName = resolveStudioDisplayName(studio);
      const studioLogoUrl = studio?.public_logo_url ?? null;
      const footerNote = buildStudioMarketingFooterNote(studio);
      const replyTo = getStudioReplyToEmail(studio, userResult.user.email);
      const subject = sanitizeEmailSubject(campaign.subject);

      await deliverCampaignBatch({
        summary,
        admin,
        transport: createResendMarketingTransport(),
        ...scope,
        recipientIds: batch.ids,
        from: fromEmail,
        replyTo,
        render: ({ unsubscribeUrl }) => {
          const emailParams: CampaignEmailParams = {
            studioName,
            studioLogoUrl,
            subject,
            previewText: campaign.preview_text,
            bodyText: campaign.body_text,
            ctaLabel: campaign.cta_label,
            ctaUrl: campaign.cta_url,
            footerNote,
            unsubscribeUrl,
          };
          return {
            subject,
            html: buildCampaignEmailHtml(emailParams),
            text: buildCampaignEmailText(emailParams),
          };
        },
      });
    } finally {
      // Accepted recipients become usage and the commitment shrinks to what is still owed an attempt (also on an
      // unexpected throw). If settling fails the capacity stays held and the batch is reconciled later: a successful
      // send is never left uncounted. The campaign status is always restored, so a failed batch cannot leave it stuck.
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
        .from("marketing_campaigns")
        .update(
          openAfter === 0
            ? { status: "sent", sent_at: nowIso, updated_at: nowIso }
            : { status: "draft", updated_at: nowIso },
        )
        .eq("id", campaign.id)
        .eq("studio_id", studioId);
    }

    if (summary.stoppedReason) {
      throw new CampaignActionError(summary.stoppedReason === "marketing_paused" ? "marketing_paused" : "send_paused_provider");
    }
  } catch (error) {
    // A redirect thrown inside the try (campaign_locked, campaign_already_sent, ...) is the intended response.
    if (isRedirectError(error)) throw error;
    if (error instanceof CampaignAllowanceBlockedError) {
      // Nothing was sent. Redirect from the catch (not the try body) so the structured limit result reaches the page.
      let blockedUrl = fallback;
      for (const [key, value] of Object.entries(error.query)) {
        blockedUrl = appendQueryParam(blockedUrl, key, String(value));
      }
      redirect(blockedUrl);
    }
    if (error instanceof CampaignActionError) {
      redirect(appendQueryParam(fallback, "campaign_error", error.code));
    }
    if (error instanceof MarketingComplianceError) {
      console.error("sendMarketingCampaignAction stopped (compliance)", error.code);
      redirect(appendQueryParam(fallback, "campaign_error", "eligibility_check_failed"));
    }
    console.error("sendMarketingCampaignAction failed", error);
    redirect(appendQueryParam(fallback, "campaign_error", "send_failed"));
  }

  redirect(appendQueryParam(fallback, "campaign_sent", "1"));
}
