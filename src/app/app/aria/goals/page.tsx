import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  PauseCircle,
  Plus,
  Sparkles,
  Target,
  Trophy,
} from "lucide-react";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import AriaAvatar from "@/components/app/AriaAvatar";
import AriaInsightCard from "@/components/app/AriaInsightCard";
import { createAriaGoalAction, updateAriaGoalStatusAction } from "./actions";

type AriaGoalRow = {
  id: string;
  title: string;
  goal_type: string;
  focus_area: string;
  target_value: number | string | null;
  target_unit: string;
  timeline_days: number;
  starts_at: string | null;
  target_date: string | null;
  status: string;
  baseline_notes: string | null;
  current_value?: number | string | null;
  progress_notes?: string | null;
  completed_at?: string | null;
  archived_at?: string | null;
  plan_summary: string | null;
  weekly_milestones: unknown;
  kpi_snapshot: unknown;
  created_at: string;
  updated_at: string;
};

type AutomationActionRow = {
  id: string;
  status: string;
  priority: string;
  rule_key: string;
  created_at: string;
};

type AutomationRuleRow = {
  id: string;
  rule_key: string;
  enabled: boolean;
};

const GOAL_TYPES = [
  { value: "revenue", label: "Revenue" },
  { value: "private_lessons", label: "Private lessons" },
  { value: "memberships", label: "Memberships" },
  { value: "group_classes", label: "Group classes" },
  { value: "retention", label: "Retention" },
  { value: "events", label: "Events" },
  { value: "custom", label: "Custom" },
];

const FOCUS_AREAS = [
  { value: "package_renewals", label: "Package renewals" },
  { value: "rebooking", label: "Rebooking" },
  { value: "lead_conversion", label: "Lead conversion" },
  { value: "memberships", label: "Memberships" },
  { value: "group_classes", label: "Group classes" },
  { value: "events", label: "Events" },
  { value: "retention", label: "Retention" },
  { value: "overall_growth", label: "Overall growth" },
  { value: "custom", label: "Custom" },
];

const TARGET_UNITS = [
  { value: "dollars", label: "Dollars" },
  { value: "clients", label: "Clients" },
  { value: "bookings", label: "Bookings" },
  { value: "memberships", label: "Memberships" },
  { value: "attendees", label: "Attendees" },
  { value: "percent", label: "Percent" },
  { value: "count", label: "Count" },
];

function formatDate(value: string | null | undefined) {
  if (!value) return "Not set";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Not set";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function labelFor(options: { value: string; label: string }[], value: string) {
  return options.find((option) => option.value === value)?.label ?? value.replaceAll("_", " ");
}

function formatTarget(value: number | string | null, unit: string) {
  if (value === null || value === undefined || value === "") return "Target not set";

  const numericValue = typeof value === "number" ? value : Number(value);
  const formattedValue = Number.isFinite(numericValue)
    ? numericValue.toLocaleString("en-US")
    : String(value);

  if (unit === "dollars") return `$${formattedValue}`;
  if (unit === "percent") return `${formattedValue}%`;

  return `${formattedValue} ${unit}`;
}

function statusClass(status: string) {
  if (status === "completed") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "paused") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "archived") return "border-slate-200 bg-slate-100 text-slate-600";
  return "border-[#F9A8D4] bg-[#FCE7F3] text-[#BE185D]";
}

function parseMilestones(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;

      return {
        week: typeof row.week === "number" ? row.week : null,
        title: typeof row.title === "string" ? row.title : "Milestone",
        body: typeof row.body === "string" ? row.body : "",
      };
    })
    .filter((item): item is { week: number | null; title: string; body: string } => Boolean(item));
}

function getGoalProgress(goal: AriaGoalRow) {
  const start = goal.starts_at ? new Date(goal.starts_at).getTime() : new Date(goal.created_at).getTime();
  const target = goal.target_date ? new Date(goal.target_date).getTime() : start + goal.timeline_days * 24 * 60 * 60 * 1000;
  const now = Date.now();

  if (target <= start) return 0;

  const progress = Math.round(((now - start) / (target - start)) * 100);
  return Math.min(100, Math.max(0, progress));
}

export default async function AriaGoalsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    redirect("/app");
  }

  const studioId = context.studioId;
  const canManageGoals = canManageSettings(context.studioRole);
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const created = resolvedSearchParams.created === "1";

  const [
    goalsResult,
    automationActionsResult,
    automationRulesResult,
    pendingRequestsResult,
    lowBalanceResult,
  ] = await Promise.all([
    supabase
      .from("aria_goals")
      .select(
        "id, title, goal_type, focus_area, target_value, current_value, target_unit, timeline_days, starts_at, target_date, status, baseline_notes, progress_notes, plan_summary, weekly_milestones, kpi_snapshot, completed_at, archived_at, created_at, updated_at",
      )
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(25),

    supabase
      .from("automation_actions")
      .select("id, status, priority, rule_key, created_at")
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(250),

    supabase
      .from("automation_rules")
      .select("id, rule_key, enabled")
      .eq("studio_id", studioId),

    supabase
      .from("booking_requests")
      .select("id", { count: "exact" })
      .eq("studio_id", studioId)
      .eq("status", "pending"),

    supabase
      .from("client_packages")
      .select(
        `
        id,
        client_package_items (
          quantity_remaining,
          is_unlimited
        )
      `,
      )
      .eq("studio_id", studioId)
      .eq("active", true)
      .limit(250),
  ]);

  if (goalsResult.error) {
    throw new Error(`Failed to load ARIA goals: ${goalsResult.error.message}`);
  }

  if (automationActionsResult.error) {
    throw new Error(`Failed to load ARIA goal automation activity: ${automationActionsResult.error.message}`);
  }

  if (automationRulesResult.error) {
    throw new Error(`Failed to load ARIA goal automation rules: ${automationRulesResult.error.message}`);
  }

  if (pendingRequestsResult.error) {
    throw new Error(`Failed to load ARIA goal booking data: ${pendingRequestsResult.error.message}`);
  }

  if (lowBalanceResult.error) {
    throw new Error(`Failed to load ARIA goal package data: ${lowBalanceResult.error.message}`);
  }

  const goals = (goalsResult.data ?? []) as AriaGoalRow[];
  const automationActions = (automationActionsResult.data ?? []) as AutomationActionRow[];
  const automationRules = (automationRulesResult.data ?? []) as AutomationRuleRow[];

  const activeGoals = goals.filter((goal) => goal.status === "active");
  const completedGoals = goals.filter((goal) => goal.status === "completed");
  const openAutomationActions = automationActions.filter((action) =>
    ["suggested", "drafted", "queued"].includes(action.status),
  );
  const sentAutomationActions = automationActions.filter((action) => action.status === "completed" || action.status === "sent");
  const enabledRules = automationRules.filter((rule) => rule.enabled);
  const pendingBookingCount = pendingRequestsResult.count ?? 0;
  const lowBalancePackages = (lowBalanceResult.data ?? []).filter((pkg: any) => {
    const items = Array.isArray(pkg.client_package_items) ? pkg.client_package_items : [];
    return items.some((item: any) => {
      if (item?.is_unlimited) return false;
      const remaining = Number(item?.quantity_remaining);
      return Number.isFinite(remaining) && remaining <= 2;
    });
  });

  const latestGoal = activeGoals[0] ?? goals[0] ?? null;

  return (
    <main className="space-y-8 p-6 md:p-8">
      <section className="overflow-hidden rounded-[36px] border border-[#F9A8D4] bg-white shadow-sm">
        <div className="relative p-6 md:p-8">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(236,72,153,0.18),transparent_32%),linear-gradient(135deg,rgba(255,247,237,0.9),rgba(255,255,255,0.95)_45%,rgba(250,245,255,0.9))]" />
          <div className="relative grid gap-6 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
            <AriaAvatar size="lg" />
            <div>
              <Link
                href="/app/aria"
                className="inline-flex items-center gap-2 text-sm font-semibold text-[#6B21A8] hover:underline"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to ARIA
              </Link>
              <p className="mt-4 text-xs font-bold uppercase tracking-[0.22em] text-[#BE185D]">
                ARIA Goals
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                Give ARIA a target. She’ll build the plan.
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-700 md:text-base">
                Set a revenue, retention, booking, membership, group class, or event goal with a
                timeline. ARIA will turn your studio data into a practical plan with weekly
                milestones, automations to use, and KPIs to watch.
              </p>
            </div>
            <div className="rounded-[28px] border border-white/70 bg-white/85 p-5 shadow-sm backdrop-blur">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Current focus
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {activeGoals.length || "0"}
              </p>
              <p className="mt-1 text-sm text-slate-600">
                active ARIA goal{activeGoals.length === 1 ? "" : "s"}
              </p>
              <Link
                href="#new-goal"
                className="mt-4 inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-[#BE185D] to-[#F97316] px-4 py-2 text-sm font-semibold text-white shadow-sm"
              >
                New goal
                <Plus className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {created ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
          ARIA created the goal and prepared an initial growth plan.
        </div>
      ) : null}

      <section className="grid gap-4 md:grid-cols-4">
        {[
          {
            label: "Active goals",
            value: activeGoals.length,
            icon: Target,
            helper: "Goals ARIA is tracking now",
          },
          {
            label: "Completed",
            value: completedGoals.length,
            icon: Trophy,
            helper: "Goals marked complete",
          },
          {
            label: "Open actions",
            value: openAutomationActions.length,
            icon: ClipboardList,
            helper: "Suggested, drafted, or queued",
          },
          {
            label: "Enabled automations",
            value: enabledRules.length,
            icon: Sparkles,
            helper: "Rules supporting goals",
          },
        ].map((stat) => {
          const Icon = stat.icon;

          return (
            <article key={stat.label} className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-[#FCE7F3] text-[#BE185D]">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="text-2xl font-semibold text-slate-950">{stat.value}</span>
              </div>
              <p className="mt-3 text-sm font-semibold text-slate-900">{stat.label}</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">{stat.helper}</p>
            </article>
          );
        })}
      </section>

      <AriaInsightCard
  title={latestGoal ? "Your active ARIA goal" : "Create your first ARIA goal"}
  insight={
    latestGoal
      ? `${latestGoal.title} is active. ARIA will help you keep the plan visible and turn your studio data into weekly priorities.`
      : "Create a goal so ARIA can help organize revenue opportunities, automations, and weekly focus areas around a clear target."
  }
  recommendation={
    latestGoal
      ? "Review your active goal plan, update progress, and use ARIA's recommended automations to keep momentum."
      : "Start with a revenue, retention, membership, or booking goal. ARIA will create a starter plan you can refine over time."
  }
  metric={`${lowBalancePackages.length} low-balance package${lowBalancePackages.length === 1 ? "" : "s"} · ${pendingBookingCount} pending request${pendingBookingCount === 1 ? "" : "s"}`}
  primaryAction={{
    href: latestGoal ? "/app/automations" : "#new-goal",
    label: latestGoal ? "Review automations" : "Create goal",
  }}
  secondaryAction={{
    href: "/app/aria",
    label: "Open opportunity hub",
  }}
/>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-5">
          <section className="rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
                  Goal plans
                </p>
                <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                  Active and recent ARIA goals
                </h2>
              </div>
              <Link
                href="/app/aria"
                className="inline-flex items-center gap-2 text-sm font-semibold text-[#6B21A8] hover:underline"
              >
                Review opportunities
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>

            {goals.length === 0 ? (
              <div className="mt-6 rounded-[28px] border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
                <Target className="mx-auto h-10 w-10 text-slate-400" />
                <h3 className="mt-3 text-base font-semibold text-slate-950">
                  No ARIA goals yet
                </h3>
                <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-600">
                  Create a goal to turn ARIA’s opportunity hub into a timeline, weekly rhythm,
                  and measurable plan.
                </p>
              </div>
            ) : (
              <div className="mt-6 space-y-4">
                {goals.map((goal) => {
                  const milestones = parseMilestones(goal.weekly_milestones);
                  const progress = getGoalProgress(goal);

                  return (
                    <article key={goal.id} className="rounded-[28px] border border-slate-200 bg-slate-50 p-5">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusClass(goal.status)}`}>
                              {goal.status}
                            </span>
                            <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                              {labelFor(GOAL_TYPES, goal.goal_type)}
                            </span>
                            <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                              {labelFor(FOCUS_AREAS, goal.focus_area)}
                            </span>
                          </div>
                          <h3 className="mt-3 text-lg font-semibold text-slate-950">{goal.title}</h3>
                          <p className="mt-1 text-sm leading-6 text-slate-600">
                            {formatTarget(goal.target_value, goal.target_unit)} by {formatDate(goal.target_date)}
                          </p>
                        </div>

                        {canManageGoals ? (
                          <div className="flex flex-wrap gap-2">
                            <Link
                              href={`/app/aria/goals/${goal.id}`}
                              className="inline-flex items-center gap-2 rounded-full border border-[#F9A8D4] bg-white px-3 py-2 text-xs font-semibold text-[#BE185D]"
                            >
                              Open plan
                              <ArrowRight className="h-3.5 w-3.5" />
                            </Link>
                            {goal.status !== "completed" ? (
                              <form action={updateAriaGoalStatusAction}>
                                <input type="hidden" name="goalId" value={goal.id} />
                                <input type="hidden" name="status" value="completed" />
                                <button className="inline-flex items-center gap-2 rounded-full bg-emerald-600 px-3 py-2 text-xs font-semibold text-white">
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                  Complete
                                </button>
                              </form>
                            ) : null}
                            {goal.status === "active" ? (
                              <form action={updateAriaGoalStatusAction}>
                                <input type="hidden" name="goalId" value={goal.id} />
                                <input type="hidden" name="status" value="paused" />
                                <button className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                                  <PauseCircle className="h-3.5 w-3.5" />
                                  Pause
                                </button>
                              </form>
                            ) : goal.status === "paused" ? (
                              <form action={updateAriaGoalStatusAction}>
                                <input type="hidden" name="goalId" value={goal.id} />
                                <input type="hidden" name="status" value="active" />
                                <button className="inline-flex items-center gap-2 rounded-full border border-[#F9A8D4] bg-[#FCE7F3] px-3 py-2 text-xs font-semibold text-[#BE185D]">
                                  <Target className="h-3.5 w-3.5" />
                                  Resume
                                </button>
                              </form>
                            ) : null}
                          </div>
                        ) : null}
                      </div>

                      <div className="mt-4">
                        <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
                          <span>Timeline progress</span>
                          <span>{progress}%</span>
                        </div>
                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-white">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-[#BE185D] to-[#F97316]"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                        <p className="mt-2 text-xs text-slate-500">
                          Started {formatDate(goal.starts_at)} · Updated {formatDateTime(goal.updated_at)}
                        </p>
                      </div>

                      {goal.plan_summary ? (
                        <div className="mt-5 rounded-2xl border border-white bg-white p-4">
                          <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#6B21A8]">
                            ARIA plan summary
                          </p>
                          <p className="mt-2 text-sm leading-6 text-slate-700">{goal.plan_summary}</p>
                        </div>
                      ) : null}

                      {milestones.length > 0 ? (
                        <div className="mt-5 grid gap-3 md:grid-cols-2">
                          {milestones.map((milestone) => (
                            <div key={`${goal.id}-${milestone.week}-${milestone.title}`} className="rounded-2xl border border-white bg-white p-4">
                              <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
                                {milestone.week ? `Week ${milestone.week}` : "Milestone"}
                              </p>
                              <p className="mt-2 text-sm font-semibold text-slate-950">{milestone.title}</p>
                              {milestone.body ? (
                                <p className="mt-1 text-xs leading-5 text-slate-600">{milestone.body}</p>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <aside id="new-goal" className="rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
            New goal
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            What should ARIA help you reach?
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Start with one measurable goal. ARIA will prepare the first plan using the studio data and
            automation workflows already available.
          </p>

          {canManageGoals ? (
            <form action={createAriaGoalAction} className="mt-5 space-y-4">
              <label className="block">
                <span className="text-sm font-semibold text-slate-800">Goal title</span>
                <input
                  name="title"
                  required
                  placeholder="Increase private lesson revenue"
                  className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-[#F9A8D4] focus:ring-2 focus:ring-[#FCE7F3]"
                />
              </label>

              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
                <label className="block">
                  <span className="text-sm font-semibold text-slate-800">Goal type</span>
                  <select
                    name="goalType"
                    defaultValue="revenue"
                    className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-[#F9A8D4] focus:ring-2 focus:ring-[#FCE7F3]"
                  >
                    {GOAL_TYPES.map((goalType) => (
                      <option key={goalType.value} value={goalType.value}>
                        {goalType.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="text-sm font-semibold text-slate-800">Focus area</span>
                  <select
                    name="focusArea"
                    defaultValue="package_renewals"
                    className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-[#F9A8D4] focus:ring-2 focus:ring-[#FCE7F3]"
                  >
                    {FOCUS_AREAS.map((focusArea) => (
                      <option key={focusArea.value} value={focusArea.value}>
                        {focusArea.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-1">
                <label className="block">
                  <span className="text-sm font-semibold text-slate-800">Target value</span>
                  <input
                    name="targetValue"
                    inputMode="decimal"
                    placeholder="3000"
                    className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-[#F9A8D4] focus:ring-2 focus:ring-[#FCE7F3]"
                  />
                </label>

                <label className="block">
                  <span className="text-sm font-semibold text-slate-800">Target unit</span>
                  <select
                    name="targetUnit"
                    defaultValue="dollars"
                    className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-[#F9A8D4] focus:ring-2 focus:ring-[#FCE7F3]"
                  >
                    {TARGET_UNITS.map((unit) => (
                      <option key={unit.value} value={unit.value}>
                        {unit.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="text-sm font-semibold text-slate-800">Timeline days</span>
                  <input
                    name="timelineDays"
                    type="number"
                    min={7}
                    max={365}
                    defaultValue={60}
                    className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-[#F9A8D4] focus:ring-2 focus:ring-[#FCE7F3]"
                  />
                </label>
              </div>

              <label className="block">
                <span className="text-sm font-semibold text-slate-800">Baseline notes</span>
                <textarea
                  name="baselineNotes"
                  rows={4}
                  placeholder="Example: We want to fill Tuesday evenings and increase renewals before packages run out."
                  className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-[#F9A8D4] focus:ring-2 focus:ring-[#FCE7F3]"
                />
              </label>

              <button className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-[#BE185D] to-[#F97316] px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:opacity-95">
                Create ARIA goal
                <ArrowRight className="h-4 w-4" />
              </button>
            </form>
          ) : (
            <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-800">
              Only studio owners, admins, and independent instructors can create or update ARIA goals.
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}
