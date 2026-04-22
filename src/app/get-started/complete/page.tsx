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

function workspaceLabel(value: string) {
  return value === "organizer" ? "organization" : "studio";
}

function completionTitle(value: string) {
  if (value === "organizer") return "Complete your organizer trial setup";
  return "Complete your studio trial setup";
}

function nextStepLabel(value: string) {
  if (value === "organizer") return "Continue to Organizer Billing";
  return "Continue to Studio Billing";
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

  const fullName =
    typeof user.user_metadata?.full_name === "string"
      ? user.user_metadata.full_name.trim()
      : "";

  const workspaceName =
    typeof user.user_metadata?.workspace_name === "string"
      ? user.user_metadata.workspace_name.trim()
      : "";

  return (
    <>
      <PublicSiteHeader currentPath="pricing" isAuthenticated />

      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_18%,#f8fafc_100%)]">
        <section className="border-b border-slate-200/70">
          <div className="mx-auto max-w-6xl px-6 py-14 lg:px-8 lg:py-20">
            <div className="mx-auto max-w-3xl text-center">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                Trial Setup
              </p>

              <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
                {completionTitle(intent)}
              </h1>

              <p className="mt-4 text-lg leading-8 text-slate-600">
                Your account is ready. The last step is billing so we can start your{" "}
                {plan.trialDays}-day trial and send you into the correct{" "}
                <span className="font-medium text-slate-900">
                  {audienceLabel(intent).toLowerCase()}
                </span>{" "}
                workflow.
              </p>
            </div>

            <div className="mt-8 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
              <div className="space-y-6">
                <div className="rounded-[32px] border border-[var(--brand-border)] bg-white p-7 shadow-sm">
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Your Setup
                  </p>

                  <div className="mt-5 grid gap-4 md:grid-cols-2">
                    <div className="rounded-2xl bg-slate-50 p-5">
                      <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Name
                      </p>
                      <p className="mt-2 text-xl font-semibold text-slate-900">
                        {fullName || "Account owner"}
                      </p>
                    </div>

                    <div className="rounded-2xl bg-slate-50 p-5">
                      <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                        {intent === "organizer" ? "Organization" : "Studio"}
                      </p>
                      <p className="mt-2 text-xl font-semibold text-slate-900">
                        {workspaceName || `Your ${workspaceLabel(intent)}`}
                      </p>
                    </div>

                    <div className="rounded-2xl bg-slate-50 p-5">
                      <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Plan
                      </p>
                      <p className="mt-2 text-xl font-semibold text-slate-900">
                        {plan.label}
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

                <div className="rounded-[32px] border border-violet-300 bg-white p-7 shadow-sm">
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-violet-700">
                    What Happens Next
                  </p>

                  <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">
                    We will start your trial without making you create your{" "}
                    {workspaceLabel(intent)} again
                  </h2>

                  <ul className="mt-5 space-y-3 text-sm leading-7 text-slate-600">
                    <li>• Uses the account and {workspaceLabel(intent)} name you already entered</li>
                    <li>• Starts your free trial after billing is set up</li>
                    <li>
                      • Sends {intent === "organizer" ? "organizers" : "studios"} into the
                      correct side of the platform
                    </li>
                    <li>• Reduces duplicate setup and naming confusion</li>
                  </ul>

                  {plan.transparentFeeNote ? (
                    <div className="mt-5 rounded-2xl border border-violet-200 bg-violet-50 p-4 text-sm text-violet-800">
                      {plan.transparentFeeNote}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Start Trial
                </p>

                <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">
                  Add billing and begin your free trial
                </h2>

                <p className="mt-4 text-sm leading-7 text-slate-600">
                  Billing setup keeps the trial flow cleaner, reduces abuse, and ties
                  your account to the right {workspaceLabel(intent)} from the start.
                </p>

                <form action={beginPaidTrialCheckoutAction} className="mt-8 space-y-4">
                  <input type="hidden" name="planCode" value={plan.code} />
                  <input type="hidden" name="intent" value={intent} />
                  <input type="hidden" name="workspaceName" value={workspaceName} />

                  <button
                    type="submit"
                    className="w-full rounded-xl bg-violet-600 px-4 py-3 text-sm font-medium text-white hover:bg-violet-700"
                  >
                    {nextStepLabel(intent)}
                  </button>
                </form>

                <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                  <p>
                    You can always rename your {workspaceLabel(intent)} later in settings
                    if needed.
                  </p>
                </div>

                <div className="mt-6 flex flex-wrap gap-3">
                  <Link
                    href={
                      intent === "studio"
                        ? "/get-started/studio"
                        : "/get-started/organizer"
                    }
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
            </div>
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}