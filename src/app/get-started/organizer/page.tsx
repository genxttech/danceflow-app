import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatPlanMoney, getPlansByAudience } from "@/lib/billing/plans";
import { startPaidPathAction } from "../actions";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";

export default async function OrganizerPricingPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const organizerPlan = getPlansByAudience("organizer")[0];

  return (
    <>
      <PublicSiteHeader currentPath="pricing" isAuthenticated={!!user} />

      <main className="min-h-screen bg-[linear-gradient(180deg,#eff6ff_0%,#ffffff_24%,#f8fafc_100%)]">
        <section className="border-b border-slate-200/70">
          <div className="mx-auto max-w-5xl px-6 py-14 lg:px-8 lg:py-20">
            <div className="mx-auto max-w-3xl text-center">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-sky-600">
                Organizer Pricing
              </p>

              <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
                Event-first pricing with full transparency
              </h1>

              <p className="mt-4 text-lg leading-8 text-slate-600">
                Built for organizers who want public event pages, registrations,
                ticketing, and check-in without hidden pricing.
              </p>

              <div className="mt-8 rounded-2xl border border-sky-200 bg-sky-50 px-5 py-4">
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-sky-700">
                  Review pricing before creating your account
                </p>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  You should be able to see organizer pricing first. When you click
                  Start Trial, DanceFlow will move you into signup if you are not
                  already signed in.
                </p>
              </div>
            </div>

            <div className="mt-12 rounded-[36px] border border-sky-300 bg-white p-8 shadow-sm">
              <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-start">
                <div>
                  <div className="flex items-center gap-3">
                    <h2 className="text-3xl font-semibold tracking-tight text-slate-900">
                      {organizerPlan.label}
                    </h2>
                    <span className="rounded-full bg-sky-600 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white">
                      Organizer path
                    </span>
                  </div>

                  <p className="mt-4 text-sm leading-7 text-slate-600">
                    {organizerPlan.description}
                  </p>

                  <div className="mt-6 rounded-2xl border border-sky-200 bg-sky-50 px-5 py-4 text-sky-900">
                    <p className="text-sm font-semibold">Transparent ticket-sale pricing</p>
                    <p className="mt-2 text-sm leading-6">
                      2.5% Square processing fee + 3.5% DanceFlow platform fee on ticket sales.
                    </p>
                  </div>

                  <ul className="mt-6 grid gap-2 text-sm text-slate-600">
                    {organizerPlan.highlights.map((highlight) => (
                      <li key={highlight}>• {highlight}</li>
                    ))}
                  </ul>
                </div>

                <div className="rounded-[28px] bg-slate-950 px-7 py-8 text-white">
                  <p className="text-4xl font-semibold tracking-tight">
                    {formatPlanMoney(organizerPlan.amountMonthlyCents)}
                    <span className="text-base font-medium text-slate-300">/mo</span>
                  </p>

                  <p className="mt-3 text-sm text-slate-300">
                    Includes a {organizerPlan.trialDays}-day free trial.
                  </p>

                  <form action={startPaidPathAction} className="mt-6">
                    <input type="hidden" name="planCode" value={organizerPlan.code} />
                    <button
                      type="submit"
                      className="w-full rounded-xl bg-sky-600 px-4 py-3 text-sm font-medium text-white hover:bg-sky-700"
                    >
                      Start Organizer Trial
                    </button>
                  </form>
                </div>
              </div>
            </div>

            <div className="mt-10 rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
              <div className="grid gap-6 lg:grid-cols-[1fr_auto] lg:items-center">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
                    Need another path?
                  </p>
                  <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">
                    DanceFlow also supports studios and public discovery users
                  </h2>
                  <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">
                    Studio paths continue into studio pricing and trials. Public users
                    can create a free discovery account to favorite studios and events.
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
                    href="/get-started/studio"
                    className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Studio Pricing
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