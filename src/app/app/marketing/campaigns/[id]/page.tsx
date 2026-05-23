import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  generateMarketingCampaignRecipientsAction,
  sendMarketingCampaignAction,
  sendMarketingCampaignTestEmailAction,
} from "../actions";

type Params = Promise<{
  id: string;
}>;

type SearchParams = Promise<{
  test_sent?: string;
  campaign_sent?: string;
  recipients_generated?: string;
  campaign_error?: string;
}>;

type CampaignRow = {
  id: string;
  studio_id: string;
  name: string;
  subject: string;
  preview_text: string | null;
  body_text: string | null;
  cta_label: string | null;
  cta_url: string | null;
  audience_type: string;
  audience_event_id: string | null;
  status: string;
  created_at: string;
  sent_at: string | null;
};

type StudioMarketingFooterRow = {
  name: string | null;
  email: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
};

type RecipientPreview = {
  email: string;
  name: string;
  source: string;
  unsubscribed: boolean;
};

type RecipientRow = {
  id: string;
  email: string;
  name: string | null;
  status: string;
  error_message: string | null;
  sent_at: string | null;
  created_at: string;
};

const audienceLabels: Record<string, string> = {
  manual: "Manual audience",
  all_active_clients: "All active clients",
  new_leads: "New leads",
  inactive_clients: "Inactive clients",
  event_attendees: "All event registrants",
  specific_event_registrants: "Specific event registrants",
  specific_event_checked_in: "Specific event checked-in attendees",
  clients_no_upcoming_lesson: "Clients with no upcoming lesson",
  low_package_credits: "Clients with low package credits",
};

function formatDate(value: string | null) {
  if (!value) {
    return "Not sent";
  }

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function campaignErrorMessage(code?: string) {
  switch (code) {
    case "missing_resend_key":
      return "Resend is not configured yet. Add RESEND_API_KEY to the environment.";
    case "missing_from_email":
      return "Marketing sender is not configured yet. Add MARKETING_FROM_EMAIL to the environment.";
    case "missing_marketing_footer":
      return "Add the studio marketing footer address in Settings before sending live campaigns.";
    case "not_found":
      return "Campaign could not be found.";
    case "missing_content":
      return "Campaign needs a subject and message before sending.";
    case "test_send_failed":
      return "Test email could not be sent. Check Resend settings and sender verification.";
    case "recipient_generate_failed":
      return "Recipients could not be generated. Check the campaign audience and try again.";
    case "campaign_locked":
      return "This campaign is currently locked because it has already sent or is sending.";
    case "no_pending_recipients":
      return "There are no pending recipients to send. Prepare the send list first.";
    case "send_not_confirmed":
      return "Please confirm the send summary before sending this campaign.";
    case "campaign_already_sent":
      return "This campaign has already been sent.";
    case "send_failed":
      return "Campaign sending could not be completed. Check recipient statuses for details.";
    default:
      return null;
  }
}

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function buildName(firstName: unknown, lastName: unknown) {
  return `${String(firstName ?? "").trim()} ${String(lastName ?? "").trim()}`.trim();
}

function isSpecificEventAudience(audienceType: string) {
  return audienceType === "specific_event_registrants" || audienceType === "specific_event_checked_in";
}

function cleanFooterPart(value: unknown) {
  return String(value ?? "").trim();
}

function hasMarketingFooterAddress(studio: StudioMarketingFooterRow | null | undefined) {
  return Boolean(
    cleanFooterPart(studio?.name) &&
      cleanFooterPart(studio?.address_line_1) &&
      cleanFooterPart(studio?.city) &&
      cleanFooterPart(studio?.state) &&
      cleanFooterPart(studio?.postal_code) &&
      cleanFooterPart(studio?.country),
  );
}

function formatMarketingFooterAddress(studio: StudioMarketingFooterRow | null | undefined) {
  const lineOne = cleanFooterPart(studio?.address_line_1);
  const lineTwo = cleanFooterPart(studio?.address_line_2);
  const cityStateZip = [
    cleanFooterPart(studio?.city),
    cleanFooterPart(studio?.state),
    cleanFooterPart(studio?.postal_code),
  ]
    .filter(Boolean)
    .join(", ");

  return [lineOne, lineTwo, cityStateZip, cleanFooterPart(studio?.country)].filter(Boolean).join(" · ");
}

function countByStatus(recipients: RecipientRow[]) {
  return recipients.reduce(
    (totals, recipient) => {
      const status = String(recipient.status ?? "pending").toLowerCase();

      if (status === "sent") {
        totals.sent += 1;
      } else if (status === "failed") {
        totals.failed += 1;
      } else if (status === "unsubscribed") {
        totals.unsubscribed += 1;
      } else if (status === "skipped") {
        totals.skipped += 1;
      } else {
        totals.pending += 1;
      }

      return totals;
    },
    { pending: 0, sent: 0, failed: 0, skipped: 0, unsubscribed: 0 },
  );
}

function campaignStatusLabel(status: string) {
  switch (String(status ?? "draft").toLowerCase()) {
    case "sending":
      return "Sending";
    case "sent":
      return "Sent";
    case "failed":
      return "Failed";
    default:
      return "Draft";
  }
}

function campaignStatusClass(status: string) {
  switch (String(status ?? "draft").toLowerCase()) {
    case "sending":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "sent":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "failed":
      return "border-red-200 bg-red-50 text-red-700";
    default:
      return "border-[var(--brand-border)] bg-[var(--brand-soft-bg)] text-[var(--brand-muted)]";
  }
}

async function getUnsubscribedEmails(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
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

  return new Set((data ?? []).map((row) => normalizeEmail(row.email)).filter(Boolean));
}

async function getClientRecipients(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  audienceType: string;
  unsubscribedEmails: Set<string>;
}) {
  const { supabase, studioId, audienceType, unsubscribedEmails } = params;
  const baseClientSelect = "id, first_name, last_name, email, status";

  if (audienceType === "clients_no_upcoming_lesson") {
    const [{ data: clients, error: clientsError }, { data: appointments, error: appointmentsError }] =
      await Promise.all([
        supabase
          .from("clients")
          .select(baseClientSelect)
          .eq("studio_id", studioId)
          .eq("status", "active")
          .not("email", "is", null)
          .limit(1500),
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
      console.error("Failed to load low-credit package audience", packagesError);
      return [];
    }

    const lowCreditClientIds = Array.from(
      new Set((packages ?? []).map((pkg) => String(pkg.client_id ?? "")).filter(Boolean)),
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
      .limit(1500);

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
    .limit(1500);

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
      email,
      name: buildName(row.first_name, row.last_name),
      source,
      unsubscribed: unsubscribedEmails.has(email),
    });
  }

  return recipients;
}

async function getEventRecipients(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
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
      .select("id, attendee_first_name, attendee_last_name, attendee_email, status, event_id")
      .eq("studio_id", studioId)
      .eq("event_id", audienceEventId)
      .not("attendee_email", "is", null)
      .limit(1500);

    if (registrationsError) {
      console.error("Failed to load specific event campaign registrations", registrationsError);
      return [];
    }

    const activeRegistrations = (registrations ?? []).filter(
      (registration) => String(registration.status ?? "").toLowerCase() !== "cancelled",
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
        .limit(1500);

      if (attendeesError) {
        console.error("Failed to load specific event campaign attendees", attendeesError);
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
    .select("attendee_first_name, attendee_last_name, attendee_email, status")
    .eq("studio_id", studioId)
    .not("attendee_email", "is", null)
    .limit(1500);

  if (error) {
    console.error("Failed to load event campaign audience", error);
    return [];
  }

  for (const row of data ?? []) {
    if (String(row.status ?? "").toLowerCase() === "cancelled") {
      continue;
    }

    addRecipient({
      first_name: row.attendee_first_name,
      last_name: row.attendee_last_name,
      email: row.attendee_email,
      source: "Event registration",
    });
  }

  return recipients;
}

async function getRecipientPreview(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  audienceType: string;
  audienceEventId?: string | null;
}) {
  const { supabase, studioId, audienceType, audienceEventId } = params;
  const unsubscribedEmails = await getUnsubscribedEmails({ supabase, studioId });

  if (audienceType === "event_attendees" || isSpecificEventAudience(audienceType)) {
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

  return getClientRecipients({ supabase, studioId, audienceType, unsubscribedEmails });
}

export default async function MarketingCampaignDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const resolvedParams = await params;
  const resolvedSearchParams = await searchParams;
  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const { data: userResult } = await supabase.auth.getUser();
  const currentUserEmail = userResult.user?.email ?? "";

  const [{ data: campaign, error }, { data: generatedRecipients }, { data: studioFooter }] = await Promise.all([
    supabase
      .from("marketing_campaigns")
      .select("id, studio_id, name, subject, preview_text, body_text, cta_label, cta_url, audience_type, audience_event_id, status, created_at, sent_at")
      .eq("id", resolvedParams.id)
      .eq("studio_id", studioId)
      .maybeSingle<CampaignRow>(),
    supabase
      .from("marketing_campaign_recipients")
      .select("id, email, name, status, error_message, sent_at, created_at")
      .eq("campaign_id", resolvedParams.id)
      .eq("studio_id", studioId)
      .order("created_at", { ascending: true })
      .limit(25),
    supabase
      .from("studios")
      .select("name, email, address_line_1, address_line_2, city, state, postal_code, country")
      .eq("id", studioId)
      .maybeSingle<StudioMarketingFooterRow>(),
  ]);

  if (error || !campaign) {
    notFound();
  }

  const [
    { count: pendingRecipientCount },
    { count: sentRecipientCount },
    { count: failedRecipientCount },
    { count: unsubscribedRecipientCount },
    { count: skippedRecipientCount },
  ] = await Promise.all([
    supabase
      .from("marketing_campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", resolvedParams.id)
      .eq("studio_id", studioId)
      .eq("status", "pending"),
    supabase
      .from("marketing_campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", resolvedParams.id)
      .eq("studio_id", studioId)
      .eq("status", "sent"),
    supabase
      .from("marketing_campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", resolvedParams.id)
      .eq("studio_id", studioId)
      .eq("status", "failed"),
    supabase
      .from("marketing_campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", resolvedParams.id)
      .eq("studio_id", studioId)
      .eq("status", "unsubscribed"),
    supabase
      .from("marketing_campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", resolvedParams.id)
      .eq("studio_id", studioId)
      .eq("status", "skipped"),
  ]);

  const { data: selectedEvent } = campaign.audience_event_id
    ? await supabase
        .from("events")
        .select("id, name, start_date")
        .eq("id", campaign.audience_event_id)
        .eq("studio_id", studioId)
        .maybeSingle()
    : { data: null };

  const recipients = await getRecipientPreview({
    supabase,
    studioId,
    audienceType: campaign.audience_type,
    audienceEventId: campaign.audience_event_id,
  });

  const includedRecipients = recipients.filter((recipient) => !recipient.unsubscribed);
  const suppressedRecipients = recipients.filter((recipient) => recipient.unsubscribed);
  const sampleRecipients = recipients.slice(0, 5);
  const remainingRecipientCount = Math.max(recipients.length - sampleRecipients.length, 0);
  const recipientRows = (generatedRecipients ?? []) as RecipientRow[];
  const recipientStatusCounts = {
    pending: pendingRecipientCount ?? 0,
    sent: sentRecipientCount ?? 0,
    failed: failedRecipientCount ?? 0,
    unsubscribed: unsubscribedRecipientCount ?? 0,
    skipped: skippedRecipientCount ?? 0,
  };
  const totalPreparedRecipients =
    recipientStatusCounts.pending +
    recipientStatusCounts.sent +
    recipientStatusCounts.failed +
    recipientStatusCounts.unsubscribed +
    recipientStatusCounts.skipped;
  const generatedRecipientSample = recipientRows.slice(0, 5);
  const hasGeneratedRecipients = totalPreparedRecipients > 0;
  const resultStatusCards = [
    {
      label: "Sent",
      value: recipientStatusCounts.sent,
      className: "border-emerald-200 bg-emerald-50 text-emerald-800",
    },
    {
      label: "Failed",
      value: recipientStatusCounts.failed,
      className: "border-red-200 bg-red-50 text-red-700",
    },
    {
      label: "Pending",
      value: recipientStatusCounts.pending,
      className: "border-amber-200 bg-amber-50 text-amber-800",
    },
    {
      label: "Suppressed",
      value: recipientStatusCounts.unsubscribed + recipientStatusCounts.skipped,
      className: "border-slate-200 bg-slate-50 text-slate-700",
    },
  ];
  const recipientDetailGroups = [
    {
      label: "Sent recipients",
      count: recipientStatusCounts.sent,
      recipients: recipientRows.filter((recipient) => String(recipient.status ?? "").toLowerCase() === "sent").slice(0, 5),
    },
    {
      label: "Failed recipients",
      count: recipientStatusCounts.failed,
      recipients: recipientRows.filter((recipient) => String(recipient.status ?? "").toLowerCase() === "failed").slice(0, 5),
    },
    {
      label: "Pending recipients",
      count: recipientStatusCounts.pending,
      recipients: recipientRows.filter((recipient) => String(recipient.status ?? "pending").toLowerCase() === "pending").slice(0, 5),
    },
    {
      label: "Suppressed / skipped recipients",
      count: recipientStatusCounts.unsubscribed + recipientStatusCounts.skipped,
      recipients: recipientRows
        .filter((recipient) => {
          const status = String(recipient.status ?? "").toLowerCase();
          return status === "unsubscribed" || status === "skipped";
        })
        .slice(0, 5),
    },
  ];
  const hasMarketingFooter = hasMarketingFooterAddress(studioFooter);
  const marketingFooterAddress = formatMarketingFooterAddress(studioFooter);
  const canSendCampaign =
    hasMarketingFooter &&
    hasGeneratedRecipients &&
    recipientStatusCounts.pending > 0 &&
    campaign.status !== "sent" &&
    campaign.status !== "sending";
  const campaignError = campaignErrorMessage(resolvedSearchParams.campaign_error);

  return (
    <main className="min-h-screen bg-[var(--brand-page-bg)] px-4 py-6 text-[var(--brand-text)] sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        {resolvedSearchParams.test_sent ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 shadow-sm">
            Test email sent.
          </div>
        ) : null}

        {resolvedSearchParams.recipients_generated ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 shadow-sm">
            Send list prepared. Review the send readiness summary before sending.
          </div>
        ) : null}

        {resolvedSearchParams.campaign_sent ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 shadow-sm">
            Campaign sending finished. Check the recipient status summary for any failed emails.
          </div>
        ) : null}

        {campaignError ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 shadow-sm">
            {campaignError}
          </div>
        ) : null}

        <section className="overflow-hidden rounded-3xl border border-[var(--brand-border)] bg-white shadow-sm">
          <div className="bg-gradient-to-r from-[#241432] via-[#4D1F47] to-[#E85D2A] px-6 py-7 text-white sm:px-8">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/75">
              DanceFlow Marketing
            </p>
            <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
                  {campaign.name}
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-white/85 sm:text-base">
                  Review the message, verify the audience, send a test, and send the campaign when ready.
                </p>
              </div>

              <Link
                href="/app/marketing/campaigns"
                className="inline-flex items-center justify-center rounded-2xl border border-white/25 bg-white/10 px-4 py-2 text-sm font-semibold text-white shadow-sm backdrop-blur transition hover:bg-white/20"
              >
                Back to Campaigns
              </Link>
            </div>
          </div>

          <div className="grid gap-4 p-5 sm:p-6 lg:grid-cols-4">
            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-4">
              <p className="text-sm font-semibold text-[var(--brand-muted)]">Status</p>
              <span className={`mt-2 inline-flex rounded-full border px-3 py-1 text-xs font-bold ${campaignStatusClass(campaign.status)}`}>
                {campaignStatusLabel(campaign.status)}
              </span>
            </div>
            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-4">
              <p className="text-sm font-semibold text-[var(--brand-muted)]">Audience</p>
              <p className="mt-2 text-lg font-bold text-[var(--brand-text)]">
                {audienceLabels[campaign.audience_type] ?? campaign.audience_type}
              </p>
              {selectedEvent ? (
                <p className="mt-1 text-xs leading-5 text-[var(--brand-muted)]">
                  {selectedEvent.name}{selectedEvent.start_date ? ` · ${formatDate(selectedEvent.start_date)}` : ""}
                </p>
              ) : null}
            </div>
            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-4">
              <p className="text-sm font-semibold text-[var(--brand-muted)]">Ready to send</p>
              <p className="mt-2 text-lg font-bold text-[var(--brand-text)]">{includedRecipients.length}</p>
            </div>
            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-4">
              <p className="text-sm font-semibold text-[var(--brand-muted)]">Suppressed</p>
              <p className="mt-2 text-lg font-bold text-[var(--brand-text)]">{suppressedRecipients.length}</p>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
          <div className="flex flex-col gap-6">
            <section className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm sm:p-6">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-xl font-bold text-[var(--brand-text)]">Message preview</h2>
                <p className="mt-1 text-sm text-[var(--brand-muted)]">Created {formatDate(campaign.created_at)} · Sent {formatDate(campaign.sent_at)}</p>
              </div>
              <span className={`inline-flex w-fit rounded-full border px-3 py-1 text-xs font-bold ${campaignStatusClass(campaign.status)}`}>
                {campaignStatusLabel(campaign.status)}
              </span>
            </div>

            <div className="mt-5 rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--brand-muted)]">Subject</p>
              <p className="mt-2 text-lg font-bold text-[var(--brand-text)]">{campaign.subject}</p>
              {campaign.preview_text ? (
                <p className="mt-1 text-sm text-[var(--brand-muted)]">{campaign.preview_text}</p>
              ) : null}
            </div>

            <div className="mt-4 whitespace-pre-wrap rounded-2xl border border-[var(--brand-border)] bg-white p-4 text-sm leading-6 text-[var(--brand-text)]">
              {campaign.body_text}
            </div>

            {campaign.cta_label && campaign.cta_url ? (
              <div className="mt-4 rounded-2xl border border-[var(--brand-border)] bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--brand-muted)]">CTA</p>
                <a
                  href={campaign.cta_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center justify-center rounded-2xl bg-[#4D1F47] px-4 py-2 text-sm font-bold text-white transition hover:bg-[#3D1839]"
                >
                  {campaign.cta_label}
                </a>
              </div>
            ) : null}
            </section>

            <section className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm sm:p-6">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-xl font-bold text-[var(--brand-text)]">Campaign results</h2>
                  <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                    Track delivery status after the send list is prepared and the campaign is sent.
                  </p>
                </div>
                <span className={`inline-flex w-fit rounded-full border px-3 py-1 text-xs font-bold ${campaignStatusClass(campaign.status)}`}>
                  {campaignStatusLabel(campaign.status)}
                </span>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {resultStatusCards.map((card) => (
                  <div key={card.label} className={`rounded-2xl border p-3 text-center ${card.className}`}>
                    <p className="text-xl font-bold">{card.value}</p>
                    <p className="text-[11px] font-semibold uppercase tracking-wide">{card.label}</p>
                  </div>
                ))}
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--brand-muted)]">
                    Prepared recipients
                  </p>
                  <p className="mt-1 text-lg font-bold text-[var(--brand-text)]">{totalPreparedRecipients}</p>
                </div>
                <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--brand-muted)]">
                    Sent date
                  </p>
                  <p className="mt-1 text-lg font-bold text-[var(--brand-text)]">{formatDate(campaign.sent_at)}</p>
                </div>
              </div>

              <details className="mt-4 rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-4">
                <summary className="cursor-pointer text-sm font-bold text-[var(--brand-text)]">
                  Show recipient status details
                </summary>

                <div className="mt-4 space-y-3">
                  {recipientDetailGroups.map((group) => (
                    <details key={group.label} className="rounded-2xl border border-[var(--brand-border)] bg-white p-3">
                      <summary className="cursor-pointer text-sm font-bold text-[var(--brand-text)]">
                        {group.label} · {group.count}
                      </summary>

                      <div className="mt-3 space-y-2">
                        {group.recipients.length > 0 ? (
                          group.recipients.map((recipient) => (
                            <div
                              key={recipient.id}
                              className="rounded-xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-3"
                            >
                              <p className="truncate text-sm font-semibold text-[var(--brand-text)]">
                                {recipient.name || recipient.email}
                              </p>
                              <p className="truncate text-xs text-[var(--brand-muted)]">{recipient.email}</p>
                              {recipient.sent_at ? (
                                <p className="mt-1 text-xs text-[var(--brand-muted)]">Sent {formatDate(recipient.sent_at)}</p>
                              ) : null}
                              {recipient.error_message ? (
                                <p className="mt-1 text-xs text-red-700">{recipient.error_message}</p>
                              ) : null}
                            </div>
                          ))
                        ) : (
                          <p className="rounded-xl border border-dashed border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-3 text-xs text-[var(--brand-muted)]">
                            No sample recipients to show in this status.
                          </p>
                        )}

                        {group.count > group.recipients.length ? (
                          <p className="text-xs text-[var(--brand-muted)]">
                            Showing up to 5 sample recipients for this status to keep the page compact on mobile.
                          </p>
                        ) : null}
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            </section>
          </div>

          <aside className="flex flex-col gap-6">
            <section className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm sm:p-6">
              <h2 className="text-lg font-bold text-[var(--brand-text)]">Send test email</h2>
              <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                Send a test to yourself or another studio staff email before sending to the audience.
              </p>

              <form action={sendMarketingCampaignTestEmailAction} className="mt-4 space-y-4">
                <input type="hidden" name="campaignId" value={campaign.id} />
                <div>
                  <label htmlFor="testEmail" className="text-sm font-semibold text-[var(--brand-text)]">
                    Test recipient
                  </label>
                  <input
                    id="testEmail"
                    name="testEmail"
                    type="email"
                    defaultValue={currentUserEmail}
                    className="mt-2 w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
                    placeholder="owner@example.com"
                  />
                </div>
                <button
                  type="submit"
                  className="inline-flex w-full items-center justify-center rounded-2xl bg-[#4D1F47] px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-[#3D1839]"
                >
                  Send Test Email
                </button>
              </form>
            </section>

            <section className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm sm:p-6">
              <h2 className="text-lg font-bold text-[var(--brand-text)]">Audience check</h2>
              <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                Review the audience summary without loading a long contact ledger. Suppressed contacts are excluded before sending.
              </p>

              <div className="mt-4 grid grid-cols-3 gap-2">
                <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-3 text-center">
                  <p className="text-lg font-bold text-[var(--brand-text)]">{recipients.length}</p>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--brand-muted)]">Found</p>
                </div>
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-center">
                  <p className="text-lg font-bold text-emerald-800">{includedRecipients.length}</p>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">Ready</p>
                </div>
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-center">
                  <p className="text-lg font-bold text-amber-800">{suppressedRecipients.length}</p>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Suppressed</p>
                </div>
              </div>

              <details className="mt-4 rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-4">
                <summary className="cursor-pointer text-sm font-bold text-[var(--brand-text)]">
                  Show sample recipients
                </summary>

                <div className="mt-4 space-y-3">
                  {sampleRecipients.length > 0 ? (
                    sampleRecipients.map((recipient) => (
                      <div
                        key={recipient.email}
                        className="rounded-2xl border border-[var(--brand-border)] bg-white p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-[var(--brand-text)]">
                              {recipient.name || recipient.email}
                            </p>
                            <p className="truncate text-xs text-[var(--brand-muted)]">{recipient.email}</p>
                            <p className="mt-1 text-xs text-[var(--brand-muted)]">{recipient.source}</p>
                          </div>
                          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${recipient.unsubscribed ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>
                            {recipient.unsubscribed ? "Suppressed" : "Ready"}
                          </span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-2xl border border-dashed border-[var(--brand-border)] bg-white p-4 text-sm text-[var(--brand-muted)]">
                      No recipients found for this audience yet.
                    </div>
                  )}

                  {remainingRecipientCount > 0 ? (
                    <p className="rounded-2xl border border-dashed border-[var(--brand-border)] bg-white px-3 py-2 text-xs text-[var(--brand-muted)]">
                      Showing 5 sample recipients. {remainingRecipientCount} more are included in the audience summary but hidden to keep this page usable on mobile.
                    </p>
                  ) : null}
                </div>
              </details>
            </section>

            <section className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm sm:p-6">
              <h2 className="text-lg font-bold text-[var(--brand-text)]">Prepare send list</h2>
              <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                Lock in the current audience for this campaign. Unsubscribed contacts are kept out of the pending send queue.
              </p>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-3 text-center">
                  <p className="text-lg font-bold text-[var(--brand-text)]">{totalPreparedRecipients}</p>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--brand-muted)]">Prepared</p>
                </div>
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-center">
                  <p className="text-lg font-bold text-emerald-800">{recipientStatusCounts.pending}</p>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">Pending</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-center">
                  <p className="text-lg font-bold text-slate-800">{recipientStatusCounts.sent}</p>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-700">Sent</p>
                </div>
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-center">
                  <p className="text-lg font-bold text-amber-800">{recipientStatusCounts.unsubscribed + recipientStatusCounts.skipped + recipientStatusCounts.failed}</p>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Other</p>
                </div>
              </div>

              <form action={generateMarketingCampaignRecipientsAction} className="mt-4">
                <input type="hidden" name="campaignId" value={campaign.id} />
                <button
                  type="submit"
                  disabled={campaign.status === "sent" || campaign.status === "sending"}
                  className="inline-flex w-full items-center justify-center rounded-2xl border border-[var(--brand-border)] bg-white px-5 py-3 text-sm font-bold text-[var(--brand-text)] shadow-sm transition hover:bg-[var(--brand-soft-bg)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {hasGeneratedRecipients ? "Refresh Send List" : "Prepare Send List"}
                </button>
              </form>

              <details className="mt-4 rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-4">
                <summary className="cursor-pointer text-sm font-bold text-[var(--brand-text)]">
                  Show send list sample
                </summary>

                <div className="mt-4 space-y-3">
                  {generatedRecipientSample.length > 0 ? (
                    generatedRecipientSample.map((recipient) => (
                      <div
                        key={recipient.id}
                        className="rounded-2xl border border-[var(--brand-border)] bg-white p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-[var(--brand-text)]">
                              {recipient.name || recipient.email}
                            </p>
                            <p className="truncate text-xs text-[var(--brand-muted)]">{recipient.email}</p>
                            {recipient.error_message ? (
                              <p className="mt-1 text-xs text-red-700">{recipient.error_message}</p>
                            ) : null}
                          </div>
                          <span className="shrink-0 rounded-full bg-[var(--brand-soft-bg)] px-2.5 py-1 text-xs font-bold capitalize text-[var(--brand-muted)]">
                            {recipient.status}
                          </span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-2xl border border-dashed border-[var(--brand-border)] bg-white p-4 text-sm text-[var(--brand-muted)]">
                      No send list has been prepared yet.
                    </div>
                  )}
                </div>
              </details>
            </section>

            <section className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm sm:p-6">
              <h2 className="text-lg font-bold text-[var(--brand-text)]">Send campaign</h2>
              <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                Send only after the test email looks right. DanceFlow excludes unsubscribed contacts and includes an unsubscribe link in every live marketing email.
              </p>

              <div className="mt-4 rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--brand-muted)]">Send summary</p>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-xl bg-white p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--brand-muted)]">Campaign</p>
                    <p className="mt-1 truncate font-bold text-[var(--brand-text)]">{campaign.name}</p>
                  </div>
                  <div className="rounded-xl bg-white p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--brand-muted)]">Audience</p>
                    <p className="mt-1 truncate font-bold text-[var(--brand-text)]">
                      {audienceLabels[campaign.audience_type] ?? campaign.audience_type}
                    </p>
                    {selectedEvent ? (
                      <p className="mt-1 truncate text-xs text-[var(--brand-muted)]">{selectedEvent.name}</p>
                    ) : null}
                  </div>
                  <div className="rounded-xl bg-white p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--brand-muted)]">Pending send</p>
                    <p className="mt-1 font-bold text-[var(--brand-text)]">{recipientStatusCounts.pending}</p>
                  </div>
                  <div className="rounded-xl bg-white p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--brand-muted)]">Suppressed/skipped</p>
                    <p className="mt-1 font-bold text-[var(--brand-text)]">
                      {recipientStatusCounts.unsubscribed + recipientStatusCounts.skipped}
                    </p>
                  </div>
                </div>
                <div className="mt-3 rounded-xl bg-white p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--brand-muted)]">Subject</p>
                  <p className="mt-1 text-sm font-bold text-[var(--brand-text)]">{campaign.subject}</p>
                </div>
                <div className={`mt-3 rounded-xl border p-3 text-xs leading-5 ${hasMarketingFooter ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
                  <p className="font-bold">Marketing email footer</p>
                  {hasMarketingFooter ? (
                    <p className="mt-1">{studioFooter?.name} · {marketingFooterAddress}</p>
                  ) : (
                    <p className="mt-1">Missing. Add the studio mailing address in Settings before live campaign sending.</p>
                  )}
                </div>
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                  <p className="font-bold">Marketing permission reminder</p>
                  <p className="mt-1">
                    DanceFlow will suppress unsubscribed contacts, but each studio is responsible for sending campaigns only to contacts it is allowed to email.
                  </p>
                </div>
              </div>

              <form action={sendMarketingCampaignAction} className="mt-4 space-y-4">
                <input type="hidden" name="campaignId" value={campaign.id} />

                <label className={`flex gap-3 rounded-2xl border p-4 text-sm leading-6 ${canSendCampaign ? "border-amber-200 bg-amber-50 text-amber-900" : "border-[var(--brand-border)] bg-[var(--brand-soft-bg)] text-[var(--brand-muted)]"}`}>
                  <input
                    type="checkbox"
                    name="confirmSend"
                    value="yes"
                    disabled={!canSendCampaign}
                    required
                    className="mt-1 h-4 w-4 rounded border-amber-300"
                  />
                  <span>
                    I confirm this campaign is being sent to contacts this studio is allowed to email, and I understand DanceFlow will include an unsubscribe link. This will send to {recipientStatusCounts.pending} pending recipient{recipientStatusCounts.pending === 1 ? "" : "s"}.
                  </span>
                </label>

                <button
                  type="submit"
                  disabled={!canSendCampaign}
                  className="inline-flex w-full items-center justify-center rounded-2xl bg-[#4D1F47] px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-[#3D1839] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {campaign.status === "sent"
                    ? "Campaign Sent"
                    : canSendCampaign
                      ? `Send to ${recipientStatusCounts.pending} Recipient${recipientStatusCounts.pending === 1 ? "" : "s"}`
                      : !hasMarketingFooter
                        ? "Add Marketing Footer First"
                        : "Prepare Send List First"}
                </button>
              </form>

              <p className="mt-3 text-xs leading-5 text-[var(--brand-muted)]">
                This sends the prepared pending list now. Test the email, review the send summary, and confirm the studio has permission to email this audience before sending.
              </p>
            </section>
          </aside>
        </section>
      </div>
    </main>
  );
}

