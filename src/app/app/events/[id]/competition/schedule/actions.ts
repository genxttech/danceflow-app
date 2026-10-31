"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireCompetitionManager } from "@/lib/competition/workspaceServer";
import { buildFloorPlan, toApplyPayload } from "@/lib/competition/floorPlanner";
import { loadPlannerInput, loadScheduleVersions } from "@/lib/competition/floorScheduleServer";
import { isRetryableError, withRetryOnce, errorText } from "@/lib/competition/results/advancement";
import { hasResultMessage } from "@/lib/competition/results/messages";

/* 10D: Schedule & Heats operations. Every change goes through the database authority
   (apply/move/insert/delete RPCs + deferred integrity checks); nothing here is trusted. */

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function schedulePath(eventId: string) {
  return `/app/events/${eventId}/competition/schedule`;
}

/** Plain-language message for an organizer; never a raw database error. */
function friendly(error: { message?: string; code?: string | null } | null | undefined) {
  const message = error?.message ?? "";
  // CF1: a deadlock (40P01) or refused lock wait (55P03) is not a failure of the request; nothing was saved. The schedule RPCs carry no
  // request id, so they are not repeated automatically: the organizer is told to try again.
  if (error && isRetryableError({ message, code: error.code })) return errorText({ message, code: error.code });
  const match = message.match(/COMP10D_[A-Z_]+:\s*([\s\S]+)$/);
  if (match) return match[1].replace(/\s+/g, " ").trim();
  if (hasResultMessage(message)) return errorText({ message, code: error?.code });
  if (message.includes("Locked or certified")) return "A locked heat can only change through the correction workflow.";
  if (message.includes("Add at least one session")) return "Generate heats before publishing.";
  return "That change could not be saved. Refresh and try again.";
}

function back(eventId: string, params: Record<string, string | undefined>): never {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  revalidatePath(schedulePath(eventId));
  redirect(`${schedulePath(eventId)}${search.size ? `?${search}` : ""}`);
}

async function manager(formData: FormData) {
  const eventId = text(formData, "eventId");
  const { supabase } = await requireCompetitionManager(eventId);
  return { eventId, supabase };
}

export async function generateHeatsAction(formData: FormData): Promise<void> {
  const { eventId, supabase } = await manager(formData);
  const versions = await loadScheduleVersions(supabase, eventId);
  let draft = versions.find((version) => version.status === "draft");
  if (!draft) {
    const { data: versionId, error } = await supabase.rpc("create_competition_schedule_version", {
      selected_event_id: eventId, selected_name: "Running order", source_version_id: null,
    });
    if (error || !versionId) back(eventId, { error: friendly(error) });
    draft = { id: versionId as string, version_number: 0, name: "Running order", status: "draft", published_at: null };
  }
  const plan = buildFloorPlan(await loadPlannerInput(supabase, eventId));
  if (plan.floorHeats.length === 0) back(eventId, { error: "There are no confirmed entries to schedule yet." });
  const { error } = await supabase.rpc("apply_competition_floor_plan", { p_version_id: draft.id, p_plan: toApplyPayload(plan) });
  if (error) back(eventId, { error: friendly(error) });
  back(eventId, { notice: `Created ${plan.floorHeats.length} heats for ${plan.scheduledEntryCount} entries.` });
}

export async function clearHeatsAction(formData: FormData): Promise<void> {
  const { eventId, supabase } = await manager(formData);
  const { error } = await supabase.rpc("clear_competition_floor_plan", { p_version_id: text(formData, "versionId") });
  back(eventId, error ? { error: friendly(error) } : { notice: "The draft running order was cleared." });
}

export async function moveScoringHeatAction(formData: FormData): Promise<void> {
  const { eventId, supabase } = await manager(formData);
  const heatId = text(formData, "heatId");
  const target = text(formData, "target");
  const result = target.startsWith("new:")
    ? await supabase.rpc("move_competition_scoring_heat_to_new_floor_heat", { p_heat_id: heatId, p_at_number: Number(target.slice(4)) })
    : await supabase.rpc("move_competition_scoring_heat", { p_heat_id: heatId, p_target_floor_heat_id: target });
  back(eventId, result.error ? { error: friendly(result.error), heat: text(formData, "floorHeatId") } : { notice: "Division moved.", heat: target.startsWith("new:") ? (result.data as string) : target });
}

export async function moveFloorHeatAction(formData: FormData): Promise<void> {
  const { eventId, supabase } = await manager(formData);
  const floorHeatId = text(formData, "floorHeatId");
  const { error } = await supabase.rpc("move_competition_floor_heat", { p_floor_heat_id: floorHeatId, p_new_number: Number(text(formData, "position")) });
  back(eventId, error ? { error: friendly(error), heat: floorHeatId } : { notice: "Running order updated.", heat: floorHeatId });
}

export async function insertFloorHeatAction(formData: FormData): Promise<void> {
  const { eventId, supabase } = await manager(formData);
  const { data, error } = await supabase.rpc("insert_competition_floor_heat", { p_version_id: text(formData, "versionId"), p_at_number: Number(text(formData, "position")) });
  back(eventId, error ? { error: friendly(error) } : { notice: "Empty heat added.", heat: data as string });
}

export async function deleteFloorHeatAction(formData: FormData): Promise<void> {
  const { eventId, supabase } = await manager(formData);
  const { error } = await supabase.rpc("delete_competition_floor_heat", { p_floor_heat_id: text(formData, "floorHeatId") });
  back(eventId, error ? { error: friendly(error) } : { notice: "Empty heat removed." });
}

export async function setHeatCapacityAction(formData: FormData): Promise<void> {
  const { eventId, supabase } = await manager(formData);
  // CF1 A0: the two-argument RPC always refuses (COMP_CAPACITY_REASON_REQUIRED). The reasoned RPC has a request id, so one retry is safe.
  const reason = text(formData, "reason");
  if (!reason) back(eventId, { error: errorText({ message: "COMP_CAPACITY_REASON_REQUIRED" }), heat: text(formData, "floorHeatId") });
  const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text(formData, "requestId")) ? text(formData, "requestId") : randomUUID();
  const rpc = withRetryOnce((name, args) => supabase.rpc(name, args));
  const { error } = await rpc("set_competition_round_heat_capacity", {
    p_round_id: text(formData, "roundId"),
    p_capacity: Number(text(formData, "capacity")),
    p_reason: reason,
    p_request_id: requestId,
  });
  back(eventId, error ? { error: friendly(error), heat: text(formData, "floorHeatId") } : { notice: "Heat size saved. It applies the next time heats are generated.", heat: text(formData, "floorHeatId") });
}

export async function publishRunningOrderAction(formData: FormData): Promise<void> {
  const { eventId, supabase } = await manager(formData);
  const { error } = await supabase.rpc("publish_competition_schedule_version", { selected_version_id: text(formData, "versionId") });
  back(eventId, error ? { error: friendly(error) } : { notice: "Running order published." });
}

export async function editPublishedRunningOrderAction(formData: FormData): Promise<void> {
  const { eventId, supabase } = await manager(formData);
  const { error } = await supabase.rpc("create_competition_schedule_version", {
    selected_event_id: eventId, selected_name: "Running order (edited)", source_version_id: text(formData, "versionId"),
  });
  back(eventId, error ? { error: friendly(error) } : { notice: "A new draft copy is ready to edit. The published running order stays in effect until you publish again." });
}
