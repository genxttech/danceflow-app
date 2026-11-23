import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateEntryOperationalGate, participantsAdultVerified, type EntryGateReason } from "@/lib/competition/eligibilityGate";

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
    supabase.from("event_competition_divisions").select("id, age_label").eq("event_id", eventId),
    supabase.from("event_competition_entry_participants").select("entry_id, competitor_id").eq("event_id", eventId),
    supabase.from("event_competition_competitors").select("id, date_of_birth").eq("event_id", eventId),
  ]);
  const failed = [entryResult, divisionResult, participantResult, competitorResult].find((result) => result.error);
  if (failed?.error) throw new Error("Could not verify entry eligibility.");

  const ageLabelByDivision = new Map((divisionResult.data ?? []).map((row: { id: string; age_label: string | null }) => [row.id, row.age_label]));
  const dobByCompetitor = new Map((competitorResult.data ?? []).map((row: { id: string; date_of_birth: string | null }) => [row.id, row.date_of_birth]));
  const dobsByEntry = new Map<string, Array<string | null>>();
  for (const row of (participantResult.data ?? []) as Array<{ entry_id: string; competitor_id: string | null }>) {
    const list = dobsByEntry.get(row.entry_id) ?? [];
    list.push(row.competitor_id ? (dobByCompetitor.get(row.competitor_id) ?? null) : null);
    dobsByEntry.set(row.entry_id, list);
  }

  const results = new Map<string, EntryGateResult>();
  for (const entry of (entryResult.data ?? []) as Array<{ id: string; division_id: string; status: string; eligibility_status: string; metadata: unknown }>) {
    const gate = evaluateEntryOperationalGate({
      status: entry.status,
      eligibilityStatus: entry.eligibility_status,
      ageLabel: ageLabelByDivision.get(entry.division_id),
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
