import Link from "next/link";
import AriaInsightCard from "@/components/app/AriaInsightCard";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { getBillingPlan } from "@/lib/billing/plans";
import { createClient } from "@/lib/supabase/server";

type SearchParams = Promise<{
  range?: string;
}>;

type StudioRow = {
  id: string;
  name: string;
  created_at: string;
  billing_plan: string | null;
  subscription_status: string | null;
  active: boolean | null;
  trial_ends_at: string | null;
  last_workspace_access_at: string | null;
};

type SubscriptionPlanRow = {
  code: string | null;
  name: string | null;
};

type SubscriptionRow = {
  id: string;
  studio_id: string;
  status: string | null;
  billing_interval: string | null;
  created_at: string;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  cancelled_at: string | null;
  cancel_at_period_end: boolean | null;
  subscription_plans: SubscriptionPlanRow | SubscriptionPlanRow[] | null;
};

type AddonEntitlementRow = {
  id: string;
  studio_id: string | null;
  feature_key: string | null;
  status: string | null;
  source: string | null;
  created_at: string;
};

type OrganizerRow = {
  id: string;
  studio_id: string;
  active: boolean | null;
};

type EventRow = {
  id: string;
  studio_id: string | null;
  visibility: string | null;
  status: string | null;
  event_type: string | null;
  created_at: string;
};

type RegistrationRow = {
  id: string;
  event_id: string;
  payment_status: string | null;
  total_amount: number | null;
  total_price: number | null;
  created_at: string;
};

type EventPaymentRow = {
  id: string;
  amount: number | null;
  status: string | null;
  created_at: string;
};

type StudioInvoiceRow = {
  id: string;
  studio_id: string;
  amount_paid: number | null;
  currency: string | null;
  status: string | null;
  created_at: string;
};

const PLATFORM_TICKET_FEE_RATE = 0.035;
const ORGANIZER_SUITE_ADDON_CENTS = 1200;
const PAID_STATUSES = new Set(["paid", "processed", "succeeded", "complete", "completed"]);
const PAID_INVOICE_STATUSES = new Set(["paid", "succeeded"]);

const RANGE_OPTIONS = [
  { value: "30", label: "Last 30 days", days: 30 },
  { value: "90", label: "Last 90 days", days: 90 },
  { value: "180", label: "Last 180 days", days: 180 },
  { value: "365", label: "Last 12 months", days: 365 },
];

const PLAN_LABELS: Record<string, string> = {
  starter: "Starter",
  growth: "Growth",
  pro: "Pro",
  organizer: "Organizer Suite",
};

function getRange(value: string | undefined) {
  return RANGE_OPTIONS.find((option) => option.value === value) ?? RANGE_OPTIONS[1];
}

function getPlan(value: SubscriptionPlanRow | SubscriptionPlanRow[] | null) {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function formatLabel(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatMoney(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(Number(value ?? 0));
}

function formatPercent(numerator: number, denominator: number) {
  if (!denominator) return "0%";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function isOnOrAfter(value: string | null | undefined, start: Date) {
  if (!value) return false;
  return new Date(value).getTime() >= start.getTime();
}

function isPaidRegistrationStatus(value: string | null | undefined) {
  return PAID_STATUSES.has(normalize(value));
}

function daysSince(value: string | null | undefined) {
  if (!value) return null;
  return Math.floor((Date.now() - new Date(value).getTime()) / (1000 * 60 * 60 * 24));
}

function daysUntil(value: string | null | undefined) {
  if (!value) return null;
  return Math.ceil((new Date(value).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

function getPlanCode(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
}) {
  const subscriptionPlan = params.subscription
    ? getPlan(params.subscription.subscription_plans)
    : null;

  return normalize(subscriptionPlan?.code) || normalize(params.studio.billing_plan);
}

function getPlanName(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
}) {
  const planCode = getPlanCode(params);
  const subscriptionPlan = params.subscription
    ? getPlan(params.subscription.subscription_plans)
    : null;

  return subscriptionPlan?.name?.trim() || PLAN_LABELS[planCode] || (planCode ? formatLabel(planCode) : "No plan");
}

function getBillingStatus(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
}) {
  return (
    normalize(params.subscription?.status) ||
    normalize(params.studio.subscription_status) ||
    (params.studio.active === false ? "inactive" : "not_started")
  );
}

function isOrganizerWorkspace(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
}) {
  const planCode = getPlanCode(params);
  const sharedPlan = getBillingPlan(planCode);

  if (sharedPlan?.audience === "organizer" || planCode === "organizer") {
    return true;
  }

  const normalizedName = params.studio.name.trim().toLowerCase();
  return (
    normalizedName.endsWith(" organizer") ||
    normalizedName.includes(" organizer ") ||
    normalizedName.endsWith(" events") ||
    normalizedName.includes(" festival")
  );
}

function monthlyPlanAmount(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
}) {
  const plan = getBillingPlan(getPlanCode(params));
  if (!plan) return 0;

  const monthlyCents = plan.amountMonthlyCents ?? 0;
  if (normalize(params.subscription?.billing_interval) === "year") {
    return monthlyCents / 100;
  }

  return monthlyCents / 100;
}

function StatCard({
  label,
  value,
  helper,
  tone = "slate",
}: {
  label: string;
  value: string;
  helper: string;
  tone?: "slate" | "emerald" | "sky" | "amber" | "rose" | "violet";
}) {
  const tones = {
    slate: "border-slate-200 bg-white text-slate-950",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-950",
    sky: "border-sky-200 bg-sky-50 text-sky-950",
    amber: "border-amber-200 bg-amber-50 text-amber-950",
    rose: "border-rose-200 bg-rose-50 text-rose-950",
    violet: "border-violet-200 bg-violet-50 text-violet-950",
  };

  return (
    <div className={`rounded-2xl border p-5 shadow-sm ${tones[tone]}`}>
      <p className="text-sm font-medium opacity-75">{label}</p>
      <p className="mt-2 text-3xl font-semibold">{value}</p>
      <p className="mt-2 text-xs leading-5 opacity-75">{helper}</p>
    </div>
  );
}

function ProgressBar({ value }: { value: number }) {
  const width = Math.max(0, Math.min(100, value));

  return (
    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
      <div className="h-full rounded-full bg-[#BE185D]" style={{ width: `${width}%` }} />
    </div>
  );
}

function statusBadgeClass(status: string) {
  if (status === "active") return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  if (status === "trialing") return "bg-sky-50 text-sky-700 ring-1 ring-sky-200";
  if (status === "past_due") return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  if (status === "cancelled" || status === "canceled") return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

export default async function PlatformAnalyticsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requirePlatformAdmin();

  const params = await searchParams;
  const range = getRange(params.range);
  const rangeStart = new Date(Date.now() - range.days * 24 * 60 * 60 * 1000);
  const supabase = await createClient();

  const [
    { data: studios, error: studiosError },
    { data: subscriptions, error: subscriptionsError },
    { data: addonEntitlements, error: addonEntitlementsError },
    { data: organizers, error: organizersError },
    { data: events, error: eventsError },
    { data: registrations, error: registrationsError },
    { data: eventPayments, error: eventPaymentsError },
    { data: studioInvoices, error: studioInvoicesError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name, created_at, billing_plan, subscription_status, active, trial_ends_at, last_workspace_access_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("studio_subscriptions")
      .select(`
        id,
        studio_id,
        status,
        billing_interval,
        created_at,
        current_period_start,
        current_period_end,
        trial_ends_at,
        cancelled_at,
        cancel_at_period_end,
        subscription_plans (
          code,
          name
        )
      `),
    supabase
      .from("usage_addon_entitlements")
      .select("id, studio_id, feature_key, status, source, created_at")
      .eq("feature_key", "organizer_suite"),
    supabase.from("organizers").select("id, studio_id, active"),
    supabase.from("events").select("id, studio_id, visibility, status, event_type, created_at"),
    supabase
      .from("event_registrations")
      .select("id, event_id, payment_status, total_amount, total_price, created_at"),
    supabase.from("event_payments").select("id, amount, status, created_at"),
    supabase.from("studio_invoices").select("id, studio_id, amount_paid, currency, status, created_at"),
  ]);

  if (studiosError) throw new Error(`Failed to load studios: ${studiosError.message}`);
  if (subscriptionsError) throw new Error(`Failed to load subscriptions: ${subscriptionsError.message}`);
  if (addonEntitlementsError) throw new Error(`Failed to load add-ons: ${addonEntitlementsError.message}`);
  if (organizersError) throw new Error(`Failed to load organizers: ${organizersError.message}`);
  if (eventsError) throw new Error(`Failed to load events: ${eventsError.message}`);
  if (registrationsError) throw new Error(`Failed to load registrations: ${registrationsError.message}`);
  if (eventPaymentsError) throw new Error(`Failed to load event payments: ${eventPaymentsError.message}`);
  if (studioInvoicesError) throw new Error(`Failed to load invoices: ${studioInvoicesError.message}`);

  const typedStudios = (studios ?? []) as StudioRow[];
  const typedSubscriptions = (subscriptions ?? []) as SubscriptionRow[];
  const typedAddonEntitlements = (addonEntitlements ?? []) as AddonEntitlementRow[];
  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const typedEvents = (events ?? []) as EventRow[];
  const typedRegistrations = (registrations ?? []) as RegistrationRow[];
  const typedEventPayments = (eventPayments ?? []) as EventPaymentRow[];
  const typedStudioInvoices = (studioInvoices ?? []) as StudioInvoiceRow[];

  const subscriptionByStudioId = new Map(
    typedSubscriptions.map((subscription) => [subscription.studio_id, subscription])
  );

  const activeOrganizerSuiteAddons = typedAddonEntitlements.filter(
    (entitlement) => normalize(entitlement.status) === "active"
  );

  const studiosWithSubscription = typedStudios.map((studio) => {
    const subscription = subscriptionByStudioId.get(studio.id);
    const status = getBillingStatus({ studio, subscription });
    const planCode = getPlanCode({ studio, subscription });
    const planName = getPlanName({ studio, subscription });
    const organizerWorkspace = isOrganizerWorkspace({ studio, subscription });

    return {
      studio,
      subscription,
      status,
      planCode,
      planName,
      organizerWorkspace,
      activeBilling: status === "active",
      trialing: status === "trialing",
    };
  });

  const studioWorkspaces = studiosWithSubscription.filter((row) => !row.organizerWorkspace);
  const organizerWorkspaces = studiosWithSubscription.filter((row) => row.organizerWorkspace);
  const activeStudioWorkspaces = studioWorkspaces.filter((row) => row.status === "active");
  const trialStudioWorkspaces = studioWorkspaces.filter((row) => row.status === "trialing");
  const activeOrganizerWorkspaces = organizerWorkspaces.filter((row) => row.status === "active");
  const pastDueWorkspaces = studiosWithSubscription.filter((row) => row.status === "past_due");
  const cancelingWorkspaces = studiosWithSubscription.filter((row) => row.subscription?.cancel_at_period_end);
  const churnedInRange = typedSubscriptions.filter((subscription) =>
    isOnOrAfter(subscription.cancelled_at, rangeStart)
  );

  const trialStartsInRange = typedSubscriptions.filter((subscription) =>
    isOnOrAfter(subscription.created_at, rangeStart)
  );
  const activeConversionsInRange = trialStartsInRange.filter((subscription) =>
    normalize(subscription.status) === "active" ||
    isOnOrAfter(subscription.current_period_start, rangeStart)
  );

  const activeMrr = studiosWithSubscription
    .filter((row) => row.status === "active")
    .reduce(
      (sum, row) => sum + monthlyPlanAmount({ studio: row.studio, subscription: row.subscription }),
      0
    );

  const organizerSuiteMrr = activeOrganizerSuiteAddons.length * (ORGANIZER_SUITE_ADDON_CENTS / 100);
  const estimatedMrr = activeMrr + organizerSuiteMrr;

  const paidEventPaymentVolume = typedEventPayments
    .filter((payment) => isPaidRegistrationStatus(payment.status))
    .filter((payment) => isOnOrAfter(payment.created_at, rangeStart))
    .reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0);

  const ticketFeeRevenue = paidEventPaymentVolume * PLATFORM_TICKET_FEE_RATE;

  const subscriptionRevenue = typedStudioInvoices
    .filter((invoice) => PAID_INVOICE_STATUSES.has(normalize(invoice.status)))
    .filter((invoice) => isOnOrAfter(invoice.created_at, rangeStart))
    .reduce((sum, invoice) => sum + Number(invoice.amount_paid ?? 0), 0);

  const eventStudioMap = new Map(typedEvents.map((event) => [event.id, event.studio_id]));
  const paidRegistrations = typedRegistrations.filter((registration) =>
    isPaidRegistrationStatus(registration.payment_status)
  );
  const paidRegistrationsInRange = paidRegistrations.filter((registration) =>
    isOnOrAfter(registration.created_at, rangeStart)
  );

  const registrationRevenueByStudio = new Map<string, number>();
  const registrationCountByStudio = new Map<string, number>();

  for (const registration of paidRegistrations) {
    const studioId = eventStudioMap.get(registration.event_id);
    if (!studioId) continue;

    registrationCountByStudio.set(studioId, (registrationCountByStudio.get(studioId) ?? 0) + 1);
    registrationRevenueByStudio.set(
      studioId,
      (registrationRevenueByStudio.get(studioId) ?? 0) +
        Number(registration.total_amount ?? registration.total_price ?? 0)
    );
  }

  const publicEvents = typedEvents.filter(
    (event) => normalize(event.status) === "published" && normalize(event.visibility) === "public"
  );

  const planMix = studiosWithSubscription.reduce<Record<string, number>>((acc, row) => {
    acc[row.planName] = (acc[row.planName] ?? 0) + 1;
    return acc;
  }, {});

  const maxPlanCount = Math.max(1, ...Object.values(planMix));
  const organizerSuiteAttachRate = formatPercent(activeOrganizerSuiteAddons.length, activeStudioWorkspaces.length);

  const staleWorkspaces = studioWorkspaces
    .filter((row) => {
      const inactiveDays = daysSince(row.studio.last_workspace_access_at);
      return inactiveDays === null || inactiveDays >= 30;
    })
    .sort((a, b) => {
      const aDays = daysSince(a.studio.last_workspace_access_at) ?? 9999;
      const bDays = daysSince(b.studio.last_workspace_access_at) ?? 9999;
      return bDays - aDays;
    })
    .slice(0, 8);

  const trialEndingSoon = trialStudioWorkspaces
    .map((row) => ({
      ...row,
      trialDaysLeft: daysUntil(row.subscription?.trial_ends_at ?? row.studio.trial_ends_at),
    }))
    .filter((row) => row.trialDaysLeft !== null && row.trialDaysLeft <= 7)
    .sort((a, b) => (a.trialDaysLeft ?? 99) - (b.trialDaysLeft ?? 99))
    .slice(0, 8);

  const topEventWorkspaces = studiosWithSubscription
    .map((row) => ({
      ...row,
      registrationRevenue: registrationRevenueByStudio.get(row.studio.id) ?? 0,
      registrationCount: registrationCountByStudio.get(row.studio.id) ?? 0,
      publicEventCount: publicEvents.filter((event) => event.studio_id === row.studio.id).length,
    }))
    .filter((row) => row.registrationRevenue > 0 || row.publicEventCount > 0)
    .sort((a, b) => b.registrationRevenue - a.registrationRevenue)
    .slice(0, 8);

  const revenueRows = [
    {
      label: "Estimated MRR",
      value: estimatedMrr,
      detail: "Active subscriptions plus Organizer Suite add-ons.",
    },
    {
      label: `${range.label} subscription collections`,
      value: subscriptionRevenue,
      detail: "Paid Stripe invoices recorded in DanceFlow.",
    },
    {
      label: `${range.label} ticket fee revenue`,
      value: ticketFeeRevenue,
      detail: "Estimated 3.5% DanceFlow fee from paid event payments.",
    },
  ];

  const opportunityInsight =
    pastDueWorkspaces.length > 0
      ? {
          title: "Billing follow-up is the highest leverage admin move.",
          insight: `${pastDueWorkspaces.length} workspace${pastDueWorkspaces.length === 1 ? "" : "s"} are past due, and ${cancelingWorkspaces.length} subscription${cancelingWorkspaces.length === 1 ? "" : "s"} are set to cancel at period end.`,
          recommendation: "Start with billing risk before expanding the beta audience or pushing new paid add-ons.",
          metric: `${formatMoney(estimatedMrr)} est. MRR`,
        }
      : {
          title: "Platform health is ready for growth monitoring.",
          insight: `The platform has ${activeStudioWorkspaces.length} active studio workspace${activeStudioWorkspaces.length === 1 ? "" : "s"}, ${activeOrganizerWorkspaces.length} active organizer workspace${activeOrganizerWorkspaces.length === 1 ? "" : "s"}, and ${publicEvents.length} public event listing${publicEvents.length === 1 ? "" : "s"}.`,
          recommendation: "Use trial conversion, inactive workspaces, and Organizer Suite attach rate as the next weekly operating rhythm.",
          metric: `${formatPercent(activeConversionsInRange.length, trialStartsInRange.length)} trial conversion`,
        };

  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                Platform Analytics
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Growth, Revenue, and Health
              </h1>
              <p className="mt-3 text-sm leading-7 text-white/85 md:text-base">
                Track trial conversion, subscription revenue, Organizer Suite adoption, event fee revenue, and workspace health across DanceFlow.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {RANGE_OPTIONS.map((option) => (
                <Link
                  key={option.value}
                  href={`/platform/analytics?range=${option.value}`}
                  className={`rounded-xl border px-4 py-2 text-sm font-semibold ${
                    option.value === range.value
                      ? "border-white bg-white text-[var(--brand-primary)]"
                      : "border-white/20 bg-white/10 text-white hover:bg-white/15"
                  }`}
                >
                  {option.label}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>

      <AriaInsightCard
        eyebrow="ARIA Platform Signal"
        title={opportunityInsight.title}
        insight={opportunityInsight.insight}
        recommendation={opportunityInsight.recommendation}
        metric={opportunityInsight.metric}
        primaryAction={{ href: "/platform/billing", label: "Review Billing" }}
        secondaryAction={{ href: "/platform/studios", label: "Open Studios" }}
      />

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Estimated MRR"
          value={formatMoney(estimatedMrr)}
          helper={`${formatMoney(activeMrr)} subscriptions + ${formatMoney(organizerSuiteMrr)} Organizer Suite add-ons`}
          tone="emerald"
        />
        <StatCard
          label="Trial Conversion"
          value={formatPercent(activeConversionsInRange.length, trialStartsInRange.length)}
          helper={`${activeConversionsInRange.length} converted from ${trialStartsInRange.length} trials in ${range.label.toLowerCase()}`}
          tone="sky"
        />
        <StatCard
          label="Organizer Suite Attach"
          value={organizerSuiteAttachRate}
          helper={`${activeOrganizerSuiteAddons.length} active add-on${activeOrganizerSuiteAddons.length === 1 ? "" : "s"} across active studio workspaces`}
          tone="violet"
        />
        <StatCard
          label="Ticket Fee Revenue"
          value={formatMoney(ticketFeeRevenue)}
          helper={`${formatMoney(paidEventPaymentVolume)} paid event volume in ${range.label.toLowerCase()}`}
          tone="amber"
        />
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Active Studios"
          value={formatNumber(activeStudioWorkspaces.length)}
          helper={`${trialStudioWorkspaces.length} trials and ${pastDueWorkspaces.length} past-due workspace${pastDueWorkspaces.length === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Active Organizers"
          value={formatNumber(activeOrganizerWorkspaces.length)}
          helper={`${typedOrganizers.filter((organizer) => organizer.active).length} active organizer records`}
        />
        <StatCard
          label="Public Events"
          value={formatNumber(publicEvents.length)}
          helper={`${paidRegistrationsInRange.length} paid registration${paidRegistrationsInRange.length === 1 ? "" : "s"} in ${range.label.toLowerCase()}`}
        />
        <StatCard
          label="Churn Watch"
          value={formatNumber(churnedInRange.length + cancelingWorkspaces.length)}
          helper={`${churnedInRange.length} canceled in range, ${cancelingWorkspaces.length} canceling at period end`}
          tone={churnedInRange.length + cancelingWorkspaces.length ? "rose" : "slate"}
        />
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Revenue Mix
              </p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                Platform Revenue Signals
              </h2>
            </div>
            <Link href="/platform/billing" className="text-sm font-semibold text-[#BE185D]">
              Billing details
            </Link>
          </div>

          <div className="mt-5 space-y-4">
            {revenueRows.map((row) => (
              <div key={row.label} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-semibold text-slate-950">{row.label}</p>
                    <p className="mt-1 text-sm text-slate-600">{row.detail}</p>
                  </div>
                  <p className="text-2xl font-semibold text-slate-950">{formatMoney(row.value)}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Plan Mix
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
            Workspace Distribution
          </h2>
          <div className="mt-5 space-y-4">
            {Object.entries(planMix)
              .sort((a, b) => b[1] - a[1])
              .map(([label, count]) => (
                <div key={label} className="space-y-2">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-semibold text-slate-800">{label}</span>
                    <span className="text-slate-500">{count}</span>
                  </div>
                  <ProgressBar value={(count / maxPlanCount) * 100} />
                </div>
              ))}
          </div>
        </section>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Conversion Watch
              </p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                Trials Ending Soon
              </h2>
            </div>
            <Link href="/platform/billing" className="text-sm font-semibold text-[#BE185D]">
              Manage trials
            </Link>
          </div>

          <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
            {trialEndingSoon.length ? (
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Workspace</th>
                    <th className="px-4 py-3">Plan</th>
                    <th className="px-4 py-3">Trial End</th>
                    <th className="px-4 py-3">Days</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {trialEndingSoon.map((row) => (
                    <tr key={row.studio.id}>
                      <td className="px-4 py-3 font-semibold text-slate-900">
                        <Link href={`/platform/studios/${row.studio.id}`} className="hover:text-[#BE185D]">
                          {row.studio.name}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{row.planName}</td>
                      <td className="px-4 py-3 text-slate-600">
                        {formatDate(row.subscription?.trial_ends_at ?? row.studio.trial_ends_at)}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{row.trialDaysLeft}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="bg-slate-50 p-5 text-sm text-slate-500">
                No studio trials ending in the next week.
              </div>
            )}
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Adoption Watch
              </p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                Inactive Workspaces
              </h2>
            </div>
            <Link href="/platform/studios" className="text-sm font-semibold text-[#BE185D]">
              Studio directory
            </Link>
          </div>

          <div className="mt-5 space-y-3">
            {staleWorkspaces.length ? (
              staleWorkspaces.map((row) => {
                const inactiveDays = daysSince(row.studio.last_workspace_access_at);
                return (
                  <div key={row.studio.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <Link href={`/platform/studios/${row.studio.id}`} className="font-semibold text-slate-950 hover:text-[#BE185D]">
                          {row.studio.name}
                        </Link>
                        <p className="mt-1 text-sm text-slate-600">
                          Last access: {row.studio.last_workspace_access_at ? formatDate(row.studio.last_workspace_access_at) : "Never"}
                        </p>
                      </div>
                      <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700 ring-1 ring-amber-200">
                        {inactiveDays === null ? "Never opened" : `${inactiveDays}d inactive`}
                      </span>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-500">
                No stale studio workspaces in this snapshot.
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Event Commerce
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
              Top Event-Producing Workspaces
            </h2>
          </div>
          <Link href="/platform/organizers" className="text-sm font-semibold text-[#BE185D]">
            Organizer directory
          </Link>
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
          {topEventWorkspaces.length ? (
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Workspace</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Public Events</th>
                  <th className="px-4 py-3">Paid Registrations</th>
                  <th className="px-4 py-3">Gross Registration Volume</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {topEventWorkspaces.map((row) => (
                  <tr key={row.studio.id}>
                    <td className="px-4 py-3 font-semibold text-slate-900">
                      <Link href={`/platform/studios/${row.studio.id}`} className="hover:text-[#BE185D]">
                        {row.studio.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {row.organizerWorkspace ? "Organizer" : "Studio"}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{row.publicEventCount}</td>
                    <td className="px-4 py-3 text-slate-600">{row.registrationCount}</td>
                    <td className="px-4 py-3 font-semibold text-slate-900">
                      {formatMoney(row.registrationRevenue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="bg-slate-50 p-5 text-sm text-slate-500">
              No event commerce activity is available yet.
            </div>
          )}
        </div>
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          Billing Attention
        </p>
        <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
          Risk Snapshot
        </h2>
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          {pastDueWorkspaces.slice(0, 6).map((row) => (
            <div key={row.studio.id} className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <Link href={`/platform/studios/${row.studio.id}`} className="font-semibold text-amber-950 hover:text-[#BE185D]">
                    {row.studio.name}
                  </Link>
                  <p className="mt-1 text-sm text-amber-800">{row.planName}</p>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusBadgeClass(row.status)}`}>
                  {formatLabel(row.status)}
                </span>
              </div>
            </div>
          ))}
          {!pastDueWorkspaces.length ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-800">
              No past-due workspaces in this snapshot.
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}