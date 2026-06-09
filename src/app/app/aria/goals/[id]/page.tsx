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
  Sparkles,
  Target,
} from "lucide-react";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import AriaAvatar from "@/components/app/AriaAvatar";
import AriaInsightCard from "@/components/app/AriaInsightCard";
import { updateAriaGoalProgressAction, updateAriaGoalStatusAction } from "../actions";

type AriaGoalRow = {
  id: string;
  title: string;
  goal_type: string;
  focus_area: string;
  target_value: number | string | null;
  current_value: number | string | null;
  target_unit: string;
  timeline_days: number;
  starts_at: string | null;
  target_date: string | null;
  status: string;
  baseline_notes: string | null;
  progress_notes: string | null;
  plan_summary: string | null;
  weekly_milestones: unknown;
  kpi_snapshot: unknown;
  completed_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type AutomationActionRow = {
  id: string;
  rule_key: string;
  title: string;
  body: string | null;
  status: string;
  priority: string;
  created_at: string;
  completed_at: string | null;
  dismissed_at: string | null;
};

type AutomationRuleRow = {
  id: string;
  rule_key: string;
  enabled: boolean;
  last_evaluated_at: string | null;
};

type AutomationDeliveryRow = {
  id: string;
  related_id: string | null;
  recipient_email: string | null;
  subject: string | null;
  status: string;
  error_message: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string | null;
};

type GoalTimelineEntry = {
  id: string;
  at: string;
  label: string;
  title: string;
  body: string;
  tone: "aria" | "automation" | "email" | "goal";
};

const GOAL_TYPES: Record<string, string> = {
  revenue: "Revenue",
  private_lessons: "Private lessons",
  memberships: "Memberships",
  group_classes: "Group classes",
  retention: "Retention",
  events: "Events",
  custom: "Custom",
};

const FOCUS_AREAS: Record<string, string> = {
  package_renewals: "Package renewals",
  rebooking: "Rebooking",
  lead_conversion: "Lead conversion",
  memberships: "Memberships",
  group_classes: "Group classes",
  events: "Events",
  retention: "Retention",
  overall_growth: "Overall growth",
  custom: "Custom",
};

const RULE_LABELS: Record<string, string> = {
  low_package_balance: "Low package balance renewal",
  no_upcoming_lesson: "No upcoming lesson rebooking",
  pending_booking_request: "Pending booking request reminder",
  unsigned_document: "Unsigned document reminder",
  first_lesson_follow_up: "First lesson follow-up",
};

function asNumber(value: number | string | null | undefined) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

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

function formatTarget(value: number | string | null, unit: string) {
  const numericValue = asNumber(value);

  if (numericValue === null) return "Target not set";
  if (unit === "dollars") return `$${numericValue.toLocaleString("en-US")}`;
  if (unit === "percent") return `${numericValue.toLocaleString("en-US")}%`;

  return `${numericValue.toLocaleString("en-US")} ${unit}`;
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

function getTimelineProgress(goal: AriaGoalRow) {
  const start = goal.starts_at ? new Date(goal.starts_at).getTime() : new Date(goal.created_at).getTime();
  const target = goal.target_date ? new Date(goal.target_date).getTime() : start + goal.timeline_days * 24 * 60 * 60 * 1000;
  const now = Date.now();

  if (target <= start) return 0;

  return Math.min(100, Math.max(0, Math.round(((now - start) / (target - start)) * 100)));
}

function getTargetProgress(goal: AriaGoalRow) {
  const target = asNumber(goal.target_value);
  const current = asNumber(goal.current_value);

  if (!target || target <= 0 || current === null) return null;

  return Math.min(100, Math.max(0, Math.round((current / target) * 100)));
}

function recommendedRulesForGoal(goal: AriaGoalRow) {
  const rules = new Set<string>();

  if (["package_renewals", "overall_growth", "retention"].includes(goal.focus_area)) {
    rules.add("low_package_balance");
  }

  if (["rebooking", "overall_growth", "retention", "private_lessons"].includes(goal.focus_area) || goal.goal_type === "private_lessons") {
    rules.add("no_upcoming_lesson");
    rules.add("first_lesson_follow_up");
  }

  if (["lead_conversion", "overall_growth"].includes(goal.focus_area)) {
    rules.add("pending_booking_request");
  }

  if (["events", "retention", "overall_growth"].includes(goal.focus_area)) {
    rules.add("unsigned_document");
  }

  if (rules.size === 0) {
    rules.add("low_package_balance");
    rules.add("no_upcoming_lesson");
  }

  return Array.from(rules);
}

function recommendationReasonForRule(ruleKey: string, goal: AriaGoalRow) {
  if (ruleKey === "low_package_balance") {
    if (goal.focus_area === "package_renewals") {
      return "This directly supports package renewal growth by surfacing clients who are close to running out of lessons.";
    }
    return "Low-balance clients are often the quickest revenue opportunity because they already have an active relationship with the studio.";
  }

  if (ruleKey === "no_upcoming_lesson") {
    if (goal.focus_area === "rebooking" || goal.goal_type === "private_lessons") {
      return "This helps protect private lesson momentum by finding clients who recently danced but do not have their next lesson scheduled.";
    }
    return "Rebooking existing clients is one of the fastest ways to keep revenue and retention moving toward this goal.";
  }

  if (ruleKey === "first_lesson_follow_up") {
    return "First-lesson clients need fast follow-up while interest is fresh, especially when the goal depends on conversions or repeat bookings.";
  }

  if (ruleKey === "pending_booking_request") {
    return "Pending requests can turn into lost opportunities if they sit too long, so this keeps lead conversion moving.";
  }

  if (ruleKey === "unsigned_document") {
    return "Unsigned documents can slow down lessons, events, and check-ins, so this reduces front desk friction while supporting the goal.";
  }

  return "ARIA recommends this automation because it supports the goal focus area and keeps follow-up work moving.";
}

function timelineToneClass(tone: GoalTimelineEntry["tone"]) {
  if (tone === "email") return "border-blue-200 bg-blue-50 text-blue-700";
  if (tone === "automation") return "border-purple-200 bg-purple-50 text-purple-700";
  if (tone === "goal") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  return "border-[#F9A8D4] bg-[#FCE7F3] text-[#BE185D]";
}

function deliveryStatusLabel(delivery: AutomationDeliveryRow) {
  if (delivery.status === "sent") return `Email sent${delivery.sent_at ? ` on ${formatDateTime(delivery.sent_at)}` : ""}`;
  if (delivery.status === "failed") return `Email failed${delivery.error_message ? `: ${delivery.error_message}` : ""}`;
  if (delivery.status === "queued") return "Email queued for send";
  if (delivery.status === "draft") return "Email draft created";
  if (delivery.status === "skipped") return "Email skipped";
  return `Email ${delivery.status}`;
}


export default async function AriaGoalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    redirect("/app");
  }

  const { id } = await params;
  const studioId = context.studioId;
  const canManageGoals = canManageSettings(context.studioRole);

  const [goalResult, automationActionsResult, automationRulesResult] = await Promise.all([
    supabase
      .from("aria_goals")
      .select(
        "id, title, goal_type, focus_area, target_value, current_value, target_unit, timeline_days, starts_at, target_date, status, baseline_notes, progress_notes, plan_summary, weekly_milestones, kpi_snapshot, completed_at, archived_at, created_at, updated_at",
      )
      .eq("studio_id", studioId)
      .eq("id", id)
      .maybeSingle(),

    supabase
      .from("automation_actions")
      .select("id, rule_key, title, body, status, priority, created_at, completed_at, dismissed_at")
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(100),

    supabase
      .from("automation_rules")
      .select("id, rule_key, enabled, last_evaluated_at")
      .eq("studio_id", studioId),
  ]);

  if (goalResult.error) {
    throw new Error(`Failed to load ARIA goal: ${goalResult.error.message}`);
  }

  if (!goalResult.data) {
    redirect("/app/aria/goals");
  }

  if (automationActionsResult.error) {
    throw new Error(`Failed to load ARIA goal automation activity: ${automationActionsResult.error.message}`);
  }

  if (automationRulesResult.error) {
    throw new Error(`Failed to load ARIA goal automation rules: ${automationRulesResult.error.message}`);
  }

  const goal = goalResult.data as AriaGoalRow;
  const automationActions = (automationActionsResult.data ?? []) as AutomationActionRow[];
  const automationRules = (automationRulesResult.data ?? []) as AutomationRuleRow[];
  const milestones = parseMilestones(goal.weekly_milestones);
  const timelineProgress = getTimelineProgress(goal);
  const targetProgress = getTargetProgress(goal);
  const recommendedRules = recommendedRulesForGoal(goal);
  const recommendedRuleRows = recommendedRules.map((ruleKey) => ({
    ruleKey,
    label: RULE_LABELS[ruleKey] ?? ruleKey.replaceAll("_", " "),
    enabled: automationRules.find((rule) => rule.rule_key === ruleKey)?.enabled ?? false,
    lastEvaluatedAt: automationRules.find((rule) => rule.rule_key === ruleKey)?.last_evaluated_at ?? null,
    openActions: automationActions.filter((action) => action.rule_key === ruleKey && ["suggested", "drafted", "queued"].includes(action.status)).length,
    reason: recommendationReasonForRule(ruleKey, goal),
  }));

  const relatedActions = automationActions.filter((action) => recommendedRules.includes(action.rule_key)).slice(0, 8);
  const relatedActionIds = relatedActions.map((action) => action.id);

  let automationDeliveries: AutomationDeliveryRow[] = [];

  if (relatedActionIds.length > 0) {
    const deliveriesResult = await supabase
      .from("outbound_deliveries")
      .select("id, related_id, recipient_email, subject, status, error_message, sent_at, created_at, updated_at")
      .eq("studio_id", studioId)
      .eq("related_table", "automation_actions")
      .in("related_id", relatedActionIds)
      .order("created_at", { ascending: false });

    if (deliveriesResult.error) {
      throw new Error(`Failed to load ARIA goal email activity: ${deliveriesResult.error.message}`);
    }

    automationDeliveries = (deliveriesResult.data ?? []) as AutomationDeliveryRow[];
  }

  const deliveriesByActionId = automationDeliveries.reduce<Record<string, AutomationDeliveryRow[]>>((acc, delivery) => {
    if (!delivery.related_id) return acc;
    acc[delivery.related_id] = [...(acc[delivery.related_id] ?? []), delivery];
    return acc;
  }, {});

  const goalTimeline: GoalTimelineEntry[] = [
    {
      id: `goal-created-${goal.id}`,
      at: goal.created_at,
      label: "Goal",
      title: "Goal created",
      body: `${goal.title} was created with a target of ${formatTarget(goal.target_value, goal.target_unit)}.`,
      tone: "goal",
    },
  ];

  if (goal.progress_notes || goal.current_value !== null) {
    goalTimeline.push({
      id: `goal-progress-${goal.id}`,
      at: goal.updated_at,
      label: "Progress",
      title: "Progress updated",
      body: goal.progress_notes
        ? goal.progress_notes
        : `Current progress was updated to ${formatTarget(goal.current_value, goal.target_unit)}.`,
      tone: "aria",
    });
  }

  if (goal.completed_at) {
    goalTimeline.push({
      id: `goal-completed-${goal.id}`,
      at: goal.completed_at,
      label: "Goal",
      title: "Goal completed",
      body: "This ARIA goal was marked complete.",
      tone: "goal",
    });
  }

  if (goal.archived_at) {
    goalTimeline.push({
      id: `goal-archived-${goal.id}`,
      at: goal.archived_at,
      label: "Goal",
      title: "Goal archived",
      body: "This ARIA goal was archived.",
      tone: "goal",
    });
  }

  for (const action of relatedActions) {
    goalTimeline.push({
      id: `automation-${action.id}`,
      at: action.created_at,
      label: "Automation",
      title: action.title,
      body: `${RULE_LABELS[action.rule_key] ?? action.rule_key.replaceAll("_", " ")} created a ${action.status} action.`,
      tone: "automation",
    });

    if (action.completed_at) {
      goalTimeline.push({
        id: `automation-completed-${action.id}`,
        at: action.completed_at,
        label: "Automation",
        title: "Automation action completed",
        body: action.title,
        tone: "goal",
      });
    }

    if (action.dismissed_at) {
      goalTimeline.push({
        id: `automation-dismissed-${action.id}`,
        at: action.dismissed_at,
        label: "Automation",
        title: "Automation action dismissed",
        body: action.title,
        tone: "automation",
      });
    }

    for (const delivery of deliveriesByActionId[action.id] ?? []) {
      goalTimeline.push({
        id: `delivery-${delivery.id}`,
        at: delivery.sent_at ?? delivery.updated_at ?? delivery.created_at,
        label: "Email",
        title: delivery.subject ?? "Automation email",
        body: `${deliveryStatusLabel(delivery)}${delivery.recipient_email ? ` for ${delivery.recipient_email}` : ""}.`,
        tone: "email",
      });
    }
  }

  goalTimeline.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return (
    <main className="space-y-8 p-6 md:p-8">
      <section className="overflow-hidden rounded-[36px] border border-[#F9A8D4] bg-white shadow-sm">
        <div className="relative p-6 md:p-8">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(236,72,153,0.18),transparent_32%),linear-gradient(135deg,rgba(255,247,237,0.9),rgba(255,255,255,0.95)_45%,rgba(250,245,255,0.9))]" />
          <div className="relative grid gap-6 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
            <AriaAvatar size="lg" />
            <div>
              <Link
                href="/app/aria/goals"
                className="inline-flex items-center gap-2 text-sm font-semibold text-[#6B21A8] hover:underline"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to ARIA Goals
              </Link>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusClass(goal.status)}`}>
                  {goal.status}
                </span>
                <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                  {GOAL_TYPES[goal.goal_type] ?? goal.goal_type}
                </span>
                <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                  {FOCUS_AREAS[goal.focus_area] ?? goal.focus_area}
                </span>
              </div>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                {goal.title}
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-700 md:text-base">
                ARIA is tracking this goal through weekly milestones, progress notes, and the
                automations most likely to move the studio toward the target.
              </p>
            </div>
            <div className="rounded-[28px] border border-white/70 bg-white/85 p-5 shadow-sm backdrop-blur">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Target
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {formatTarget(goal.target_value, goal.target_unit)}
              </p>
              <p className="mt-1 text-sm text-slate-600">by {formatDate(goal.target_date)}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-4">
        {[
          {
            label: "Timeline",
            value: `${timelineProgress}%`,
            helper: `${goal.timeline_days} day plan`,
            icon: CalendarDays,
          },
          {
            label: "Target progress",
            value: targetProgress === null ? "Not set" : `${targetProgress}%`,
            helper: goal.current_value === null ? "Add current progress" : `${formatTarget(goal.current_value, goal.target_unit)} current`,
            icon: BarChart3,
          },
          {
            label: "Open actions",
            value: relatedActions.filter((action) => ["suggested", "drafted", "queued"].includes(action.status)).length,
            helper: "Recommended automation work",
            icon: ClipboardList,
          },
          {
            label: "Recommended rules",
            value: recommendedRuleRows.length,
            helper: "Automations tied to this goal",
            icon: Sparkles,
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
  title="ARIA Goal Coach"
  insight={
    targetProgress === null
      ? "This goal has a plan and timeline. Add a current progress value so ARIA can show how close the studio is to the target."
      : `This goal is ${targetProgress}% of the way to the target and ${timelineProgress}% through the timeline.`
  }
  recommendation="Use the recommended automations to keep follow-ups moving, then update progress after bookings, renewals, attendance, or revenue changes."
  primaryAction={{
    href: "/app/automations",
    label: "Review automations",
  }}
  secondaryAction={{
    href: "/app/aria",
    label: "Open ARIA hub",
  }}
/>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-6">
          <section className="rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
              ARIA plan
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">Plan summary</h2>
            <p className="mt-3 text-sm leading-7 text-slate-700">
              {goal.plan_summary || "ARIA has not generated a plan summary for this goal yet."}
            </p>

            {goal.baseline_notes ? (
              <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
                  Baseline notes
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-700">{goal.baseline_notes}</p>
              </div>
            ) : null}
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
              Weekly milestones
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">Follow the rhythm</h2>

            {milestones.length === 0 ? (
              <p className="mt-4 text-sm leading-6 text-slate-600">No milestones are saved for this goal yet.</p>
            ) : (
              <div className="mt-5 grid gap-3 md:grid-cols-2">
                {milestones.map((milestone) => (
                  <article key={`${milestone.week}-${milestone.title}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
                      {milestone.week ? `Week ${milestone.week}` : "Milestone"}
                    </p>
                    <p className="mt-2 text-sm font-semibold text-slate-950">{milestone.title}</p>
                    {milestone.body ? (
                      <p className="mt-1 text-xs leading-5 text-slate-600">{milestone.body}</p>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
                  Recommended automations
                </p>
                <h2 className="mt-2 text-2xl font-semibold text-slate-950">Keep the goal moving</h2>
              </div>
              <Link
                href="/app/automations"
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-[#6B21A8] hover:bg-slate-50"
              >
                Open automations
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {recommendedRuleRows.map((rule) => (
                <article key={rule.ruleKey} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">{rule.label}</p>
                      <p className="mt-1 text-xs leading-5 text-slate-600">
                        {rule.openActions} open action{rule.openActions === 1 ? "" : "s"} · Last evaluated {formatDateTime(rule.lastEvaluatedAt)}
                      </p>
                      <p className="mt-2 text-xs leading-5 text-slate-600">{rule.reason}</p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${rule.enabled ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-slate-100 text-slate-600 ring-1 ring-slate-200"}`}>
                      {rule.enabled ? "Enabled" : "Off"}
                    </span>
                  </div>
                  <Link
                    href={`/app/automations#${rule.ruleKey}`}
                    className="mt-4 inline-flex items-center gap-2 text-xs font-semibold text-[#6B21A8] underline"
                  >
                    {rule.enabled ? "Evaluate or review this automation" : "Turn on this automation"}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </article>
              ))}
            </div>
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
              Related automation activity
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">Recent actions</h2>

            {relatedActions.length === 0 ? (
              <p className="mt-4 text-sm leading-6 text-slate-600">
                No related automation actions yet. Evaluate the recommended rules to create suggested actions.
              </p>
            ) : (
              <div className="mt-5 space-y-3">
                {relatedActions.map((action) => (
                  <article key={action.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                        {RULE_LABELS[action.rule_key] ?? action.rule_key.replaceAll("_", " ")}
                      </span>
                      <span className="rounded-full bg-[#FCE7F3] px-3 py-1 text-xs font-semibold text-[#BE185D]">
                        {action.status}
                      </span>
                      <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                        {action.priority}
                      </span>
                    </div>
                    <p className="mt-3 text-sm font-semibold text-slate-950">{action.title}</p>
                    {action.body ? (
                      <p className="mt-1 text-xs leading-5 text-slate-600">{action.body}</p>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
              ARIA goal timeline
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">Progress and activity</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              ARIA tracks goal updates, recommended automation work, and automation email activity so the plan feels connected to real follow-up.
            </p>

            <div className="mt-5 space-y-3">
              {goalTimeline.slice(0, 12).map((entry) => (
                <article key={entry.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${timelineToneClass(entry.tone)}`}>
                      {entry.label}
                    </span>
                    <span className="text-xs font-medium text-slate-500">{formatDateTime(entry.at)}</span>
                  </div>
                  <p className="mt-3 text-sm font-semibold text-slate-950">{entry.title}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-600">{entry.body}</p>
                </article>
              ))}
            </div>
          </section>
        </div>

        <aside className="space-y-6">
          <section className="rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
              Progress update
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">Tell ARIA what changed</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Update the current value and notes after renewals, bookings, campaign responses, or revenue changes.
            </p>

            {canManageGoals ? (
              <form action={updateAriaGoalProgressAction} className="mt-5 space-y-4">
                <input type="hidden" name="goalId" value={goal.id} />
                <input type="hidden" name="returnTo" value={`/app/aria/goals/${goal.id}`} />

                <label className="block">
                  <span className="text-sm font-semibold text-slate-800">Current value</span>
                  <input
                    name="currentValue"
                    inputMode="decimal"
                    defaultValue={goal.current_value ?? ""}
                    placeholder="Example: 1200"
                    className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-[#F9A8D4] focus:ring-2 focus:ring-[#FCE7F3]"
                  />
                </label>

                <label className="block">
                  <span className="text-sm font-semibold text-slate-800">Progress notes</span>
                  <textarea
                    name="progressNotes"
                    rows={5}
                    defaultValue={goal.progress_notes ?? ""}
                    placeholder="Example: Renewed 3 packages and booked 2 inactive clients this week."
                    className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-[#F9A8D4] focus:ring-2 focus:ring-[#FCE7F3]"
                  />
                </label>

                <button className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-[#BE185D] to-[#F97316] px-4 py-3 text-sm font-semibold text-white shadow-sm">
                  Save progress
                  <ArrowRight className="h-4 w-4" />
                </button>
              </form>
            ) : (
              <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-800">
                Only studio owners, admins, and independent instructors can update ARIA goals.
              </div>
            )}
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
              Goal controls
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">Status</h2>

            {canManageGoals ? (
              <div className="mt-5 grid gap-2">
                {goal.status !== "active" ? (
                  <form action={updateAriaGoalStatusAction}>
                    <input type="hidden" name="goalId" value={goal.id} />
                    <input type="hidden" name="status" value="active" />
                    <input type="hidden" name="returnTo" value={`/app/aria/goals/${goal.id}`} />
                    <button className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-[#F9A8D4] bg-[#FCE7F3] px-4 py-2 text-sm font-semibold text-[#BE185D]">
                      <Target className="h-4 w-4" />
                      Resume goal
                    </button>
                  </form>
                ) : (
                  <form action={updateAriaGoalStatusAction}>
                    <input type="hidden" name="goalId" value={goal.id} />
                    <input type="hidden" name="status" value="paused" />
                    <input type="hidden" name="returnTo" value={`/app/aria/goals/${goal.id}`} />
                    <button className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-700">
                      <PauseCircle className="h-4 w-4" />
                      Pause goal
                    </button>
                  </form>
                )}

                {goal.status !== "completed" ? (
                  <form action={updateAriaGoalStatusAction}>
                    <input type="hidden" name="goalId" value={goal.id} />
                    <input type="hidden" name="status" value="completed" />
                    <input type="hidden" name="returnTo" value={`/app/aria/goals/${goal.id}`} />
                    <button className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white">
                      <CheckCircle2 className="h-4 w-4" />
                      Mark complete
                    </button>
                  </form>
                ) : null}

                {goal.status !== "archived" ? (
                  <form action={updateAriaGoalStatusAction}>
                    <input type="hidden" name="goalId" value={goal.id} />
                    <input type="hidden" name="status" value="archived" />
                    <input type="hidden" name="returnTo" value="/app/aria/goals" />
                    <button className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700">
                      Archive goal
                    </button>
                  </form>
                ) : null}
              </div>
            ) : (
              <p className="mt-5 text-sm leading-6 text-slate-600">You can view this goal, but cannot change the status.</p>
            )}

            <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs leading-5 text-slate-600">
              Created {formatDateTime(goal.created_at)} · Updated {formatDateTime(goal.updated_at)}
              {goal.completed_at ? ` · Completed ${formatDateTime(goal.completed_at)}` : ""}
              {goal.archived_at ? ` · Archived ${formatDateTime(goal.archived_at)}` : ""}
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}
