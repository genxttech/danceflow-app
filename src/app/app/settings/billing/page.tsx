import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";
import {
  BILLING_PLANS,
  formatPlanMoney,
  getBillingPlan,
  type PlanCode,
} from "@/lib/billing/plans";

type StudioBillingRow = {
  id: string;
  name: string | null;
  subscription_status: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_connected_account_id: string | null;
  stripe_connect_details_submitted: boolean | null;
  stripe_connect_charges_enabled: boolean | null;
  stripe_connect_payouts_enabled: boolean | null;
  stripe_connect_onboarding_complete: boolean | null;
};

type StudioConnectReadiness = {
  connectedAccountId: string | null;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  onboardingComplete: boolean;
  cardPaymentsEnabled: boolean;
  transfersEnabled: boolean;
  currentlyDue: string[];
  eventuallyDue: string[];
  pendingVerification: string[];
  disabledReason: string | null;
};

function formatStripeRequirementLabel(value: string) {
  return value.replaceAll(".", " → ").replaceAll("_", " ");
}

function statusBadgeClasses(tone: "green" | "yellow" | "red" | "slate" | "violet" | "sky") {
  switch (tone) {
    case "green":
      return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
    case "yellow":
      return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
    case "red":
      return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
    case "violet":
      return "bg-violet-50 text-violet-700 ring-1 ring-violet-200";
    case "sky":
      return "bg-sky-50 text-sky-700 ring-1 ring-sky-200";
    default:
      return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
  }
}

function getSubscriptionTone(
  status: string | null
): "green" | "yellow" | "red" | "slate" {
  if (status === "active" || status === "trialing") return "green";
  if (status === "past_due" || status === "incomplete") return "yellow";
  if (status === "canceled" || status === "unpaid") return "red";
  return "slate";
}

function getSubscriptionLabel(status: string | null) {
  switch (status) {
    case "trialing":
      return "Trial";
    case "active":
      return "Subscribed";
    case "canceled":
      return "Canceled";
    case "past_due":
      return "Past due";
    case "incomplete":
      return "Incomplete";
    case "unpaid":
      return "Unpaid";
    default:
      return (status ?? "Not started").replaceAll("_", " ");
  }
}

function getConnectStatus(connect: StudioConnectReadiness) {
  if (!connect.connectedAccountId) {
    return {
      label: "Not connected",
      tone: "slate" as const,
      description:
        "Connect Stripe so your studio can accept payments and receive payouts.",
      buttonLabel: "Connect Stripe",
    };
  }

  if (
    connect.onboardingComplete &&
    connect.chargesEnabled &&
    connect.payoutsEnabled &&
    connect.cardPaymentsEnabled &&
    connect.transfersEnabled
  ) {
    return {
      label: "Direct-charge ready",
      tone: "green" as const,
      description:
        "Your payout account is ready for direct-charge payment flows, including Organizer ticket sales.",
      buttonLabel: "Update payout details",
    };
  }

  if (connect.detailsSubmitted) {
    return {
      label: "Action required",
      tone: "yellow" as const,
      description:
        "Stripe still needs additional capabilities or information before direct-charge payment flows are fully enabled.",
      buttonLabel: "Continue onboarding",
    };
  }

  return {
    label: "In progress",
    tone: "yellow" as const,
    description:
      "Your connected Stripe account exists, but onboarding is not complete yet.",
    buttonLabel: "Continue onboarding",
  };
}

function parseSingleSearchParam(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isPlanCode(value: string | undefined): value is PlanCode {
  return value === "starter" || value === "growth" || value === "pro" || value === "organizer";
}

function isPlanAudience(value: string | undefined): value is "studio" | "organizer" {
  return value === "studio" || value === "organizer";
}

export default async function BillingSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const stripe = getStripe();
  const resolvedSearchParams = (await searchParams) ?? {};

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  if (!context?.studioId) {
    redirect("/app");
  }

  const studioId = context.studioId;

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select(
      `
        id,
        name,
        subscription_status,
        stripe_customer_id,
        stripe_subscription_id,
        stripe_connected_account_id,
        stripe_connect_details_submitted,
        stripe_connect_charges_enabled,
        stripe_connect_payouts_enabled,
        stripe_connect_onboarding_complete
      `
    )
    .eq("id", studioId)
    .single<StudioBillingRow>();

  if (studioError || !studio) {
    redirect("/app");
  }

  let connectReadiness: StudioConnectReadiness = {
    connectedAccountId: studio.stripe_connected_account_id ?? null,
    detailsSubmitted: studio.stripe_connect_details_submitted ?? false,
    chargesEnabled: studio.stripe_connect_charges_enabled ?? false,
    payoutsEnabled: studio.stripe_connect_payouts_enabled ?? false,
    onboardingComplete: studio.stripe_connect_onboarding_complete ?? false,
    cardPaymentsEnabled: false,
    transfersEnabled: false,
    currentlyDue: [],
    eventuallyDue: [],
    pendingVerification: [],
    disabledReason: null,
  };

  if (studio.stripe_connected_account_id) {
    try {
      const connectedAccount = await stripe.accounts.retrieve(
        studio.stripe_connected_account_id
      );

      connectReadiness = {
        connectedAccountId: studio.stripe_connected_account_id,
        detailsSubmitted:
          connectedAccount.details_submitted ??
          (studio.stripe_connect_details_submitted ?? false),
        chargesEnabled:
          connectedAccount.charges_enabled ??
          (studio.stripe_connect_charges_enabled ?? false),
        payoutsEnabled:
          connectedAccount.payouts_enabled ??
          (studio.stripe_connect_payouts_enabled ?? false),
        onboardingComplete:
          (connectedAccount.details_submitted ?? false) &&
          (connectedAccount.charges_enabled ?? false) &&
          (connectedAccount.payouts_enabled ?? false),
        cardPaymentsEnabled:
          connectedAccount.capabilities?.card_payments === "active",
        transfersEnabled:
          connectedAccount.capabilities?.transfers === "active",
        currentlyDue: connectedAccount.requirements?.currently_due ?? [],
        eventuallyDue: connectedAccount.requirements?.eventually_due ?? [],
        pendingVerification:
          connectedAccount.requirements?.pending_verification ?? [],
        disabledReason: connectedAccount.requirements?.disabled_reason ?? null,
      };
    } catch (error) {
      console.error("Could not retrieve Stripe connected account capabilities:", error);
    }
  }

  const { data: currentSubscriptionRow } = await supabase
    .from("studio_subscriptions")
    .select(
      `
      status,
      subscription_plans (
        code
      )
    `
    )
    .eq("studio_id", studio.id)
    .maybeSingle();

  const currentPlanCode = (() => {
    if (!currentSubscriptionRow) return null;
    const subscriptionPlan = Array.isArray(currentSubscriptionRow.subscription_plans)
      ? currentSubscriptionRow.subscription_plans[0]
      : currentSubscriptionRow.subscription_plans;
    return subscriptionPlan?.code ?? null;
  })();

  let portalUrl: string | null = null;

  if (studio.stripe_customer_id && studio.stripe_subscription_id) {
    const subscriptions = await stripe.subscriptions.list({
      customer: studio.stripe_customer_id,
      limit: 10,
      status: "all",
    });

    const currentSubscription = subscriptions.data.find(
      (sub) => sub.id === studio.stripe_subscription_id
    );

    if (currentSubscription) {
      const session = await stripe.billingPortal.sessions.create({
        customer: studio.stripe_customer_id,
        return_url: `${
          process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
        }/app/settings/billing`,
      });

      portalUrl = session.url;
    }
  }

  const subscriptionStatus = studio.subscription_status ?? "not_started";
  const currentPlan = currentPlanCode ? getBillingPlan(currentPlanCode) : null;
  const hasManagedSubscription =
    Boolean(studio.stripe_customer_id) &&
    Boolean(studio.stripe_subscription_id) &&
    ["active", "trialing", "past_due", "unpaid"].includes(subscriptionStatus);

  const connectStatus = getConnectStatus(connectReadiness);

    const successParam = parseSingleSearchParam(resolvedSearchParams.success);
  const errorParam = parseSingleSearchParam(resolvedSearchParams.error);
  const entryParam = parseSingleSearchParam(resolvedSearchParams.entry);
  const recommendedParam = parseSingleSearchParam(resolvedSearchParams.recommended);
  const pathParam = parseSingleSearchParam(resolvedSearchParams.path);

  const recommendedPlanCode = isPlanCode(recommendedParam) ? recommendedParam : undefined;
  const recommendedPlan = recommendedPlanCode ? getBillingPlan(recommendedPlanCode) : null;
  const selectedPath = isPlanAudience(pathParam) ? pathParam : undefined;

  const studioPlans = BILLING_PLANS.filter((plan) => plan.audience === "studio");
  const organizerPlans = BILLING_PLANS.filter((plan) => plan.audience === "organizer");

  const visibleStudioPlans =
    selectedPath === "organizer" ? [] : studioPlans;

  const visibleOrganizerPlans =
    selectedPath === "studio" ? [] : organizerPlans;

  const pageTitle =
    selectedPath === "studio"
      ? "Studio billing"
      : selectedPath === "organizer"
      ? "Organizer billing"
      : "Billing & payments";

  const pageDescription =
    selectedPath === "studio"
      ? "Choose the studio plan that fits your operations and growth goals."
      : selectedPath === "organizer"
      ? "Activate your organizer plan for public events, registrations, and ticketing."
      : "Manage your DanceFlow subscription and connect your payout account.";

  return (
    <div className="space-y-6">
            <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {pageTitle}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          {pageDescription}
        </p>
      </div>

            {entryParam === "chooser" && recommendedPlan ? (
        <div className="rounded-2xl border border-[var(--brand-primary)] bg-[var(--brand-primary-soft)]/40 px-4 py-3 text-sm text-slate-800">
          Based on your selected path, the recommended plan is{" "}
          <span className="font-semibold">{recommendedPlan.label}</span>.
          {selectedPath === "studio"
            ? " You are currently viewing the studio billing path."
            : selectedPath === "organizer"
            ? " You are currently viewing the organizer billing path."
            : " You can still choose any eligible plan below."}
        </div>
      ) : null}

      {successParam ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {successParam === "stripe_connect_updated"
            ? "Your Stripe payout account was updated successfully."
            : "Billing update completed successfully."}
        </div>
      ) : null}

      {errorParam ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {errorParam === "no_studio_context" &&
            "No studio context was found for this account."}
          {errorParam === "studio_not_found" &&
            "Studio record could not be found."}
          {errorParam === "save_connected_account_failed" &&
            "The connected Stripe account was created but could not be saved locally."}
          {errorParam === "missing_connected_account" &&
            "No Stripe connected account was found for this studio."}
          {errorParam === "sync_connected_account_failed" &&
            "Stripe returned successfully, but the account status could not be synced."}
          {![
            "no_studio_context",
            "studio_not_found",
            "save_connected_account_failed",
            "missing_connected_account",
            "sync_connected_account_failed",
          ].includes(errorParam)
            ? "Something went wrong while updating billing."
            : null}
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                    <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                {selectedPath === "studio"
                  ? "Studio plans"
                  : selectedPath === "organizer"
                  ? "Organizer plan"
                  : "DanceFlow subscription"}
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {selectedPath === "studio"
                  ? "Choose the studio tier that best matches your workflow and growth stage."
                  : selectedPath === "organizer"
                  ? "Activate the organizer plan for public events, ticketing, and attendee management."
                  : "Choose the plan that fits how this account will use DanceFlow."}
              </p>
            </div>

            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClasses(
                getSubscriptionTone(subscriptionStatus)
              )}`}
            >
              {getSubscriptionLabel(subscriptionStatus)}
            </span>
          </div>

          {currentPlan ? (
            <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-sm text-slate-500">Current plan</p>
              <p className="mt-1 text-base font-semibold text-slate-900">
                {currentPlan.label}
              </p>
            </div>
          ) : null}

                    <div className="mt-6 space-y-6">
            {visibleStudioPlans.length > 0 ? (
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-violet-600">
                    Studio plans
                  </h3>
                  <span className="rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-700">
                    14-day trial
                  </span>
                </div>

                <div className="space-y-3">
                  {visibleStudioPlans.map((plan) => {
                    const isCurrentPlan = currentPlanCode === plan.code;
                    const isRecommended = recommendedPlanCode === plan.code;

                    const changeLabel =
                      currentPlan && plan.amountMonthlyCents > currentPlan.amountMonthlyCents
                        ? "Upgrade in billing portal"
                        : currentPlan && plan.amountMonthlyCents < currentPlan.amountMonthlyCents
                        ? "Downgrade in billing portal"
                        : "Choose plan";

                    return (
                      <div
                        key={plan.code}
                        className={`rounded-2xl border p-4 ${
                          isCurrentPlan
                            ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)]/40"
                            : isRecommended
                            ? "border-violet-300 bg-violet-50/50"
                            : "border-slate-200"
                        }`}
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-sm font-semibold text-slate-900">
                                {plan.label}
                              </div>

                              {isCurrentPlan ? (
                                <span className="inline-flex items-center rounded-full bg-slate-900 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white">
                                  Current plan
                                </span>
                              ) : null}

                              {isRecommended ? (
                                <span className="inline-flex items-center rounded-full bg-violet-600 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white">
                                  Recommended
                                </span>
                              ) : null}
                            </div>

                            <div className="mt-1 text-sm text-slate-600">
                              {plan.description}
                            </div>

                            <ul className="mt-3 grid gap-1 text-xs text-slate-500">
                              {plan.highlights.map((highlight) => (
                                <li key={highlight}>• {highlight}</li>
                              ))}
                            </ul>
                          </div>

                          <div className="flex items-center gap-3">
                            <div className="text-sm font-semibold text-slate-900">
                              {formatPlanMoney(plan.amountMonthlyCents)}/mo
                            </div>

                            {isCurrentPlan ? (
                              <button
                                type="button"
                                disabled
                                className="inline-flex cursor-not-allowed items-center rounded-xl border border-slate-300 bg-slate-100 px-4 py-2 text-sm font-medium text-slate-500"
                              >
                                Current plan
                              </button>
                            ) : hasManagedSubscription && portalUrl ? (
                              <Link
                                href={portalUrl}
                                className="inline-flex items-center rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                              >
                                {changeLabel}
                              </Link>
                            ) : (
                              <form action="/api/billing/checkout" method="post">
                                <input type="hidden" name="planKey" value={plan.code} />
                                <button
                                  type="submit"
                                  className="inline-flex items-center rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                                >
                                  Start trial
                                </button>
                              </form>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {visibleOrganizerPlans.length > 0 ? (
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-sky-600">
                    Organizer plan
                  </h3>
                  <span className="rounded-full bg-sky-50 px-2.5 py-1 text-[11px] font-semibold text-sky-700">
                    Event-first
                  </span>
                </div>

                <div className="space-y-3">
                  {visibleOrganizerPlans.map((plan) => {
                    const isCurrentPlan = currentPlanCode === plan.code;
                    const isRecommended = recommendedPlanCode === plan.code;

                    return (
                      <div
                        key={plan.code}
                        className={`rounded-2xl border p-4 ${
                          isCurrentPlan
                            ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)]/40"
                            : isRecommended
                            ? "border-sky-300 bg-sky-50/50"
                            : "border-slate-200"
                        }`}
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-sm font-semibold text-slate-900">
                                {plan.label}
                              </div>

                              {isCurrentPlan ? (
                                <span className="inline-flex items-center rounded-full bg-slate-900 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white">
                                  Current plan
                                </span>
                              ) : null}

                              {isRecommended ? (
                                <span className="inline-flex items-center rounded-full bg-sky-600 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white">
                                  Recommended
                                </span>
                              ) : null}
                            </div>

                            <div className="mt-1 text-sm text-slate-600">
                              {plan.description}
                            </div>

                            {plan.transparentFeeNote ? (
                              <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
                                {plan.transparentFeeNote}
                              </div>
                            ) : null}

                            <ul className="mt-3 grid gap-1 text-xs text-slate-500">
                              {plan.highlights.map((highlight) => (
                                <li key={highlight}>• {highlight}</li>
                              ))}
                            </ul>
                          </div>

                          <div className="flex items-center gap-3">
                            <div className="text-sm font-semibold text-slate-900">
                              {formatPlanMoney(plan.amountMonthlyCents)}/mo
                            </div>

                            {isCurrentPlan ? (
                              <button
                                type="button"
                                disabled
                                className="inline-flex cursor-not-allowed items-center rounded-xl border border-slate-300 bg-slate-100 px-4 py-2 text-sm font-medium text-slate-500"
                              >
                                Current plan
                              </button>
                            ) : hasManagedSubscription && portalUrl ? (
                              <Link
                                href={portalUrl}
                                className="inline-flex items-center rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                              >
                                Change in billing portal
                              </Link>
                            ) : (
                              <form action="/api/billing/checkout" method="post">
                                <input type="hidden" name="planKey" value={plan.code} />
                                <button
                                  type="submit"
                                  className="inline-flex items-center rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                                >
                                  Start trial
                                </button>
                              </form>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="pt-2">
              <p className="mb-3 text-sm text-slate-500">
                Paid studio tiers include a 14-day free trial with a card required at signup.
                Billing begins automatically when the trial ends unless canceled first.
              </p>

              <div className="flex flex-wrap items-center gap-3">
                {portalUrl ? (
                  <>
                    <Link
                      href={portalUrl}
                      className="inline-flex items-center rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Manage subscription
                    </Link>
                    <Link
                      href={portalUrl}
                      className="inline-flex items-center rounded-xl border border-rose-300 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50"
                    >
                      Cancel subscription
                    </Link>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled
                      className="inline-flex cursor-not-allowed items-center rounded-xl border border-slate-300 bg-slate-100 px-4 py-2 text-sm font-medium text-slate-500"
                    >
                      Manage subscription
                    </button>
                    <button
                      type="button"
                      disabled
                      className="inline-flex cursor-not-allowed items-center rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-400"
                    >
                      Cancel subscription
                    </button>
                  </>
                )}
              </div>

              {!portalUrl ? (
                <p className="mt-3 text-xs text-slate-500">
                  Subscription management becomes available after the Stripe billing portal session is created for this account.
                </p>
              ) : null}
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Studio payout account
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Connect Stripe to accept payments and receive payouts.
              </p>
            </div>

            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClasses(
                connectStatus.tone
              )}`}
            >
              {connectStatus.label}
            </span>
          </div>

          <div className="mt-6 space-y-4">
            <div className="rounded-2xl border border-slate-200 p-4">
              <div className="text-sm text-slate-700">
                {connectStatus.description}
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <div className="rounded-2xl bg-slate-50 p-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Details submitted
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-900">
                    {connectReadiness.detailsSubmitted ? "Yes" : "No"}
                  </div>
                </div>

                <div className="rounded-2xl bg-slate-50 p-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Charges enabled
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-900">
                    {connectReadiness.chargesEnabled ? "Yes" : "No"}
                  </div>
                </div>

                <div className="rounded-2xl bg-slate-50 p-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Payouts enabled
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-900">
                    {connectReadiness.payoutsEnabled ? "Yes" : "No"}
                  </div>
                </div>

                <div className="rounded-2xl bg-slate-50 p-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Card payments
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-900">
                    {connectReadiness.cardPaymentsEnabled ? "Active" : "Not active"}
                  </div>
                </div>

                <div className="rounded-2xl bg-slate-50 p-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Transfers
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-900">
                    {connectReadiness.transfersEnabled ? "Active" : "Not active"}
                  </div>
                </div>
              </div>

              <form
                action="/api/stripe/connect/onboarding"
                method="post"
                className="mt-4"
              >
                <button
                  type="submit"
                  className="inline-flex items-center rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                >
                  {connectStatus.buttonLabel}
                </button>
              </form>
            </div>

            {(connectReadiness.currentlyDue.length > 0 ||
              connectReadiness.pendingVerification.length > 0 ||
              connectReadiness.eventuallyDue.length > 0) && (
              <div className="space-y-3">
                {connectReadiness.currentlyDue.length > 0 ? (
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                    <p className="text-sm font-semibold text-amber-900">Currently due</p>
                    <ul className="mt-2 grid gap-1 text-sm text-amber-800">
                      {connectReadiness.currentlyDue.map((item) => (
                        <li key={item}>• {formatStripeRequirementLabel(item)}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {connectReadiness.pendingVerification.length > 0 ? (
                  <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4">
                    <p className="text-sm font-semibold text-sky-900">Pending verification</p>
                    <ul className="mt-2 grid gap-1 text-sm text-sky-800">
                      {connectReadiness.pendingVerification.map((item) => (
                        <li key={item}>• {formatStripeRequirementLabel(item)}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {connectReadiness.eventuallyDue.length > 0 ? (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <p className="text-sm font-semibold text-slate-900">Eventually due</p>
                    <ul className="mt-2 grid gap-1 text-sm text-slate-700">
                      {connectReadiness.eventuallyDue.map((item) => (
                        <li key={item}>• {formatStripeRequirementLabel(item)}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {connectReadiness.disabledReason ? (
                  <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
                    Stripe disabled reason: {formatStripeRequirementLabel(connectReadiness.disabledReason)}
                  </div>
                ) : null}
              </div>
            )}

            <div className="rounded-2xl border border-dashed border-slate-300 p-4 text-sm text-slate-600">
              Online payment features should stay gated until this payout account is fully connected.
              Organizer direct-charge ticket sales additionally require active Card payments and Transfers capabilities.
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}