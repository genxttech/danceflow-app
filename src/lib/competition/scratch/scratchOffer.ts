import { classifyPlacements, type PlacementState } from "@/lib/competition/scratch/scratch";

/**
 * Whether a page may OFFER a whole-entry scratch (owner decision 2026-11-26, Option A; DanceFlow Studio/Custom policy).
 * No offer once any heat of the entry has started or finished, carries a danced or disqualified status, or is locked
 * or certified. This only decides whether a link is shown: the scratch page, the server action and the database each
 * decide again. If the placements cannot be read, nothing is offered.
 */

type Result = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
type Query = {
  eq: (column: string, value: string) => Query;
  in: (column: string, values: string[]) => Query;
  order: (column: string) => Query;
  range: (from: number, to: number) => Result;
};
export type ScratchOfferSupabase = { from: (table: string) => { select: (columns: string) => Query } };

/** `left`: entries already scratched or withdrawn (a leftover placement of theirs is not a no-show). */
export type ScratchOffer = { loaded: boolean; blocked: ReadonlySet<string>; left: ReadonlySet<string> };

const PAGE = 1000;

type Heat = { lock_state: string | null; status: string | null };
type PlacementRow = { entry_id: string; status: string; heat: Heat | Heat[] | null };

/** Reads every row: an event can hold more placements than one API response returns. */
async function readAll(query: () => Query): Promise<unknown[] | null> {
  const rows: unknown[] = [];
  for (;;) {
    const { data, error } = await query().order("id").range(rows.length, rows.length + PAGE - 1);
    if (error) return null;
    if (!data || data.length === 0) return rows;
    rows.push(...data);
  }
}

export async function loadScratchOffer(supabase: ScratchOfferSupabase, eventId: string): Promise<ScratchOffer> {
  const [placements, closedEntries] = await Promise.all([
    readAll(() => supabase.from("event_competition_heat_entries").select("entry_id, status, heat:event_competition_heats(lock_state, status)").eq("event_id", eventId)),
    readAll(() => supabase.from("event_competition_entries").select("id, status").eq("event_id", eventId).in("status", ["disqualified", "complete", "scratched", "withdrawn"])),
  ]);
  if (!placements || !closedEntries) return { loaded: false, blocked: new Set(), left: new Set() };

  const closed = closedEntries as { id: string; status: string }[];
  const left = new Set<string>(closed.filter((entry) => entry.status === "scratched" || entry.status === "withdrawn").map((entry) => entry.id));
  const blocked = new Set<string>(closed.filter((entry) => !left.has(entry.id)).map((entry) => entry.id));
  const byEntry = new Map<string, PlacementState[]>();
  for (const row of placements as PlacementRow[]) {
    const heat = Array.isArray(row.heat) ? row.heat[0] : row.heat;
    // An unreadable heat could be on the floor or finished: offer nothing for that entry.
    if (!heat) {
      blocked.add(row.entry_id);
      continue;
    }
    const list = byEntry.get(row.entry_id) ?? [];
    list.push({ heatLockState: heat.lock_state ?? "open", placementStatus: row.status, heatStatus: heat.status });
    byEntry.set(row.entry_id, list);
  }
  for (const [entryId, states] of byEntry) {
    const placementClass = classifyPlacements(states);
    if (placementClass !== "open" && placementClass !== "unplaced") blocked.add(entryId);
  }
  return { loaded: true, blocked, left };
}

export function mayOfferScratch(offer: ScratchOffer, entryId: string): boolean {
  return offer.loaded && !offer.blocked.has(entryId);
}
