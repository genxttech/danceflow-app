import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatPlanMoney, getPlansByAudience } from "@/lib/billing/plans";
import { startPaidPathAction } from "../actions";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";

const marketingTierHighlights: Record<string, string[]> = {
  starter: [
    "Basic branded email campaigns",
    "General client email audience",
    "Campaign drafts and test emails",
  ],
  growth: [
    "Targeted CRM campaign audiences",
    "Inactive client follow-up",
    "No upcoming lesson and low-credit reminders",
  ],
  pro: [
    "Event-based campaign audiences",
    "Specific event registrants and checked-in attendees",
    "Advanced reports, exports, and future marketing automations",
  ],
};

export default async function StudioPricingPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const studioPlans = getPlansByAudience("studio");

  return (
    <>
      <PublicSiteHeader currentPath="pricing" isAuthenticated={!!user} />

      <main className="min-h-screen bg-[linear-gradient(180deg,#f5f3ff_0%,#ffffff_24%,#f8fafc_100%)]">
        <section className="border-b border-slate-200/70">
          <div className="mx-auto max-w-7xl px-6 py-14 lg:px-8 lg:py-20">
            <div className="mx-auto max-w-3xl text-center">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-600">
                Studio Pricing
              </p>

              <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
                Pricing built for dance studios and independent instructors
              </h1>

              <p className="mt-4 text-lg leading-8 text-slate-600">
                Start with a 30-day trial and use DanceFlow to manage your
                studio CRM, scheduling, packages, events, payments, reports,
                AI help, syllabus progress, and built-in follow-up marketing
                from one place.
              </p>

              <div className="mt-8 grid gap-4 text-left sm:grid-cols-2">
                <div className="rounded-2xl border border-violet-200 bg-violet-50 px-5 py-4">
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-violet-700">
                    Founder pricing
                  </p>
                  <p className="mt-2 text-sm leading-7 text-violet-950">
                    Available for the first 25 studios. Founder pricing lasts
                    for 12 months after your 30-day free trial.
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white px-5 py-4">
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-700">
                    Existing account friendly
                  </p>
                  <p className="mt-2 text-sm leading-7 text-slate-600">
                    Already linked to another studio? Log in when prompted and
                    DanceFlow will create a separate workspace for your own business.
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-12 grid gap-6 lg:grid-cols-3">
              {studioPlans.map((plan) => {
                const marketingHighlights =
                  marketingTierHighlights[plan.code] ?? [];

                return (
                  <section
                    key={plan.code}
                    className={`rounded-[32px] border bg-white p-7 shadow-sm ${
                      plan.code === "growth"
                        ? "border-violet-300 ring-2 ring-violet-100"
                        : "border-slate-200"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
                        {plan.label}
                      </h2>

                      {plan.code === "growth" ? (
                        <span className="rounded-full bg-violet-600 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white">
                          Best value
                        </span>
                      ) : null}
                    </div>

                    <div className="mt-4">
                      {plan.regularAmountMonthlyCents ? (
                        <p className="text-sm font-medium text-slate-500">
                          Founder price · regularly {formatPlanMoney(plan.regularAmountMonthlyCents)}/mo
                        </p>
                      ) : null}

                      <p className="mt-1 text-4xl font-semibold tracking-tight text-slate-950">
                        {formatPlanMoney(plan.amountMonthlyCents)}
                        <span className="text-base font-medium text-slate-500">/mo</span>
                      </p>
                    </div>

                    <p className="mt-3 text-sm leading-7 text-slate-600">
                      {plan.description}
                    </p>

                    <div className="mt-4 rounded-2xl bg-violet-50 px-4 py-3 text-sm leading-6 text-violet-900">
                      Includes a {plan.trialDays}-day free trial. Founder pricing
                      applies for 12 months after the trial for eligible early studios.
                    </div>

                    <ul className="mt-6 space-y-2 text-sm leading-7 text-slate-600">
                      {plan.highlights.map((highlight) => (
                        <li key={highlight}>• {highlight}</li>
                      ))}
                    </ul>

                    {marketingHighlights.length > 0 ? (
                      <div className="mt-6 rounded-2xl border border-violet-100 bg-violet-50/70 p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                          Studio CRM + Marketing
                        </p>
                        <ul className="mt-3 space-y-2 text-sm leading-6 text-violet-950">
                          {marketingHighlights.map((highlight) => (
                            <li key={highlight}>• {highlight}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    <form action={startPaidPathAction} className="mt-8">
                      <input type="hidden" name="planCode" value={plan.code} />
                      <input type="hidden" name="intent" value="studio" />
                      <button
                        type="submit"
                        className={`w-full rounded-xl px-4 py-3 text-sm font-medium text-white ${
                          plan.code === "growth"
                            ? "bg-violet-600 hover:bg-violet-700"
                            : "bg-slate-900 hover:bg-slate-800"
                        }`}
                      >
                        Start {plan.label} Trial
                      </button>
                    </form>
                  </section>
                );
              })}
            </div>

            <div className="mt-10 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
              <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
                  Built-in studio marketing
                </p>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">
                  Turn your CRM into follow-up
                </h2>
                <p className="mt-3 text-sm leading-7 text-slate-600">
                  DanceFlow helps studios send simple branded email campaigns to
                  clients, leads, students without upcoming lessons, low-credit
                  package holders, and event attendees without leaving the app.
                </p>

                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  {[
                    "New lead follow-up",
                    "No upcoming lesson reminders",
                    "Low package credit reminders",
                    "Event registrant updates",
                  ].map((item) => (
                    <div
                      key={item}
                      className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700"
                    >
                      {item}
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
                  What grows by tier
                </p>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">
                  Start simple, then target smarter
                </h2>
                <div className="mt-5 space-y-4 text-sm leading-7 text-slate-600">
                  <p>
                    <span className="font-semibold text-slate-900">Starter:</span>{" "}
basic campaign drafts, general client emails, and core studio operations.
                  </p>
                  <p>
                    <span className="font-semibold text-slate-900">Growth:</span>{" "}
targeted CRM audiences, AI help, inactive client follow-up, no upcoming
                    lessons, and low package credits.
                  </p>
                  <p>
                    <span className="font-semibold text-slate-900">Pro:</span>{" "}
event-based audiences, checked-in attendee campaigns, ticketing,
                    QR check-in, advanced reporting, exports, and larger AI usage.
                  </p>
                </div>
              </section>
            </div>

            <div className="mt-10 rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
              <div className="grid gap-6 lg:grid-cols-[1fr_auto] lg:items-center">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
                    Need a different path?
                  </p>
                  <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">
                    DanceFlow also supports public users and organizers
                  </h2>
                  <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">
                    Free discovery accounts are for dancers and the public. Organizer
                    accounts continue into organizer pricing and event tools. Organizer
                    campaign tools are planned as a near-term event marketing workflow
                    after studio Campaigns V1 stabilizes.
                  </p>
                </div>

                <div className="flex flex-wrap gap-3">
                  <Link
                    href="/get-started"
                    className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Back to Path Chooser
                  </Link>

                  <Link
                    href="/get-started/organizer"
                    className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Organizer Pricing
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}

