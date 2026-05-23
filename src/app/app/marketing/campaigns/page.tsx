import Link from "next/link";

const campaignTypes = [
  {
    title: "New lead follow-up",
    description:
      "Reach dancers who came in through discovery, event forms, or manual lead entry.",
  },
  {
    title: "Inactive client re-engagement",
    description:
      "Invite students who have not booked recently back into lessons, classes, or events.",
  },
  {
    title: "Event promotion",
    description:
      "Send a simple announcement to relevant clients and leads when a workshop or event is ready.",
  },
  {
    title: "Studio announcement",
    description:
      "Share schedule updates, bulletin-style news, and important studio reminders.",
  },
];

export default function MarketingCampaignsPage() {
  return (
    <main className="min-h-screen bg-[var(--brand-page-bg)] px-4 py-6 text-[var(--brand-text)] sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
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
                Studio owners should create and send campaigns without leaving
                DanceFlow or learning a separate email tool.
              </p>
            </div>

            <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-4">
              <p className="text-sm font-semibold text-[var(--brand-muted)]">
                Next Build
              </p>
              <p className="mt-2 text-lg font-bold text-[var(--brand-text)]">
                Audience builder
              </p>
              <p className="mt-2 text-sm leading-6 text-[var(--brand-muted)]">
                Start with preset audiences like new leads, inactive clients,
                event attendees, and active clients.
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
                Campaign sending will respect unsubscribe/suppression records
                before emails go out.
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-xl font-bold text-[var(--brand-text)]">
                Campaign templates to build first
              </h2>
              <p className="mt-1 text-sm text-[var(--brand-muted)]">
                These are the revenue-focused workflows that make the CRM
                actionable.
              </p>
            </div>
            <span className="inline-flex w-fit rounded-full border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] px-3 py-1 text-xs font-semibold text-[var(--brand-muted)]">
              Planning foundation
            </span>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {campaignTypes.map((campaign) => (
              <article
                key={campaign.title}
                className="rounded-2xl border border-[var(--brand-border)] bg-white p-4 shadow-sm"
              >
                <h3 className="font-semibold text-[var(--brand-text)]">
                  {campaign.title}
                </h3>
                <p className="mt-2 text-sm leading-6 text-[var(--brand-muted)]">
                  {campaign.description}
                </p>
              </article>
            ))}
          </div>
        </section>

        <section className="rounded-3xl border border-dashed border-[var(--brand-border)] bg-white p-5 text-sm text-[var(--brand-muted)] shadow-sm sm:p-6">
          <p className="font-semibold text-[var(--brand-text)]">
            Build sequence
          </p>
          <p className="mt-2 leading-6">
            Database tables and navigation are the foundation. Next we add the
            campaign draft form, audience preview counts, test send, send now,
            recipient logging, and unsubscribe handling.
          </p>
        </section>
      </div>
    </main>
  );
}
