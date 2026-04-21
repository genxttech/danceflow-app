import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getBillingPlan } from "@/lib/billing/plans";
import { beginPaidTrialCheckoutAction } from "../actions";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";

type SearchParams = Promise<{
  intent?: string;
  plan?: string;
}>;

function audienceLabel(value: string) {
  if (value === "studio") return "Studio";
  if (value === "organizer") return "Organizer";
  return "Paid";
}

function getWorkspaceLabel(value: string) {
  return value === "organizer" ? "organizer workspace" : "studio workspace";
}

export default async function GetStartedCompletePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const resolved = await searchParams;

  const planCode =
    typeof resolved.plan === "string" ? resolved.plan.trim().toLowerCase() : "";
  const intent =
    typeof resolved.intent === "string"
      ? resolved.intent.trim().toLowerCase()
      : "";

  const plan = getBillingPlan(planCode);

  if (!plan || !["studio", "organizer"].includes(intent) || plan.audience !== intent) {
    redirect("/get-started");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(
      `/signup?intent=${encodeURIComponent(intent)}&plan=${encodeURIComponent(
        plan.code
      )}&next=${encodeURIComponent(
        `/get-started/complete?intent=${intent}&plan=${plan.code}`
      )}`
    );
  }

  return (
    <>
      <PublicSiteHeader currentPath="pricing" isAuthenticated />

      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_20%,#f8fafc_100%)]">
        <section className="border-b border-slate-200/70">
          <div className="mx-auto max-w-6xl px-6 py-14 lg:px-8 lg:py-20">
            <div className="mx-auto max-w-3xl text-center">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                Complete Your Trial Setup
              </p>

              <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
                Start your {audienceLabel(intent)} trial the right way
              </h1>

              <p className="mt-4 text-lg leading-8 text-slate-600">
                You are signed in. The next step is to connect billing and enter the
                correct <span className="font-medium text-slate-900">{getWorkspaceLabel(intent)}</span>.
              </p>
            </div>

            <div className="mt-8 rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
              <div className="grid gap-5 lg:grid-cols-3">
                <div className="rounded-2xl bg-slate-50 p-5">
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Plan
                  </p>
                  <p className="mt-2 text-xl font-semibold text-slate-900">{plan.label}</p>
                </div>

                <div className="rounded-2xl bg-slate-50 p-5">
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Audience
                  </p>
                  <p className="mt-2 text-xl font-semibold text-slate-900">
                    {audienceLabel(intent)}
                  </p>
                </div>

                <div className="rounded-2xl bg-slate-50 p-5">
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Trial Length
                  </p>
                  <p className="mt-2 text-xl font-semibold text-slate-900">
                    {plan.trialDays} days
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-10 rounded-[32px] border border-violet-300 bg-white p-7 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-violet-700">
                Start Your Trial
              </p>

              <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">
                Add billing and begin your free trial
              </h2>

              <p className="mt-4 text-sm leading-7 text-slate-600">
                Your {plan.trialDays}-day free trial starts after billing is set up.
                This keeps the onboarding flow cleaner, reduces abuse, and makes sure
                you enter the correct {getWorkspaceLabel(intent)} from the start.
              </p>

              <ul className="mt-5 space-y-2 text-sm text-slate-600">
                <li>• Starts the free trial immediately after billing setup</li>
                <li>• Creates or selects the right workspace for your path</li>
                <li>
                  • Sends {intent === "organizer" ? "organizers" : "studios"} into the
                  correct side of the platform after signup
                </li>
              </ul>

              {plan.transparentFeeNote ? (
                <div className="mt-5 rounded-2xl border border-violet-200 bg-violet-50 p-4 text-sm text-violet-800">
                  {plan.transparentFeeNote}
                </div>
              ) : null}

              <form action={beginPaidTrialCheckoutAction} className="mt-8">
                <input type="hidden" name="planCode" value={plan.code} />
                <input type="hidden" name="intent" value={intent} />
                <button
                  type="submit"
                  className="w-full rounded-xl bg-violet-600 px-4 py-3 text-sm font-medium text-white hover:bg-violet-700"
                >
                  Continue to Billing
                </button>
              </form>
            </div>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href={intent === "studio" ? "/get-started/studio" : "/get-started/organizer"}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Back to Pricing
              </Link>

              <Link
                href="/get-started"
                className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Back to Path Chooser
              </Link>
            </div>
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}