import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createClient } from "@/lib/supabase/server";
import { createOpsReviewFollowUpAction, markPlatformOpsReviewSignalAction } from "./actions";

type SearchParams = Promise<{
  focus?: string;
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

type ClientRow = { id: string; studio_id: string };
type AppointmentRow = { id: string; studio_id: string };
type EventRow = { id: string; studio_id: string | null; status: string | null; visibility: string | null };
type InvoiceRow = { id: string; studio_id: string; amount_paid: number | null; status: string | null };

type SuccessFollowUpRow = {
  id: string;
  studio_id: string;
  category: string;
  priority: string;
  status: string;
  note: string | null;
  next_follow_up_at: string | null;
  created_at: string;
};

type DismissalRow = {
  id: string;
  studio_id: string | null;
  signal_key: string;
  status: string;
  reason: string | null;
  created_at: string;
};

type OpsSignal = {
  key: string;
  studio: StudioRow;
  focus: "conversion" | "billing" | "inactive" | "activation" | "success" | "upgrade";
  priority: "high" | "medium" | "low";
  title: string;
  reason: string;
  recommendation: string;
  supportingSignal: string;
  category: string;
  nextFollowUpDays: number;
  score: number;
};

const PLAN_LABELS: Record<string, string> = {
  starter: "Starter",
  growth: "Growth",
  pro: "Pro",
  organizer: "Organizer Suite",
};

const PAID_INVOICE_STATUSES = new Set(["paid", "succeeded"]);
const BILLING_RISK_STATUSES = new Set(["past_due", "unpaid", "incomplete", "canceled", "cancelled"]);

const FOCUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "conversion", label: "Conversion" },
  { value: "billing", label: "Billing" },
  { value: "inactive", label: "Inactive" },
  { value: "activation", label: "Activation" },
  { value: "success", label: "Follow-ups" },
  { value: "upgrade", label: "Upgrade" },
];

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

function addDays(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function countByStudio<T extends { studio_id: string | null }>(rows: T[]) {
  const map = new Map<string, number>();
  for (const row of rows) {
    if (!row.studio_id) continue;
    map.set(row.studio_id, (map.get(row.studio_id) ?? 0) + 1);
  }
  return map;
}

function sumInvoicesByStudio(rows: InvoiceRow[]) {
  const map = new Map<string, number>();
  for (const row of rows) {
    if (!PAID_INVOICE_STATUSES.has(normalize(row.status))) continue;
    map.set(row.studio_id, (map.get(row.studio_id) ?? 0) + Number(row.amount_paid ?? 0));
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

function priorityClass(priority: OpsSignal["priority"]) {
  if (priority === "high") return "bg-rose-600 text-white";
  if (priority === "medium") return "bg-amber-500 text-white";
  return "bg-slate-200 text-slate-700";
}

function focusClass(focus: OpsSignal["focus"]) {
  if (focus === "conversion") return "bg-violet-50 text-violet-700 ring-violet-200";
  if (focus === "billing") return "bg-rose-50 text-rose-700 ring-rose-200";
  if (focus === "inactive") return "bg-slate-100 text-slate-700 ring-slate-200";
  if (focus === "activation") return "bg-blue-50 text-blue-700 ring-blue-200";
  if (focus === "upgrade") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  return "bg-amber-50 text-amber-700 ring-amber-200";
}

function defaultReason(signal: OpsSignal) {
  return `${signal.title}: ${signal.supportingSignal}`;
}

function createSignal(input: Omit<OpsSignal, "score">): OpsSignal {
  const focusWeight = {
    billing: 95,
    conversion: 86,
    success: 82,
    inactive: 76,
    upgrade: 68,
    activation: 58,
  }[input.focus];
  const priorityWeight = input.priority === "high" ? 20 : input.priority === "medium" ? 10 : 0;
  return { ...input, score: focusWeight + priorityWeight };
}

function StatCard({ label, value, helper, tone = "slate" }: { label: string; value: string; helper: string; tone?: "slate" | "rose" | "amber" | "emerald" | "violet" | "blue" }) {
  const toneClass = {
    slate: "bg-slate-50 text-slate-700 ring-slate-200",
    rose: "bg-rose-50 text-rose-700 ring-rose-200",
    amber: "bg-amber-50 text-amber-700 ring-amber-200",
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    violet: "bg-violet-50 text-violet-700 ring-violet-200",
    blue: "bg-blue-50 text-blue-700 ring-blue-200",
  }[tone];

  return (
    <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{value}</p>
      <p className={`mt-4 inline-flex rounded-full px-3 py-1 text-xs font-semibold ring-1 ${toneClass}`}>{helper}</p>
    </div>
  );
}

function SignalActions({ signal, returnTo }: { signal: OpsSignal; returnTo: string }) {
  return (
    <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_auto]">
      <form action={createOpsReviewFollowUpAction} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <input type="hidden" name="returnTo" value={returnTo} />
        <input type="hidden" name="studioId" value={signal.studio.id} />
        <input type="hidden" name="signalKey" value={signal.key} />
        <input type="hidden" name="category" value={signal.category} />
        <input type="hidden" name="priority" value={signal.priority} />
        <div className="grid gap-3 md:grid-cols-[1fr_180px_auto] md:items-end">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Follow-up note</span>
            <textarea
              name="note"
              rows={2}
              defaultValue={`${signal.recommendation}\n\nSignal: ${signal.supportingSignal}`}
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-[#BE185D] focus:ring-2 focus:ring-[#FCE7F3]"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Next date</span>
            <input
              type="date"
              name="nextFollowUpAt"
              defaultValue={addDays(signal.nextFollowUpDays)}
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-[#BE185D] focus:ring-2 focus:ring-[#FCE7F3]"
            />
          </label>
          <button className="rounded-xl bg-[#BE185D] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#9D174D]">
            Create follow-up
          </button>
        </div>
      </form>

      <div className="flex flex-wrap gap-2 lg:flex-col lg:justify-center">
        <form action={markPlatformOpsReviewSignalAction}>
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="studioId" value={signal.studio.id} />
          <input type="hidden" name="signalKey" value={signal.key} />
          <input type="hidden" name="status" value="reviewed" />
          <input type="hidden" name="reason" value={defaultReason(signal)} />
          <button className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            Mark reviewed
          </button>
        </form>
        <form action={markPlatformOpsReviewSignalAction}>
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="studioId" value={signal.studio.id} />
          <input type="hidden" name="signalKey" value={signal.key} />
          <input type="hidden" name="status" value="skipped" />
          <input type="hidden" name="reason" value={defaultReason(signal)} />
          <button className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            Skip
          </button>
        </form>
      </div>
    </div>
  );
}

export default async function PlatformOpsReviewPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePlatformAdmin();

  const params = await searchParams;
  const focus = params.focus ?? "all";
  const supabase = await createClient();

  const [
    { data: studios, error: studiosError },
    { data: subscriptions, error: subscriptionsError },
    { data: clients, error: clientsError },
    { data: appointments, error: appointmentsError },
    { data: events, error: eventsError },
    { data: invoices, error: invoicesError },
    { data: followUps, error: followUpsError },
    { data: dismissals, error: dismissalsError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name, created_at, billing_plan, subscription_status, active, stripe_customer_id, stripe_subscription_id, trial_ends_at, last_workspace_access_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("studio_subscriptions")
      .select("id, studio_id, status, current_period_end, trial_ends_at, cancel_at_period_end, subscription_plans ( code, name )"),
    supabase.from("clients").select("id, studio_id"),
    supabase.from("appointments").select("id, studio_id"),
    supabase.from("events").select("id, studio_id, status, visibility"),
    supabase.from("studio_invoices").select("id, studio_id, amount_paid, status"),
    supabase
      .from("platform_success_followups")
      .select("id, studio_id, category, priority, status, note, next_follow_up_at, created_at")
      .eq("status", "open")
      .order("next_follow_up_at", { ascending: true, nullsFirst: false }),
    supabase
      .from("platform_ops_review_dismissals")
      .select("id, studio_id, signal_key, status, reason, created_at"),
  ]);

  if (studiosError) throw new Error(`Failed to load studios: ${studiosError.message}`);
  if (subscriptionsError) throw new Error(`Failed to load subscriptions: ${subscriptionsError.message}`);
  if (clientsError) throw new Error(`Failed to load clients: ${clientsError.message}`);
  if (appointmentsError) throw new Error(`Failed to load appointments: ${appointmentsError.message}`);
  if (eventsError) throw new Error(`Failed to load events: ${eventsError.message}`);
  if (invoicesError) throw new Error(`Failed to load invoices: ${invoicesError.message}`);
  if (followUpsError) throw new Error(`Failed to load success follow-ups: ${followUpsError.message}`);
  if (dismissalsError) throw new Error(`Failed to load ops review dismissals: ${dismissalsError.message}`);

  const typedStudios = (studios ?? []) as StudioRow[];
  const typedSubscriptions = (subscriptions ?? []) as SubscriptionRow[];
  const typedClients = (clients ?? []) as ClientRow[];
  const typedAppointments = (appointments ?? []) as AppointmentRow[];
  const typedEvents = (events ?? []) as EventRow[];
  const typedInvoices = (invoices ?? []) as InvoiceRow[];
  const typedFollowUps = (followUps ?? []) as SuccessFollowUpRow[];
  const typedDismissals = (dismissals ?? []) as DismissalRow[];

  const subscriptionByStudio = new Map(typedSubscriptions.map((subscription) => [subscription.studio_id, subscription]));
  const clientCounts = countByStudio(typedClients);
  const appointmentCounts = countByStudio(typedAppointments);
  const eventCounts = countByStudio(typedEvents);
  const publicEventCounts = countByStudio(typedEvents.filter((event) => normalize(event.visibility) === "public"));
  const invoiceCollections = sumInvoicesByStudio(typedInvoices);
  const openFollowUpsByStudio = new Map<string, SuccessFollowUpRow[]>();

  for (const followUp of typedFollowUps) {
    const rows = openFollowUpsByStudio.get(followUp.studio_id) ?? [];
    rows.push(followUp);
    openFollowUpsByStudio.set(followUp.studio_id, rows);
  }

  const hiddenSignals = new Set(
    typedDismissals.map((dismissal) => `${dismissal.studio_id ?? "platform"}:${dismissal.signal_key}`)
  );

  const signals: OpsSignal[] = [];

  for (const studio of typedStudios) {
    const subscription = subscriptionByStudio.get(studio.id);
    const billingStatus = getBillingStatus(studio, subscription);
    const planLabel = getPlanLabel(studio, subscription);
    const daysUntilTrialEnd = daysBetweenNow(subscription?.trial_ends_at ?? studio.trial_ends_at);
    const accessDays = daysSince(studio.last_workspace_access_at);
    const clientsCount = clientCounts.get(studio.id) ?? 0;
    const appointmentsCount = appointmentCounts.get(studio.id) ?? 0;
    const eventsCount = eventCounts.get(studio.id) ?? 0;
    const publicEventsCount = publicEventCounts.get(studio.id) ?? 0;
    const collected = invoiceCollections.get(studio.id) ?? 0;
    const isPaid = billingStatus === "active";
    const isTrial = billingStatus === "trialing" || daysUntilTrialEnd !== null;
    const openStudioFollowUps = openFollowUpsByStudio.get(studio.id) ?? [];
    const overdueFollowUps = openStudioFollowUps.filter((row) => {
      const days = daysBetweenNow(row.next_follow_up_at);
      return days !== null && days < 0;
    });

    function push(signal: Omit<OpsSignal, "score">) {
      const key = `${studio.id}:${signal.key}`;
      if (!hiddenSignals.has(key)) signals.push(createSignal(signal));
    }

    if (BILLING_RISK_STATUSES.has(billingStatus)) {
      push({
        key: `billing-risk:${billingStatus}`,
        studio,
        focus: "billing",
        priority: "high",
        title: "Billing risk needs follow-up",
        reason: `${studio.name} has billing status ${formatLabel(billingStatus)}.` ,
        recommendation: "Contact the studio owner, verify the payment issue, and decide whether this is a save, support, or cancellation path.",
        supportingSignal: `Billing status: ${formatLabel(billingStatus)} · Plan: ${planLabel}`,
        category: "billing_follow_up",
        nextFollowUpDays: 1,
      });
    }

    if (!isPaid && daysUntilTrialEnd !== null && daysUntilTrialEnd <= 3 && daysUntilTrialEnd >= 0) {
      push({
        key: `trial-ending:${daysUntilTrialEnd}`,
        studio,
        focus: "conversion",
        priority: "high",
        title: "Trial ending soon",
        reason: `${studio.name} has ${daysUntilTrialEnd} day${daysUntilTrialEnd === 1 ? "" : "s"} left in trial.`,
        recommendation: "Create a conversion follow-up that reviews usage wins, remaining onboarding blockers, and next plan recommendation.",
        supportingSignal: `${clientsCount} clients · ${appointmentsCount} appointments · ${eventsCount} events`,
        category: "trial_conversion",
        nextFollowUpDays: 1,
      });
    }

    if (!isPaid && daysUntilTrialEnd !== null && daysUntilTrialEnd < 0) {
      push({
        key: "trial-expired-no-conversion",
        studio,
        focus: "conversion",
        priority: "high",
        title: "Trial expired without conversion",
        reason: `${studio.name} is past trial end and has not converted to active paid billing.`,
        recommendation: "Follow up with a clear conversion path, founder offer reminder, or lost-reason check.",
        supportingSignal: `Trial ended ${Math.abs(daysUntilTrialEnd)} day${Math.abs(daysUntilTrialEnd) === 1 ? "" : "s"} ago`,
        category: "trial_conversion",
        nextFollowUpDays: 1,
      });
    }

    if ((accessDays === null || accessDays >= 14) && !isPaid) {
      push({
        key: "inactive-trial-workspace",
        studio,
        focus: "inactive",
        priority: accessDays === null || accessDays >= 30 ? "high" : "medium",
        title: "Trial workspace inactive",
        reason: `${studio.name} has not accessed the workspace recently.`,
        recommendation: "Send an onboarding nudge with one specific next action instead of a generic check-in.",
        supportingSignal: accessDays === null ? "No workspace access recorded" : `Last access ${accessDays} days ago`,
        category: "onboarding_nudge",
        nextFollowUpDays: 2,
      });
    }

    if (isTrial && clientsCount === 0 && appointmentsCount === 0) {
      push({
        key: "no-activation-data",
        studio,
        focus: "activation",
        priority: "medium",
        title: "No activation data yet",
        reason: `${studio.name} has no client or appointment activity yet.`,
        recommendation: "Guide the studio to add one client, create one package, and schedule one lesson as the first activation milestone.",
        supportingSignal: "0 clients · 0 appointments",
        category: "onboarding_nudge",
        nextFollowUpDays: 2,
      });
    }

    if (isPaid && appointmentsCount >= 20 && publicEventsCount === 0) {
      push({
        key: "paid-no-public-events",
        studio,
        focus: "upgrade",
        priority: "low",
        title: "Public event adoption opportunity",
        reason: `${studio.name} is using scheduling but has not published public events.`,
        recommendation: "Recommend publishing one group class, workshop, or social dance to drive student app discovery.",
        supportingSignal: `${appointmentsCount} appointments · ${publicEventsCount} public events`,
        category: "upgrade_opportunity",
        nextFollowUpDays: 7,
      });
    }

    if (isPaid && collected > 0 && eventsCount >= 3 && normalize(studio.billing_plan) !== "organizer") {
      push({
        key: "organizer-upsell-signal",
        studio,
        focus: "upgrade",
        priority: "medium",
        title: "Organizer/event upsell signal",
        reason: `${studio.name} has event activity and paid collections.`,
        recommendation: "Review whether Organizer Suite or event commerce features should be positioned as the next upgrade.",
        supportingSignal: `${eventsCount} events · ${formatLabel(planLabel)} plan · $${Math.round(collected).toLocaleString()} collected`,
        category: "upgrade_opportunity",
        nextFollowUpDays: 7,
      });
    }

    if (overdueFollowUps.length > 0) {
      push({
        key: "overdue-success-followup",
        studio,
        focus: "success",
        priority: "high",
        title: "Open follow-up is overdue",
        reason: `${studio.name} has ${overdueFollowUps.length} overdue success follow-up${overdueFollowUps.length === 1 ? "" : "s"}.`,
        recommendation: "Complete the overdue follow-up or reset the next follow-up date with an updated note.",
        supportingSignal: overdueFollowUps[0]?.next_follow_up_at ? `Oldest due ${formatDate(overdueFollowUps[0].next_follow_up_at)}` : "Follow-up overdue",
        category: "retention_save",
        nextFollowUpDays: 1,
      });
    }
  }

  const filteredSignals = signals
    .filter((signal) => focus === "all" || signal.focus === focus)
    .sort((a, b) => b.score - a.score)
    .slice(0, 60);

  const highPriority = signals.filter((signal) => signal.priority === "high").length;
  const conversionCount = signals.filter((signal) => signal.focus === "conversion").length;
  const billingCount = signals.filter((signal) => signal.focus === "billing").length;
  const inactiveCount = signals.filter((signal) => signal.focus === "inactive").length;
  const followUpCount = signals.filter((signal) => signal.focus === "success").length;
  const returnTo = focus === "all" ? "/platform/ops-review" : `/platform/ops-review?focus=${encodeURIComponent(focus)}`;

  return (
    <main className="space-y-8">
      <section className="rounded-[32px] border border-slate-200 bg-gradient-to-br from-slate-950 via-[#831843] to-[#BE185D] p-8 text-white shadow-sm">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.28em] text-pink-100">Platform ARIA</p>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">Ops Review</h1>
            <p className="mt-4 max-w-3xl text-sm leading-6 text-pink-50/90">
              Review platform signals, turn the right ones into success follow-ups, and clear the queue when a recommendation has been handled.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/platform/success" className="rounded-2xl bg-white/15 px-4 py-3 text-sm font-semibold text-white ring-1 ring-white/25 hover:bg-white/20">
              Success Center
            </Link>
            <Link href="/platform/studio-health" className="rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-[#9D174D] shadow-sm hover:bg-pink-50">
              Studio Health
            </Link>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Open Signals" value={String(signals.length)} helper="Actionable recommendations" tone="violet" />
        <StatCard label="High Priority" value={String(highPriority)} helper="Needs attention first" tone="rose" />
        <StatCard label="Conversion" value={String(conversionCount)} helper="Trial or paid path" tone="amber" />
        <StatCard label="Billing" value={String(billingCount)} helper="Payment risk" tone="rose" />
        <StatCard label="Overdue" value={String(followUpCount)} helper="Success follow-ups" tone="blue" />
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap gap-2">
          {FOCUS_FILTERS.map((item) => {
            const active = focus === item.value || (!focus && item.value === "all");
            return (
              <Link
                key={item.value}
                href={item.value === "all" ? "/platform/ops-review" : `/platform/ops-review?focus=${item.value}`}
                className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                  active ? "bg-slate-950 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </section>

      <section className="grid gap-5">
        {filteredSignals.length ? (
          filteredSignals.map((signal) => (
            <article key={`${signal.studio.id}:${signal.key}`} className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${priorityClass(signal.priority)}`}>{formatLabel(signal.priority)}</span>
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${focusClass(signal.focus)}`}>{formatLabel(signal.focus)}</span>
                  </div>
                  <h2 className="mt-4 text-xl font-semibold tracking-tight text-slate-950">{signal.title}</h2>
                  <p className="mt-1 text-sm font-semibold text-slate-700">{signal.studio.name}</p>
                  <p className="mt-3 max-w-4xl text-sm leading-6 text-slate-600">{signal.reason}</p>
                </div>
                <div className="flex flex-wrap gap-2 lg:justify-end">
                  <Link href={`/platform/studios/${signal.studio.id}`} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                    View studio
                  </Link>
                  <Link href={`/platform/success?focus=${signal.focus}`} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                    Success
                  </Link>
                </div>
              </div>

              <div className="mt-5 grid gap-4 lg:grid-cols-2">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Supporting signal</p>
                  <p className="mt-2 text-sm font-semibold text-slate-950">{signal.supportingSignal}</p>
                </div>
                <div className="rounded-2xl border border-pink-200 bg-pink-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-pink-700">Recommended action</p>
                  <p className="mt-2 text-sm font-semibold text-pink-950">{signal.recommendation}</p>
                </div>
              </div>

              <SignalActions signal={signal} returnTo={returnTo} />
            </article>
          ))
        ) : (
          <div className="rounded-[28px] border border-slate-200 bg-white p-8 text-center shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">Queue Clear</p>
            <h2 className="mt-3 text-2xl font-semibold text-slate-950">No active Ops Review signals in this view.</h2>
            <p className="mt-3 text-sm text-slate-500">Reviewed and skipped signals stay hidden so ARIA does not keep repeating the same recommendation.</p>
          </div>
        )}
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">ARIA Operating Note</p>
        <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">This is an approval center, not another dashboard.</h2>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Every signal should be converted into a follow-up, reviewed, or skipped. The dismissal table keeps handled signals out of the queue while the underlying dashboards continue to show the raw data.
        </p>
      </section>
    </main>
  );
}
