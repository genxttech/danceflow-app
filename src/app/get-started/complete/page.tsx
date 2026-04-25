import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  beginPaidTrialCheckoutAction,
} from "../actions";
import {
  formatPlanMoney,
  getBillingPlan,
  type PlanAudience,
} from "@/lib/billing/plans";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";

type CompletePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function readSingle(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parseAudience(value: string | undefined): PlanAudience | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "studio" || normalized === "organizer") {
    return normalized;
  }
  return null;
}

function getAudienceLabels(audience: PlanAudience) {
  if (audience === "organizer") {
    return {
      eyebrow: "Organizer setup",
      heading: "Finish your organizer trial setup",
      subheading:
        "Confirm your plan, name your organizer workspace, and continue into secure billing to activate your free trial.",
      workspaceLabel: "Organizer workspace name",
      workspacePlaceholder: "Example: Country Spark Events",
      buttonLabel: "Continue to Organizer Billing",
      pricingHref: "/get-started/organizer",
      pricingLabel: "Back to Organizer Pricing",
      appHref: "/app",
      successHeading: "Your organizer trial is active",
      successCopy:
        "Your organizer workspace is ready. Continue into your dashboard to finish setup, connect payouts, and start building events.",
    };
  }

  return {
    eyebrow: "Studio setup",
    heading: "Finish your studio trial setup",
    subheading:
      "Confirm your plan, name your studio workspace, and continue into secure billing to activate your free trial.",
    workspaceLabel: "Studio workspace name",
    workspacePlaceholder: "Example: DanceFlow Academy",
    buttonLabel: "Continue to Studio Billing",
    pricingHref: "/get-started/studio",
    pricingLabel: "Back to Studio Pricing",
    appHref: "/app",
    successHeading: "Your studio trial is active",
    successCopy:
      "Your studio workspace is ready. Continue into your dashboard to finish setup, review billing, and start building your studio operations.",
  };
}

export default async function GetStartedCompletePage({
  searchParams,
}: CompletePageProps) {
  const resolvedSearchParams = (await searchParams) ?? {};

  const intent = parseAudience(readSingle(resolvedSearchParams.intent));
  const planCode = (readSingle(resolvedSearchParams.plan) ?? "")
    .trim()
    .toLowerCase();
  const mode = (readSingle(resolvedSearchParams.mode) ?? "").trim().toLowerCase();
  const cancelled =
    (readSingle(resolvedSearchParams.cancelled) ?? "").trim().toLowerCase() === "1";

  if (!intent || !planCode) {
    redirect("/get-started");
  }

  const plan = getBillingPlan(planCode);

  if (!plan || plan.audience !== intent) {
    redirect(intent === "studio" ? "/get-started/studio" : "/get-started/organizer");
  }

  const labels = getAudienceLabels(intent);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const next = `/get-started/complete?intent=${encodeURIComponent(
      intent
    )}&plan=${encodeURIComponent(plan.code)}`;

    redirect(
      `/signup?intent=${encodeURIComponent(intent)}&plan=${encodeURIComponent(
        plan.code
      )}&next=${encodeURIComponent(next)}`
    );
  }

  const suggestedWorkspaceName =
    typeof user.user_metadata?.workspace_name === "string" &&
    user.user_metadata.workspace_name.trim()
      ? user.user_metadata.workspace_name.trim()
      : typeof user.user_metadata?.full_name === "string" &&
          user.user_metadata.full_name.trim()
        ? intent === "studio"
          ? `${user.user_metadata.full_name.trim()} Studio`
          : `${user.user_metadata.full_name.trim()} Organizer`
        : "";

  const showSuccess = mode === "success";

  return (
    <>
      <PublicSiteHeader currentPath="pricing" isAuthenticated />

      <main className="min-h-screen bg-[linear-gradient(180deg,#f5f3ff_0%,#ffffff_24%,#f8fafc_100%)]">
        <section className="border-b border-slate-200/70">
          <div className="mx-auto max-w-5xl px-6 py-14 lg:px-8 lg:py-20">
            <div className="mx-auto max-w-3xl text-center">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-600">
                {labels.eyebrow}
              </p>

              <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
                {showSuccess ? labels.successHeading : labels.heading}
              </h1>

              <p className="mt-4 text-lg leading-8 text-slate-600">
                {showSuccess ? labels.successCopy : labels.subheading}
              </p>
            </div>

            {showSuccess ? (
              <div className="mx-auto mt-10 max-w-3xl rounded-[32px] border border-emerald-200 bg-white p-8 shadow-sm">
                <div className="rounded-2xl bg-emerald-50 px-5 py-4">
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-emerald-700">
                    Trial activated
                  </p>
                  <p className="mt-2 text-sm leading-7 text-slate-600">
                    Your {plan.label} trial is active. Billing is attached to this
                    workspace and you can continue into the app now.
                  </p>
                </div>

                <div className="mt-8 grid gap-4 sm:grid-cols-2">
                  <Link
                    href={labels.appHref}
                    className="inline-flex items-center justify-center rounded-xl bg-violet-600 px-4 py-3 text-sm font-medium text-white hover:bg-violet-700"
                  >
                    Go to Dashboard
                  </Link>

                  <Link
                    href="/app/settings/billing"
                    className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    View Billing &amp; Payouts
                  </Link>
                </div>
              </div>
            ) : (
              <div className="mx-auto mt-10 grid max-w-5xl gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
                <section className="rounded-[32px] border border-slate-200 bg-white p-8 shadow-sm">
                  <div className="rounded-2xl bg-violet-50 px-5 py-4">
                    <p className="text-sm font-semibold uppercase tracking-[0.16em] text-violet-700">
                      Selected plan
                    </p>
                    <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
                      <div>
                        <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                          {plan.label}
                        </h2>
                        <p className="mt-2 text-sm leading-7 text-slate-600">
                          {plan.description}
                        </p>
                      </div>

                      <div className="text-right">
                        <p className="text-3xl font-semibold tracking-tight text-slate-950">
                          {formatPlanMoney(plan.amountMonthlyCents)}
                          <span className="text-base font-medium text-slate-500">
                            /mo
                          </span>
                        </p>
                        <p className="mt-2 text-sm font-medium text-violet-700">
                          Includes a {plan.trialDays}-day free trial
                        </p>
                      </div>
                    </div>
                  </div>

                  {cancelled ? (
                    <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
                      <p className="text-sm font-semibold uppercase tracking-[0.16em] text-amber-700">
                        Checkout cancelled
                      </p>
                      <p className="mt-2 text-sm leading-7 text-slate-600">
                        Your workspace setup is still here. Review your details below
                        and continue when you are ready.
                      </p>
                    </div>
                  ) : null}

                  <form action={beginPaidTrialCheckoutAction} className="mt-8 space-y-6">
                    <input type="hidden" name="planCode" value={plan.code} />
                    <input type="hidden" name="intent" value={intent} />

                    <div>
                      <label
                        htmlFor="workspaceName"
                        className="block text-sm font-medium text-slate-700"
                      >
                        {labels.workspaceLabel}
                      </label>
                      <input
                        id="workspaceName"
                        name="workspaceName"
                        type="text"
                        defaultValue={suggestedWorkspaceName}
                        placeholder={labels.workspacePlaceholder}
                        className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-violet-500"
                      />
                      <p className="mt-2 text-xs leading-6 text-slate-500">
                        This creates the initial workspace name used for billing and
                        onboarding. You can refine branding later.
                      </p>
                    </div>

                    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4">
                      <p className="text-sm font-medium text-slate-900">
                        What happens next
                      </p>
                      <ul className="mt-3 space-y-2 text-sm leading-7 text-slate-600">
                        <li>• Your workspace will be created or reused for this account.</li>
                        <li>• You will continue into secure Stripe checkout.</li>
                        <li>• Your free trial begins when checkout is completed.</li>
                        <li>• After that, you will land back here and continue into the app.</li>
                      </ul>
                    </div>

                    <button
                      type="submit"
                      className="w-full rounded-xl bg-violet-600 px-4 py-3 text-sm font-medium text-white hover:bg-violet-700"
                    >
                      {labels.buttonLabel}
                    </button>
                  </form>
                </section>

                <aside className="rounded-[32px] border border-slate-200 bg-white p-8 shadow-sm">
                  <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Signed in as
                  </p>
                  <h2 className="mt-3 text-2xl font-semibold text-slate-950">
                    {user.user_metadata?.full_name?.toString().trim() || user.email}
                  </h2>
                  <p className="mt-2 text-sm text-slate-600">{user.email}</p>

                  <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <p className="text-sm font-medium text-slate-900">Plan summary</p>
                    <dl className="mt-3 space-y-3 text-sm">
                      <div className="flex items-start justify-between gap-4">
                        <dt className="text-slate-500">Plan</dt>
                        <dd className="font-medium text-slate-900">{plan.label}</dd>
                      </div>
                      <div className="flex items-start justify-between gap-4">
                        <dt className="text-slate-500">Audience</dt>
                        <dd className="font-medium capitalize text-slate-900">
                          {intent}
                        </dd>
                      </div>
                      <div className="flex items-start justify-between gap-4">
                        <dt className="text-slate-500">Trial</dt>
                        <dd className="font-medium text-slate-900">
                          {plan.trialDays} days
                        </dd>
                      </div>
                      <div className="flex items-start justify-between gap-4">
                        <dt className="text-slate-500">Billing</dt>
                        <dd className="font-medium text-slate-900">Monthly</dd>
                      </div>
                    </dl>
                  </div>

                  <div className="mt-6 space-y-3">
                    <Link
                      href={labels.pricingHref}
                      className="inline-flex w-full items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      {labels.pricingLabel}
                    </Link>

                    <Link
                      href="/get-started"
                      className="inline-flex w-full items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Back to Path Chooser
                    </Link>
                  </div>
                </aside>
              </div>
            )}
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}