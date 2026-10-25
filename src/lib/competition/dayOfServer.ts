import type { SupabaseClient } from "@supabase/supabase-js";
import { buildDayOfFloorHeats, type DayOfHeatInput } from "@/lib/competition/dayOf";

/* O1: read model for the day-of console (manager RLS applies; one query per table, no per-row lookups). */

export async function loadDayOf(supabase: SupabaseClient, eventId: string) {
  const { data: versions, error: versionError } = await supabase
    .from("event_competition_schedule_versions")
    .select("id, version_number, name, status, published_at")
    .eq("event_id", eventId)
    .in("status", ["published", "live"])
    .order("published_at", { ascending: false })
    .limit(1);
  if (versionError) throw new Error(`Could not load the running order: ${versionError.message}`);
  const version = versions?.[0] ?? null;

  const roundsResult = await supabase
    .from("event_competition_rounds")
    .select("id, name, round_type, sequence_number, status, division_id")
    .eq("event_id", eventId)
    .order("sequence_number");
  const divisionsResult = await supabase.from("event_competition_divisions").select("id, name").eq("event_id", eventId);
  if (roundsResult.error || divisionsResult.error) throw new Error("Could not load rounds.");
  const rounds = roundsResult.data ?? [];
  const divisionName = new Map((divisionsResult.data ?? []).map((division) => [division.id as string, division.name as string]));

  if (!version) return { version: null, rounds, divisionName, floorHeats: [], heatsByFloor: new Map<string, ScoringRow[]>(), entriesByHeat: new Map<string, EntryRow[]>() };

  const [floorResult, heatResult] = await Promise.all([
    supabase.from("event_competition_floor_heats").select("id, heat_number").eq("schedule_version_id", version.id).order("heat_number"),
    supabase.from("event_competition_heats").select("id, floor_heat_id, round_id, division_id, name, status, lock_state")
      .eq("schedule_version_id", version.id).neq("status", "cancelled"),
  ]);
  if (floorResult.error || heatResult.error) throw new Error("Could not load the running order.");
  const heats = (heatResult.data ?? []) as ScoringRow[];
  const heatIds = heats.map((heat) => heat.id);
  const entriesByHeat = new Map<string, EntryRow[]>();
  if (heatIds.length > 0) {
    const entryResult = await supabase.from("event_competition_heat_entries").select("heat_id, entry_id, status, floor_order").in("heat_id", heatIds).neq("status", "scratched");
    if (entryResult.error) throw new Error("Could not load heat entries.");
    const entryRows = entryResult.data ?? [];
    const ids = Array.from(new Set(entryRows.map((row) => row.entry_id as string)));
    const entryInfo = ids.length === 0
      ? { data: [] as Array<{ id: string; display_name: string; entry_number: string | null }> }
      : await supabase.from("event_competition_entries").select("id, display_name, entry_number").in("id", ids);
    const info = new Map((entryInfo.data ?? []).map((entry) => [entry.id, entry]));
    for (const row of entryRows) {
      const entry = info.get(row.entry_id as string);
      const list = entriesByHeat.get(row.heat_id as string) ?? [];
      list.push({ entryId: row.entry_id as string, name: entry?.display_name ?? "Entry", number: entry?.entry_number ?? null, order: (row.floor_order as number | null) ?? 0 });
      entriesByHeat.set(row.heat_id as string, list);
    }
    for (const list of entriesByHeat.values()) list.sort((a, b) => a.order - b.order);
  }

  const heatsByFloor = new Map<string, ScoringRow[]>();
  for (const heat of heats) {
    if (!heat.floor_heat_id) continue;
    heatsByFloor.set(heat.floor_heat_id, [...(heatsByFloor.get(heat.floor_heat_id) ?? []), heat]);
  }
  const inputs: DayOfHeatInput[] = heats.filter((heat) => heat.floor_heat_id).map((heat) => ({
    id: heat.id, floorHeatId: heat.floor_heat_id as string, roundId: heat.round_id, status: heat.status, lockState: heat.lock_state,
  }));
  return { version, rounds, divisionName, floorHeats: buildDayOfFloorHeats(floorResult.data ?? [], inputs), heatsByFloor, entriesByHeat };
}

export type ScoringRow = { id: string; floor_heat_id: string | null; round_id: string; division_id: string; name: string | null; status: string; lock_state: string };
export type EntryRow = { entryId: string; name: string; number: string | null; order: number };
