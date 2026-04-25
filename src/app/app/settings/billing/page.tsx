import Link from "next/link";
import { redirect } from "next/navigation";
import type { ComponentType } from "react";
import {
  ArrowRight,
  CreditCard,
  ShieldCheck,
  Sparkles,
  Wallet,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";
import {
  BILLING_PLANS,
  formatPlanMoney,
  getBillingPlan,
  type BillingPlan,
  type PlanAudience,
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

type SubscriptionRow = {
  status: string | null;
  subscription_plans:
    | { code: string | null }
    | { code: string | null }[]
    | null;
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

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function parseSingleSearchParam(
  value: string | string[] | undefined
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function getBillingReason(value?: string) {
  if (value === "access_paused") {
    return value;
  }

  return "default";
}

function isPlanCode(value: string | undefined): value is PlanCode {
  return (
    value === "starter" ||
    value === "growth" ||
    value === "pro" ||
    value === "organizer"
  );
}

function isAudience(value: string | undefined): value is PlanAudience {
  return value === "studio" || value === "organizer";
}

function canManageBilling(role: string | null | undefined, isPlatformAdminRole: boolean) {
  if (isPlatformAdminRole) return true;
  return role === "studio_owner" || role === "organizer_owner";
}

function getAudienceFromRole(role: string | null | undefined): PlanAudience {
  return role === "organizer_owner" || role === "organizer_admin"
    ? "organizer"
    : "studio";
}

function formatStripeRequirementLabel(value: string) {
  return value.replaceAll(".", " → ").replaceAll("_", " ");
}

function badgeClasses(
  tone: "green" | "yellow" | "red" | "slate" | "violet" | "sky"
) {
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
      return "Not started";
  }
}

function getCurrentPlanCode(row: SubscriptionRow | null) {
  if (!row) return null;
  const plan = Array.isArray(row.subscription_plans)
    ? row.subscription_plans[0]
    : row.subscription_plans;
  return plan?.code ?? null;
}

function getEntryMode(value?: string) {
  if (
    value === "trial-complete" ||
    value === "chooser" ||
    value === "no-card-trial"
  ) {
    return value;
  }
  return "default";
}

function getPostTrialDashboardPath(audience: PlanAudience) {
  return audience === "organizer" ? "/app/events" : "/app";
}

function getWorkspaceTone(audience: PlanAudience) {
  return audience === "organizer" ? "violet" : "sky";
}

function getWorkspaceTitle(audience: PlanAudience) {
  return audience === "organizer" ? "Organizer billing" : "Studio billing";
}

function getConnectStatus(connect: StudioConnectReadiness) {
  if (!connect.connectedAccountId) {
    return {
      label: "Not connected",
      tone: "slate" as const,
      description:
        "Connect Stripe so this workspace can accept payments and receive payouts.",
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
      label: "Ready",
      tone: "green" as const,
      description:
        "Stripe payouts are connected and ready for payment flows.",
      buttonLabel: "Update payout details",
    };
  }

  if (connect.detailsSubmitted) {
    return {
      label: "Action required",
      tone: "yellow" as const,
      description:
        "Stripe still needs additional information or capability approval.",
      buttonLabel: "Continue onboarding",
    };
  }

  return {
    label: "In progress",
    tone: "yellow" as const,
    description: "Finish the payout onboarding flow to enable money movement.",
    buttonLabel: "Continue onboarding",
  };
}

function getSuccessMessage(
  success?: string,
  audience?: PlanAudience
): { title: string; body: string; tone: "green" | "sky" | "violet" } | null {
  if (!success) return null;

  if (success === "subscription_checkout_started") {
    return {
      title: "Checkout opened",
      body:
        audience === "organizer"
          ? "Complete billing setup to begin your organizer trial."
          : "Complete billing setup to begin your studio trial.",
      tone: audience === "organizer" ? "violet" : "sky",
    };
  }

  if (success === "manage_subscription") {
    return {
      title: "Billing portal opened",
      body: "You were redirected to manage your existing subscription.",
      tone: "green",
    };
  }

  if (success === "current_plan") {
    return {
      title: "Already on this plan",
      body:
        "This workspace is already on that plan. Use subscription management to make changes.",
      tone: "green",
    };
  }

  if (success === "stripe_connected") {
    return {
      title: "Stripe connected",
      body: "Your payout account is now connected to this workspace.",
      tone: "green",
    };
  }

  return null;
}

function getErrorMessage(error?: string) {
  if (!error) return null;

  const messages: Record<string, string> = {
    plan_not_found: "The selected billing plan could not be found.",
    checkout_failed: "Billing checkout could not be started.",
    checkout_cancelled: "Billing checkout was canceled.",
    studio_not_found: "The current workspace could not be loaded.",
    no_studio_context: "No active workspace was selected for billing.",
    missing_price_id: "The selected plan is missing a Stripe price ID.",
    connect_failed: "Stripe onboarding could not be started.",
  };

  return messages[error] ?? "Something went wrong while loading billing.";
}

function isManagedSubscriptionStatus(status: string | null | undefined) {
  return ["active", "trialing", "past_due", "unpaid"].includes(status ?? "");
}

function InfoCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-sm text-slate-500">{label}</p>
          <p className="mt-1 text-lg font-semibold text-slate-950">{value}</p>
        </div>
      </div>
    </div>
  );
}

function PlanCard({
  plan,
  selectedAudience,
  isCurrent,
  isRecommended,
  entryMode,
  hasManagedSubscription,
}: {
  plan: BillingPlan;
  selectedAudience: PlanAudience;
  isCurrent: boolean;
  isRecommended: boolean;
  entryMode: string;
  hasManagedSubscription: boolean;
}) {
  const ctaLabel = isCurrent
    ? "Current Plan"
    : hasManagedSubscription
      ? "Change Plan"
      : `Start ${plan.label} Trial`;

  return (
    <div
      className={[
        "rounded-[28px] border bg-white p-6 shadow-sm",
        isRecommended ? "border-violet-300 ring-2 ring-violet-100" : "border-slate-200",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
            {plan.audience === "organizer" ? "Organizer Plan" : "Studio Plan"}
          </p>
          <h3 className="mt-2 text-2xl font-semibold text-slate-950">{plan.label}</h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">{plan.description}</p>
        </div>

        <div className="flex flex-col items-end gap-2">
          {isCurrent ? (
            <span
              className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${badgeClasses(
                "green"
              )}`}
            >
              Current plan
            </span>
          ) : null}

          {isRecommended ? (
            <span
              className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${badgeClasses(
                "violet"
              )}`}
            >
              Recommended
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-6">
        <p className="text-3xl font-semibold text-slate-950">
          {formatPlanMoney(plan.amountMonthlyCents)}
          <span className="ml-1 text-base font-medium text-slate-500">/month</span>
        </p>
        <p className="mt-2 text-sm text-slate-500">{plan.trialDays}-day free trial</p>
      </div>

      <ul className="mt-6 space-y-2 text-sm text-slate-600">
        {plan.highlights.map((highlight) => (
          <li key={highlight}>• {highlight}</li>
        ))}
      </ul>

      {plan.transparentFeeNote ? (
        <div className="mt-5 rounded-2xl border border-violet-200 bg-violet-50 p-4 text-sm text-violet-800">
          {plan.transparentFeeNote}
        </div>
      ) : null}

      <form action="/api/billing/checkout" method="post" className="mt-6">
        <input type="hidden" name="planCode" value={plan.code} />
        <input type="hidden" name="path" value={selectedAudience} />
        <input type="hidden" name="entry" value={entryMode} />
        <input type="hidden" name="billingInterval" value="month" />

        <button
          type="submit"
          disabled={isCurrent}
          className={[
            "inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium transition",
            isCurrent
              ? "cursor-not-allowed border border-slate-300 bg-white text-slate-500"
              : "bg-slate-900 text-white hover:bg-slate-800",
          ].join(" ")}
        >
          <span>{ctaLabel}</span>
          {!isCurrent ? <ArrowRight className="h-4 w-4" /> : null}
        </button>
      </form>
    </div>
  );
}

export default async function BillingSettingsPage({
  searchParams,
}: {
  searchParams?: SearchParams;
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
    redirect("/account");
  }

  const canAccessBilling = canManageBilling(
    context.studioRole,
    context.isPlatformAdmin
  );

  const studioId = context.studioId;

  if (!canAccessBilling) {
    const workspaceAudience: PlanAudience = getAudienceFromRole(context.studioRole);

    return (
      <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
        <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
          <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                {workspaceAudience === "organizer" ? "DanceFlow Organizer Billing" : "DanceFlow Studio Billing"}
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Billing &amp; Payouts
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                This page is reserved for the account owner so billing, payouts, and subscription changes stay protected.
              </p>
            </div>
          </div>

          <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="text-lg font-semibold text-amber-950">
                You do not have access to billing settings
              </h2>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                Billing and payout controls are limited to the workspace owner. Please ask the studio owner or organizer owner to make billing changes for this account.
              </p>

              <div className="mt-5 flex flex-wrap gap-3">
                <Link
                  href="/app"
                  className="rounded-xl bg-amber-900 px-4 py-2 text-sm font-medium text-white hover:bg-amber-800"
                >
                  Back to Dashboard
                </Link>

                <Link
                  href="/app/notifications"
                  className="rounded-xl border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100"
                >
                  Open Notifications
                </Link>
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

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
    .maybeSingle<SubscriptionRow>();

  const successParam = parseSingleSearchParam(resolvedSearchParams.success);
const errorParam = parseSingleSearchParam(resolvedSearchParams.error);
const entryParam = parseSingleSearchParam(resolvedSearchParams.entry);
const reasonParam = parseSingleSearchParam(resolvedSearchParams.reason);
  const pathParam = parseSingleSearchParam(resolvedSearchParams.path);
  const recommendedParam = parseSingleSearchParam(resolvedSearchParams.recommended);

  const inferredAudience: PlanAudience = getAudienceFromRole(context.studioRole);

  const selectedAudience: PlanAudience =
    (isAudience(pathParam) ? pathParam : undefined) ?? inferredAudience;

  const entryMode = getEntryMode(entryParam);

  const currentPlanCode = getCurrentPlanCode(currentSubscriptionRow ?? null);
  const currentPlan =
    currentPlanCode && isPlanCode(currentPlanCode)
      ? getBillingPlan(currentPlanCode)
      : null;

  const recommendedPlanCode =
    (isPlanCode(recommendedParam) ? recommendedParam : undefined) ??
    (selectedAudience === "organizer" ? "organizer" : undefined);

  const recommendedPlan =
    recommendedPlanCode ? getBillingPlan(recommendedPlanCode) : null;

  const effectiveSubscriptionStatus =
    currentSubscriptionRow?.status ?? studio.subscription_status ?? "not_started";

  const hasManagedSubscription = isManagedSubscriptionStatus(
    effectiveSubscriptionStatus
  );

  const isTrialCompleteEntry = entryMode === "trial-complete";
  const billingReason = getBillingReason(reasonParam);
  const isAccessPaused = billingReason === "access_paused";
  const showWorkspaceButton = hasManagedSubscription && !isAccessPaused;
  const showPayoutsCard = !isTrialCompleteEntry || hasManagedSubscription;

  const visiblePlans = BILLING_PLANS.filter((plan) => plan.audience === selectedAudience);

  const connectReadinessBase: StudioConnectReadiness = {
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

  let connectReadiness = connectReadinessBase;

  if (showPayoutsCard && studio.stripe_connected_account_id) {
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
          connectedAccount.details_submitted ??
          (studio.stripe_connect_onboarding_complete ?? false),
        cardPaymentsEnabled:
          connectedAccount.capabilities?.card_payments === "active",
        transfersEnabled: connectedAccount.capabilities?.transfers === "active",
        currentlyDue: connectedAccount.requirements?.currently_due ?? [],
        eventuallyDue: connectedAccount.requirements?.eventually_due ?? [],
        pendingVerification: connectedAccount.requirements?.pending_verification ?? [],
        disabledReason: connectedAccount.requirements?.disabled_reason ?? null,
      };
    } catch (error) {
      console.error("Failed to retrieve connected account readiness", error);
    }
  }

  const connectStatus = getConnectStatus(connectReadiness);
  const successMessage = getSuccessMessage(successParam, selectedAudience);
  const errorMessage = getErrorMessage(errorParam);

  return (
    <main className="min-h-screen bg-slate-50">
      <section className="border-b border-slate-200/70 bg-white">
        <div className="mx-auto max-w-7xl px-6 py-12">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <span
                className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${badgeClasses(
                  getWorkspaceTone(selectedAudience)
                )}`}
              >
                {getWorkspaceTitle(selectedAudience)}
              </span>

              <h1 className="mt-4 text-4xl font-semibold tracking-tight text-slate-950">
                Billing & Payouts
              </h1>

              <p className="mt-3 max-w-3xl text-lg leading-8 text-slate-600">
                {isTrialCompleteEntry && !hasManagedSubscription
                  ? `Start your ${
                      selectedAudience === "organizer" ? "organizer" : "studio"
                    } subscription and begin your free trial.`
                  : `Manage your subscription, connect Stripe, and keep this ${
                      selectedAudience === "organizer" ? "organizer" : "studio"
                    } workspace ready for payments.`}
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              {hasManagedSubscription && studio.stripe_customer_id ? (
                <form action="/api/billing/portal" method="post">
                  <button
                    type="submit"
                    className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Open Billing Portal
                  </button>
                </form>
              ) : null}

              {showWorkspaceButton ? (
                <Link
                  href={getPostTrialDashboardPath(selectedAudience)}
                  className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                >
                  Go to Workspace
                </Link>
              ) : null}
            </div>
          </div>

          {isTrialCompleteEntry && !hasManagedSubscription ? (
            <div
              className={`mt-8 rounded-2xl border p-4 text-sm ${
                selectedAudience === "organizer"
                  ? "border-violet-200 bg-violet-50 text-violet-800"
                  : "border-sky-200 bg-sky-50 text-sky-800"
              }`}
            >
              {selectedAudience === "organizer"
                ? "Complete billing first to begin your organizer trial. Payout setup comes after your subscription is started."
                : "Complete billing first to begin your studio trial. Payout setup comes after your subscription is started."}
            </div>
          ) : entryMode === "trial-complete" ? (
            <div
              className={`mt-8 rounded-2xl border p-4 text-sm ${
                selectedAudience === "organizer"
                  ? "border-violet-200 bg-violet-50 text-violet-800"
                  : "border-sky-200 bg-sky-50 text-sky-800"
              }`}
            >
              {selectedAudience === "organizer"
                ? "Your organizer trial is active. You can manage billing, continue into the workspace, and complete payouts when needed."
                : "Your studio trial is active. You can manage billing, continue into the workspace, and complete payouts when needed."}
            </div>
          ) : null}

          {isAccessPaused ? (
            <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
              <p className="font-semibold">Workspace access paused</p>
              <p className="mt-1">
                Billing must be resolved before access to this workspace is restored.
                Update your subscription or payment method below to regain access.
              </p>
            </div>
          ) : null}

          {successMessage ? (
            <div
              className={`mt-6 rounded-2xl border p-4 text-sm ${
                successMessage.tone === "green"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : successMessage.tone === "violet"
                    ? "border-violet-200 bg-violet-50 text-violet-800"
                    : "border-sky-200 bg-sky-50 text-sky-800"
              }`}
            >
              <p className="font-semibold">{successMessage.title}</p>
              <p className="mt-1">{successMessage.body}</p>
            </div>
          ) : null}

          {errorMessage ? (
            <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
              <p className="font-semibold">Billing issue</p>
              <p className="mt-1">{errorMessage}</p>
            </div>
          ) : null}

          <div className="mt-8 grid gap-4 md:grid-cols-3">
            <InfoCard
              label="Workspace"
              value={studio.name ?? "Workspace"}
              icon={Sparkles}
            />
            <InfoCard
              label="Subscription"
              value={getSubscriptionLabel(effectiveSubscriptionStatus)}
              icon={CreditCard}
            />
            <InfoCard
              label={showPayoutsCard ? "Payout setup" : "Next step"}
              value={showPayoutsCard ? connectStatus.label : "Complete billing"}
              icon={showPayoutsCard ? Wallet : ArrowRight}
            />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-10">
        <div className="grid gap-8 xl:grid-cols-[1.15fr_0.85fr]">
          <div className="space-y-8">
            <div className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
              <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Subscription
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                    Choose the right {" "}
                    {selectedAudience === "organizer" ? "organizer" : "studio"} plan
                  </h2>
                  <p className="mt-2 text-sm leading-7 text-slate-600">
                    {selectedAudience === "organizer"
                      ? "Organizer billing focuses on public event pages, registrations, ticketing, and transparent event-sale fees."
                      : "Studio billing focuses on CRM, scheduling, operations, and studio growth."}
                  </p>
                </div>

                <span
                  className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${badgeClasses(
                    getSubscriptionTone(effectiveSubscriptionStatus)
                  )}`}
                >
                  {getSubscriptionLabel(effectiveSubscriptionStatus)}
                </span>
              </div>

              {currentPlan ? (
                <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                  Current plan:{" "}
                  <span className="font-semibold text-slate-950">{currentPlan.label}</span>
                </div>
              ) : null}

              {hasManagedSubscription ? (
                <div className="mt-4 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-800">
                  This workspace already has a subscription. Choosing another plan will
                  take you to subscription management instead of creating a second
                  subscription.
                </div>
              ) : (
                <div className="mt-4 rounded-2xl border border-violet-200 bg-violet-50 p-4 text-sm text-violet-800">
                  Start billing first. Workspace access and payout setup should come after the subscription is active.
                </div>
              )}

              <div className="mt-6 grid gap-6 lg:grid-cols-2">
                {visiblePlans.map((plan) => (
                  <PlanCard
                    key={plan.code}
                    plan={plan}
                    selectedAudience={selectedAudience}
                    isCurrent={currentPlan?.code === plan.code}
                    isRecommended={recommendedPlan?.code === plan.code}
                    entryMode={entryMode}
                    hasManagedSubscription={hasManagedSubscription}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-8">
            {showPayoutsCard ? (
              <div className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
                <div className="flex items-start gap-3">
                  <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
                    <ShieldCheck className="h-5 w-5" />
                  </div>

                  <div className="min-w-0">
                    <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                      Stripe Payouts
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                      Connect payout details
                    </h2>
                    <p className="mt-2 text-sm leading-7 text-slate-600">
                      {connectStatus.description}
                    </p>
                  </div>
                </div>

                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <span
                    className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${badgeClasses(
                      connectStatus.tone
                    )}`}
                  >
                    {connectStatus.label}
                  </span>

                  <a
                    href="/api/stripe/connect/onboarding"
                    className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                  >
                    <span>{connectStatus.buttonLabel}</span>
                    <ArrowRight className="h-4 w-4" />
                  </a>
                </div>

                {connectReadiness.disabledReason ? (
                  <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                    Stripe disabled reason:{" "}
                    {formatStripeRequirementLabel(connectReadiness.disabledReason)}
                  </div>
                ) : null}

                {connectReadiness.currentlyDue.length > 0 ? (
                  <div className="mt-5">
                    <p className="text-sm font-semibold text-slate-900">Currently due</p>
                    <ul className="mt-2 space-y-2 text-sm text-slate-600">
                      {connectReadiness.currentlyDue.slice(0, 8).map((item) => (
                        <li key={item}>• {formatStripeRequirementLabel(item)}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {connectReadiness.pendingVerification.length > 0 ? (
                  <div className="mt-5">
                    <p className="text-sm font-semibold text-slate-900">
                      Pending verification
                    </p>
                    <ul className="mt-2 space-y-2 text-sm text-slate-600">
                      {connectReadiness.pendingVerification.slice(0, 8).map((item) => (
                        <li key={item}>• {formatStripeRequirementLabel(item)}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                Workspace Fit
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                {selectedAudience === "organizer"
                  ? "Organizer-first billing view"
                  : "Studio-first billing view"}
              </h2>

              <p className="mt-3 text-sm leading-7 text-slate-600">
                {selectedAudience === "organizer"
                  ? "This billing view is tuned for event publishing, registrations, ticketing, and payout readiness."
                  : "This billing view is tuned for studio operations, customer billing, and growth features."}
              </p>

              {selectedAudience === "organizer" ? (
                <div className="mt-5 rounded-2xl border border-violet-200 bg-violet-50 p-4 text-sm text-violet-800">
                  Transparent fees: 2.5% Square processing fee + 3.5% DanceFlow platform fee on ticket sales.
                </div>
              ) : null}
            </div>

            <div className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                Next Step
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                Continue into the correct workspace
              </h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                {selectedAudience === "organizer"
                  ? "Your organizer trial is active. Continue into event operations and complete payouts when needed."
                  : "Your studio trial is active. Continue into the workspace and finish billing setup as needed."}
              </p>

              <div className="mt-6">
                <Link
                  href="/app"
                  className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-800"
                >
                  <span>
                    {selectedAudience === "organizer"
                      ? "Go to Organizer Workspace"
                      : "Go to Studio Workspace"}
                  </span>
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}