import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { sendMarketingCampaignTestEmailAction } from "../actions";

type Params = Promise<{
  id: string;
}>;

type SearchParams = Promise<{
  test_sent?: string;
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
  status: string;
  created_at: string;
  sent_at: string | null;
};

type RecipientPreview = {
  email: string;
  name: string;
  source: string;
  unsubscribed: boolean;
};

const audienceLabels: Record<string, string> = {
  manual: "Manual audience",
  all_active_clients: "All active clients",
  new_leads: "New leads",
  inactive_clients: "Inactive clients",
  event_attendees: "Event registrants",
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
    case "not_found":
      return "Campaign could not be found.";
    case "missing_content":
      return "Campaign needs a subject and message before sending a test.";
    case "test_send_failed":
      return "Test email could not be sent. Check Resend settings and sender verification.";
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

  let query = supabase
    .from("clients")
    .select("id, first_name, last_name, email, status")
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

  const seen = new Set<string>();
  const recipients: RecipientPreview[] = [];

  for (const row of data ?? []) {
    const email = normalizeEmail(row.email);

    if (!email || seen.has(email)) {
      continue;
    }

    seen.add(email);
    recipients.push({
      email,
      name: buildName(row.first_name, row.last_name),
      source: "CRM",
      unsubscribed: unsubscribedEmails.has(email),
    });
  }

  return recipients;
}

async function getEventRecipients(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  unsubscribedEmails: Set<string>;
}) {
  const { supabase, studioId, unsubscribedEmails } = params;

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
      email,
      name: buildName(row.attendee_first_name, row.attendee_last_name),
      source: "Event registration",
      unsubscribed: unsubscribedEmails.has(email),
    });
  }

  return recipients;
}

async function getRecipientPreview(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  audienceType: string;
}) {
  const { supabase, studioId, audienceType } = params;
  const unsubscribedEmails = await getUnsubscribedEmails({ supabase, studioId });

  if (audienceType === "event_attendees") {
    return getEventRecipients({ supabase, studioId, unsubscribedEmails });
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

  const { data: campaign, error } = await supabase
    .from("marketing_campaigns")
    .select("id, studio_id, name, subject, preview_text, body_text, cta_label, cta_url, audience_type, status, created_at, sent_at")
    .eq("id", resolvedParams.id)
    .eq("studio_id", studioId)
    .maybeSingle<CampaignRow>();

  if (error || !campaign) {
    notFound();
  }

  const recipients = await getRecipientPreview({
    supabase,
    studioId,
    audienceType: campaign.audience_type,
  });

  const includedRecipients = recipients.filter((recipient) => !recipient.unsubscribed);
  const suppressedRecipients = recipients.filter((recipient) => recipient.unsubscribed);
  const sampleRecipients = recipients.slice(0, 5);
  const remainingRecipientCount = Math.max(recipients.length - sampleRecipients.length, 0);
  const campaignError = campaignErrorMessage(resolvedSearchParams.campaign_error);

  return (
    <main className="min-h-screen bg-[var(--brand-page-bg)] px-4 py-6 text-[var(--brand-text)] sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        {resolvedSearchParams.test_sent ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 shadow-sm">
            Test email sent.
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
                  Review the message, check the audience, and send a test email before live sending is enabled.
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
              <p className="mt-2 text-lg font-bold capitalize text-[var(--brand-text)]">{campaign.status}</p>
            </div>
            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-4">
              <p className="text-sm font-semibold text-[var(--brand-muted)]">Audience</p>
              <p className="mt-2 text-lg font-bold text-[var(--brand-text)]">
                {audienceLabels[campaign.audience_type] ?? campaign.audience_type}
              </p>
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
          <div className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm sm:p-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-xl font-bold text-[var(--brand-text)]">Message preview</h2>
                <p className="mt-1 text-sm text-[var(--brand-muted)]">Created {formatDate(campaign.created_at)} · Sent {formatDate(campaign.sent_at)}</p>
              </div>
              <span className="inline-flex w-fit rounded-full border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] px-3 py-1 text-xs font-semibold capitalize text-[var(--brand-muted)]">
                {campaign.status}
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
          </div>

          <aside className="flex flex-col gap-6">
            <section className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm sm:p-6">
              <h2 className="text-lg font-bold text-[var(--brand-text)]">Send test email</h2>
              <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                Send a test to yourself or another studio staff email before enabling live campaign sending.
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
          </aside>
        </section>
      </div>
    </main>
  );
}

