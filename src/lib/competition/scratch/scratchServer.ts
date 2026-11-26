import {
  classifyPlacements,
  hasOpenPlacement,
  isAlreadyScratched,
  normalizeReason,
  SCRATCH_FEE_HANDLING,
  SCRATCH_RPC,
  SCRATCH_STATUS,
  scratchConsistent,
  scratchErrorCode,
  scratchPreflight,
  type ScratchRefusal,
} from "@/lib/competition/scratch/scratch";

/**
 * SC1: the one scratch writer. `supabase` MUST be the signed-in user's client (createClient from
 * @/lib/supabase/server), never a service-role client: the lifecycle RPC checks
 * can_manage_event_competition(auth.uid()) itself (SECURITY INVOKER on the live line). Nothing here writes a table directly.
 */

type Rows<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
type One<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>;
type Query<T> = { eq: (c: string, v: string) => Query<T> } & Rows<T> & { maybeSingle: () => One<T> };

export type ScratchSupabase = {
  from: (table: string) => { select: (columns: string) => Query<unknown> };
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export type ScratchOutcome =
  | { ok: true; outcome: "scratched" | "already_scratched" | "already_withdrawn" }
  | { ok: false; code: ScratchRefusal | "COMP_SC1_UNAUDITED" | "COMP_SC1_UNKNOWN" };

type HeatEntryRow = { status: string; heat: { lock_state: string | null; status: string | null } | { lock_state: string | null; status: string | null }[] | null };

async function loadHeatEntries(supabase: ScratchSupabase, eventId: string, entryId: string) {
  const result = await supabase
    .from("event_competition_heat_entries")
    .select("status, heat:event_competition_heats(lock_state, status)")
    .eq("entry_id", entryId)
    .eq("event_id", eventId);
  return { rows: (result.data ?? []) as HeatEntryRow[], error: result.error };
}

function placementStates(rows: HeatEntryRow[]) {
  return rows.map((row) => {
    const heat = Array.isArray(row.heat) ? row.heat[0] : row.heat;
    return { heatLockState: heat?.lock_state ?? "open", placementStatus: row.status, heatStatus: heat?.status ?? null };
  });
}

export async function performScratch(
  supabase: ScratchSupabase,
  input: { eventId: string; entryId: string; reason: string | null | undefined },
): Promise<ScratchOutcome> {
  const reason = normalizeReason(input.reason);
  const entryResult = await supabase
    .from("event_competition_entries")
    .select("id, status")
    .eq("id", input.entryId)
    .eq("event_id", input.eventId)
    .maybeSingle();
  const entry = entryResult.data as { id: string; status: string } | null;
  if (entryResult.error || !entry) return { ok: false, code: "COMP_SC1_NOT_FOUND" };

  const before = await loadHeatEntries(supabase, input.eventId, input.entryId);
  if (before.error) return { ok: false, code: "COMP_SC1_UNKNOWN" };
  // Replay / double submit (sequential): an entry that is already out is never sent to the RPC again. On the live (June) RPC a
  // repeat call overwrites the recorded reason and time with no new audit row, so even an entry with heat placements left
  // behind is reported for correction instead of being re-written here.
  if (isAlreadyScratched(entry.status)) {
    if (hasOpenPlacement(before.rows.map((row) => row.status))) return { ok: false, code: "COMP_SC1_STRANDED" };
    return { ok: true, outcome: entry.status === "withdrawn" ? "already_withdrawn" : "already_scratched" };
  }
  if (!reason) return { ok: false, code: "COMP_SC1_REASON_REQUIRED" };
  const decision = scratchPreflight({ entryStatus: entry.status, placementClass: classifyPlacements(placementStates(before.rows)) });
  if (!decision.allowed) return { ok: false, code: decision.code };

  const { error } = await supabase.rpc(SCRATCH_RPC, {
    selected_entry_id: input.entryId,
    selected_status: SCRATCH_STATUS,
    selected_reason: reason,
    selected_fee_handling: SCRATCH_FEE_HANDLING,
  });
  if (error) return { ok: false, code: scratchErrorCode(error.message) };

  // Read-back: parent entry scratched and no heat entry left scheduled / checked in.
  const [after, afterEntry] = await Promise.all([
    loadHeatEntries(supabase, input.eventId, input.entryId),
    supabase.from("event_competition_entries").select("id, status").eq("id", input.entryId).eq("event_id", input.eventId).maybeSingle(),
  ]);
  const afterStatus = (afterEntry.data as { status: string } | null)?.status;
  if (after.error || afterEntry.error || !scratchConsistent(afterStatus, after.rows.map((row) => row.status))) {
    return { ok: false, code: "COMP_SC1_INCONSISTENT" };
  }
  return { ok: true, outcome: "scratched" };
}
