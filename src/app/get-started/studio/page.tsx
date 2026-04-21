import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatPlanMoney, getPlansByAudience } from "@/lib/billing/plans";
import { startPaidPathAction } from "../actions";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";

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
                Pricing built for dance studios
              </h1>

              <p className="mt-4 text-lg leading-8 text-slate-600">
                Compare studio plans, see features clearly, and choose the trial that
                matches your operation now and where you want to grow next.
              </p>

              <div className="mt-8 rounded-2xl border border-violet-200 bg-violet-50 px-5 py-4">
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-violet-700">
                  Start with pricing, then create your account
                </p>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Studios should be able to review pricing before signing up. When you
                  click Start Trial, DanceFlow will guide you into account creation if
                  needed.
                </p>
              </div>
            </div>

            <div className="mt-12 grid gap-6 lg:grid-cols-3">
              {studioPlans.map((plan) => (
                <section
                  key={plan.code}
                  className={`rounded-[32px] border bg-white p-7 shadow-sm ${
                    plan.code === "growth"
                      ? "border-violet-400 ring-2 ring-violet-200"
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

                  <p className="mt-4 text-4xl font-semibold tracking-tight text-slate-950">
                    {formatPlanMoney(plan.amountMonthlyCents)}
                    <span className="text-base font-medium text-slate-500">/mo</span>
                  </p>

                  <p className="mt-3 text-sm leading-7 text-slate-600">
                    {plan.description}
                  </p>

                  <div className="mt-4 rounded-2xl bg-violet-50 px-4 py-3 text-sm text-violet-900">
                    Includes a {plan.trialDays}-day free trial.
                  </div>

                  <ul className="mt-6 space-y-2 text-sm leading-7 text-slate-600">
                    {plan.highlights.map((highlight) => (
                      <li key={highlight}>• {highlight}</li>
                    ))}
                  </ul>

                  <form action={startPaidPathAction} className="mt-8">
                    <input type="hidden" name="planCode" value={plan.code} />
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
              ))}
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
                    accounts continue into organizer pricing and event tools.
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