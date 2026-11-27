"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import { ELIGIBILITY_CRITERIA, validateEligibilityDecision, type EligibilityCriterion } from "@/lib/competition/eligibilityGate";
import { EligibilityDecisionError, eligibilityErrorCode, recordEligibilityDecision, type EligibilityErrorCode, type RpcClient } from "@/lib/competition/eligibilityRpc";
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
  if (event.organizer_id) {
    const { data: organizerUser } = await supabase.from("organizer_users").select("role").eq("organizer_id", event.organizer_id).eq("user_id", context.userId).eq("active", true).maybeSingle();
    organizerCanManage = ["organizer_owner", "organizer_admin", "organizer_staff"].includes(organizerUser?.role ?? "");
  }
  if (!context.isPlatformAdmin && !studioCanManage && !organizerCanManage) throw new Error("You do not have permission to manage competition registrations.");
  return { supabase };
}

function refresh(eventId: string) {
  revalidatePath(`/app/events/${eventId}/competition`);
  revalidatePath(`/app/events/${eventId}/competition/registrations`);
  revalidatePath(`/app/events/${eventId}/competition/readiness`);
}

/** A refusal is shown on the registrations page; a thrown server-action message would be hidden in production. */
function refused(eventId: string, code: EligibilityErrorCode): never {
  redirect(`/app/events/${eventId}/competition/registrations?eligibilityError=${code}`);
}

export async function updateCompetitionEntryEligibilityAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const entryId = text(formData, "entryId");
  const eligibilityStatus = text(formData, "eligibilityStatus");
  const reasonCode = text(formData, "reasonCode");
  if (!eventId || !entryId || !ELIGIBILITY.includes(eligibilityStatus)) throw new Error("A valid eligibility decision is required.");
  const { supabase } = await requireEventManager(eventId);
  // OD-03 / OD-18 / R-15: the decision is recorded by the audited database function (actor, role, time, outcome, reason, criteria). No direct table write.
  // OD-02: eligible/waived is refused unless every competitor's STORED date of birth shows 18 or older (fails closed).
  const { data: entry, error: entryError } = await supabase.from("event_competition_entries").select("id").eq("id", entryId).eq("event_id", eventId).maybeSingle();
  if (entryError || !entry) throw new Error("Competition entry not found.");
  // OD-18: which criteria apply is derived from STORED division labels and participant roles, never from the form.
  const classification = await loadEntryRequiredCriteria(supabase, eventId, entryId);
  if (!classification.divisionFound) throw new Error("Competition division not found.");
  const verifiedCriteria = (formData.getAll("criteria") as string[]).map(String).filter((item): item is EligibilityCriterion => (ELIGIBILITY_CRITERIA as readonly string[]).includes(item));
  const participantsAdult = await entryParticipantsAdultVerified(supabase, eventId, entryId);
  const problem = validateEligibilityDecision({ outcome: eligibilityStatus, reasonCode, required: classification.required, verifiedCriteria, participantsAdult });
  if (problem) {
    const code = eligibilityErrorCode({ message: problem });
    refused(eventId, code === "failed" ? "invalid" : code);
  }
  const criteria = eligibilityStatus === "eligible" ? verifiedCriteria : [];
  try {
    await recordEligibilityDecision(supabase as unknown as RpcClient, { entryId, outcome: eligibilityStatus, reasonCode, criteria, requestId: randomUUID() });
  } catch (error) {
    if (error instanceof EligibilityDecisionError) refused(eventId, error.code);
    throw error;
  }
  refresh(eventId);
}

export async function assignCompetitionEntryNumberAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const entryId = text(formData, "entryId");
  const entryNumber = text(formData, "entryNumber");
  if (!eventId || !entryId) throw new Error("Competition entry is required.");
  const { supabase } = await requireEventManager(eventId);
  const { error } = await supabase.from("event_competition_entries").update({ entry_number: entryNumber || null }).eq("id", entryId).eq("event_id", eventId);
  if (error) throw new Error(`Could not assign entry number: ${error.message}`);
  refresh(eventId);
}
