import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createClient } from "@/lib/supabase/server";

type SearchParams = Promise<{
  focus?: string;
  q?: string;
}>;

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
};

type SubscriptionPlanRow = {
  code: string | null;
  name: string | null;
};

type SubscriptionRow = {
  id: string;
  studio_id: string;
  status: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  cancel_at_period_end: boolean | null;
  subscription_plans: SubscriptionPlanRow | SubscriptionPlanRow[] | null;
};

type EventRow = {
  id: string;
  studio_id: string | null;
  status: string | null;
  visibility: string | null;
};

type ClientRow = {
  id: string;
  studio_id: string;
};

type AppointmentRow = {
  id: string;
  studio_id: string;
};

type InvoiceRow = {
  id: string;
  studio_id: string;
  amount_paid: number | null;
  status: string | null;
};

type SuccessFocus = "conversion" | "billing-risk" | "inactive" | "trial-risk" | "healthy";

type SuccessRow = {
  studio: StudioRow;
  planLabel: string;
  billingStatus: string;
  focus: SuccessFocus;
  focusLabel: string;
  score: number;
  daysUntilTrialEnd: number | null;
  daysSinceAccess: number | null;
  clientCount: number;
  appointmentCount: number;
  eventCount: number;
  publicEventCount: number;
  paidInvoiceCount: number;
  invoiceCollections: number;
  reason: string;
  nextAction: string;
  urgency: "high" | "medium" | "low";
};

const FOCUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "conversion", label: "Conversion" },
  { value: "trial-risk", label: "Trial Risk" },
  { value: "billing-risk", label: "Billing Risk" },
  { value: "inactive", label: "Inactive" },
  { value: "healthy", label: "Healthy" },
];

const PLAN_LABELS: Record<string, string> = {
  starter: "Starter",
  growth: "Growth",
  pro: "Pro",
  organizer: "Organizer Suite",
};

const BILLING_RISK_STATUSES = new Set(["past_due", "unpaid", "incomplete", "canceled", "cancelled"]);
const PAID_INVOICE_STATUSES = new Set(["paid", "succeeded"]);

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function getOne<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function formatLabel(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatDateTime(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function daysBetweenNow(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

function daysSince(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor((Date.now() - date.getTime()) / 86_400_000);
}

function countByStudio<T extends { studio_id: string | null }>(rows: T[]) {
  const map = new Map<string, number>();
  for (const row of rows) {
    if (!row.studio_id) continue;
    map.set(row.studio_id, (map.get(row.studio_id) ?? 0) + 1);
  }
  return map;
}

function getPlanLabel(studio: StudioRow, subscription: SubscriptionRow | undefined) {
  const subscriptionPlan = getOne(subscription?.subscription_plans ?? null);
  const code = normalize(subscriptionPlan?.code) || normalize(studio.billing_plan);
  return subscriptionPlan?.name?.trim() || PLAN_LABELS[code] || (code ? formatLabel(code) : "No plan");
}

function getBillingStatus(studio: StudioRow, subscription: SubscriptionRow | undefined) {
  return normalize(subscription?.status) || normalize(studio.subscription_status) || (studio.active === false ? "inactive" : "not_started");
}

function statusBadgeClass(status: string) {
  if (status === "active") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (status === "trialing") return "bg-blue-50 text-blue-700 ring-blue-200";
  if (status === "past_due" || status === "unpaid" || status === "incomplete") return "bg-amber-50 text-amber-700 ring-amber-200";
  if (status === "canceled" || status === "cancelled") return "bg-rose-50 text-rose-700 ring-rose-200";
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function focusBadgeClass(focus: SuccessFocus) {
  if (focus === "conversion") return "bg-violet-50 text-violet-700 ring-violet-200";
  if (focus === "trial-risk") return "bg-amber-50 text-amber-700 ring-amber-200";
  if (focus === "billing-risk") return "bg-rose-50 text-rose-700 ring-rose-200";
  if (focus === "inactive") return "bg-slate-100 text-slate-700 ring-slate-200";
  return "bg-emerald-50 text-emerald-700 ring-emerald-200";
}

function urgencyClass(urgency: SuccessRow["urgency"]) {
  if (urgency === "high") return "bg-rose-600 text-white";
  if (urgency === "medium") return "bg-amber-500 text-white";
  return "bg-slate-200 text-slate-700";
}

function buildSuccessRow(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
  clientCount: number;
  appointmentCount: number;
  eventCount: number;
  publicEventCount: number;
  paidInvoiceCount: number;
  invoiceCollections: number;
}): SuccessRow {
  const billingStatus = getBillingStatus(params.studio, params.subscription);
  const trialEndsAt = params.subscription?.trial_ends_at ?? params.studio.trial_ends_at ?? null;
  const daysUntilTrialEnd = daysBetweenNow(trialEndsAt);
  const daysSinceAccess = daysSince(params.studio.last_workspace_access_at);
  const activationTotal = params.clientCount + params.appointmentCount + params.eventCount + params.paidInvoiceCount;
  let score = 50;

  if (billingStatus === "active") score += 25;
  if (billingStatus === "trialing") score += 8;
  if (BILLING_RISK_STATUSES.has(billingStatus)) score -= 35;
  if (params.studio.active === false) score -= 25;
  if (daysSinceAccess === null) score -= 18;
  else if (daysSinceAccess <= 7) score += 12;
  else if (daysSinceAccess >= 30) score -= 20;
  else if (daysSinceAccess >= 14) score -= 8;
  if (activationTotal >= 10) score += 15;
  if (params.publicEventCount > 0) score += 5;

  score = Math.max(0, Math.min(100, score));

  if (BILLING_RISK_STATUSES.has(billingStatus)) {
    return {
      studio: params.studio,
      planLabel: getPlanLabel(params.studio, params.subscription),
      billingStatus,
      focus: "billing-risk",
      focusLabel: "Billing Risk",
      score,
      daysUntilTrialEnd,
      daysSinceAccess,
      clientCount: params.clientCount,
      appointmentCount: params.appointmentCount,
      eventCount: params.eventCount,
      publicEventCount: params.publicEventCount,
      paidInvoiceCount: params.paidInvoiceCount,
      invoiceCollections: params.invoiceCollections,
      reason: "Subscription status needs attention before access, retention, or conversion is impacted.",
      nextAction: "Review billing status, then contact the studio owner with the next payment or subscription step.",
      urgency: "high",
    };
  }

  if (billingStatus === "trialing" && daysUntilTrialEnd !== null && daysUntilTrialEnd <= 7) {
    return {
      studio: params.studio,
      planLabel: getPlanLabel(params.studio, params.subscription),
      billingStatus,
      focus: "trial-risk",
      focusLabel: "Trial Risk",
      score,
      daysUntilTrialEnd,
      daysSinceAccess,
      clientCount: params.clientCount,
      appointmentCount: params.appointmentCount,
      eventCount: params.eventCount,
      publicEventCount: params.publicEventCount,
      paidInvoiceCount: params.paidInvoiceCount,
      invoiceCollections: params.invoiceCollections,
      reason: daysUntilTrialEnd < 0 ? "Trial has expired without a paid conversion." : "Trial ends soon and needs conversion follow-up.",
      nextAction: "Ask what is blocking paid conversion and offer a short onboarding or setup session.",
      urgency: daysUntilTrialEnd < 0 ? "high" : "medium",
    };
  }

  if (daysSinceAccess === null || daysSinceAccess >= 30 || params.studio.active === false) {
    return {
      studio: params.studio,
      planLabel: getPlanLabel(params.studio, params.subscription),
      billingStatus,
      focus: "inactive",
      focusLabel: "Inactive",
      score,
      daysUntilTrialEnd,
      daysSinceAccess,
      clientCount: params.clientCount,
      appointmentCount: params.appointmentCount,
      eventCount: params.eventCount,
      publicEventCount: params.publicEventCount,
      paidInvoiceCount: params.paidInvoiceCount,
      invoiceCollections: params.invoiceCollections,
      reason: daysSinceAccess === null ? "No recorded workspace access yet." : "Workspace activity has gone cold.",
      nextAction: "Send a reactivation note and ask whether setup, imports, or staff training are blocking progress.",
      urgency: "medium",
    };
  }

  if (billingStatus === "trialing" && activationTotal >= 10 && daysSinceAccess !== null && daysSinceAccess <= 14) {
    return {
      studio: params.studio,
      planLabel: getPlanLabel(params.studio, params.subscription),
      billingStatus,
      focus: "conversion",
      focusLabel: "Conversion",
      score,
      daysUntilTrialEnd,
      daysSinceAccess,
      clientCount: params.clientCount,
      appointmentCount: params.appointmentCount,
      eventCount: params.eventCount,
      publicEventCount: params.publicEventCount,
      paidInvoiceCount: params.paidInvoiceCount,
      invoiceCollections: params.invoiceCollections,
      reason: "Trial has meaningful activation signals and recent activity.",
      nextAction: "Reach out with a conversion nudge and confirm the right paid plan.",
      urgency: "medium",
    };
  }

  return {
    studio: params.studio,
    planLabel: getPlanLabel(params.studio, params.subscription),
    billingStatus,
    focus: "healthy",
    focusLabel: "Healthy",
    score,
    daysUntilTrialEnd,
    daysSinceAccess,
    clientCount: params.clientCount,
    appointmentCount: params.appointmentCount,
    eventCount: params.eventCount,
    publicEventCount: params.publicEventCount,
    paidInvoiceCount: params.paidInvoiceCount,
    invoiceCollections: params.invoiceCollections,
    reason: "No immediate success risk detected from current platform signals.",
    nextAction: "Monitor for upgrade, organizer suite, mobile app, or integration expansion opportunities.",
    urgency: "low",
  };
}

function StatCard({ label, value, helper, tone = "slate" }: { label: string; value: string; helper: string; tone?: "slate" | "emerald" | "amber" | "rose" | "violet" }) {
  const toneClass = {
    slate: "from-slate-50 to-white text-slate-950",
    emerald: "from-emerald-50 to-white text-emerald-950",
    amber: "from-amber-50 to-white text-amber-950",
    rose: "from-rose-50 to-white text-rose-950",
    violet: "from-violet-50 to-white text-violet-950",
  }[tone];

  return (
    <div className={`rounded-[28px] border border-slate-200 bg-gradient-to-br ${toneClass} p-5 shadow-sm`}>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-3 text-3xl font-semibold tracking-tight">{value}</p>
      <p className="mt-2 text-sm leading-6 text-slate-600">{helper}</p>
    </div>
  );
}

export default async function PlatformSuccessPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePlatformAdmin();

  const query = await searchParams;
  const focusFilter = normalize(query.focus) || "all";
  const q = normalize(query.q);
  const supabase = await createClient();

  const [
    { data: studios, error: studiosError },
    { data: subscriptions, error: subscriptionsError },
    { data: events, error: eventsError },
    { data: clients, error: clientsError },
    { data: appointments, error: appointmentsError },
    { data: invoices, error: invoicesError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name, created_at, billing_plan, subscription_status, active, stripe_customer_id, stripe_subscription_id, trial_ends_at, last_workspace_access_at, last_workspace_access_user_id")
      .order("created_at", { ascending: false }),
    supabase.from("studio_subscriptions").select(`
      id,
      studio_id,
      status,
      current_period_end,
      trial_ends_at,
      cancel_at_period_end,
      subscription_plans (
        code,
        name
      )
    `),
    supabase.from("events").select("id, studio_id, status, visibility"),
    supabase.from("clients").select("id, studio_id"),
    supabase.from("appointments").select("id, studio_id"),
    supabase.from("studio_invoices").select("id, studio_id, amount_paid, status"),
  ]);

  if (studiosError) throw new Error(`Failed to load studios: ${studiosError.message}`);
  if (subscriptionsError) throw new Error(`Failed to load subscriptions: ${subscriptionsError.message}`);
  if (eventsError) throw new Error(`Failed to load events: ${eventsError.message}`);
  if (clientsError) throw new Error(`Failed to load clients: ${clientsError.message}`);
  if (appointmentsError) throw new Error(`Failed to load appointments: ${appointmentsError.message}`);
  if (invoicesError) throw new Error(`Failed to load invoices: ${invoicesError.message}`);

  const typedStudios = (studios ?? []) as StudioRow[];
  const typedSubscriptions = (subscriptions ?? []) as SubscriptionRow[];
  const typedEvents = (events ?? []) as EventRow[];
  const typedClients = (clients ?? []) as ClientRow[];
  const typedAppointments = (appointments ?? []) as AppointmentRow[];
  const typedInvoices = (invoices ?? []) as InvoiceRow[];

  const subscriptionByStudioId = new Map(typedSubscriptions.map((subscription) => [subscription.studio_id, subscription]));
  const clientCounts = countByStudio(typedClients);
  const appointmentCounts = countByStudio(typedAppointments);
  const eventCounts = new Map<string, { total: number; publicPublished: number }>();
  const invoiceStats = new Map<string, { paidCount: number; collections: number }>();

  for (const event of typedEvents) {
    if (!event.studio_id) continue;
    const current = eventCounts.get(event.studio_id) ?? { total: 0, publicPublished: 0 };
    current.total += 1;
    if (normalize(event.visibility) === "public" && normalize(event.status) === "published") {
      current.publicPublished += 1;
    }
    eventCounts.set(event.studio_id, current);
  }

  for (const invoice of typedInvoices) {
    const current = invoiceStats.get(invoice.studio_id) ?? { paidCount: 0, collections: 0 };
    if (PAID_INVOICE_STATUSES.has(normalize(invoice.status))) {
      current.paidCount += 1;
      current.collections += Number(invoice.amount_paid ?? 0) / 100;
    }
    invoiceStats.set(invoice.studio_id, current);
  }

  const successRows = typedStudios.map((studio) => {
    const eventCount = eventCounts.get(studio.id) ?? { total: 0, publicPublished: 0 };
    const invoiceStat = invoiceStats.get(studio.id) ?? { paidCount: 0, collections: 0 };

    return buildSuccessRow({
      studio,
      subscription: subscriptionByStudioId.get(studio.id),
      clientCount: clientCounts.get(studio.id) ?? 0,
      appointmentCount: appointmentCounts.get(studio.id) ?? 0,
      eventCount: eventCount.total,
      publicEventCount: eventCount.publicPublished,
      paidInvoiceCount: invoiceStat.paidCount,
      invoiceCollections: invoiceStat.collections,
    });
  });

  const filteredRows = successRows
    .filter((row) => (focusFilter === "all" ? true : row.focus === focusFilter))
    .filter((row) => (q ? normalize(row.studio.name).includes(q) : true))
    .sort((a, b) => {
      const priority: Record<SuccessFocus, number> = {
        "billing-risk": 0,
        "trial-risk": 1,
        inactive: 2,
        conversion: 3,
        healthy: 4,
      };
      return priority[a.focus] - priority[b.focus] || a.score - b.score || a.studio.name.localeCompare(b.studio.name);
    });

  const conversionRows = successRows.filter((row) => row.focus === "conversion");
  const trialRiskRows = successRows.filter((row) => row.focus === "trial-risk");
  const billingRiskRows = successRows.filter((row) => row.focus === "billing-risk");
  const inactiveRows = successRows.filter((row) => row.focus === "inactive");
  const needsAttentionRows = successRows.filter((row) => row.focus !== "healthy");
  const highPriorityRows = needsAttentionRows.slice().sort((a, b) => a.score - b.score).slice(0, 5);

  const ariaSignal = billingRiskRows.length
    ? {
        title: "Billing risk should be handled first.",
        detail: `${billingRiskRows.length} studio${billingRiskRows.length === 1 ? "" : "s"} have payment or subscription statuses that need attention before broader activation work.`,
      }
    : trialRiskRows.length
      ? {
          title: "Trial conversion follow-up is the highest leverage work.",
          detail: `${trialRiskRows.length} trial studio${trialRiskRows.length === 1 ? "" : "s"} are near or past trial end. Prioritize the ones with recent activity and client or appointment setup.`,
        }
      : conversionRows.length
        ? {
            title: "Several studios are ready for a conversion nudge.",
            detail: `${conversionRows.length} studio${conversionRows.length === 1 ? "" : "s"} show activation signals. Ask what is needed to move into a paid plan.`,
          }
        : {
            title: "No urgent success risks detected.",
            detail: "Use this window to review onboarding notes, identify expansion candidates, and prepare the next beta or rollout communication.",
          };

  return (
    <main className="space-y-6">
      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-violet-600">Platform Success</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">Success Center</h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Work the accounts that need action today: trial conversion, billing risk, inactive studios, and expansion-ready workspaces.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/platform/studio-health" className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50">
              Studio Health
            </Link>
            <Link href="/platform/support-notes" className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800">
              Support Notes
            </Link>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Needs Attention" value={String(needsAttentionRows.length)} helper="Studios outside healthy status" tone={needsAttentionRows.length ? "amber" : "emerald"} />
        <StatCard label="Conversion" value={String(conversionRows.length)} helper="Activated trials ready for paid follow-up" tone="violet" />
        <StatCard label="Trial Risk" value={String(trialRiskRows.length)} helper="Trials ending soon or expired" tone="amber" />
        <StatCard label="Billing Risk" value={String(billingRiskRows.length)} helper="Past due, unpaid, incomplete, or canceled" tone={billingRiskRows.length ? "rose" : "emerald"} />
        <StatCard label="Inactive" value={String(inactiveRows.length)} helper="No recent workspace activity" tone="slate" />
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Priority Queue</p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">Top Follow-ups</h2>
            </div>
            <Link href="/platform/studios" className="text-sm font-semibold text-[#BE185D]">All studios</Link>
          </div>

          <div className="mt-5 space-y-3">
            {highPriorityRows.length ? (
              highPriorityRows.map((row) => (
                <div key={row.studio.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/platform/studios/${row.studio.id}`} className="font-semibold text-slate-950 hover:text-[#BE185D]">
                          {row.studio.name}
                        </Link>
                        <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${focusBadgeClass(row.focus)}`}>
                          {row.focusLabel}
                        </span>
                        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${urgencyClass(row.urgency)}`}>
                          {formatLabel(row.urgency)}
                        </span>
                      </div>
                      <p className="mt-2 text-sm text-slate-600">{row.reason}</p>
                      <p className="mt-2 text-sm font-medium text-slate-800">Next: {row.nextAction}</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Link href={`/platform/studios/${row.studio.id}`} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                        View
                      </Link>
                      <Link href="/platform/support-notes" className="rounded-xl bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800">
                        Notes
                      </Link>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-800">
                No urgent success follow-ups are currently detected.
              </div>
            )}
          </div>
        </div>

        <div className="rounded-[32px] border border-violet-200 bg-violet-50 p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">ARIA Success Signal</p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-violet-950">{ariaSignal.title}</h2>
          <p className="mt-3 text-sm leading-6 text-violet-900">{ariaSignal.detail}</p>
          <div className="mt-5 rounded-2xl border border-violet-200 bg-white/70 p-4 text-sm leading-6 text-violet-900">
            Future ARIA workflow: generate the outreach draft, queue it for platform approval, log the outcome, and schedule the next follow-up.
          </div>
        </div>
      </section>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Success Workspace</p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">Studio Follow-up Board</h2>
          </div>
          <form className="flex flex-col gap-2 sm:flex-row">
            <input
              name="q"
              defaultValue={q}
              placeholder="Search studios"
              className="min-h-11 rounded-xl border border-slate-200 px-3 text-sm text-slate-900 shadow-sm outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100"
            />
            <select
              name="focus"
              defaultValue={focusFilter}
              className="min-h-11 rounded-xl border border-slate-200 px-3 text-sm text-slate-900 shadow-sm outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100"
            >
              {FOCUS_FILTERS.map((filter) => (
                <option key={filter.value} value={filter.value}>{filter.label}</option>
              ))}
            </select>
            <button className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800">
              Filter
            </button>
          </form>
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              <tr>
                <th className="px-4 py-3">Studio</th>
                <th className="px-4 py-3">Focus</th>
                <th className="px-4 py-3">Billing</th>
                <th className="px-4 py-3">Activity</th>
                <th className="px-4 py-3">Activation</th>
                <th className="px-4 py-3">Next Step</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {filteredRows.map((row) => (
                <tr key={row.studio.id}>
                  <td className="px-4 py-4 align-top">
                    <Link href={`/platform/studios/${row.studio.id}`} className="font-semibold text-slate-950 hover:text-[#BE185D]">
                      {row.studio.name}
                    </Link>
                    <p className="mt-1 text-xs text-slate-500">Created {formatDate(row.studio.created_at)}</p>
                  </td>
                  <td className="px-4 py-4 align-top">
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${focusBadgeClass(row.focus)}`}>
                      {row.focusLabel}
                    </span>
                    <p className="mt-2 text-xs text-slate-500">Score {row.score}/100</p>
                  </td>
                  <td className="px-4 py-4 align-top">
                    <p className="font-semibold text-slate-900">{row.planLabel}</p>
                    <span className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-semibold ring-1 ${statusBadgeClass(row.billingStatus)}`}>
                      {formatLabel(row.billingStatus)}
                    </span>
                    {row.daysUntilTrialEnd !== null ? (
                      <p className="mt-2 text-xs text-slate-500">Trial {row.daysUntilTrialEnd < 0 ? "ended" : "ends"} {Math.abs(row.daysUntilTrialEnd)} day{Math.abs(row.daysUntilTrialEnd) === 1 ? "" : "s"} {row.daysUntilTrialEnd < 0 ? "ago" : ""}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-4 align-top text-slate-600">
                    <p>{formatDateTime(row.studio.last_workspace_access_at)}</p>
                    <p className="mt-1 text-xs text-slate-500">{row.daysSinceAccess === null ? "No access recorded" : `${row.daysSinceAccess} day${row.daysSinceAccess === 1 ? "" : "s"} ago`}</p>
                  </td>
                  <td className="px-4 py-4 align-top text-slate-600">
                    <p>{row.clientCount} clients · {row.appointmentCount} appointments</p>
                    <p className="mt-1">{row.eventCount} events · {row.publicEventCount} public</p>
                    <p className="mt-1">{row.paidInvoiceCount} paid invoices · {formatMoney(row.invoiceCollections)}</p>
                  </td>
                  <td className="max-w-md px-4 py-4 align-top text-slate-600">
                    <p>{row.nextAction}</p>
                  </td>
                  <td className="px-4 py-4 align-top">
                    <div className="flex flex-col gap-2">
                      <Link href={`/platform/studios/${row.studio.id}`} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-center text-xs font-semibold text-slate-700 hover:bg-slate-50">
                        View Studio
                      </Link>
                      <Link href="/platform/billing" className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-center text-xs font-semibold text-slate-700 hover:bg-slate-50">
                        Billing
                      </Link>
                      <Link href="/platform/support-notes" className="rounded-xl bg-slate-950 px-3 py-2 text-center text-xs font-semibold text-white hover:bg-slate-800">
                        Add Note Later
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredRows.length === 0 ? (
            <div className="bg-slate-50 p-6 text-sm text-slate-500">No studios match this success filter.</div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
