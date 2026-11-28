"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireCompetitionManager } from "@/lib/competition/workspaceServer";
import { performScratch } from "@/lib/competition/scratch/scratchServer";

// SC1 (live-line port): scratching never moves money and never un-scratches. Authority, locked / certified refusal,
// the audit row and the heat-entry cascade live in the lifecycle RPC (run as the signed-in manager); this action
// forwards the form through performScratch. There is deliberately no un-scratch action: U18-S refuses it for every
// non-owner writer, and a restore goes through the correction workflow.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

export async function scratchCompetitionEntryAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const entryId = text(formData, "entryId");
  if (!UUID.test(eventId) || !UUID.test(entryId)) redirect("/app/events");
  const back = `/app/events/${eventId}/competition/registrations/scratch/${entryId}`;
  // Throws for anyone who cannot manage the competition (chair, staff without a manager role, judge, other studio).
  const { supabase } = await requireCompetitionManager(eventId);
  const result = await performScratch(supabase as never, { eventId, entryId, reason: text(formData, "reason") });
  if (!result.ok) redirect(`${back}?error=${result.code}`);
  revalidatePath(`/app/events/${eventId}/competition`);
  revalidatePath(`/app/events/${eventId}/competition/registrations`);
  revalidatePath(`/app/events/${eventId}/competition/schedule`);
  revalidatePath(`/app/events/${eventId}/competition/checkin`);
  revalidatePath(`/app/events/${eventId}/competition/day-of`);
  redirect(`/app/events/${eventId}/competition/registrations/scratch/${entryId}?${result.outcome === "scratched" ? "done=1" : result.outcome === "already_withdrawn" ? "already=withdrawn" : "already=1"}`);
}
