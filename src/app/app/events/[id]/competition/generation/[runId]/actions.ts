"use server";

import { revalidatePath } from "next/cache";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
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
    const { data: organizerUser } = await supabase.from("organizer_users").select("role").eq("organizer_id", event.organizer_id).eq("user_id", context.userId).eq("active", true).maybeSingle();
    organizerCanManage = ["organizer_owner", "organizer_admin", "organizer_staff"].includes(organizerUser?.role ?? "");
  }
  if (!context.isPlatformAdmin && !studioCanManage && !organizerCanManage) throw new Error("You do not have permission to manage this competition.");
  return supabase;
}

function refresh(eventId: string, runId: string) {
  revalidatePath(`/app/events/${eventId}/competition/readiness`);
  revalidatePath(`/app/events/${eventId}/competition/schedule`);
  revalidatePath(`/app/events/${eventId}/competition/generation/${runId}`);
}

export async function acknowledgeHeatPlanConflictAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const runId = text(formData, "runId");
  const conflictId = text(formData, "conflictId");
  if (!eventId || !runId || !conflictId) throw new Error("Conflict is required.");
  const supabase = await requireEventManager(eventId);
  const { error } = await (supabase as any).rpc("acknowledge_competition_heat_plan_conflict", {
    selected_conflict_id: conflictId,
    selected_note: text(formData, "note") || null,
  });
  if (error) throw new Error(`Could not acknowledge warning: ${error.message}`);
  refresh(eventId, runId);
}

export async function reviewHeatPlanAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const runId = text(formData, "runId");
  const decision = text(formData, "decision");
  if (!eventId || !runId || !["reviewed", "rejected"].includes(decision)) throw new Error("A valid review decision is required.");
  const supabase = await requireEventManager(eventId);
  const { error } = await (supabase as any).rpc("review_competition_heat_plan", {
    selected_run_id: runId,
    selected_decision: decision,
  });
  if (error) throw new Error(`Could not review heat plan: ${error.message}`);
  refresh(eventId, runId);
}

export async function applyHeatPlanAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const runId = text(formData, "runId");
  if (!eventId || !runId) throw new Error("Approved heat plan is required.");
  const supabase = await requireEventManager(eventId);
  const { error } = await (supabase as any).rpc("apply_competition_heat_plan", { selected_run_id: runId });
  if (error) throw new Error(`Could not apply heat plan: ${error.message}`);
  refresh(eventId, runId);
}
