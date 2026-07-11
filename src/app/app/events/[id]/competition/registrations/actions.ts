"use server";

import { revalidatePath } from "next/cache";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";

const ELIGIBILITY = ["unverified", "eligible", "needs_review", "ineligible", "waived"];

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

async function requireEventManager(eventId: string) {
  const context = await getCurrentStudioContext();
  const supabase = await createClient();
  const { data: event, error } = await supabase.from("events").select("id, studio_id, organizer_id").eq("id", eventId).eq("studio_id", context.studioId).maybeSingle();
  if (error || !event) throw new Error("Event not found.");
  const studioCanManage = ["studio_owner", "studio_admin"].includes(context.studioRole ?? "");
  let organizerCanManage = false;
  if (event.organizer_id) {
    const { data: organizerUser } = await supabase.from("organizer_users").select("role").eq("organizer_id", event.organizer_id).eq("user_id", context.userId).eq("active", true).maybeSingle();
    organizerCanManage = ["organizer_owner", "organizer_admin", "organizer_staff"].includes(organizerUser?.role ?? "");
  }
  if (!context.isPlatformAdmin && !studioCanManage && !organizerCanManage) throw new Error("You do not have permission to manage competition registrations.");
  return supabase;
}

function refresh(eventId: string) {
  revalidatePath(`/app/events/${eventId}/competition`);
  revalidatePath(`/app/events/${eventId}/competition/registrations`);
  revalidatePath(`/app/events/${eventId}/competition/readiness`);
}

export async function updateCompetitionEntryEligibilityAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const entryId = text(formData, "entryId");
  const eligibilityStatus = text(formData, "eligibilityStatus");
  if (!eventId || !entryId || !ELIGIBILITY.includes(eligibilityStatus)) throw new Error("A valid eligibility decision is required.");
  const supabase = await requireEventManager(eventId);
  const { error } = await (supabase as any).from("event_competition_entries").update({ eligibility_status: eligibilityStatus }).eq("id", entryId).eq("event_id", eventId);
  if (error) throw new Error(`Could not update entry eligibility: ${error.message}`);
  refresh(eventId);
}

export async function assignCompetitionEntryNumberAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const entryId = text(formData, "entryId");
  const entryNumber = text(formData, "entryNumber");
  if (!eventId || !entryId) throw new Error("Competition entry is required.");
  const supabase = await requireEventManager(eventId);
  const { error } = await (supabase as any).from("event_competition_entries").update({ entry_number: entryNumber || null }).eq("id", entryId).eq("event_id", eventId);
  if (error) throw new Error(`Could not assign entry number: ${error.message}`);
  refresh(eventId);
}
