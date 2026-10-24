"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { parseResolution, scratchErrorMessage } from "@/lib/competition/scratch/scratch";
import { createClient } from "@/lib/supabase/server";

// SC1: scratching never moves money. Authority, policy, locked/danced/certified rules and the audit row all
// live in scratch_competition_entry; this action only forwards the form.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

async function eventInWorkspace(eventId: string) {
  if (!UUID.test(eventId)) throw new Error("Event not found.");
  const context = await getCurrentStudioContext();
  const supabase = await createClient();
  const { data: event, error } = await supabase.from("events").select("id").eq("id", eventId).eq("studio_id", context.studioId).maybeSingle();
  if (error || !event) throw new Error("Event not found.");
  return supabase;
}

function refresh(eventId: string) {
  revalidatePath(`/app/events/${eventId}/competition`);
  revalidatePath(`/app/events/${eventId}/competition/registrations`);
  revalidatePath(`/app/events/${eventId}/competition/schedule`);
  revalidatePath(`/app/events/${eventId}/competition/checkin`);
}

export async function scratchCompetitionEntryAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const entryId = text(formData, "entryId");
  const requestId = text(formData, "requestId");
  const reason = text(formData, "reason");
  const resolution = parseResolution(text(formData, "resolution"));
  const back = `/app/events/${eventId}/competition/registrations/scratch/${entryId}`;
  if (!UUID.test(entryId) || !UUID.test(requestId) || !resolution) {
    redirect(`${back}?error=${encodeURIComponent("Choose a resolution and try again.")}`);
  }
  const supabase = await eventInWorkspace(eventId);
  const { error } = await supabase.rpc("scratch_competition_entry", {
    p_entry_id: entryId,
    p_request_id: requestId,
    p_reason: reason || null,
    p_resolution: resolution,
  });
  if (error) redirect(`${back}?error=${encodeURIComponent(scratchErrorMessage(error.message))}`);
  refresh(eventId);
  redirect(`/app/events/${eventId}/competition/registrations?scratched=${entryId}`);
}

export async function setCompetitionScratchPolicyAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const programId = text(formData, "programId");
  const value = text(formData, "resolution");
  const back = `/app/events/${eventId}/competition/registrations/scratch/policy`;
  const resolution = value === "inherit" ? null : parseResolution(value);
  if (!UUID.test(programId) || (value !== "inherit" && !resolution)) redirect(`${back}?error=${encodeURIComponent("Choose a policy.")}`);
  const supabase = await eventInWorkspace(eventId);
  const { error } = await supabase.rpc("set_competition_scratch_policy", { p_program_id: programId, p_resolution: resolution });
  if (error) redirect(`${back}?error=${encodeURIComponent(scratchErrorMessage(error.message))}`);
  revalidatePath(back);
  redirect(`${back}?saved=1`);
}

export async function setCompetitionScratchPolicyDefaultAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const resolution = parseResolution(text(formData, "resolution"));
  const back = `/app/events/${eventId}/competition/registrations/scratch/policy`;
  if (!resolution) redirect(`${back}?error=${encodeURIComponent("Choose a policy.")}`);
  const supabase = await eventInWorkspace(eventId);
  const { error } = await supabase.rpc("set_competition_scratch_policy_default", { p_event_id: eventId, p_resolution: resolution });
  if (error) {
    const message = error.message.includes("COMP_SC1_NOT_FOUND")
      ? "Only the event's organizer (or studio, for studio-run events) owners and admins can set the standard policy."
      : scratchErrorMessage(error.message);
    redirect(`${back}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(back);
  redirect(`${back}?saved=1`);
}
