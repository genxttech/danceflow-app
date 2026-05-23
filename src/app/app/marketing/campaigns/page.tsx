import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createMarketingCampaignDraftAction } from "./actions";

type SearchParams = Promise<{
  campaign_saved?: string;
  campaign_error?: string;
}>;

type CampaignRow = {
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
    description: "Clients marked inactive who may need a re-engagement message.",
  },
  {
    key: "event_attendees",
    label: "All event registrants",
    description: "People who registered for any event and have an email address.",
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
    description: "Active clients who do not currently have a future lesson scheduled.",
  },
  {
    key: "low_package_credits",
    label: "Clients with low package credits",
    description: "Clients with an active package that has 2 or fewer credits remaining.",
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

function audienceLabel(value: string) {
  return audienceOptions.find((option) => option.key === value)?.label ?? value;
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
  return audienceType === "specific_event_registrants" || audienceType === "specific_event_checked_in";
}

async function getClientAudiencePreview(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  audienceType: string;
}) {
  const { supabase, studioId, audienceType } = params;
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
      (clients ?? []).filter((client) => !clientsWithUpcomingLessons.has(String(client.id))),
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
      new Set((packages ?? []).map((pkg) => String(pkg.client_id ?? "")).filter(Boolean)),
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
    const email = String(row.email ?? "").trim().toLowerCase();

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
    const email = String(row.attendee_email ?? "").trim().toLowerCase();

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
  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const [audiencePreviews, campaignsResult, eventsResult] = await Promise.all([
    getAudiencePreviews({ supabase, studioId }),
    supabase
      .from("marketing_campaigns")
      .select("id, name, subject, preview_text, audience_type, audience_event_id, status, created_at, sent_at")
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
  const campaignError = campaignErrorMessage(resolvedSearchParams.campaign_error);

  return (
    <main className="min-h-screen bg-[var(--brand-page-bg)] px-4 py-6 text-[var(--brand-text)] sm:px-6 lg:px-8">
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

        <section className="overflow-hidden rounded-3xl border border-[var(--brand-border)] bg-white shadow-sm">
          <div className="bg-gradient-to-r from-[#241432] via-[#4D1F47] to-[#E85D2A] px-6 py-7 text-white sm:px-8">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/75">
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
                className="inline-flex items-center justify-center rounded-2xl border border-white/25 bg-white/10 px-4 py-2 text-sm font-semibold text-white shadow-sm backdrop-blur transition hover:bg-white/20"
              >
                View CRM
              </Link>
            </div>
          </div>

          <div className="grid gap-4 p-5 sm:p-6 lg:grid-cols-3">
            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-4">
              <p className="text-sm font-semibold text-[var(--brand-muted)]">
                V1 Focus
              </p>
              <p className="mt-2 text-lg font-bold text-[var(--brand-text)]">
                Native in-app emails
              </p>
              <p className="mt-2 text-sm leading-6 text-[var(--brand-muted)]">
                Studio owners create campaign drafts without leaving DanceFlow.
              </p>
            </div>

            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-4">
              <p className="text-sm font-semibold text-[var(--brand-muted)]">
                Audience Preview
              </p>
              <p className="mt-2 text-lg font-bold text-[var(--brand-text)]">
                {audiencePreviews.reduce((sum, audience) => sum + audience.count, 0)} possible contacts
              </p>
              <p className="mt-2 text-sm leading-6 text-[var(--brand-muted)]">
                Counts are deduped within each audience and exclude blank emails.
              </p>
            </div>

            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-4">
              <p className="text-sm font-semibold text-[var(--brand-muted)]">
                Compliance
              </p>
              <p className="mt-2 text-lg font-bold text-[var(--brand-text)]">
                Unsubscribes built in
              </p>
              <p className="mt-2 text-sm leading-6 text-[var(--brand-muted)]">
                Sending will respect suppression records before emails go out.
              </p>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
          <div className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm sm:p-6">
            <div>
              <h2 className="text-xl font-bold text-[var(--brand-text)]">
                Create campaign draft
              </h2>
              <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                Start with a simple branded message. Sending and test emails come
                next after recipient logging and unsubscribe handling are wired.
              </p>
            </div>

            <form action={createMarketingCampaignDraftAction} className="mt-5 space-y-4">
              <div>
                <label htmlFor="name" className="text-sm font-semibold text-[var(--brand-text)]">
                  Campaign name
                </label>
                <input
                  id="name"
                  name="name"
                  required
                  className="mt-2 w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
                  placeholder="June workshop follow-up"
                />
              </div>

              <div>
                <label htmlFor="audienceType" className="text-sm font-semibold text-[var(--brand-text)]">
                  Audience
                </label>
                <select
                  id="audienceType"
                  name="audienceType"
                  defaultValue="all_active_clients"
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
                <label htmlFor="audienceEventId" className="text-sm font-semibold text-[var(--brand-text)]">
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
                      {event.name}{event.start_date ? ` · ${formatDate(event.start_date)}` : ""}
                    </option>
                  ))}
                </select>
                <p className="mt-2 text-xs leading-5 text-[var(--brand-muted)]">
                  Required only for Specific event registrants and Specific event checked-in attendees.
                </p>
              </div>

              <div>
                <label htmlFor="subject" className="text-sm font-semibold text-[var(--brand-text)]">
                  Subject line
                </label>
                <input
                  id="subject"
                  name="subject"
                  required
                  className="mt-2 w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
                  placeholder="Ready for your next lesson?"
                />
              </div>

              <div>
                <label htmlFor="previewText" className="text-sm font-semibold text-[var(--brand-text)]">
                  Preview text
                </label>
                <input
                  id="previewText"
                  name="previewText"
                  className="mt-2 w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
                  placeholder="A quick update from the studio..."
                />
              </div>

              <div>
                <label htmlFor="bodyText" className="text-sm font-semibold text-[var(--brand-text)]">
                  Message
                </label>
                <textarea
                  id="bodyText"
                  name="bodyText"
                  required
                  rows={8}
                  className="mt-2 w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm leading-6 outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
                  placeholder="Write the message the studio wants to send..."
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="ctaLabel" className="text-sm font-semibold text-[var(--brand-text)]">
                    CTA button text
                  </label>
                  <input
                    id="ctaLabel"
                    name="ctaLabel"
                    className="mt-2 w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
                    placeholder="Book a lesson"
                  />
                </div>

                <div>
                  <label htmlFor="ctaUrl" className="text-sm font-semibold text-[var(--brand-text)]">
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

              <button
                type="submit"
                className="inline-flex w-full items-center justify-center rounded-2xl bg-[#4D1F47] px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-[#3D1839] sm:w-auto"
              >
                Save Draft
              </button>
            </form>
          </div>

          <aside className="flex flex-col gap-6">
            <section className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm sm:p-6">
              <h2 className="text-lg font-bold text-[var(--brand-text)]">
                Audience preview
              </h2>
              <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                These preset audiences come from existing CRM, schedule, package,
                and event data.
              </p>

              <div className="mt-4 space-y-3">
                {audiencePreviews.map((audience) => (
                  <details
                    key={audience.key}
                    className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-4"
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

        <section className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-xl font-bold text-[var(--brand-text)]">
                Recent campaign drafts
              </h2>
              <p className="mt-1 text-sm text-[var(--brand-muted)]">
                Drafts are saved now. Test send, send now, and delivery logs are
                the next layer.
              </p>
            </div>
            <span className="inline-flex w-fit rounded-full border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] px-3 py-1 text-xs font-semibold text-[var(--brand-muted)]">
              Draft mode
            </span>
          </div>

          <div className="mt-5 space-y-3">
            {campaigns.length > 0 ? (
              campaigns.map((campaign) => (
                <article
                  key={campaign.id}
                  className="rounded-2xl border border-[var(--brand-border)] bg-white p-4 shadow-sm"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="font-semibold text-[var(--brand-text)]">
                        {campaign.name}
                      </p>
                      <p className="mt-1 text-sm text-[var(--brand-muted)]">
                        {campaign.subject}
                      </p>
                      {campaign.preview_text ? (
                        <p className="mt-1 text-xs text-[var(--brand-muted)]">
                          {campaign.preview_text}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className="rounded-full bg-[var(--brand-soft-bg)] px-3 py-1 text-xs font-semibold text-[var(--brand-muted)]">
                        {audienceLabel(campaign.audience_type)}
                      </span>
                      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold capitalize text-slate-700">
                        {campaign.status}
                      </span>
                      <Link
                        href={`/app/marketing/campaigns/${campaign.id}`}
                        className="inline-flex items-center justify-center rounded-full border border-[var(--brand-border)] bg-white px-3 py-1 text-xs font-bold text-[#4D1F47] transition hover:bg-[var(--brand-soft-bg)]"
                      >
                        Open
                      </Link>
                    </div>
                  </div>
                  <p className="mt-3 text-xs text-[var(--brand-muted)]">
                    Created {formatDate(campaign.created_at)} · Sent{" "}
                    {formatDate(campaign.sent_at)}
                  </p>
                </article>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-5 text-sm text-[var(--brand-muted)]">
                No campaign drafts yet. Create the first draft above.
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}


