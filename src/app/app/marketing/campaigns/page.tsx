import Link from "next/link";
import { ArrowRight, CheckCircle2, Link2, Mail, Megaphone, Sparkles, Users, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { requireStudioFeature } from "@/lib/billing/access";
import { createMarketingCampaignDraftAction } from "./actions";
import CampaignAIAssistant from "./CampaignAIAssistant";
import MarketingCampaignList from "./MarketingCampaignList";

type SearchParams = Promise<{
  campaign_saved?: string;
  campaign_error?: string;
  template?: string;
}>;

export type CampaignRow = {
  id: string;
  name: string;
  subject: string;
  preview_text: string | null;
  audience_type: string;
  audience_event_id: string | null;
  status: string;
  created_at: string;
  sent_at: string | null;
};

type AudiencePreview = {
  key: string;
  label: string;
  description: string;
  count: number;
  sample: string[];
};

type EventOption = {
  id: string;
  name: string;
  start_date: string | null;
};

const audienceOptions = [
  {
    key: "all_active_clients",
    label: "All active clients",
    description: "Clients marked active who have an email address.",
  },
  {
    key: "new_leads",
    label: "New leads",
    description: "Client records currently marked as leads.",
  },
  {
    key: "inactive_clients",
    label: "Inactive clients",
    description:
      "Clients marked inactive who may need a re-engagement message.",
  },
  {
    key: "event_attendees",
    label: "All event registrants",
    description:
      "People who registered for any event and have an email address.",
  },
  {
    key: "specific_event_registrants",
    label: "Specific event registrants",
    description: "People registered for the event selected in the Event field.",
  },
  {
    key: "specific_event_checked_in",
    label: "Specific event checked-in attendees",
    description: "People checked in for the event selected in the Event field.",
  },
  {
    key: "clients_no_upcoming_lesson",
    label: "Clients with no upcoming lesson",
    description:
      "Active clients who do not currently have a future lesson scheduled.",
  },
  {
    key: "low_package_credits",
    label: "Clients with low package credits",
    description:
      "Clients with an active package that has 2 or fewer credits remaining.",
  },
];

const campaignTemplates = [
  {
    key: "new-lead-follow-up",
    label: "New Lead Follow-Up",
    description: "A warm first-touch message for people who showed interest.",
    audienceType: "new_leads",
    name: "New lead follow-up",
    subject: "Thanks for reaching out about dance lessons",
    previewText: "We would love to help you take the next step.",
    bodyText:
      "Hi,\n\nThanks for your interest in dance lessons. We would love to help you find the right next step, whether you are brand new, returning to dance, or getting ready for an event.\n\nReply to this email or use the button below to get started. We are happy to answer questions and help you find a lesson or class that fits your goals.",
    ctaLabel: "Get started",
  },
  {
    key: "no-upcoming-lesson",
    label: "No Upcoming Lesson",
    description: "Encourage active clients to get their next lesson scheduled.",
    audienceType: "clients_no_upcoming_lesson",
    name: "No upcoming lesson reminder",
    subject: "Ready to schedule your next lesson?",
    previewText: "Let’s keep your progress moving.",
    bodyText:
      "Hi,\n\nWe noticed you do not currently have an upcoming lesson scheduled. This is a great time to get your next session on the calendar and keep your dancing moving forward.\n\nUse the button below or reply to this email and we will help you find a time that works.",
    ctaLabel: "Schedule a lesson",
  },
  {
    key: "low-package-credits",
    label: "Low Package Credits",
    description: "Remind students before they run out of lesson credits.",
    audienceType: "low_package_credits",
    name: "Low package credits reminder",
    subject: "Your lesson package is almost used",
    previewText: "A quick reminder before your credits run low.",
    bodyText:
      "Hi,\n\nYour current lesson package is getting close to being used. Renewing early helps you keep your preferred lesson times and continue progressing without interruption.\n\nReply to this email or use the button below if you would like help with your next package.",
    ctaLabel: "Renew package",
  },
  {
    key: "event-reminder",
    label: "Event Reminder",
    description: "Send a practical reminder to people registered for an event.",
    audienceType: "specific_event_registrants",
    name: "Event reminder",
    subject: "Reminder: your upcoming dance event",
    previewText: "Here are the details to help you get ready.",
    bodyText:
      "Hi,\n\nWe are excited to see you at the upcoming event. Please review the event details, arrival time, and anything you need to bring before you arrive.\n\nUse the button below for the event page, or reply to this email with any questions.",
    ctaLabel: "View event details",
  },
  {
    key: "post-event-thank-you",
    label: "Post-Event Thank You",
    description:
      "Follow up with attendees and guide them to the next opportunity.",
    audienceType: "specific_event_checked_in",
    name: "Post-event thank you",
    subject: "Thank you for joining us",
    previewText: "We loved having you at the event.",
    bodyText:
      "Hi,\n\nThank you for joining us. We loved having you at the event and hope you had a great experience.\n\nIf you would like to keep learning, join us again, or schedule a lesson, use the button below or reply to this email. We would be happy to help with your next step.",
    ctaLabel: "See what is next",
  },
  {
    key: "studio-announcement",
    label: "Studio Announcement",
    description:
      "A flexible update for news, schedule changes, or general messages.",
    audienceType: "all_active_clients",
    name: "Studio announcement",
    subject: "A quick update from the studio",
    previewText: "Here is what is happening at the studio.",
    bodyText:
      "Hi,\n\nWe wanted to share a quick update from the studio. Please read the details below and let us know if you have any questions.\n\nWe appreciate being part of your dance journey.",
    ctaLabel: "Learn more",
  },
];

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
    case "missing_name":
      return "Campaign name is required.";
    case "invalid_audience":
      return "Choose a valid audience.";
    case "missing_event":
      return "Choose an event for this event-based audience.";
    case "invalid_event":
      return "The selected event could not be found for this studio.";
    case "missing_subject":
      return "Subject line is required.";
    case "missing_body":
      return "Message body is required.";
    case "save_failed":
      return "Campaign draft could not be saved. Confirm the marketing tables and RLS policies are in place.";
    default:
      return null;
  }
}

function isSpecificEventAudience(audienceType: string) {
  return (
    audienceType === "specific_event_registrants" ||
    audienceType === "specific_event_checked_in"
  );
}

async function getClientAudiencePreview(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  audienceType: string;
}) {
  const { supabase, studioId, audienceType } = params;
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
        .limit(1000),
      supabase
        .from("appointments")
        .select("client_id")
        .eq("studio_id", studioId)
        .eq("status", "scheduled")
        .gte("starts_at", new Date().toISOString())
        .not("client_id", "is", null)
        .limit(5000),
    ]);

    if (clientsError || appointmentsError) {
      console.error("No-upcoming-lesson audience preview failed", {
        clientsError,
        appointmentsError,
      });
      return { count: 0, sample: [] };
    }

    const clientsWithUpcomingLessons = new Set(
      (appointments ?? [])
        .map((appointment) => String(appointment.client_id ?? ""))
        .filter(Boolean),
    );

    return buildClientAudienceSummary(
      (clients ?? []).filter(
        (client) => !clientsWithUpcomingLessons.has(String(client.id)),
      ),
    );
  }

  if (audienceType === "low_package_credits") {
    const { data: packages, error: packagesError } = await supabase
      .from("client_packages")
      .select("client_id, lessons_remaining, active")
      .eq("studio_id", studioId)
      .eq("active", true)
      .lte("lessons_remaining", 2)
      .not("client_id", "is", null)
      .limit(5000);

    if (packagesError) {
      console.error("Low-credit audience preview failed", packagesError);
      return { count: 0, sample: [] };
    }

    const clientIds = Array.from(
      new Set(
        (packages ?? [])
          .map((pkg) => String(pkg.client_id ?? ""))
          .filter(Boolean),
      ),
    );

    if (clientIds.length === 0) {
      return { count: 0, sample: [] };
    }

    const { data: clients, error: clientsError } = await supabase
      .from("clients")
      .select(baseClientSelect)
      .eq("studio_id", studioId)
      .in("id", clientIds)
      .not("email", "is", null)
      .limit(1000);

    if (clientsError) {
      console.error("Low-credit client audience preview failed", clientsError);
      return { count: 0, sample: [] };
    }

    return buildClientAudienceSummary(clients ?? []);
  }

  let query = supabase
    .from("clients")
    .select(baseClientSelect)
    .eq("studio_id", studioId)
    .not("email", "is", null)
    .limit(1000);

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
    console.error(`Audience preview failed for ${audienceType}`, error);
    return { count: 0, sample: [] };
  }

  return buildClientAudienceSummary(data ?? []);
}

function buildClientAudienceSummary(
  clients: Array<{
    first_name: unknown;
    last_name: unknown;
    email: unknown;
  }>,
) {
  const uniqueEmails = new Set<string>();
  const sample: string[] = [];

  for (const row of clients) {
    const email = String(row.email ?? "")
      .trim()
      .toLowerCase();

    if (!email || uniqueEmails.has(email)) {
      continue;
    }

    uniqueEmails.add(email);

    if (sample.length < 3) {
      const name = `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();
      sample.push(name ? `${name} · ${email}` : email);
    }
  }

  return { count: uniqueEmails.size, sample };
}

async function getEventAudiencePreview(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
}) {
  const { supabase, studioId } = params;

  const { data, error } = await supabase
    .from("event_registrations")
    .select("attendee_first_name, attendee_last_name, attendee_email, status")
    .eq("studio_id", studioId)
    .not("attendee_email", "is", null)
    .limit(1000);

  if (error) {
    console.error("Event audience preview failed", error);
    return { count: 0, sample: [] };
  }

  const uniqueEmails = new Set<string>();
  const sample: string[] = [];

  for (const row of data ?? []) {
    const email = String(row.attendee_email ?? "")
      .trim()
      .toLowerCase();

    if (!email || uniqueEmails.has(email)) {
      continue;
    }

    if (String(row.status ?? "").toLowerCase() === "cancelled") {
      continue;
    }

    uniqueEmails.add(email);

    if (sample.length < 3) {
      const name = `${row.attendee_first_name ?? ""} ${
        row.attendee_last_name ?? ""
      }`.trim();
      sample.push(name ? `${name} · ${email}` : email);
    }
  }

  return { count: uniqueEmails.size, sample };
}

async function getAudiencePreviews(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
}): Promise<AudiencePreview[]> {
  const { supabase, studioId } = params;

  const previews = await Promise.all(
    audienceOptions.map(async (option) => {
      if (option.key === "event_attendees") {
        const result = await getEventAudiencePreview({ supabase, studioId });

        return {
          ...option,
          count: result.count,
          sample: result.sample,
        };
      }

      if (isSpecificEventAudience(option.key)) {
        return {
          ...option,
          count: 0,
          sample: ["Choose an event when creating the campaign."],
        };
      }

      const result = await getClientAudiencePreview({
        supabase,
        studioId,
        audienceType: option.key,
      });

      return {
        ...option,
        count: result.count,
        sample: result.sample,
      };
    }),
  );

  return previews;
}

export default async function MarketingCampaignsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const resolvedSearchParams = await searchParams;
  await requireStudioFeature("marketing_campaigns");
  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const [audiencePreviews, campaignsResult, eventsResult] = await Promise.all([
    getAudiencePreviews({ supabase, studioId }),
    supabase
      .from("marketing_campaigns")
      .select(
        "id, name, subject, preview_text, audience_type, audience_event_id, status, created_at, sent_at",
      )
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(8),
    supabase
      .from("events")
      .select("id, name, start_date")
      .eq("studio_id", studioId)
      .order("start_date", { ascending: false })
      .limit(100),
  ]);

  const campaigns = (campaignsResult.data ?? []) as CampaignRow[];
  const events = (eventsResult.data ?? []) as EventOption[];
  const campaignStatusCounts = campaigns.reduce(
    (counts, campaign) => {
      const normalized = campaign.status.trim().toLowerCase();

      if (normalized === "sent") {
        counts.sent += 1;
      } else if (normalized === "scheduled") {
        counts.scheduled += 1;
      } else if (normalized === "failed") {
        counts.failed += 1;
      } else {
        counts.draft += 1;
      }

      return counts;
    },
    { draft: 0, scheduled: 0, sent: 0, failed: 0 },
  );
  const campaignError = campaignErrorMessage(
    resolvedSearchParams.campaign_error,
  );
  const selectedTemplate =
    campaignTemplates.find(
      (template) => template.key === resolvedSearchParams.template,
    ) ?? null;
  const selectedTemplateAudienceIsAvailable = selectedTemplate
    ? audiencePreviews.some(
        (audience) => audience.key === selectedTemplate.audienceType,
      )
    : false;
  const defaultAudienceType = selectedTemplateAudienceIsAvailable
    ? (selectedTemplate?.audienceType ?? "all_active_clients")
    : "all_active_clients";
  const defaultAudienceLabel =
    audiencePreviews.find((audience) => audience.key === defaultAudienceType)
      ?.label ?? "Selected audience";

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.09),transparent_28%),radial-gradient(circle_at_top_right,rgba(124,58,237,0.10),transparent_26%),linear-gradient(180deg,#fff7ed_0%,var(--brand-page-bg)_32%,#ffffff_100%)] px-4 py-6 text-[var(--brand-text)] sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        {resolvedSearchParams.campaign_saved ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 shadow-sm">
            Campaign draft saved.
          </div>
        ) : null}

        {campaignError ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 shadow-sm">
            {campaignError}
          </div>
        ) : null}

        <section className="overflow-hidden rounded-3xl border border-violet-200/80 bg-white shadow-[0_20px_55px_rgba(76,29,149,0.12)]">
          <div className="bg-[linear-gradient(135deg,#111827_0%,#4c1d95_52%,#f97316_145%)] px-6 py-7 text-white sm:px-8">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-orange-200">
              DanceFlow Marketing
            </p>
            <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
                  Campaigns
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-white/85 sm:text-base">
                  Turn the leads and clients already inside DanceFlow into
                  follow-ups, event registrations, and return visits.
                </p>
              </div>

              <Link
                href="/app/clients"
                className="inline-flex items-center justify-center rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 text-sm font-semibold text-white shadow-sm backdrop-blur transition hover:bg-white/15"
              >
                View CRM
              </Link>
            </div>
          </div>

          <div className="grid gap-4 bg-[linear-gradient(135deg,#fff7ed_0%,#faf5ff_55%,#ffffff_100%)] p-5 sm:p-6 lg:grid-cols-3">
            <div className="rounded-2xl border border-orange-200 bg-white/90 p-4 shadow-sm">
              <div className="flex items-start gap-3">
                <span className="rounded-xl bg-orange-50 p-2 text-orange-700 ring-1 ring-orange-200">
                  <Megaphone className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-orange-700">
                    Campaign workspace
                  </p>
                  <p className="mt-1 text-lg font-bold text-[var(--brand-text)]">
                    {campaigns.length} recent draft{campaigns.length === 1 ? "" : "s"}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                    Draft, review, test, and send without leaving DanceFlow.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-violet-200 bg-white/90 p-4 shadow-sm">
              <div className="flex items-start gap-3">
                <span className="rounded-xl bg-violet-50 p-2 text-violet-700 ring-1 ring-violet-200">
                  <Users className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">
                    Audience reach
                  </p>
                  <p className="mt-1 text-lg font-bold text-[var(--brand-text)]">
                    {audiencePreviews.reduce(
                      (sum, audience) => sum + audience.count,
                      0,
                    )} possible contacts
                  </p>
                  <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                    Audience counts come from current CRM, schedule, package, and event data.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-emerald-200 bg-white/90 p-4 shadow-sm">
              <div className="flex items-start gap-3">
                <span className="rounded-xl bg-emerald-50 p-2 text-emerald-700 ring-1 ring-emerald-200">
                  <ShieldCheck className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">
                    Delivery safeguards
                  </p>
                  <p className="mt-1 text-lg font-bold text-[var(--brand-text)]">
                    Suppressions respected
                  </p>
                  <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                    Unsubscribes and suppression records are checked before sending.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
          <div className="rounded-3xl border border-violet-200/80 bg-white p-5 shadow-[0_18px_45px_rgba(76,29,149,0.09)] sm:p-6">
            <div>
              <h2 className="text-xl font-bold text-[var(--brand-text)]">
                Create campaign draft
              </h2>
              <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                Start from a DanceFlow quick-start template or write your own
                message. Everything stays inside the studio workflow.
              </p>
            </div>

            <div className="mt-5 rounded-2xl border border-orange-200/70 bg-[linear-gradient(135deg,#fff7ed_0%,#faf5ff_100%)] p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-orange-700">
                    Start with a template
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[var(--brand-muted)]">
                    Choose a starting point, then edit the audience, event,
                    subject, message, and call to action before saving.
                  </p>
                </div>

                {selectedTemplate ? (
                  <Link
                    href="/app/marketing/campaigns"
                    className="inline-flex w-fit items-center justify-center rounded-full border border-[var(--brand-border)] bg-white px-3 py-1 text-xs font-bold text-[#4D1F47] transition hover:bg-white/80"
                  >
                    Clear template
                  </Link>
                ) : null}
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {campaignTemplates.map((template) => (
                  <Link
                    key={template.key}
                    href={`/app/marketing/campaigns?template=${template.key}`}
                    className={`rounded-2xl border px-4 py-3 text-left transition ${
                      selectedTemplate?.key === template.key
                        ? "border-orange-400 bg-white shadow-[0_10px_28px_rgba(249,115,22,0.12)] ring-1 ring-orange-200"
                        : "border-[var(--brand-border)] bg-white/70 hover:border-[#A64AC9] hover:bg-white"
                    }`}
                  >
                    <p className="text-sm font-bold text-[var(--brand-text)]">
                      {template.label}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-[var(--brand-muted)]">
                      {template.description}
                    </p>
                  </Link>
                ))}
              </div>

              {selectedTemplate &&
              isSpecificEventAudience(defaultAudienceType) ? (
                <p className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  This template uses a specific-event audience. Choose the
                  matching event before saving the draft.
                </p>
              ) : null}
            </div>

            <div className="mt-5 grid gap-2 sm:grid-cols-4">
              {[
                { step: "1", label: "Choose audience", detail: "Who should receive it" },
                { step: "2", label: "Write message", detail: "Subject, preview, and body" },
                { step: "3", label: "Add action", detail: "Optional button and link" },
                { step: "4", label: "Save draft", detail: "Review before sending" },
              ].map((item, index) => (
                <div
                  key={item.step}
                  className="relative rounded-2xl border border-violet-100 bg-white p-3 shadow-sm"
                >
                  <div className="flex items-start gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,#4c1d95_0%,#f97316_130%)] text-xs font-bold text-white">
                      {item.step}
                    </span>
                    <div>
                      <p className="text-sm font-bold text-[var(--brand-text)]">{item.label}</p>
                      <p className="mt-1 text-xs leading-5 text-[var(--brand-muted)]">{item.detail}</p>
                    </div>
                  </div>
                  {index < 3 ? (
                    <ArrowRight className="absolute -right-3 top-1/2 hidden h-4 w-4 -translate-y-1/2 text-violet-300 sm:block" />
                  ) : null}
                </div>
              ))}
            </div>

            <form
              action={createMarketingCampaignDraftAction}
              className="mt-5 space-y-5"
            >
              <section className="rounded-3xl border border-violet-200/70 bg-[linear-gradient(135deg,#ffffff_0%,#faf5ff_100%)] p-4 sm:p-5">
                <div className="mb-4 flex items-start gap-3">
                  <span className="rounded-xl bg-violet-50 p-2 text-violet-700 ring-1 ring-violet-200">
                    <Users className="h-4 w-4" />
                  </span>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">Step 1</p>
                    <h3 className="mt-1 text-lg font-bold text-[var(--brand-text)]">Campaign and audience</h3>
                    <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                      Name the campaign, choose the audience, and select an event only when required.
                    </p>
                  </div>
                </div>
                <div className="space-y-4">
                  <div>
                    <label
                      htmlFor="name"
                  className="text-sm font-semibold text-[var(--brand-text)]"
                >
                  Campaign name
                </label>
                <input
                  id="name"
                  name="name"
                  required
                  className="mt-2 w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
                  placeholder="June workshop follow-up"
                  defaultValue={selectedTemplate?.name ?? ""}
                />
              </div>

              <div>
                <label
                  htmlFor="audienceType"
                  className="text-sm font-semibold text-[var(--brand-text)]"
                >
                  Audience
                </label>
                <select
                  id="audienceType"
                  name="audienceType"
                  defaultValue={defaultAudienceType}
                  className="mt-2 w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
                >
                  {audiencePreviews.map((audience) => (
                    <option key={audience.key} value={audience.key}>
                      {audience.label} · {audience.count}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="audienceEventId"
                  className="text-sm font-semibold text-[var(--brand-text)]"
                >
                  Event
                </label>
                <select
                  id="audienceEventId"
                  name="audienceEventId"
                  defaultValue=""
                  className="mt-2 w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
                >
                  <option value="">No specific event selected</option>
                  {events.map((event) => (
                    <option key={event.id} value={event.id}>
                      {event.name}
                      {event.start_date
                        ? ` · ${formatDate(event.start_date)}`
                        : ""}
                    </option>
                  ))}
                </select>
                <p className="mt-2 text-xs leading-5 text-[var(--brand-muted)]">
                  Required only for Specific event registrants and Specific
                  event checked-in attendees.
                </p>
                  </div>
                </div>
              </section>

              <section className="rounded-3xl border border-orange-200/70 bg-[linear-gradient(135deg,#ffffff_0%,#fff7ed_100%)] p-4 sm:p-5">
                <div className="mb-4 flex items-start gap-3">
                  <span className="rounded-xl bg-orange-50 p-2 text-orange-700 ring-1 ring-orange-200">
                    <Mail className="h-4 w-4" />
                  </span>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-orange-700">Step 2</p>
                    <h3 className="mt-1 text-lg font-bold text-[var(--brand-text)]">Message</h3>
                    <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                      Write the subject, inbox preview, and branded studio message.
                    </p>
                  </div>
                </div>
                <div className="space-y-4">
                  <div>
                    <label
                      htmlFor="subject"
                  className="text-sm font-semibold text-[var(--brand-text)]"
                >
                  Subject line
                </label>
                <input
                  id="subject"
                  name="subject"
                  required
                  className="mt-2 w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
                  placeholder="Ready for your next lesson?"
                  defaultValue={selectedTemplate?.subject ?? ""}
                />
              </div>

              <div>
                <label
                  htmlFor="previewText"
                  className="text-sm font-semibold text-[var(--brand-text)]"
                >
                  Preview text
                </label>
                <input
                  id="previewText"
                  name="previewText"
                  className="mt-2 w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
                  placeholder="A quick update from the studio..."
                  defaultValue={selectedTemplate?.previewText ?? ""}
                />
              </div>

              <div>
                <label
                  htmlFor="bodyText"
                  className="text-sm font-semibold text-[var(--brand-text)]"
                >
                  Message
                </label>
                <textarea
                  id="bodyText"
                  name="bodyText"
                  required
                  rows={8}
                  className="mt-2 w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm leading-6 outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
                  placeholder="Write the message the studio wants to send..."
                  defaultValue={selectedTemplate?.bodyText ?? ""}
                />
              </div>

                  <CampaignAIAssistant
                    campaignContext="studio"
                    audienceLabel={defaultAudienceLabel}
                    currentSubject={selectedTemplate?.subject ?? ""}
                    currentPreviewText={selectedTemplate?.previewText ?? ""}
                    currentBodyText={selectedTemplate?.bodyText ?? ""}
                    ctaLabel={selectedTemplate?.ctaLabel ?? ""}
                    compact
                  />
                </div>
              </section>

              <section className="rounded-3xl border border-emerald-200/70 bg-[linear-gradient(135deg,#ffffff_0%,#ecfdf5_100%)] p-4 sm:p-5">
                <div className="mb-4 flex items-start gap-3">
                  <span className="rounded-xl bg-emerald-50 p-2 text-emerald-700 ring-1 ring-emerald-200">
                    <Link2 className="h-4 w-4" />
                  </span>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">Step 3</p>
                    <h3 className="mt-1 text-lg font-bold text-[var(--brand-text)]">Call to action</h3>
                    <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                      Add an optional button that directs recipients to the next step.
                    </p>
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="ctaLabel"
                    className="text-sm font-semibold text-[var(--brand-text)]"
                  >
                    CTA button text
                  </label>
                  <input
                    id="ctaLabel"
                    name="ctaLabel"
                    className="mt-2 w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
                    placeholder="Book a lesson"
                    defaultValue={selectedTemplate?.ctaLabel ?? ""}
                  />
                </div>

                <div>
                  <label
                    htmlFor="ctaUrl"
                    className="text-sm font-semibold text-[var(--brand-text)]"
                  >
                    CTA link
                  </label>
                  <input
                    id="ctaUrl"
                    name="ctaUrl"
                    className="mt-2 w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
                    placeholder="https://idanceflow.com/..."
                  />
                </div>
              </div>
              </section>

              <section className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
                <div className="flex items-start gap-3">
                  <span className="rounded-xl bg-white p-2 text-violet-700 ring-1 ring-slate-200">
                    <CheckCircle2 className="h-4 w-4" />
                  </span>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">Step 4</p>
                    <h3 className="mt-1 text-base font-bold text-[var(--brand-text)]">Save for review</h3>
                    <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                      Saving creates a draft only. Review recipients, branding, and delivery settings before sending.
                    </p>
                  </div>
                </div>

                <button
                  type="submit"
                  className="inline-flex w-full shrink-0 items-center justify-center rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:brightness-110 sm:w-auto"
                >
                  Save Draft
                </button>
              </section>
            </form>
          </div>

          <aside className="flex flex-col gap-6">
            <section className="rounded-3xl border border-orange-200/80 bg-[linear-gradient(180deg,#ffffff_0%,#fff7ed_100%)] p-5 shadow-[0_18px_45px_rgba(249,115,22,0.08)] sm:p-6">
              <h2 className="text-lg font-bold text-[var(--brand-text)]">
                Audience preview
              </h2>
              <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                These preset audiences come from existing CRM, schedule,
                package, and event data.
              </p>

              <div className="mt-4 space-y-3">
                {audiencePreviews.map((audience) => (
                  <details
                    key={audience.key}
                    className="rounded-2xl border border-violet-100 bg-white/85 p-4 transition hover:border-orange-200 hover:shadow-sm"
                  >
                    <summary className="cursor-pointer list-none">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-[var(--brand-text)]">
                            {audience.label}
                          </p>
                          <p className="mt-1 text-xs leading-5 text-[var(--brand-muted)]">
                            {audience.description}
                          </p>
                        </div>
                        <span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold text-[#4D1F47]">
                          {audience.count}
                        </span>
                      </div>
                    </summary>

                    <div className="mt-3 border-t border-[var(--brand-border)] pt-3">
                      {audience.sample.length > 0 ? (
                        <ul className="space-y-1 text-xs text-[var(--brand-muted)]">
                          {audience.sample.map((recipient) => (
                            <li key={recipient}>{recipient}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-[var(--brand-muted)]">
                          No recipients found for this audience yet.
                        </p>
                      )}
                    </div>
                  </details>
                ))}
              </div>
            </section>
          </aside>
        </section>

        <section className="rounded-3xl border border-violet-200/80 bg-white p-5 shadow-[0_18px_45px_rgba(76,29,149,0.09)] sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                Campaign activity
              </p>
              <h2 className="mt-1 text-xl font-bold text-[var(--brand-text)]">
                Recent campaigns
              </h2>
              <p className="mt-1 text-sm text-[var(--brand-muted)]">
                See what needs work, what is scheduled, and what has already been delivered.
              </p>
            </div>
            <span className="inline-flex w-fit rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-800">
              {campaigns.length} recent
            </span>
          </div>

          <div className="mt-5 grid gap-2 sm:grid-cols-4">
            <div className="rounded-2xl border border-violet-100 bg-violet-50/70 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-violet-700">
                Drafts
              </p>
              <p className="mt-1 text-2xl font-bold text-violet-950">
                {campaignStatusCounts.draft}
              </p>
            </div>
            <div className="rounded-2xl border border-sky-100 bg-sky-50/70 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-sky-700">
                Scheduled
              </p>
              <p className="mt-1 text-2xl font-bold text-sky-950">
                {campaignStatusCounts.scheduled}
              </p>
            </div>
            <div className="rounded-2xl border border-emerald-100 bg-emerald-50/70 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                Sent
              </p>
              <p className="mt-1 text-2xl font-bold text-emerald-950">
                {campaignStatusCounts.sent}
              </p>
            </div>
            <div className="rounded-2xl border border-red-100 bg-red-50/70 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-red-700">
                Attention
              </p>
              <p className="mt-1 text-2xl font-bold text-red-950">
                {campaignStatusCounts.failed}
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-3">
            {campaigns.length > 0 ? (
              <MarketingCampaignList campaigns={campaigns} />
            ) : (
              <div className="rounded-2xl border border-dashed border-violet-200 bg-[linear-gradient(135deg,#faf5ff_0%,#fff7ed_100%)] p-5 text-sm text-[var(--brand-muted)]">
                No campaign drafts yet. Create the first draft above.
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
