import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateEntryOperationalGate, participantsAdultVerified, requiredCriteria, type EligibilityCriterion, type EntryGateReason } from "@/lib/competition/eligibilityGate";

/*
  OD-03 / OD-02: server-side loader for the per-entry operational gate. Reads stored data only (entry status,
  eligibility, organizer determination in entry metadata, division age label, participants' stored dates of birth).
  Dates of birth are consumed in memory by the pure gate and never returned or logged.
  Fails closed: any load error throws, so callers never fall back to "allowed".
*/

export type EntryGateResult = { entryId: string; ready: boolean; reasons: EntryGateReason[] };

export async function loadEntryOperationalGates(supabase: SupabaseClient, eventId: string, now: Date = new Date()): Promise<Map<string, EntryGateResult>> {
  const [entryResult, divisionResult, participantResult, competitorResult] = await Promise.all([
    supabase.from("event_competition_entries").select("id, division_id, status, eligibility_status, metadata").eq("event_id", eventId),
    supabase.from("event_competition_divisions").select("id, age_label, skill_label").eq("event_id", eventId),
    supabase.from("event_competition_entry_participants").select("entry_id, competitor_id, participant_role").eq("event_id", eventId),
    supabase.from("event_competition_competitors").select("id, date_of_birth").eq("event_id", eventId),
  ]);
  const failed = [entryResult, divisionResult, participantResult, competitorResult].find((result) => result.error);
  if (failed?.error) throw new Error("Could not verify entry eligibility.");

  const labelsByDivision = new Map((divisionResult.data ?? []).map((row: { id: string; age_label: string | null; skill_label: string | null }) => [row.id, row]));
  const rolesByEntry = new Map<string, string[]>();
  const dobByCompetitor = new Map((competitorResult.data ?? []).map((row: { id: string; date_of_birth: string | null }) => [row.id, row.date_of_birth]));
  const dobsByEntry = new Map<string, Array<string | null>>();
  for (const row of (participantResult.data ?? []) as Array<{ entry_id: string; competitor_id: string | null; participant_role: string }>) {
    rolesByEntry.set(row.entry_id, [...(rolesByEntry.get(row.entry_id) ?? []), row.participant_role]);
    const list = dobsByEntry.get(row.entry_id) ?? [];
    list.push(row.competitor_id ? (dobByCompetitor.get(row.competitor_id) ?? null) : null);
    dobsByEntry.set(row.entry_id, list);
  }

  const results = new Map<string, EntryGateResult>();
  for (const entry of (entryResult.data ?? []) as Array<{ id: string; division_id: string; status: string; eligibility_status: string; metadata: unknown }>) {
    const gate = evaluateEntryOperationalGate({
      status: entry.status,
      eligibilityStatus: entry.eligibility_status,
      ageLabel: labelsByDivision.get(entry.division_id)?.age_label,
      skillLabel: labelsByDivision.get(entry.division_id)?.skill_label,
      participantRoles: rolesByEntry.get(entry.id) ?? [],
      metadata: entry.metadata,
      participantDobs: dobsByEntry.get(entry.id) ?? [],
    }, now);
    results.set(entry.id, { entryId: entry.id, ...gate });
  }
  return results;
}

/** Stored-data adult check for one entry (used when an organizer records a decision). Fails closed. */
export async function entryParticipantsAdultVerified(supabase: SupabaseClient, eventId: string, entryId: string, now: Date = new Date()): Promise<boolean> {
  const { data: participants, error } = await supabase.from("event_competition_entry_participants").select("competitor_id").eq("event_id", eventId).eq("entry_id", entryId);
  if (error) throw new Error("Could not verify entry eligibility.");
  const ids = (participants ?? []).map((row: { competitor_id: string | null }) => row.competitor_id);
  if (ids.length === 0 || ids.some((id) => !id)) return false;
  const { data: competitors, error: competitorError } = await supabase.from("event_competition_competitors").select("id, date_of_birth").eq("event_id", eventId).in("id", ids as string[]);
  if (competitorError) throw new Error("Could not verify entry eligibility.");
  const dobById = new Map((competitors ?? []).map((row: { id: string; date_of_birth: string | null }) => [row.id, row.date_of_birth]));
  return participantsAdultVerified(ids.map((id) => dobById.get(id as string) ?? null), now);
}

/** Stored-data classification for one entry: which criteria an organizer must verify (per-division applicability). */
export async function loadEntryRequiredCriteria(supabase: SupabaseClient, eventId: string, entryId: string): Promise<{ divisionFound: boolean; required: EligibilityCriterion[] }> {
  const { data: entry, error } = await supabase.from("event_competition_entries").select("division_id").eq("id", entryId).eq("event_id", eventId).maybeSingle();
  if (error) throw new Error("Could not verify entry eligibility.");
  if (!entry) return { divisionFound: false, required: [] };
  const [divisionResult, participantResult] = await Promise.all([
    supabase.from("event_competition_divisions").select("age_label, skill_label").eq("id", entry.division_id).eq("event_id", eventId).maybeSingle(),
    supabase.from("event_competition_entry_participants").select("participant_role").eq("event_id", eventId).eq("entry_id", entryId),
  ]);
  if (divisionResult.error || participantResult.error) throw new Error("Could not verify entry eligibility.");
  const division = divisionResult.data as { age_label: string | null; skill_label: string | null } | null;
  if (!division) return { divisionFound: false, required: [] };
  return { divisionFound: true, required: requiredCriteria({ ageLabel: division.age_label, skillLabel: division.skill_label, participantRoles: ((participantResult.data ?? []) as Array<{ participant_role: string }>).map((row) => row.participant_role) }) };
}
