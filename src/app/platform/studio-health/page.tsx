import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createClient } from "@/lib/supabase/server";

const HEALTH_FILTERS = [
  { value: "all", label: "All Studios" },
  { value: "healthy", label: "Healthy" },
  { value: "conversion", label: "Conversion Candidates" },
  { value: "trial-risk", label: "Trial Risk" },
  { value: "billing-risk", label: "Billing Risk" },
  { value: "inactive", label: "Inactive" },
];

type SearchParams = Promise<{
  health?: string;
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
  billing_interval: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  cancel_at_period_end: boolean | null;
  subscription_plans: SubscriptionPlanRow | SubscriptionPlanRow[] | null;
};

type OrganizerRow = {
  id: string;
  studio_id: string;
  active: boolean | null;
};

type EventRow = {
  id: string;
  studio_id: string | null;
  status: string | null;
  visibility: string | null;
  event_type: string | null;
  created_at: string;
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
  created_at: string;
};

type HealthCategory = "healthy" | "conversion" | "trial-risk" | "billing-risk" | "inactive";

type StudioHealthRow = {
  studio: StudioRow;
  planLabel: string;
  planCode: string;
  billingStatus: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  daysUntilTrialEnd: number | null;
  daysSinceAccess: number | null;
  clientCount: number;
  appointmentCount: number;
  eventCount: number;
  publicEventCount: number;
  paidInvoiceCount: number;
  invoiceCollections: number;
  organizerCount: number;
  activeOrganizerCount: number;
  score: number;
  category: HealthCategory;
  categoryLabel: string;
  recommendation: string;
  signals: string[];
};

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

function formatFallbackLabel(value: string) {
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

function getPlanLabel(studio: StudioRow, subscription: SubscriptionRow | undefined) {
  const subscriptionPlan = getOne(subscription?.subscription_plans ?? null);
  const code = normalize(subscriptionPlan?.code) || normalize(studio.billing_plan);
  return subscriptionPlan?.name?.trim() || PLAN_LABELS[code] || (code ? formatFallbackLabel(code) : "No plan");
}

function getPlanCode(studio: StudioRow, subscription: SubscriptionRow | undefined) {
  const subscriptionPlan = getOne(subscription?.subscription_plans ?? null);
  return normalize(subscriptionPlan?.code) || normalize(studio.billing_plan) || "none";
}

function getBillingStatus(studio: StudioRow, subscription: SubscriptionRow | undefined) {
  return normalize(subscription?.status) || normalize(studio.subscription_status) || (studio.active === false ? "inactive" : "not_started");
}

function getTrialEndsAt(studio: StudioRow, subscription: SubscriptionRow | undefined) {
  return subscription?.trial_ends_at ?? studio.trial_ends_at ?? null;
}

function getCurrentPeriodEnd(studio: StudioRow, subscription: SubscriptionRow | undefined) {
  return subscription?.current_period_end ?? getTrialEndsAt(studio, subscription) ?? null;
}

function countByStudio<T extends { studio_id: string | null }>(rows: T[]) {
  const map = new Map<string, number>();
  for (const row of rows) {
    if (!row.studio_id) continue;
    map.set(row.studio_id, (map.get(row.studio_id) ?? 0) + 1);
  }
  return map;
}

function statusBadgeClass(status: string) {
  if (status === "active") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (status === "trialing") return "bg-blue-50 text-blue-700 ring-blue-200";
  if (status === "past_due" || status === "unpaid" || status === "incomplete") return "bg-amber-50 text-amber-700 ring-amber-200";
  if (status === "canceled" || status === "cancelled") return "bg-rose-50 text-rose-700 ring-rose-200";
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function healthBadgeClass(category: HealthCategory) {
  if (category === "healthy") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (category === "conversion") return "bg-violet-50 text-violet-700 ring-violet-200";
  if (category === "trial-risk") return "bg-amber-50 text-amber-700 ring-amber-200";
  if (category === "billing-risk") return "bg-rose-50 text-rose-700 ring-rose-200";
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function buildHealthRow(params: {
  studio: StudioRow;
  subscription?: SubscriptionRow;
  clientCount: number;
  appointmentCount: number;
  eventCount: number;
  publicEventCount: number;
  paidInvoiceCount: number;
  invoiceCollections: number;
  organizerCount: number;
  activeOrganizerCount: number;
}): StudioHealthRow {
  const billingStatus = getBillingStatus(params.studio, params.subscription);
  const planLabel = getPlanLabel(params.studio, params.subscription);
  const planCode = getPlanCode(params.studio, params.subscription);
  const trialEndsAt = getTrialEndsAt(params.studio, params.subscription);
  const currentPeriodEnd = getCurrentPeriodEnd(params.studio, params.subscription);
  const daysUntilTrialEnd = daysBetweenNow(trialEndsAt);
  const daysSinceAccess = daysSince(params.studio.last_workspace_access_at);
  const signals: string[] = [];
  let score = 50;

  if (billingStatus === "active") {
    score += 24;
    signals.push("Paid subscription active");
  }
  if (billingStatus === "trialing") {
    score += 8;
    signals.push("Trial in progress");
  }
  if (BILLING_RISK_STATUSES.has(billingStatus)) {
    score -= 30;
    signals.push("Billing needs attention");
  }
  if (params.studio.active === false) {
    score -= 25;
    signals.push("Workspace inactive");
  }
  if (daysUntilTrialEnd !== null && billingStatus === "trialing") {
    if (daysUntilTrialEnd < 0) {
      score -= 28;
      signals.push("Trial expired");
    } else if (daysUntilTrialEnd <= 7) {
      score -= 14;
      signals.push("Trial ends soon");
    }
  }
  if (daysSinceAccess === null) {
    score -= 18;
    signals.push("No recorded workspace access");
  } else if (daysSinceAccess <= 7) {
    score += 12;
    signals.push("Recently active");
  } else if (daysSinceAccess >= 30) {
    score -= 18;
    signals.push("Inactive for 30+ days");
  } else if (daysSinceAccess >= 14) {
    score -= 8;
    signals.push("Activity slowing");
  }
  if (params.clientCount >= 10) score += 8;
  if (params.appointmentCount >= 10) score += 8;
  if (params.eventCount > 0) score += 5;
  if (params.publicEventCount > 0) score += 5;
  if (params.paidInvoiceCount > 0) score += 8;

  score = Math.max(0, Math.min(100, score));

  let category: HealthCategory = "healthy";
  let categoryLabel = "Healthy";
  let recommendation = "Keep monitoring usage and look for expansion or upgrade opportunities.";

  if (BILLING_RISK_STATUSES.has(billingStatus)) {
    category = "billing-risk";
    categoryLabel = "Billing Risk";
    recommendation = "Review subscription status and follow up before access or conversion is impacted.";
  } else if (daysSinceAccess === null || (daysSinceAccess !== null && daysSinceAccess >= 30) || params.studio.active === false) {
    category = "inactive";
    categoryLabel = "Inactive";
    recommendation = "Send an onboarding or reactivation nudge and confirm whether the workspace is still moving forward.";
  } else if (billingStatus === "trialing" && daysUntilTrialEnd !== null && daysUntilTrialEnd <= 7) {
    category = "trial-risk";
    categoryLabel = "Trial Risk";
    recommendation = "Prioritize conversion outreach before the trial window closes.";
  } else if (
    billingStatus === "trialing" &&
    params.clientCount + params.appointmentCount + params.eventCount >= 10 &&
    daysSinceAccess !== null &&
    daysSinceAccess <= 14
  ) {
    category = "conversion";
    categoryLabel = "Conversion Candidate";
    recommendation = "This studio has activation signals. Ask what is needed to move to paid.";
  }

  if (signals.length === 0) signals.push("Limited usage data available");

  return {
    studio: params.studio,
    planLabel,
    planCode,
    billingStatus,
    trialEndsAt,
    currentPeriodEnd,
    daysUntilTrialEnd,
    daysSinceAccess,
    clientCount: params.clientCount,
    appointmentCount: params.appointmentCount,
    eventCount: params.eventCount,
    publicEventCount: params.publicEventCount,
    paidInvoiceCount: params.paidInvoiceCount,
    invoiceCollections: params.invoiceCollections,
    organizerCount: params.organizerCount,
    activeOrganizerCount: params.activeOrganizerCount,
    score,
    category,
    categoryLabel,
    recommendation,
    signals,
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

export default async function PlatformStudioHealthPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePlatformAdmin();

  const query = await searchParams;
  const healthFilter = normalize(query.health) || "all";
  const q = normalize(query.q);

  const supabase = await createClient();

  const [
    { data: studios, error: studiosError },
    { data: subscriptions, error: subscriptionsError },
    { data: organizers, error: organizersError },
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
      billing_interval,
      current_period_start,
      current_period_end,
      trial_ends_at,
      cancel_at_period_end,
      subscription_plans (
        code,
        name
      )
    `),
    supabase.from("organizers").select("id, studio_id, active"),
    supabase.from("events").select("id, studio_id, status, visibility, event_type, created_at"),
    supabase.from("clients").select("id, studio_id"),
    supabase.from("appointments").select("id, studio_id"),
    supabase.from("studio_invoices").select("id, studio_id, amount_paid, status, created_at"),
  ]);

  if (studiosError) throw new Error(`Failed to load studios: ${studiosError.message}`);
  if (subscriptionsError) throw new Error(`Failed to load subscriptions: ${subscriptionsError.message}`);
  if (organizersError) throw new Error(`Failed to load organizers: ${organizersError.message}`);
  if (eventsError) throw new Error(`Failed to load events: ${eventsError.message}`);
  if (clientsError) throw new Error(`Failed to load clients: ${clientsError.message}`);
  if (appointmentsError) throw new Error(`Failed to load appointments: ${appointmentsError.message}`);
  if (invoicesError) throw new Error(`Failed to load invoices: ${invoicesError.message}`);

  const typedStudios = (studios ?? []) as StudioRow[];
  const typedSubscriptions = (subscriptions ?? []) as SubscriptionRow[];
  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const typedEvents = (events ?? []) as EventRow[];
  const typedClients = (clients ?? []) as ClientRow[];
  const typedAppointments = (appointments ?? []) as AppointmentRow[];
  const typedInvoices = (invoices ?? []) as InvoiceRow[];

  const subscriptionByStudioId = new Map(typedSubscriptions.map((subscription) => [subscription.studio_id, subscription]));
  const clientCounts = countByStudio(typedClients);
  const appointmentCounts = countByStudio(typedAppointments);
  const eventCounts = new Map<string, { total: number; publicPublished: number }>();
  const organizerCounts = new Map<string, { total: number; active: number }>();
  const invoiceStats = new Map<string, { paidCount: number; collections: number }>();

  for (const organizer of typedOrganizers) {
    const current = organizerCounts.get(organizer.studio_id) ?? { total: 0, active: 0 };
    current.total += 1;
    if (organizer.active) current.active += 1;
    organizerCounts.set(organizer.studio_id, current);
  }

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

  const healthRows = typedStudios.map((studio) => {
    const eventCount = eventCounts.get(studio.id) ?? { total: 0, publicPublished: 0 };
    const organizerCount = organizerCounts.get(studio.id) ?? { total: 0, active: 0 };
    const invoiceStat = invoiceStats.get(studio.id) ?? { paidCount: 0, collections: 0 };

    return buildHealthRow({
      studio,
      subscription: subscriptionByStudioId.get(studio.id),
      clientCount: clientCounts.get(studio.id) ?? 0,
      appointmentCount: appointmentCounts.get(studio.id) ?? 0,
      eventCount: eventCount.total,
      publicEventCount: eventCount.publicPublished,
      paidInvoiceCount: invoiceStat.paidCount,
      invoiceCollections: invoiceStat.collections,
      organizerCount: organizerCount.total,
      activeOrganizerCount: organizerCount.active,
    });
  });

  const filteredRows = healthRows
    .filter((row) => (healthFilter === "all" ? true : row.category === healthFilter))
    .filter((row) => (q ? normalize(row.studio.name).includes(q) : true))
    .sort((a, b) => {
      const priority: Record<HealthCategory, number> = {
        "billing-risk": 0,
        "trial-risk": 1,
        inactive: 2,
        conversion: 3,
        healthy: 4,
      };
      return priority[a.category] - priority[b.category] || a.score - b.score || a.studio.name.localeCompare(b.studio.name);
    });

  const healthyCount = healthRows.filter((row) => row.category === "healthy").length;
  const conversionCount = healthRows.filter((row) => row.category === "conversion").length;
  const trialRiskCount = healthRows.filter((row) => row.category === "trial-risk").length;
  const billingRiskCount = healthRows.filter((row) => row.category === "billing-risk").length;
  const inactiveCount = healthRows.filter((row) => row.category === "inactive").length;
  const averageScore = healthRows.length
    ? Math.round(healthRows.reduce((sum, row) => sum + row.score, 0) / healthRows.length)
    : 0;

  const topRiskRows = healthRows
    .filter((row) => row.category !== "healthy")
    .sort((a, b) => a.score - b.score)
    .slice(0, 5);

  return (
    <main className="space-y-6">
      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-violet-600">Studio Health</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">Platform Studio Activation</h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              See which studios are healthy, ready to convert, at risk, or inactive so platform follow-up is focused on the accounts that need action today.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/platform/studios" className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50">
              Studios
            </Link>
            <Link href="/platform/billing" className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50">
              Billing
            </Link>
            <Link href="/platform/support-notes" className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800">
              Support Notes
            </Link>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Average Health" value={`${averageScore}%`} helper={`${healthRows.length} studio workspace${healthRows.length === 1 ? "" : "s"} reviewed`} tone="violet" />
        <StatCard label="Healthy" value={String(healthyCount)} helper="Stable usage and billing signals" tone="emerald" />
        <StatCard label="Conversion" value={String(conversionCount)} helper="Trial studios showing activation" tone="violet" />
        <StatCard label="At Risk" value={String(trialRiskCount + billingRiskCount)} helper="Trial or billing follow-up needed" tone="amber" />
        <StatCard label="Inactive" value={String(inactiveCount)} helper="No recent workspace activity" tone="rose" />
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <form className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_240px_auto] lg:items-end">
          <label className="space-y-2">
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Search</span>
            <input
              type="search"
              name="q"
              defaultValue={query.q ?? ""}
              placeholder="Search studios"
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none focus:border-violet-300 focus:ring-4 focus:ring-violet-100"
            />
          </label>
          <label className="space-y-2">
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Health</span>
            <select
              name="health"
              defaultValue={healthFilter}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none focus:border-violet-300 focus:ring-4 focus:ring-violet-100"
            >
              {HEALTH_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-slate-800">
            Apply
          </button>
        </form>
      </section>

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Workspace Watchlist</p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">Studio Health Table</h2>
            </div>
            <p className="text-sm text-slate-500">{filteredRows.length} matching studio{filteredRows.length === 1 ? "" : "s"}</p>
          </div>

          <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
            {filteredRows.length ? (
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Studio</th>
                    <th className="px-4 py-3">Plan</th>
                    <th className="px-4 py-3">Billing</th>
                    <th className="px-4 py-3">Activity</th>
                    <th className="px-4 py-3">Usage</th>
                    <th className="px-4 py-3">Health</th>
                    <th className="px-4 py-3">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {filteredRows.map((row) => (
                    <tr key={row.studio.id} className="align-top">
                      <td className="px-4 py-4">
                        <p className="font-semibold text-slate-950">{row.studio.name}</p>
                        <p className="mt-1 text-xs text-slate-500">Created {formatDate(row.studio.created_at)}</p>
                        <p className="mt-1 text-xs text-slate-500">Trial ends {formatDate(row.trialEndsAt)}</p>
                      </td>
                      <td className="px-4 py-4 text-slate-600">{row.planLabel}</td>
                      <td className="px-4 py-4">
                        <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${statusBadgeClass(row.billingStatus)}`}>
                          {formatFallbackLabel(row.billingStatus)}
                        </span>
                        {row.currentPeriodEnd ? <p className="mt-2 text-xs text-slate-500">Period ends {formatDate(row.currentPeriodEnd)}</p> : null}
                      </td>
                      <td className="px-4 py-4 text-slate-600">
                        <p>{formatDateTime(row.studio.last_workspace_access_at)}</p>
                        <p className="mt-1 text-xs text-slate-500">{row.daysSinceAccess === null ? "No access signal" : `${row.daysSinceAccess} day${row.daysSinceAccess === 1 ? "" : "s"} ago`}</p>
                      </td>
                      <td className="px-4 py-4 text-slate-600">
                        <p>{row.clientCount} clients</p>
                        <p>{row.appointmentCount} appointments</p>
                        <p>{row.eventCount} events · {row.publicEventCount} public</p>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-2">
                          <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${healthBadgeClass(row.category)}`}>{row.categoryLabel}</span>
                          <span className="text-sm font-semibold text-slate-950">{row.score}%</span>
                        </div>
                        <p className="mt-2 max-w-xs text-xs leading-5 text-slate-500">{row.recommendation}</p>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex flex-col gap-2">
                          <Link href={`/platform/studios/${row.studio.id}`} className="text-sm font-semibold text-[#BE185D]">View studio</Link>
                          <Link href={`/platform/support-notes?target=workspace&targetId=${row.studio.id}`} className="text-sm font-semibold text-slate-700">Support notes</Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="bg-slate-50 p-6 text-sm text-slate-500">No studios match this filter.</div>
            )}
          </div>
        </section>

        <aside className="space-y-6">
          <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">ARIA Platform Signal</p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">Who needs action today?</h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Focus first on billing risk, trials ending soon, and studios with no recent workspace access. Conversion candidates are next because they already show activation signals.
            </p>
          </section>

          <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Priority Follow-Up</p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">Top Watchlist</h2>
            <div className="mt-5 space-y-3">
              {topRiskRows.length ? (
                topRiskRows.map((row) => (
                  <Link key={row.studio.id} href={`/platform/studios/${row.studio.id}`} className="block rounded-2xl border border-slate-200 bg-slate-50 p-4 transition hover:bg-white">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-semibold text-slate-950">{row.studio.name}</p>
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${healthBadgeClass(row.category)}`}>{row.score}%</span>
                    </div>
                    <p className="mt-2 text-sm text-slate-600">{row.categoryLabel}</p>
                    <p className="mt-2 text-xs leading-5 text-slate-500">{row.signals.slice(0, 2).join(" · ")}</p>
                  </Link>
                ))
              ) : (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                  No urgent studio health risks are showing right now.
                </div>
              )}
            </div>
          </section>

          <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Revenue Context</p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">Paid Collections</h2>
            <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
              {formatMoney(healthRows.reduce((sum, row) => sum + row.invoiceCollections, 0))}
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Lifetime paid invoice collections visible in the platform invoice table for these studio workspaces.
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}
