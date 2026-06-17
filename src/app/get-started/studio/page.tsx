import Image from "next/image";
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

            <section className="mt-12 overflow-hidden rounded-[36px] border border-pink-200/80 bg-white shadow-sm">
              <div className="grid gap-0 lg:grid-cols-[0.9fr_1.1fr]">
                <div className="relative flex min-h-[320px] items-center justify-center bg-[radial-gradient(circle_at_top_left,#fce7f3_0%,#fff7ed_42%,#ffffff_100%)] p-8">
                  <div className="absolute inset-x-8 top-8 rounded-full bg-gradient-to-r from-pink-300/30 via-orange-200/30 to-violet-200/30 blur-3xl" />
                  <div className="relative h-56 w-56 overflow-hidden rounded-[32px] border border-white/80 bg-white shadow-xl sm:h-72 sm:w-72">
                    <Image
                      src="/aria/aria-avatar.png"
                      alt="ARIA, DanceFlow's AI Revenue Insights Assistant"
                      fill
                      className="object-cover"
                      sizes="(min-width: 1024px) 18rem, 14rem"
                      priority
                    />
                  </div>
                </div>

                <div className="flex flex-col justify-center p-7 md:p-9">
                  <p className="text-sm font-semibold uppercase tracking-[0.18em] text-pink-700">
                    Meet ARIA
                  </p>
                  <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                    AI Revenue Insights Assistant
                  </h2>
                  <p className="mt-4 text-sm leading-7 text-slate-600">
                    ARIA helps your studio spot the opportunities hiding inside
                    your data — package renewals, rebooking chances, pending
                    booking requests, unsigned documents, and automations that
                    reduce front desk work.
                  </p>
                  <p className="mt-3 text-sm leading-7 text-slate-600">
                    As your studio grows, ARIA will help turn your goals into
                    clear next steps so DanceFlow does more than organize your
                    business. It helps you decide what to focus on next.
                  </p>

                  <div className="mt-6 grid gap-3 sm:grid-cols-3">
                    {[
                      "Find revenue opportunities",
                      "Suggest next-best actions",
                      "Recommend automations",
                    ].map((item) => (
                      <div
                        key={item}
                        className="rounded-2xl border border-pink-100 bg-pink-50/70 px-4 py-3 text-sm font-semibold text-pink-950"
                      >
                        {item}
                      </div>
                    ))}
                  </div>

                  <div className="mt-6 rounded-3xl border border-slate-200 bg-white/80 p-5">
                    <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">
                      ARIA by plan
                    </p>
                    <div className="mt-4 grid gap-3 md:grid-cols-3">
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <p className="text-sm font-semibold text-slate-950">Starter</p>
                        <p className="mt-1 text-xs leading-5 text-slate-600">
                          Basic ARIA insights and next-step previews.
                        </p>
                      </div>
                      <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4">
                        <p className="text-sm font-semibold text-slate-950">Growth</p>
                        <p className="mt-1 text-xs leading-5 text-slate-600">
                          ARIA Opportunity Hub, automation recommendations, and revenue opportunity lists.
                        </p>
                      </div>
                      <div className="rounded-2xl border border-pink-200 bg-pink-50 p-4">
                        <p className="text-sm font-semibold text-slate-950">Pro</p>
                        <p className="mt-1 text-xs leading-5 text-slate-600">
                          Future ARIA Goals, growth plans, advanced AI recommendations, and Chat with ARIA.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

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
advanced reporting, exports, automations, documents, studio ARIA,
                    larger AI usage, and basic event listings. Add Organizer Suite for ticketing, QR check-in, settlements, event audiences, and event ARIA.
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
                    Free discovery accounts are for dancers and the public. Studio plans include basic event listings. Organizer
                    accounts continue into Organizer Suite pricing for ticketing, check-in, settlement, and event-growth tools. Organizer
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

