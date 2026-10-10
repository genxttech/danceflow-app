import type { SupabaseClient } from "@supabase/supabase-js";
import {
  analyzeFloorSchedule,
  isExclusiveMusic,
  musicKeyFor,
  type PlannerInput,
  type PlannerParticipant,
  type SavedFloorHeat,
  type SavedHeatEntry,
  type SavedScoringHeat,
} from "@/lib/competition/floorPlanner";

/* 10D: bulk loaders for Schedule & Heats (no per-competitor lookups). */

export type ScheduleVersionRow = { id: string; version_number: number; name: string; status: string; published_at: string | null };

export async function loadPlannerInput(supabase: SupabaseClient, eventId: string): Promise<PlannerInput & { roundsById: Map<string, { id: string; name: string; configuration: Record<string, unknown> | null }> }> {
  const [contests, rules, divisions, rounds, dances, offerings, entries, entryDances, participants] = await Promise.all([
    supabase.from("event_competition_contests").select("id, name, contest_type, sort_order").eq("event_id", eventId).neq("status", "cancelled"),
    supabase.from("event_competition_contest_registration_rules").select("contest_id, dance_selection_mode").eq("event_id", eventId),
    supabase.from("event_competition_divisions").select("id, name, contest_id, program_id, sort_order").eq("event_id", eventId).neq("status", "cancelled"),
    supabase.from("event_competition_rounds").select("id, name, division_id, sequence_number, round_type, configuration").eq("event_id", eventId).neq("status", "cancelled"),
    supabase.from("event_competition_dances").select("id, dance_key, name").eq("event_id", eventId),
    supabase.from("event_competition_division_dances").select("id, division_id, dance_id, sort_order, active").eq("event_id", eventId),
    supabase.from("event_competition_entries").select("id, division_id, display_name, entry_number, status, eligibility_status").eq("event_id", eventId),
    supabase.from("event_competition_entry_dances").select("entry_id, division_dance_id, status").eq("event_id", eventId),
    supabase.from("event_competition_entry_participants").select("entry_id, competitor_id, display_name").eq("event_id", eventId),
  ]);
  const failed = [contests, rules, divisions, rounds, dances, offerings, entries, entryDances, participants].find((result) => result.error);
  if (failed?.error) throw new Error(`Could not load competition entries: ${failed.error.message}`);
  const roundRows = (rounds.data ?? []) as Array<{ id: string; name: string; division_id: string; sequence_number: number; round_type: string; configuration: Record<string, unknown> | null }>;
  return {
    contests: contests.data ?? [],
    rules: rules.data ?? [],
    divisions: divisions.data ?? [],
    rounds: roundRows,
    dances: dances.data ?? [],
    offerings: offerings.data ?? [],
    entries: entries.data ?? [],
    entryDances: entryDances.data ?? [],
    participants: (participants.data ?? []) as PlannerParticipant[],
    roundsById: new Map(roundRows.map((round) => [round.id, { id: round.id, name: round.name, configuration: round.configuration }])),
  };
}

export async function loadScheduleVersions(supabase: SupabaseClient, eventId: string) {
  const { data, error } = await supabase
    .from("event_competition_schedule_versions")
    .select("id, version_number, name, status, published_at")
    .eq("event_id", eventId)
    .order("version_number", { ascending: false });
  if (error) throw new Error(`Could not load schedule versions: ${error.message}`);
  return (data ?? []) as ScheduleVersionRow[];
}

/** The version Schedule & Heats works on: the newest draft, else the newest published/live version. */
export function pickWorkingVersion(versions: ScheduleVersionRow[]) {
  return versions.find((version) => version.status === "draft")
    ?? versions.find((version) => ["live", "published"].includes(version.status))
    ?? null;
}

export type FloorScheduleView = Awaited<ReturnType<typeof loadFloorSchedule>>;

export async function loadFloorSchedule(supabase: SupabaseClient, eventId: string, versionId: string) {
  const planner = await loadPlannerInput(supabase, eventId);
  const [floorResult, heatResult] = await Promise.all([
    supabase.from("event_competition_floor_heats").select("id, heat_number, planned_start_at").eq("schedule_version_id", versionId).order("heat_number"),
    supabase.from("event_competition_heats").select("id, floor_heat_id, division_id, round_id, contest_id, name, heat_number, lock_state, schedule_block_id")
      .eq("schedule_version_id", versionId).neq("status", "cancelled"),
  ]);
  if (floorResult.error || heatResult.error) throw new Error(`Could not load the running order: ${(floorResult.error ?? heatResult.error)?.message}`);
  const heats = (heatResult.data ?? []) as Array<{ id: string; floor_heat_id: string | null; division_id: string; round_id: string; contest_id: string | null; name: string | null; heat_number: number; lock_state: string; schedule_block_id: string | null }>;
  const heatIds = heats.map((heat) => heat.id);
  const [danceResult, entryResult] = heatIds.length === 0
    ? [{ data: [], error: null }, { data: [], error: null }]
    : await Promise.all([
        supabase.from("event_competition_heat_dances").select("heat_id, dance_key, dance_label, sequence_number, status").in("heat_id", heatIds),
        supabase.from("event_competition_heat_entries").select("heat_id, entry_id, status").in("heat_id", heatIds),
      ]);
  if (danceResult.error || entryResult.error) throw new Error("Could not load heat details.");

  const divisionById = new Map(planner.divisions.map((division) => [division.id, division]));
  const contestById = new Map(planner.contests.map((contest) => [contest.id, contest]));
  const modeByContest = new Map(planner.rules.map((rule) => [rule.contest_id, rule.dance_selection_mode]));
  const dances = (danceResult.data ?? []) as Array<{ heat_id: string; dance_key: string; dance_label: string; sequence_number: number; status: string }>;
  const scoringHeats: Array<SavedScoringHeat & { round_id: string; lock_state: string; heat_number: number; divisionName: string; roundName: string }> = heats
    .filter((heat) => heat.floor_heat_id)
    .map((heat) => {
      const division = divisionById.get(heat.division_id);
      const contestId = heat.contest_id ?? division?.contest_id ?? "";
      const heatDances = dances.filter((dance) => dance.heat_id === heat.id && dance.status !== "cancelled").sort((left, right) => left.sequence_number - right.sequence_number);
      const musicKey = musicKeyFor({
        heatKey: heat.id,
        contestType: contestById.get(contestId)?.contest_type,
        selectionMode: modeByContest.get(contestId),
        danceKeys: heatDances.map((dance) => dance.dance_key),
      });
      return {
        id: heat.id,
        floor_heat_id: heat.floor_heat_id,
        division_id: heat.division_id,
        round_id: heat.round_id,
        lock_state: heat.lock_state,
        heat_number: heat.heat_number,
        name: heat.name,
        divisionName: division?.name ?? "Division",
        roundName: planner.roundsById.get(heat.round_id)?.name ?? "Round",
        musicKey,
        musicLabel: isExclusiveMusic(musicKey) ? "Own music" : heatDances.map((dance) => dance.dance_label).join(", "),
      };
    });
  const floorHeats = (floorResult.data ?? []) as SavedFloorHeat[];
  const heatEntries = (entryResult.data ?? []) as SavedHeatEntry[];
  const summaries = analyzeFloorSchedule({ floorHeats, scoringHeats, heatEntries, participants: planner.participants });
  return {
    planner,
    floorHeats,
    scoringHeats,
    heatEntries,
    summaries,
    unplacedHeatCount: heats.filter((heat) => !heat.floor_heat_id && !heat.schedule_block_id).length,
    usesTimeBlocks: heats.some((heat) => heat.schedule_block_id),
  };
}
