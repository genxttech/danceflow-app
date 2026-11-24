"use server";

import { revalidatePath } from "next/cache";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import { buildEligibilityDetermination, ELIGIBILITY_CRITERIA, validateEligibilityDecision, type EligibilityCriterion, type EligibilityReasonCode, type EligibilityStatus } from "@/lib/competition/eligibilityGate";
import { entryParticipantsAdultVerified, loadEntryRequiredCriteria } from "@/lib/competition/eligibilityGateServer";

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
  let actorRole = context.isPlatformAdmin ? "platform_admin" : studioCanManage ? (context.studioRole as string) : "";
  if (event.organizer_id) {
    const { data: organizerUser } = await supabase.from("organizer_users").select("role").eq("organizer_id", event.organizer_id).eq("user_id", context.userId).eq("active", true).maybeSingle();
    organizerCanManage = ["organizer_owner", "organizer_admin", "organizer_staff"].includes(organizerUser?.role ?? "");
    if (!actorRole && organizerCanManage) actorRole = organizerUser?.role as string;
  }
  if (!context.isPlatformAdmin && !studioCanManage && !organizerCanManage) throw new Error("You do not have permission to manage competition registrations.");
  return { supabase, userId: context.userId, actorRole };
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
  const reasonCode = text(formData, "reasonCode");
  if (!eventId || !entryId || !ELIGIBILITY.includes(eligibilityStatus)) throw new Error("A valid eligibility decision is required.");
  const { supabase, userId, actorRole } = await requireEventManager(eventId);
  // OD-03: an auditable organizer determination (who, when, outcome, reason code; no birthdates) is stored with the entry.
  // OD-02: eligible/waived is refused unless every competitor's STORED date of birth shows 18 or older (fails closed).
  const { data: entry, error: entryError } = await (supabase as any).from("event_competition_entries").select("id, division_id, metadata").eq("id", entryId).eq("event_id", eventId).maybeSingle();
  if (entryError || !entry) throw new Error("Competition entry not found.");
  // OD-18: which criteria apply is derived from STORED division labels and participant roles, never from the form.
  const classification = await loadEntryRequiredCriteria(supabase, eventId, entryId);
  if (!classification.divisionFound) throw new Error("Competition division not found.");
  const verifiedCriteria = (formData.getAll("criteria") as string[]).map(String).filter((item): item is EligibilityCriterion => (ELIGIBILITY_CRITERIA as readonly string[]).includes(item));
  const participantsAdult = await entryParticipantsAdultVerified(supabase, eventId, entryId);
  const problem = validateEligibilityDecision({ outcome: eligibilityStatus, reasonCode, required: classification.required, verifiedCriteria, participantsAdult });
  if (problem) throw new Error(problem);
  const metadata = { ...(entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {}), eligibility_determination: buildEligibilityDetermination({ by: userId, role: actorRole || "event_manager", outcome: eligibilityStatus as EligibilityStatus, reasonCode: reasonCode as EligibilityReasonCode, criteria: verifiedCriteria, fingerprint: classification.fingerprint }) };
  const { error } = await (supabase as any).from("event_competition_entries").update({ eligibility_status: eligibilityStatus, metadata }).eq("id", entryId).eq("event_id", eventId);
  if (error) throw new Error(`Could not update entry eligibility: ${error.message}`);
  refresh(eventId);
}

export async function assignCompetitionEntryNumberAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const entryId = text(formData, "entryId");
  const entryNumber = text(formData, "entryNumber");
  if (!eventId || !entryId) throw new Error("Competition entry is required.");
  const { supabase } = await requireEventManager(eventId);
  const { error } = await (supabase as any).from("event_competition_entries").update({ entry_number: entryNumber || null }).eq("id", entryId).eq("event_id", eventId);
  if (error) throw new Error(`Could not assign entry number: ${error.message}`);
  refresh(eventId);
}
