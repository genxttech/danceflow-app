"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";

const GOAL_TYPE_LABELS: Record<string, string> = {
  revenue: "revenue",
  private_lessons: "private lesson bookings",
  memberships: "memberships",
  group_classes: "group class attendance",
  retention: "client retention",
  events: "event sales",
  custom: "growth",
};

const FOCUS_LABELS: Record<string, string> = {
  package_renewals: "package renewals",
  rebooking: "rebooking clients with no upcoming lesson",
  lead_conversion: "lead conversion",
  memberships: "membership growth",
  group_classes: "group class attendance",
  events: "event registrations",
  retention: "client retention",
  overall_growth: "overall studio growth",
  custom: "custom growth work",
};

const TARGET_UNITS = new Set([
  "dollars",
  "clients",
  "bookings",
  "memberships",
  "attendees",
  "percent",
  "count",
]);

function readText(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(formData: FormData, key: string) {
  const value = readText(formData, key);
  if (!value) return null;

  const parsed = Number(value.replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function clampTimelineDays(value: number | null) {
  if (!value) return 60;
  return Math.min(365, Math.max(7, Math.round(value)));
}

function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function buildAriaGoalPlan({
  title,
  goalType,
  focusArea,
  targetValue,
  targetUnit,
  timelineDays,
  baselineNotes,
}: {
  title: string;
  goalType: string;
  focusArea: string;
  targetValue: number | null;
  targetUnit: string;
  timelineDays: number;
  baselineNotes: string | null;
}) {
  const goalLabel = GOAL_TYPE_LABELS[goalType] ?? "growth";
  const focusLabel = FOCUS_LABELS[focusArea] ?? "overall studio growth";
  const targetPhrase =
    targetValue === null
      ? `improve ${goalLabel}`
      : `reach ${targetValue.toLocaleString("en-US")} ${targetUnit.replace("_", " ")}`;

  const planSummary = [
    `ARIA will focus this plan on ${focusLabel} over the next ${timelineDays} days.`,
    `The goal is to ${targetPhrase}.`,
    "Start with the opportunities already visible in DanceFlow: low package balances, clients with no upcoming lesson, first-lesson follow-ups, pending booking requests, and unsigned documents.",
    baselineNotes
      ? `Baseline note from the studio: ${baselineNotes}`
      : "Add notes as the plan develops so ARIA can keep the next steps grounded in the studio's reality.",
  ].join(" ");

  const weeklyMilestones = [
    {
      week: 1,
      title: "Find the fastest opportunities",
      body:
        "Review ARIA opportunities, low package balances, pending booking requests, and clients without a future lesson. Enable the automations that match this goal.",
    },
    {
      week: 2,
      title: "Prepare follow-up drafts",
      body:
        "Create and review automation email drafts for the highest-priority clients. Adjust templates so the message sounds like the studio.",
    },
    {
      week: 3,
      title: "Turn follow-ups into bookings",
      body:
        "Queue approved drafts, monitor replies, and schedule clients who respond. Keep the schedule and booking request queue current.",
    },
    {
      week: 4,
      title: "Review progress and repeat",
      body:
        "Compare bookings, renewals, attendance, or revenue against the goal. Complete actions that worked and create the next batch of ARIA opportunities.",
    },
  ];

  return {
    planSummary,
    weeklyMilestones,
    kpiSnapshot: {
      goal_type: goalType,
      focus_area: focusArea,
      target_value: targetValue,
      target_unit: targetUnit,
      timeline_days: timelineDays,
      generated_by: "aria_rules_v1",
      title,
    },
  };
}

function getReturnPath() {
  return "/app/aria/goals";
}


function getGoalReturnPath(formData: FormData, goalId?: string) {
  const rawReturnTo = formData.get("returnTo");

  if (typeof rawReturnTo === "string") {
    const returnTo = rawReturnTo.trim();

    if (
      returnTo.startsWith("/app/aria/goals") &&
      !returnTo.startsWith("//") &&
      !returnTo.includes("://")
    ) {
      return returnTo;
    }
  }

  return goalId ? `/app/aria/goals/${goalId}` : "/app/aria/goals";
}

export async function createAriaGoalAction(formData: FormData) {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    redirect("/app");
  }

  if (!canManageSettings(context.studioRole)) {
    redirect("/app/aria/goals?error=permission");
  }

  const studioId = context.studioId;
  const title = readText(formData, "title");
  const goalType = readText(formData, "goalType") || "revenue";
  const focusArea = readText(formData, "focusArea") || "overall_growth";
  const targetUnit = readText(formData, "targetUnit") || "dollars";
  const targetValue = readNumber(formData, "targetValue");
  const timelineDays = clampTimelineDays(readNumber(formData, "timelineDays"));
  const baselineNotesRaw = readText(formData, "baselineNotes");
  const baselineNotes = baselineNotesRaw || null;

  if (!title) {
    redirect("/app/aria/goals?error=missing-title");
  }

  if (!GOAL_TYPE_LABELS[goalType]) {
    redirect("/app/aria/goals?error=goal-type");
  }

  if (!FOCUS_LABELS[focusArea]) {
    redirect("/app/aria/goals?error=focus-area");
  }

  if (!TARGET_UNITS.has(targetUnit)) {
    redirect("/app/aria/goals?error=target-unit");
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const startsAt = new Date();
  const targetDate = addDays(startsAt, timelineDays);
  const plan = buildAriaGoalPlan({
    title,
    goalType,
    focusArea,
    targetValue,
    targetUnit,
    timelineDays,
    baselineNotes,
  });

  const { error } = await supabase.from("aria_goals").insert({
    studio_id: studioId,
    created_by: user?.id ?? null,
    updated_by: user?.id ?? null,
    title,
    goal_type: goalType,
    focus_area: focusArea,
    target_value: targetValue,
    target_unit: targetUnit,
    timeline_days: timelineDays,
    starts_at: isoDate(startsAt),
    target_date: isoDate(targetDate),
    status: "active",
    baseline_notes: baselineNotes,
    plan_summary: plan.planSummary,
    weekly_milestones: plan.weeklyMilestones,
    kpi_snapshot: plan.kpiSnapshot,
  });

  if (error) {
    throw new Error(`Failed to create ARIA goal: ${error.message}`);
  }

  revalidatePath("/app/aria");
  revalidatePath("/app/aria/goals");
  redirect("/app/aria/goals?created=1");
}

export async function updateAriaGoalStatusAction(formData: FormData) {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    redirect("/app");
  }

  if (!canManageSettings(context.studioRole)) {
    redirect("/app/aria/goals?error=permission");
  }

  const goalId = readText(formData, "goalId");
  const status = readText(formData, "status");

  if (!goalId || !["active", "paused", "completed", "archived"].includes(status)) {
    redirect(getReturnPath());
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const updates: Record<string, unknown> = {
    status,
    updated_by: user?.id ?? null,
  };

  if (status === "completed") {
    updates.completed_at = new Date().toISOString();
  } else if (status === "archived") {
    updates.archived_at = new Date().toISOString();
  } else if (status === "active" || status === "paused") {
    updates.completed_at = null;
    updates.archived_at = null;
  }

  const { error } = await supabase
    .from("aria_goals")
    .update(updates)
    .eq("id", goalId)
    .eq("studio_id", context.studioId);

  if (error) {
    throw new Error(`Failed to update ARIA goal: ${error.message}`);
  }

  revalidatePath("/app/aria");
  revalidatePath("/app/aria/goals");
  revalidatePath(`/app/aria/goals/${goalId}`);
  redirect(getGoalReturnPath(formData, goalId));
}


export async function updateAriaGoalProgressAction(formData: FormData) {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    redirect("/app");
  }

  if (!canManageSettings(context.studioRole)) {
    redirect("/app/aria/goals?error=permission");
  }

  const goalId = readText(formData, "goalId");
  const currentValue = readNumber(formData, "currentValue");
  const progressNotesRaw = readText(formData, "progressNotes");
  const progressNotes = progressNotesRaw || null;

  if (!goalId) {
    redirect("/app/aria/goals");
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase
    .from("aria_goals")
    .update({
      current_value: currentValue,
      progress_notes: progressNotes,
      updated_by: user?.id ?? null,
    })
    .eq("id", goalId)
    .eq("studio_id", context.studioId);

  if (error) {
    throw new Error(`Failed to update ARIA goal progress: ${error.message}`);
  }

  revalidatePath("/app/aria");
  revalidatePath("/app/aria/goals");
  revalidatePath(`/app/aria/goals/${goalId}`);
  redirect(getGoalReturnPath(formData, goalId));
}
