"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomUUID } from "crypto";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import { buildHeatPlan, HEAT_PLANNER_VERSION, type HeatPlannerInput } from "@/lib/competition/heatPlanner";

const CONSTRAINT_TYPES = [
  "floor_capacity",
  "dancer_conflict",
  "instructor_conflict",
  "partner_conflict",
  "judge_availability",
  "time_window",
  "minimum_gap",
  "keep_together",
  "keep_separate",
  "round_requirement",
  "estimated_duration",
  "floor_assignment",
  "custom",
];
const ENFORCEMENT_LEVELS = ["hard", "soft", "informational"];

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function allowed(value: string, values: string[], fallback: string) {
  return values.includes(value) ? value : fallback;
}

function positiveNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function requireEventManager(eventId: string) {
  const context = await getCurrentStudioContext();
  const supabase = await createClient();
  const { data: event, error } = await supabase
    .from("events")
    .select("id, studio_id, organizer_id")
    .eq("id", eventId)
    .eq("studio_id", context.studioId)
    .maybeSingle();
  if (error || !event) throw new Error("Event not found.");

  const studioCanManage = ["studio_owner", "studio_admin"].includes(context.studioRole ?? "");
  let organizerCanManage = false;
  if (event.organizer_id) {
    const { data: organizerUser } = await supabase
      .from("organizer_users")
      .select("role")
      .eq("organizer_id", event.organizer_id)
      .eq("user_id", context.userId)
      .eq("active", true)
      .maybeSingle();
    organizerCanManage = ["organizer_owner", "organizer_admin", "organizer_staff"].includes(organizerUser?.role ?? "");
  }
  if (!context.isPlatformAdmin && !studioCanManage && !organizerCanManage) throw new Error("You do not have permission to manage this competition.");
  return supabase;
}

function refresh(eventId: string) {
  revalidatePath(`/app/events/${eventId}/competition`);
  revalidatePath(`/app/events/${eventId}/competition/schedule`);
  revalidatePath(`/app/events/${eventId}/competition/readiness`);
}

export async function addRecommendedConstraintsAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const scheduleVersionId = text(formData, "scheduleVersionId");
  if (!eventId || !scheduleVersionId) throw new Error("An editable schedule is required.");
  const supabase = await requireEventManager(eventId);

  const recommended = [
    { name: "Respect floor capacity", constraint_type: "floor_capacity", enforcement: "hard" },
    { name: "Prevent dancer conflicts", constraint_type: "dancer_conflict", enforcement: "hard" },
    { name: "Prevent instructor conflicts", constraint_type: "instructor_conflict", enforcement: "hard" },
    { name: "Prevent partner conflicts", constraint_type: "partner_conflict", enforcement: "hard" },
  ];

  const { data: existing, error: existingError } = await (supabase as any)
    .from("event_competition_generation_constraints")
    .select("constraint_type")
    .eq("event_id", eventId)
    .eq("schedule_version_id", scheduleVersionId)
    .eq("active", true)
    .in("constraint_type", recommended.map((item) => item.constraint_type));
  if (existingError) throw new Error(`Could not inspect schedule rules: ${existingError.message}`);
  const existingTypes = new Set((existing ?? []).map((item: { constraint_type: string }) => item.constraint_type));
  const rows = recommended
    .filter((item) => !existingTypes.has(item.constraint_type))
    .map((item) => ({
      event_id: eventId,
      schedule_version_id: scheduleVersionId,
      name: item.name,
      constraint_type: item.constraint_type,
      enforcement: item.enforcement,
      scope_type: "schedule",
      configuration: {},
    }));
  if (rows.length > 0) {
    const { error } = await (supabase as any).from("event_competition_generation_constraints").insert(rows);
    if (error) throw new Error(`Could not add recommended rules: ${error.message}`);
  }
  refresh(eventId);
}

export async function createGenerationConstraintAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const scheduleVersionId = text(formData, "scheduleVersionId");
  const name = text(formData, "name");
  const constraintType = allowed(text(formData, "constraintType"), CONSTRAINT_TYPES, "custom");
  if (!eventId || !scheduleVersionId || !name) throw new Error("Schedule, rule name, and rule type are required.");
  const supabase = await requireEventManager(eventId);

  const amount = positiveNumber(text(formData, "amount"));
  const note = text(formData, "note");
  const earliestTime = text(formData, "earliestTime");
  const latestTime = text(formData, "latestTime");
  let configuration: Record<string, unknown> = {};
  if (constraintType === "minimum_gap") {
    if (!amount) throw new Error("Minimum gap requires a number of minutes.");
    configuration = { minutes: amount };
  } else if (constraintType === "estimated_duration") {
    if (!amount) throw new Error("Estimated duration requires a number of minutes.");
    configuration = { seconds: Math.round(amount * 60) };
  } else if (constraintType === "time_window") {
    if (!earliestTime && !latestTime) throw new Error("Add an earliest or latest time.");
    configuration = { earliest_time: earliestTime || null, latest_time: latestTime || null };
  } else if (note) {
    configuration = { note };
  }

  const { error } = await (supabase as any).from("event_competition_generation_constraints").insert({
    event_id: eventId,
    schedule_version_id: scheduleVersionId,
    name,
    constraint_type: constraintType,
    enforcement: allowed(text(formData, "enforcement"), ENFORCEMENT_LEVELS, "hard"),
    scope_type: "schedule",
    configuration,
  });
  if (error) throw new Error(`Could not add schedule rule: ${error.message}`);
  refresh(eventId);
}

export async function disableGenerationConstraintAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const constraintId = text(formData, "constraintId");
  if (!eventId || !constraintId) throw new Error("Schedule rule is required.");
  const supabase = await requireEventManager(eventId);
  const { error } = await (supabase as any)
    .from("event_competition_generation_constraints")
    .update({ active: false })
    .eq("id", constraintId)
    .eq("event_id", eventId);
  if (error) throw new Error(`Could not disable schedule rule: ${error.message}`);
  refresh(eventId);
}

export async function generateHeatPlanAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const scheduleVersionId = text(formData, "scheduleVersionId");
  if (!eventId || !scheduleVersionId) throw new Error("An editable schedule is required.");
  const supabase = await requireEventManager(eventId);

  const [contestResult, divisionResult, roundResult, danceResult, offeringResult, entryResult, entryDanceResult, participantResult, blockResult, assignmentResult, constraintResult] = await Promise.all([
    (supabase as any).from("event_competition_contests").select("id, name, contest_type").eq("event_id", eventId).neq("status", "cancelled").order("sort_order"),
    (supabase as any).from("event_competition_divisions").select("id, contest_id, name").eq("event_id", eventId).neq("status", "cancelled").order("sort_order"),
    (supabase as any).from("event_competition_rounds").select("id, division_id, name, round_type, sequence_number, target_advancement_count").eq("event_id", eventId).neq("status", "cancelled").order("sequence_number"),
    (supabase as any).from("event_competition_dances").select("id, dance_key, name").eq("event_id", eventId).eq("active", true).order("sort_order"),
    (supabase as any).from("event_competition_division_dances").select("division_id, dance_id, required, sort_order").eq("event_id", eventId).eq("active", true).order("sort_order"),
    (supabase as any).from("event_competition_entries").select("id, division_id, display_name, entry_number").eq("event_id", eventId).eq("status", "confirmed").in("eligibility_status", ["eligible", "waived"]).order("sort_order"),
    (supabase as any).from("event_competition_entry_dances").select("entry_id, dance_key, status").eq("event_id", eventId),
    (supabase as any).from("event_competition_entry_participants").select("entry_id, client_id, instructor_id, registration_attendee_id, participant_role, display_name").eq("event_id", eventId),
    (supabase as any).from("event_competition_schedule_blocks").select("id, name, starts_at, ends_at, floor_id, floor_name_snapshot, floor_capacity_snapshot").eq("schedule_version_id", scheduleVersionId).eq("block_type", "competition").order("starts_at"),
    (supabase as any).from("event_competition_schedule_block_contests").select("block_id, contest_id, planned_round_type, sort_order").eq("schedule_version_id", scheduleVersionId).order("sort_order"),
    (supabase as any).from("event_competition_generation_constraints").select("constraint_type, enforcement, configuration").eq("event_id", eventId).eq("schedule_version_id", scheduleVersionId).eq("active", true).order("created_at"),
  ]);
  const loadError = contestResult.error || divisionResult.error || roundResult.error || danceResult.error || offeringResult.error || entryResult.error || entryDanceResult.error || participantResult.error || blockResult.error || assignmentResult.error || constraintResult.error;
  if (loadError) throw new Error(`Could not load heat-planning inputs: ${loadError.message}`);

  const seed = randomUUID();
  const input: HeatPlannerInput = {
    eventId,
    scheduleVersionId,
    seed,
    contests: contestResult.data ?? [],
    divisions: divisionResult.data ?? [],
    rounds: roundResult.data ?? [],
    dances: danceResult.data ?? [],
    offerings: offeringResult.data ?? [],
    entries: entryResult.data ?? [],
    entryDances: entryDanceResult.data ?? [],
    participants: participantResult.data ?? [],
    blocks: blockResult.data ?? [],
    assignments: assignmentResult.data ?? [],
    constraints: constraintResult.data ?? [],
  };
  const snapshot = { captured_at: new Date().toISOString(), engine_version: HEAT_PLANNER_VERSION, ...input };
  const { data: runId, error: runError } = await (supabase as any).rpc("create_competition_heat_plan_run", {
    selected_event_id: eventId,
    selected_schedule_version_id: scheduleVersionId,
    selected_engine_version: HEAT_PLANNER_VERSION,
    selected_randomization_seed: seed,
    selected_input_snapshot: snapshot,
  });
  if (runError || !runId) throw new Error(`Could not start heat planning: ${runError?.message ?? "No run was created."}`);

  try {
    const plan = buildHeatPlan(input);
    const { error: saveError } = await (supabase as any).rpc("save_competition_heat_plan", {
      selected_run_id: runId,
      selected_proposals: plan.proposals,
      selected_conflicts: plan.conflicts,
      selected_summary: plan.summary,
    });
    if (saveError) throw new Error(saveError.message);
  } catch (error) {
    await (supabase as any).rpc("fail_competition_heat_plan_run", {
      selected_run_id: runId,
      selected_failure_message: error instanceof Error ? error.message : "Heat planning failed.",
    });
    throw error;
  }

  refresh(eventId);
  redirect(`/app/events/${eventId}/competition/generation/${runId}`);
}
