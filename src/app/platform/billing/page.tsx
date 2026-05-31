import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createPlatformAdminAction } from "@/app/platform/actions";

type SubscriptionPlan = {
  code: string | null;
  name: string | null;
};

type SubscriptionRow = {
  id: string;
  studio_id: string;
  status: string | null;
  billing_interval: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
  trial_ends_at: string | null;
  stripe_subscription_id: string | null;
  subscription_plans: SubscriptionPlan | SubscriptionPlan[] | null;
};

type StudioRow = {
  id: string;
  name: string;
  created_at: string;
  billing_plan: string | null;
  subscription_status: string | null;
  active: boolean | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  trial_ends_at: string | null;
  last_workspace_access_at: string | null;
  last_workspace_access_user_id: string | null;
  billing_override_enabled: boolean | null;
  billing_override_reason: string | null;
  billing_override_expires_at: string | null;
  billing_override_notes: string | null;
};

type InvoiceRow = {
  id: string;
  studio_id: string;
  studio_subscription_id: string | null;
  stripe_invoice_id: string;
  amount_due: number;
  amount_paid: number;
  currency: string;
  status: string;
  period_start: string | null;
  period_end: string | null;
  created_at: string;
};

type PlatformAdminActionRow = {
  id: string;
  target_type: string;
  target_id: string;
  action_type: string;
  note: string | null;
  created_at: string;
};

type BillingRisk = {
  key: string;
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
  studio: StudioRow;
  subscription?: SubscriptionRow;
  status: string;
  planName: string;
  recommendedAction: string;
};

type AccountRow = {
  studio: StudioRow;
  subscription?: SubscriptionRow;
  status: string;
  planName: string;
  trialEndsAt: string | null;
  trialDaysLeft: number | null;
  paidPlan: boolean;
  stripeSubscriptionId: string;
};

const PLAN_LABELS: Record<string, string> = {
  starter: "Starter",
  growth: "Growth",
  pro: "Pro",
  organizer: "Organizer",
};

function getPlan(value: SubscriptionPlan | SubscriptionPlan[] | null) {
  return Array.isArray(value) ? value[0] : value;
}

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function formatFallbackLabel(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatDate(value: string | null) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value: string | null) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatMoney(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

function statusBadgeClass(status: string | null | undefined) {
  const normalized = normalize(status);

  if (normalized === "active" || normalized === "paid") {
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  }

  if (normalized === "trialing") {
    return "bg-sky-50 text-sky-700 ring-1 ring-sky-200";
  }

  if (normalized === "past_due" || normalized === "open") {
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  }

  if (normalized === "cancelled" || normalized === "canceled" || normalized === "void") {
    return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
  }

  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function riskBadgeClass(severity: BillingRisk["severity"]) {
  if (severity === "critical") return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
  if (severity === "warning") return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  return "bg-sky-50 text-sky-700 ring-1 ring-sky-200";
}

function riskCardClass(severity: BillingRisk["severity"]) {
  if (severity === "critical") return "border-rose-200 bg-rose-50/70";
  if (severity === "warning") return "border-amber-200 bg-amber-50/70";
  return "border-sky-200 bg-sky-50/70";
}

function statusLabel(status: string | null | undefined) {
  const normalized = normalize(status);

  if (!normalized) return "Unknown";
  if (normalized === "trialing") return "Trial";
  if (normalized === "active") return "Active";
  if (normalized === "past_due") return "Past Due";
  if (normalized === "cancelled" || normalized === "canceled") return "Canceled";
  if (normalized === "not_started") return "Billing Not Started";
  if (normalized === "no_subscription") return "No Subscription";
  if (normalized === "inactive") return "Inactive";
  if (normalized === "paid") return "Paid";
  if (normalized === "open") return "Open";
  if (normalized === "draft") return "Draft";
  if (normalized === "void") return "Void";

  return formatFallbackLabel(normalized);
}

function billingIntervalLabel(value: string | null | undefined) {
  const normalized = normalize(value);

  if (normalized === "year") return "Yearly";
  if (normalized === "month") return "Monthly";
  return "—";
}

function daysUntil(dateValue: string | null) {
  if (!dateValue) return null;

  const now = new Date();
  const target = new Date(dateValue);
  const diffMs = target.getTime() - now.getTime();

  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

function isBillingOverrideActive(studio: StudioRow) {
  if (!studio.billing_override_enabled) return false;
  if (!studio.billing_override_expires_at) return true;

  return new Date(studio.billing_override_expires_at).getTime() >= Date.now();
}

function isBillingOverrideExpired(studio: StudioRow) {
  if (!studio.billing_override_enabled || !studio.billing_override_expires_at) return false;

  return new Date(studio.billing_override_expires_at).getTime() < Date.now();
}

function billingOverrideReasonLabel(reason: string | null | undefined) {
  const normalized = normalize(reason);

  if (!normalized) return "Comped Access";
  if (normalized === "ambassador") return "Ambassador";
  if (normalized === "founder") return "Founder";
  if (normalized === "internal_test") return "Internal Test";
  if (normalized === "manual_review") return "Manual Review";

  return formatFallbackLabel(normalized);
}

function billingOverrideBadgeClass(studio: StudioRow) {
  if (isBillingOverrideExpired(studio)) {
    return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
  }

  if (isBillingOverrideActive(studio)) {
    return "bg-violet-50 text-violet-700 ring-1 ring-violet-200";
  }

  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function getPlanCode(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
}) {
  const subscriptionPlan = params.subscription
    ? getPlan(params.subscription.subscription_plans)
    : null;

  return (
    normalize(subscriptionPlan?.code) ||
    normalize(params.studio.billing_plan) ||
    ""
  );
}

function getPlanName(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
}) {
  const overrideReason = billingOverrideReasonLabel(params.studio.billing_override_reason);
  const subscriptionPlan = params.subscription
    ? getPlan(params.subscription.subscription_plans)
    : null;
  const planCode = getPlanCode(params);

  const baseName =
    subscriptionPlan?.name?.trim() ||
    PLAN_LABELS[planCode] ||
    (planCode ? formatFallbackLabel(planCode) : "No plan");

  if (isBillingOverrideActive(params.studio)) {
    return `${baseName} / ${overrideReason} Comp`;
  }

  return baseName;
}

function getEffectiveBillingStatus(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
}) {
  if (isBillingOverrideActive(params.studio)) {
    return "active";
  }

  return (
    normalize(params.subscription?.status) ||
    normalize(params.studio.subscription_status) ||
    (params.studio.active === false ? "inactive" : "not_started")
  );
}

function getEffectiveTrialEndsAt(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
}) {
  return (
    params.subscription?.trial_ends_at ??
    params.studio.trial_ends_at ??
    params.subscription?.current_period_end ??
    null
  );
}

function getEffectiveStripeSubscriptionId(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
}) {
  return (
    params.subscription?.stripe_subscription_id?.trim() ||
    params.studio.stripe_subscription_id?.trim() ||
    ""
  );
}

function hasActiveBillingAccess(status: string | null | undefined) {
  const normalized = normalize(status);
  return normalized === "active" || normalized === "trialing";
}

function isPaidPlanCode(planCode: string) {
  return Boolean(planCode) && !["free", "none", "no_plan", "not_started"].includes(planCode);
}

function hasPaidPlan(params: { studio: StudioRow; subscription?: SubscriptionRow }) {
  const planCode = getPlanCode(params);
  const stripeSubscriptionId = getEffectiveStripeSubscriptionId(params);

  return isPaidPlanCode(planCode) || Boolean(stripeSubscriptionId);
}

function getRiskSummary(risks: BillingRisk[]) {
  const critical = risks.filter((risk) => risk.severity === "critical").length;
  const warning = risks.filter((risk) => risk.severity === "warning").length;
  const info = risks.filter((risk) => risk.severity === "info").length;

  return { critical, warning, info };
}

function createBillingRisks(params: {
  studios: StudioRow[];
  subscriptionByStudioId: Map<string, SubscriptionRow>;
}) {
  const risks: BillingRisk[] = [];

  for (const studio of params.studios) {
    const subscription = params.subscriptionByStudioId.get(studio.id);
    const status = getEffectiveBillingStatus({ studio, subscription });
    const planName = getPlanName({ studio, subscription });
    const paidPlan = hasPaidPlan({ studio, subscription });
    const activeAccess = hasActiveBillingAccess(status);
    const stripeSubscriptionId = getEffectiveStripeSubscriptionId({ studio, subscription });
    const trialEndsAt = getEffectiveTrialEndsAt({ studio, subscription });
    const trialDaysLeft = daysUntil(trialEndsAt);
    const overrideActive = isBillingOverrideActive(studio);
    const overrideExpired = isBillingOverrideExpired(studio);

    if (overrideExpired) {
      risks.push({
        key: `${studio.id}-billing-override-expired`,
        severity: "critical",
        title: "Comped access expired",
        description:
          "This workspace has a billing override, but the override expiration date has passed.",
        recommendedAction:
          "Extend the override, convert the workspace to paid billing, or disable paid access.",
        studio,
        subscription,
        status,
        planName,
      });
    }

    if (paidPlan && !activeAccess && !overrideActive) {
      risks.push({
        key: `${studio.id}-paid-access-no-active-subscription`,
        severity: "critical",
        title: "Paid access without active billing",
        description:
          "This workspace has a paid plan or Stripe subscription reference, but the billing status is not active or trialing.",
        recommendedAction:
          "Review access immediately. Suspend paid features or repair the subscription record.",
        studio,
        subscription,
        status,
        planName,
      });
    }

    if (status === "past_due") {
      risks.push({
        key: `${studio.id}-past-due`,
        severity: "critical",
        title: "Subscription is past due",
        description:
          "This account has a past-due billing status and may need payment follow-up.",
        recommendedAction:
          "Open the studio record, review Stripe status, and contact the owner if needed.",
        studio,
        subscription,
        status,
        planName,
      });
    }

    if (status === "trialing" && trialDaysLeft !== null && trialDaysLeft < 0) {
      risks.push({
        key: `${studio.id}-trial-expired`,
        severity: "critical",
        title: "Trial appears expired",
        description:
          "This account is still marked trialing, but the trial end date has passed.",
        recommendedAction:
          "Convert to paid billing, extend trial intentionally, or disable paid access.",
        studio,
        subscription,
        status,
        planName,
      });
    }

    if (activeAccess && !studio.stripe_customer_id && !overrideActive) {
      risks.push({
        key: `${studio.id}-missing-stripe-customer`,
        severity: "warning",
        title: "Missing Stripe customer ID",
        description:
          "This workspace is active or trialing, but the studio record does not have a Stripe customer ID.",
        recommendedAction:
          "Confirm whether the account completed checkout or needs a billing repair.",
        studio,
        subscription,
        status,
        planName,
      });
    }

    if (activeAccess && !stripeSubscriptionId && !overrideActive) {
      risks.push({
        key: `${studio.id}-missing-stripe-subscription`,
        severity: "warning",
        title: "Missing Stripe subscription ID",
        description:
          "This workspace is active or trialing, but no Stripe subscription ID is available from the studio or subscription record.",
        recommendedAction:
          "Review whether this is legitimate free access or a subscription sync issue.",
        studio,
        subscription,
        status,
        planName,
      });
    }

    if (status === "trialing" && !trialEndsAt) {
      risks.push({
        key: `${studio.id}-trial-missing-end-date`,
        severity: "warning",
        title: "Trial is missing an end date",
        description:
          "This account is trialing, but no trial end date is stored.",
        recommendedAction:
          "Add the correct trial end date so reminders and access rules stay accurate.",
        studio,
        subscription,
        status,
        planName,
      });
    }

    if (subscription?.cancel_at_period_end) {
      risks.push({
        key: `${studio.id}-cancel-at-period-end`,
        severity: "info",
        title: "Subscription set to cancel",
        description:
          "This subscription is active for now, but it is scheduled to cancel at the end of the billing period.",
        recommendedAction:
          "Monitor for churn and consider outreach before the period ends.",
        studio,
        subscription,
        status,
        planName,
      });
    }
  }

  return risks.sort((a, b) => {
    const severityRank = { critical: 0, warning: 1, info: 2 };
    const severityCompare = severityRank[a.severity] - severityRank[b.severity];

    if (severityCompare !== 0) return severityCompare;

    return a.studio.name.localeCompare(b.studio.name, undefined, {
      sensitivity: "base",
    });
  });
}

function accountSortValue(row: AccountRow) {
  const rank: Record<string, number> = {
    past_due: 0,
    trialing: 1,
    active: 2,
    canceled: 3,
    cancelled: 3,
    inactive: 4,
    not_started: 5,
    no_subscription: 5,
  };

  return rank[row.status] ?? 9;
}

function CompactMetricCard({
  label,
  value,
  helper,
  tone = "slate",
}: {
  label: string;
  value: string | number;
  helper?: string;
  tone?: "slate" | "green" | "blue" | "amber" | "rose" | "violet";
}) {
  const tones = {
    slate: "border-slate-200 bg-white text-slate-950",
    green: "border-emerald-200 bg-emerald-50 text-emerald-950",
    blue: "border-sky-200 bg-sky-50 text-sky-950",
    amber: "border-amber-200 bg-amber-50 text-amber-950",
    rose: "border-rose-200 bg-rose-50 text-rose-950",
    violet: "border-violet-200 bg-violet-50 text-violet-950",
  };

  return (
    <div className={`rounded-2xl border p-5 shadow-sm ${tones[tone]}`}>
      <p className="text-sm font-medium opacity-75">{label}</p>
      <p className="mt-2 text-3xl font-semibold">{value}</p>
      {helper ? <p className="mt-2 text-xs leading-5 opacity-75">{helper}</p> : null}
    </div>
  );
}

function getLatestActionForTarget(
  actions: PlatformAdminActionRow[],
  targetType: string,
  targetId: string
) {
  return actions
    .filter((action) => action.target_type === targetType && action.target_id === targetId)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
}

function adminActionLabel(value: string) {
  if (value === "reviewed") return "Reviewed";
  if (value === "follow_up") return "Follow-up";
  if (value === "suspended_access") return "Suspended access";
  if (value === "restored_access") return "Restored access";
  if (value === "resolved") return "Resolved";
  return "Note";
}

function StudioActionLinks({ studioId }: { studioId: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Link
        href={`/platform/studios/${studioId}`}
        className="rounded-full bg-slate-950 px-3 py-1.5 text-xs font-semibold text-white"
      >
        Open Studio
      </Link>
      <Link
        href={`/platform/studios/${studioId}#billing`}
        className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700"
      >
        Billing Details
      </Link>
    </div>
  );
}

export default async function PlatformBillingPage() {
  await requirePlatformAdmin();

  const supabase = await createClient();

  const [
    { data: subscriptions, error: subscriptionsError },
    { data: studios, error: studiosError },
    { data: invoices, error: invoicesError },
    { data: adminActions, error: adminActionsError },
  ] = await Promise.all([
    supabase
      .from("studio_subscriptions")
      .select(`
        id,
        studio_id,
        status,
        billing_interval,
        current_period_start,
        current_period_end,
        cancel_at_period_end,
        trial_ends_at,
        stripe_subscription_id,
        subscription_plans (
          code,
          name
        )
      `),

    supabase
      .from("studios")
      .select(`
        id,
        name,
        created_at,
        billing_plan,
        subscription_status,
        active,
        stripe_customer_id,
        stripe_subscription_id,
        trial_ends_at,
        last_workspace_access_at,
        last_workspace_access_user_id,
        billing_override_enabled,
        billing_override_reason,
        billing_override_expires_at,
        billing_override_notes
      `)
      .order("created_at", { ascending: false }),

    supabase
      .from("studio_invoices")
      .select(`
        id,
        studio_id,
        studio_subscription_id,
        stripe_invoice_id,
        amount_due,
        amount_paid,
        currency,
        status,
        period_start,
        period_end,
        created_at
      `)
      .order("created_at", { ascending: false })
      .limit(50),

    supabase
      .from("platform_admin_actions")
      .select("id, target_type, target_id, action_type, note, created_at")
      .in("target_type", ["billing_risk", "workspace"])
      .order("created_at", { ascending: false })
      .limit(250),
  ]);

  if (subscriptionsError) {
    throw new Error(`Failed to load subscriptions: ${subscriptionsError.message}`);
  }

  if (studiosError) {
    throw new Error(`Failed to load studios: ${studiosError.message}`);
  }

  if (invoicesError) {
    throw new Error(`Failed to load invoices: ${invoicesError.message}`);
  }
  if (adminActionsError) {
    throw new Error(`Failed to load platform admin actions: ${adminActionsError.message}`);
  }

  const typedSubscriptions = (subscriptions ?? []) as SubscriptionRow[];
  const typedStudios = (studios ?? []) as StudioRow[];
  const typedInvoices = (invoices ?? []) as InvoiceRow[];
  const typedAdminActions = (adminActions ?? []) as PlatformAdminActionRow[];

  const studioById = new Map(typedStudios.map((studio) => [studio.id, studio]));
  const subscriptionByStudioId = new Map<string, SubscriptionRow>();

  typedSubscriptions
    .slice()
    .sort((a, b) => {
      const priority = (status: string | null) => {
        const normalized = normalize(status);
        if (normalized === "trialing") return 1;
        if (normalized === "active") return 2;
        if (normalized === "past_due") return 3;
        if (normalized === "canceled" || normalized === "cancelled") return 4;
        return 9;
      };

      const priorityCompare = priority(a.status) - priority(b.status);

      if (priorityCompare !== 0) {
        return priorityCompare;
      }

      const aDate = a.trial_ends_at ?? a.current_period_end ?? "";
      const bDate = b.trial_ends_at ?? b.current_period_end ?? "";

      return bDate.localeCompare(aDate);
    })
    .forEach((subscription) => {
      if (!subscriptionByStudioId.has(subscription.studio_id)) {
        subscriptionByStudioId.set(subscription.studio_id, subscription);
      }
    });

  const accountRows: AccountRow[] = typedStudios
    .map((studio) => {
      const subscription = subscriptionByStudioId.get(studio.id);
      const status = getEffectiveBillingStatus({ studio, subscription });
      const planName = getPlanName({ studio, subscription });
      const trialEndsAt = getEffectiveTrialEndsAt({ studio, subscription });
      const trialDaysLeft = daysUntil(trialEndsAt);

      return {
        studio,
        subscription,
        status,
        planName,
        trialEndsAt,
        trialDaysLeft,
        paidPlan: hasPaidPlan({ studio, subscription }),
        stripeSubscriptionId: getEffectiveStripeSubscriptionId({ studio, subscription }),
      };
    })
    .sort((a, b) => {
      const rankCompare = accountSortValue(a) - accountSortValue(b);
      if (rankCompare !== 0) return rankCompare;
      return a.studio.name.localeCompare(b.studio.name, undefined, { sensitivity: "base" });
    });

  const activeCount = accountRows.filter((row) => row.status === "active").length;
  const trialingCount = accountRows.filter((row) => row.status === "trialing").length;
  const pastDueCount = accountRows.filter((row) => row.status === "past_due").length;
  const cancelledCount = accountRows.filter(
    (row) => row.status === "cancelled" || row.status === "canceled"
  ).length;
  const billingNotStartedCount = accountRows.filter(
    (row) => row.status === "not_started" || row.status === "no_subscription"
  ).length;
  const compedAccessRows = accountRows.filter((row) => isBillingOverrideActive(row.studio));
  const compedAccessCount = compedAccessRows.length;

  const compedExpiringSoon = compedAccessRows
    .map((row) => ({
      ...row,
      overrideDaysLeft: daysUntil(row.studio.billing_override_expires_at),
    }))
    .filter(
      (row) =>
        row.overrideDaysLeft !== null &&
        row.overrideDaysLeft >= 0 &&
        row.overrideDaysLeft <= 30
    )
    .sort((a, b) => (a.overrideDaysLeft ?? 999) - (b.overrideDaysLeft ?? 999));

  const monthlyCount = typedSubscriptions.filter(
    (subscription) => subscription.billing_interval === "month"
  ).length;
  const yearlyCount = typedSubscriptions.filter(
    (subscription) => subscription.billing_interval === "year"
  ).length;

  const totalInvoicePaid = typedInvoices.reduce(
    (sum, invoice) => sum + Number(invoice.amount_paid ?? 0),
    0
  );

  const totalInvoiceDue = typedInvoices.reduce(
    (sum, invoice) => sum + Number(invoice.amount_due ?? 0),
    0
  );

  const openInvoiceCount = typedInvoices.filter(
    (invoice) => normalize(invoice.status) === "open"
  ).length;

  const billingRisks = createBillingRisks({
    studios: typedStudios,
    subscriptionByStudioId,
  });

  const riskSummary = getRiskSummary(billingRisks);
  const criticalRisks = billingRisks.filter((risk) => risk.severity === "critical");
  const warningRisks = billingRisks.filter((risk) => risk.severity === "warning");
  const infoRisks = billingRisks.filter((risk) => risk.severity === "info");

  const trialsEndingSoon = accountRows
    .filter(
      (row) =>
        row.status === "trialing" &&
        row.trialDaysLeft !== null &&
        row.trialDaysLeft >= 0 &&
        row.trialDaysLeft <= 14
    )
    .sort((a, b) => (a.trialDaysLeft ?? 999) - (b.trialDaysLeft ?? 999));

  const renewalsEndingSoon = typedSubscriptions
    .map((subscription) => {
      const studio = studioById.get(subscription.studio_id);
      const days = daysUntil(subscription.current_period_end);

      return {
        subscription,
        studio,
        planName: studio ? getPlanName({ studio, subscription }) : "No plan",
        days,
      };
    })
    .filter(
      (item) =>
        normalize(item.subscription.status) === "active" &&
        item.days !== null &&
        item.days >= 0 &&
        item.days <= 14
    )
    .sort((a, b) => (a.days ?? 999) - (b.days ?? 999));

  const planMix = accountRows.reduce<Record<string, number>>((acc, row) => {
    acc[row.planName] = (acc[row.planName] ?? 0) + 1;
    return acc;
  }, {});

  const recentOpenInvoices = typedInvoices.filter((invoice) => normalize(invoice.status) === "open").slice(0, 8);
  const recentInvoices = typedInvoices.slice(0, 12);

  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
            DanceFlow Platform Admin
          </p>
          <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
                Billing Risk Workflow
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-white/85 md:text-base">
                Review paid access, trials, Stripe sync, comped workspaces, invoices, and subscription status from one actionable queue.
              </p>
            </div>
            <Link
              href="/platform"
              className="inline-flex w-fit rounded-full bg-white px-4 py-2 text-sm font-semibold text-[var(--brand-primary)] shadow-sm"
            >
              Back to admin dashboard
            </Link>
          </div>
        </div>

        <div className="grid gap-4 border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 p-6 md:grid-cols-3 xl:grid-cols-6">
          <CompactMetricCard label="Critical Risks" value={riskSummary.critical} tone="rose" helper="Review these first." />
          <CompactMetricCard label="Warnings" value={riskSummary.warning} tone="amber" helper="Likely sync or setup issues." />
          <CompactMetricCard label="Trials" value={trialingCount} tone="blue" helper={`${trialsEndingSoon.length} ending soon`} />
          <CompactMetricCard label="Active" value={activeCount} tone="green" helper={`${monthlyCount} monthly / ${yearlyCount} yearly`} />
          <CompactMetricCard label="Comped" value={compedAccessCount} tone="violet" helper={`${compedExpiringSoon.length} expiring soon`} />
          <CompactMetricCard label="Open Invoices" value={openInvoiceCount} helper={formatMoney(totalInvoiceDue, "USD")} />
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-[28px] border border-rose-200 bg-rose-50 p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-rose-700">Handle first</p>
          <h2 className="mt-2 text-2xl font-semibold text-rose-950">Critical billing risk</h2>
          <p className="mt-2 text-sm leading-6 text-rose-800">
            Paid access, expired trials, past-due subscriptions, and expired comped access.
          </p>
          <p className="mt-5 text-4xl font-semibold text-rose-950">{criticalRisks.length}</p>
        </div>

        <div className="rounded-[28px] border border-amber-200 bg-amber-50 p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-amber-700">Review next</p>
          <h2 className="mt-2 text-2xl font-semibold text-amber-950">Billing setup warnings</h2>
          <p className="mt-2 text-sm leading-6 text-amber-800">
            Missing Stripe identifiers, trial end gaps, and likely subscription sync issues.
          </p>
          <p className="mt-5 text-4xl font-semibold text-amber-950">{warningRisks.length}</p>
        </div>

        <div className="rounded-[28px] border border-sky-200 bg-sky-50 p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-sky-700">Monitor</p>
          <h2 className="mt-2 text-2xl font-semibold text-sky-950">Cancellation / churn watch</h2>
          <p className="mt-2 text-sm leading-6 text-sky-800">
            Scheduled cancellations and other billing information that may need outreach.
          </p>
          <p className="mt-5 text-4xl font-semibold text-sky-950">{infoRisks.length}</p>
        </div>
      </section>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">Action queue</p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">Billing risks to review</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Use this queue to decide whether to repair billing data, contact a studio, extend intentional access, or disable paid features.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 ring-1 ring-rose-200">
              {criticalRisks.length} critical
            </span>
            <span className="rounded-full bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 ring-1 ring-amber-200">
              {warningRisks.length} warnings
            </span>
            <span className="rounded-full bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700 ring-1 ring-sky-200">
              {infoRisks.length} monitor
            </span>
          </div>
        </div>

        {billingRisks.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-dashed border-emerald-200 bg-emerald-50 px-5 py-10 text-sm text-emerald-800">
            No billing risks found right now.
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            {billingRisks.map((risk) => (
              <div key={risk.key} className={`rounded-2xl border p-5 ${riskCardClass(risk.severity)}`}>
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(260px,0.35fr)]">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${riskBadgeClass(risk.severity)}`}>
                        {risk.severity === "critical" ? "Critical" : risk.severity === "warning" ? "Warning" : "Monitor"}
                      </span>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(risk.status)}`}>
                        {statusLabel(risk.status)}
                      </span>
                      {risk.studio.billing_override_enabled ? (
                        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${billingOverrideBadgeClass(risk.studio)}`}>
                          {billingOverrideReasonLabel(risk.studio.billing_override_reason)} override
                        </span>
                      ) : null}
                    </div>

                    <h3 className="mt-3 text-lg font-semibold text-slate-950">{risk.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-700">{risk.description}</p>
                    <div className="mt-3 rounded-xl border border-white/80 bg-white/70 p-3 text-sm leading-6 text-slate-700">
                      <span className="font-semibold text-slate-950">Recommended action:</span> {risk.recommendedAction}
                    </div>

                    {(() => {
                      const latestAction = getLatestActionForTarget(
                        typedAdminActions,
                        "billing_risk",
                        risk.key
                      );

                      return latestAction ? (
                        <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                          <p className="font-semibold">
                            Last admin action: {adminActionLabel(latestAction.action_type)} · {formatDateTime(latestAction.created_at)}
                          </p>
                          {latestAction.note ? (
                            <p className="mt-1 leading-6 text-emerald-800">{latestAction.note}</p>
                          ) : null}
                        </div>
                      ) : null;
                    })()}

                    <form action={createPlatformAdminAction} className="mt-3 rounded-xl border border-white/80 bg-white/80 p-3">
                      <input type="hidden" name="targetType" value="billing_risk" />
                      <input type="hidden" name="targetId" value={risk.key} />
                      <input type="hidden" name="returnTo" value="/platform/billing" />
                      <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500" htmlFor={`billing-action-${risk.key}`}>
                        Admin review note
                      </label>
                      <textarea
                        id={`billing-action-${risk.key}`}
                        name="note"
                        rows={2}
                        placeholder="Example: Confirmed Stripe subscription is canceled; access should stay disabled."
                        className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
                      />
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button name="actionType" value="reviewed" className="rounded-xl bg-slate-950 px-3 py-2 text-xs font-semibold text-white">
                          Mark Reviewed
                        </button>
                        <button name="actionType" value="follow_up" className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800">
                          Flag Follow-up
                        </button>
                      </div>
                    </form>

                    <div className="mt-4 grid gap-2 text-xs text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
                      <p><span className="font-semibold text-slate-800">Plan:</span> {risk.planName}</p>
                      <p><span className="font-semibold text-slate-800">Created:</span> {formatDate(risk.studio.created_at)}</p>
                      <p><span className="font-semibold text-slate-800">Last access:</span> {formatDateTime(risk.studio.last_workspace_access_at)}</p>
                      <p><span className="font-semibold text-slate-800">Next date:</span> {formatDate(getEffectiveTrialEndsAt({ studio: risk.studio, subscription: risk.subscription }))}</p>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-white/80 bg-white/80 p-4">
                    <Link
                      href={`/platform/studios/${risk.studio.id}`}
                      className="font-semibold text-slate-950 underline"
                    >
                      {risk.studio.name}
                    </Link>
                    <div className="mt-3 space-y-1 text-xs text-slate-600">
                      <p>Stripe customer: {risk.studio.stripe_customer_id ?? "—"}</p>
                      <p>
                        Stripe subscription: {getEffectiveStripeSubscriptionId({
                          studio: risk.studio,
                          subscription: risk.subscription,
                        }) || "—"}
                      </p>
                      <p>Workspace: {risk.studio.active === false ? "Disabled" : "Active"}</p>
                    </div>
                    <div className="mt-4">
                      <StudioActionLinks studioId={risk.studio.id} />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Revenue and invoice snapshot</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Subscription invoice totals from stored Stripe invoice records.
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
              <p className="text-sm text-emerald-700">Recent invoice paid total</p>
              <p className="mt-2 text-3xl font-semibold text-emerald-950">
                {formatMoney(totalInvoicePaid, "USD")}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
              <p className="text-sm text-slate-500">Recent invoice due total</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">
                {formatMoney(totalInvoiceDue, "USD")}
              </p>
            </div>
          </div>

          {recentOpenInvoices.length > 0 ? (
            <div className="mt-6">
              <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">Open invoices</h3>
              <div className="mt-3 space-y-3">
                {recentOpenInvoices.map((invoice) => {
                  const studio = studioById.get(invoice.studio_id);

                  return (
                    <div key={invoice.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <div>
                          <Link href={`/platform/studios/${invoice.studio_id}`} className="font-semibold text-slate-950 underline">
                            {studio?.name ?? "Unknown studio"}
                          </Link>
                          <p className="mt-1 text-xs text-slate-500">
                            Created {formatDate(invoice.created_at)} • Period {formatDate(invoice.period_start)} - {formatDate(invoice.period_end)}
                          </p>
                        </div>
                        <div className="text-sm font-semibold text-slate-950">
                          {formatMoney(invoice.amount_due, invoice.currency || "USD")}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Plan mix and lifecycle</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Quick view of active plans, trialing accounts, cancellations, and comped access.
          </p>

          <div className="mt-5 grid gap-3">
            {Object.keys(planMix).length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500">
                No plan mix data yet.
              </div>
            ) : (
              Object.entries(planMix).map(([planName, count]) => (
                <div key={planName} className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm font-medium text-slate-700">{planName}</p>
                  <p className="text-lg font-semibold text-slate-950">{count}</p>
                </div>
              ))
            )}
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-sm text-slate-500">Past Due</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{pastDueCount}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-sm text-slate-500">Canceled</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{cancelledCount}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-sm text-slate-500">Billing Not Started</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{billingNotStartedCount}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-sm text-slate-500">Comped Access</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{compedAccessCount}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Trials ending soon</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">Trialing accounts with a trial end date in the next 14 days.</p>

          {trialsEndingSoon.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500">
              No trials ending in the next 14 days.
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {trialsEndingSoon.map((item) => (
                <div key={item.studio.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <Link href={`/platform/studios/${item.studio.id}`} className="font-medium text-slate-900 underline">
                        {item.studio.name}
                      </Link>
                      <p className="mt-1 text-sm text-slate-500">{item.planName}</p>
                    </div>
                    <div className="text-right text-sm text-slate-600">
                      <p>{item.trialDaysLeft} day{item.trialDaysLeft === 1 ? "" : "s"}</p>
                      <p>{formatDate(item.trialEndsAt)}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Renewals ending soon</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">Active subscriptions with a billing period ending in the next 14 days.</p>

          {renewalsEndingSoon.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500">
              No active renewals ending in the next 14 days.
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {renewalsEndingSoon.map((item) => (
                <div key={item.subscription.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <Link href={`/platform/studios/${item.subscription.studio_id}`} className="font-medium text-slate-900 underline">
                        {item.studio?.name ?? "Unknown studio"}
                      </Link>
                      <p className="mt-1 text-sm text-slate-500">
                        {item.planName} • {billingIntervalLabel(item.subscription.billing_interval)}
                      </p>
                    </div>
                    <div className="text-right text-sm text-slate-600">
                      <p>{item.days} day{item.days === 1 ? "" : "s"}</p>
                      <p>{formatDate(item.subscription.current_period_end)}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="rounded-[32px] border border-violet-200 bg-violet-50/60 p-6 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-violet-950">Comped / ambassador access</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-violet-800">
              Legitimate Pro or Organizer access granted by platform override. Active overrides are excluded from missing Stripe subscription risk checks, but expired overrides are flagged above.
            </p>
          </div>
          <span className="rounded-full bg-white px-3 py-1.5 text-sm font-semibold text-violet-700 ring-1 ring-violet-200">
            {compedAccessCount} active comp{compedAccessCount === 1 ? "" : "s"}
          </span>
        </div>

        {compedAccessRows.length === 0 ? (
          <div className="mt-5 rounded-xl border border-dashed border-violet-200 bg-white/70 px-4 py-8 text-sm text-violet-700">
            No active comped workspaces right now.
          </div>
        ) : (
          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {compedAccessRows.map((row) => (
              <div key={row.studio.id} className="rounded-2xl border border-violet-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${billingOverrideBadgeClass(row.studio)}`}>
                    {billingOverrideReasonLabel(row.studio.billing_override_reason)}
                  </span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(row.status)}`}>
                    {statusLabel(row.status)}
                  </span>
                </div>
                <Link href={`/platform/studios/${row.studio.id}`} className="mt-3 block font-semibold text-slate-950 underline">
                  {row.studio.name}
                </Link>
                <p className="mt-1 text-sm text-slate-600">{row.planName}</p>
                <p className="mt-2 text-xs text-slate-500">Expires: {formatDate(row.studio.billing_override_expires_at)}</p>
                {row.studio.billing_override_notes ? (
                  <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">{row.studio.billing_override_notes}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">Recent invoices</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">Recent invoice activity stored in the platform database.</p>

        {recentInvoices.length === 0 ? (
          <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500">No invoices yet.</div>
        ) : (
          <div className="mt-5 overflow-hidden rounded-xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Studio</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Amount Due</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Amount Paid</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Period</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {recentInvoices.map((invoice) => {
                  const studio = studioById.get(invoice.studio_id);

                  return (
                    <tr key={invoice.id}>
                      <td className="px-4 py-4 text-slate-900">
                        <Link href={`/platform/studios/${invoice.studio_id}`} className="font-medium underline">
                          {studio?.name ?? "Unknown studio"}
                        </Link>
                      </td>
                      <td className="px-4 py-4">
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(invoice.status)}`}>
                          {statusLabel(invoice.status)}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-slate-700">{formatMoney(invoice.amount_due, invoice.currency || "USD")}</td>
                      <td className="px-4 py-4 text-slate-700">{formatMoney(invoice.amount_paid, invoice.currency || "USD")}</td>
                      <td className="px-4 py-4 text-slate-700">{formatDate(invoice.period_start)} - {formatDate(invoice.period_end)}</td>
                      <td className="px-4 py-4 text-slate-700">{formatDate(invoice.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">All subscription accounts</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Review each workspace billing status, plan, Stripe references, and trial or renewal timing.
        </p>

        <div className="mt-5 overflow-hidden rounded-xl border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-slate-600">Workspace</th>
                <th className="px-4 py-3 text-left font-medium text-slate-600">Plan</th>
                <th className="px-4 py-3 text-left font-medium text-slate-600">Billing Status</th>
                <th className="px-4 py-3 text-left font-medium text-slate-600">Access</th>
                <th className="px-4 py-3 text-left font-medium text-slate-600">Stripe</th>
                <th className="px-4 py-3 text-left font-medium text-slate-600">Next Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white">
              {accountRows.map((row) => {
                const nextDate = row.status === "trialing" ? row.trialEndsAt : row.subscription?.current_period_end ?? null;

                return (
                  <tr key={row.studio.id}>
                    <td className="px-4 py-4">
                      <Link href={`/platform/studios/${row.studio.id}`} className="font-medium text-slate-950 underline">
                        {row.studio.name}
                      </Link>
                      <p className="mt-1 text-xs text-slate-500">Created {formatDate(row.studio.created_at)}</p>
                    </td>
                    <td className="px-4 py-4 text-slate-700">
                      <p>{row.planName}</p>
                      {row.studio.billing_override_enabled ? (
                        <span className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${billingOverrideBadgeClass(row.studio)}`}>
                          {billingOverrideReasonLabel(row.studio.billing_override_reason)} • expires {formatDate(row.studio.billing_override_expires_at)}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-4">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(row.status)}`}>
                        {statusLabel(row.status)}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-slate-700">
                      <p>{row.studio.active === false ? "Disabled" : "Active"}</p>
                      <p className="mt-1 text-xs text-slate-500">Last access: {formatDateTime(row.studio.last_workspace_access_at)}</p>
                    </td>
                    <td className="px-4 py-4 text-slate-700">
                      <p>Customer: {row.studio.stripe_customer_id ? "Yes" : "No"}</p>
                      <p className="mt-1">Subscription: {row.stripeSubscriptionId ? "Yes" : "No"}</p>
                    </td>
                    <td className="px-4 py-4 text-slate-700">{formatDate(nextDate)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}







