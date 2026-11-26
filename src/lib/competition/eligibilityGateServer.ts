import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateEntryOperationalGate, participantsAdultVerified, type EntryGateReason } from "@/lib/competition/eligibilityGate";
import { loadClearanceStates, type RpcClient } from "@/lib/competition/eligibilityRpc";

/*
  OD-03 / OD-02 / R-15: server-side loader for the per-entry operational gate. Reads stored data only (entry status,
  eligibility, the database's clearance state, participants' stored dates of birth).
  Dates of birth are consumed in memory by the pure gate and never returned or logged.
  Fails closed: any load error throws, so callers never fall back to "allowed".
*/

export type EntryGateResult = { entryId: string; ready: boolean; reasons: EntryGateReason[] };

export async function loadEntryOperationalGates(supabase: SupabaseClient, eventId: string, now: Date = new Date()): Promise<Map<string, EntryGateResult>> {
  const [entryResult, participantResult, competitorResult] = await Promise.all([
    supabase.from("event_competition_entries").select("id, status, eligibility_status").eq("event_id", eventId),
    supabase.from("event_competition_entry_participants").select("entry_id, competitor_id").eq("event_id", eventId),
    supabase.from("event_competition_competitors").select("id, date_of_birth").eq("event_id", eventId),
  ]);
  const failed = [entryResult, participantResult, competitorResult].find((result) => result.error);
  if (failed?.error) throw new Error("Could not verify entry eligibility.");

  const dobByCompetitor = new Map((competitorResult.data ?? []).map((row: { id: string; date_of_birth: string | null }) => [row.id, row.date_of_birth]));
  const dobsByEntry = new Map<string, Array<string | null>>();
  for (const row of (participantResult.data ?? []) as Array<{ entry_id: string; competitor_id: string | null }>) {
    const list = dobsByEntry.get(row.entry_id) ?? [];
    list.push(row.competitor_id ? (dobByCompetitor.get(row.competitor_id) ?? null) : null);
    dobsByEntry.set(row.entry_id, list);
  }

  const entries = (entryResult.data ?? []) as Array<{ id: string; status: string; eligibility_status: string }>;
  // Only a confirmed entry already marked eligible or waived can be cleared; the others need no round trip.
  const candidates = entries.filter((entry) => entry.status === "confirmed" && ["eligible", "waived"].includes(entry.eligibility_status)).map((entry) => entry.id);
  const clearance = await loadClearanceStates(supabase as unknown as RpcClient, candidates);

  const results = new Map<string, EntryGateResult>();
  for (const entry of entries) {
    const gate = evaluateEntryOperationalGate({
      status: entry.status,
      eligibilityStatus: entry.eligibility_status,
      clearance: clearance.get(entry.id) ?? "provisional",
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
