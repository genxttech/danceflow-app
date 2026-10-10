/*
  10D: Simple floor-heat planner (Schedule & Heats).

  Builds a deterministic running order from confirmed, eligible entries:
    division -> first round -> dance/run unit -> scoring heats (capacity, no shared competitor)
    -> numbered floor heats (same music/run context, no shared competitor, soft size target).

  The database is authoritative (public.apply_competition_floor_plan + the deferred integrity triggers in
  20261111090000_phase10d_heats_floor_schedule.sql). This module mirrors its rules so the organizer sees
  the same answers before saving:
    - musicKeyFor mirrors public._comp10d_heat_music_key;
    - analyzeFloorSchedule mirrors public._comp10d_floor_heat_problems.
*/

/** DanceFlow product default, NOT a sanctioning rule; editable per round. */
export const DEFAULT_SCORING_HEAT_CAPACITY = 8;
/** Soft recommendation for entries on the floor at once (warning only, never a blocker). */
export const DEFAULT_FLOOR_RECOMMENDATION = 8;

export const SCHEDULABLE_ENTRY_STATUS = "confirmed";

export const EXCLUSIVE_CONTEST_TYPES = ["showdance", "cabaret", "formation", "team", "spotlight"] as const;
const ROUTINE_MODES = ["routine", "none"];

export type PlannerDivision = { id: string; name: string; contest_id: string; program_id: string; sort_order?: number | null };
export type PlannerContest = { id: string; name: string; contest_type: string; sort_order?: number | null };
export type PlannerRule = { contest_id: string; dance_selection_mode: string };
export type PlannerRound = { id: string; division_id: string; sequence_number: number; round_type: string; configuration?: Record<string, unknown> | null };
export type PlannerDance = { id: string; dance_key: string; name: string };
export type PlannerOffering = { id: string; division_id: string; dance_id: string; sort_order?: number | null; active?: boolean | null };
export type PlannerEntry = { id: string; division_id: string; display_name: string; entry_number: string | null; status: string; eligibility_status: string };
export type PlannerEntryDance = { entry_id: string; division_dance_id: string | null; status: string };
export type PlannerParticipant = { entry_id: string; competitor_id: string; display_name: string };

export type PlannerInput = {
  contests: PlannerContest[];
  divisions: PlannerDivision[];
  rules: PlannerRule[];
  rounds: PlannerRound[];
  dances: PlannerDance[];
  offerings: PlannerOffering[];
  entries: PlannerEntry[];
  entryDances: PlannerEntryDance[];
  participants: PlannerParticipant[];
  floorRecommendation?: number;
};

export type PlannedScoringHeat = {
  divisionId: string;
  roundId: string;
  heatNumber: number;
  name: string;
  danceIds: string[];
  entryIds: string[];
  musicKey: string;
  musicLabel: string;
};

export type PlannedFloorHeat = { number: number; musicKey: string; musicLabel: string; scoringHeats: PlannedScoringHeat[] };

export type FloorPlan = {
  floorHeats: PlannedFloorHeat[];
  notes: string[];
  scheduledEntryCount: number;
  skippedEntryCount: number;
};

export function isSchedulableEntry(entry: Pick<PlannerEntry, "status" | "eligibility_status">) {
  return entry.status === SCHEDULABLE_ENTRY_STATUS && entry.eligibility_status !== "ineligible";
}

export function scoringHeatCapacity(round: Pick<PlannerRound, "configuration"> | null | undefined) {
  const value = Number(round?.configuration?.max_entries_per_heat);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : DEFAULT_SCORING_HEAT_CAPACITY;
}

/**
 * Run/music context of a scoring heat (mirrors public._comp10d_heat_music_key):
 * routines/own music and unknown dances are exclusive (never shared); one dance -> dance:<key>;
 * a prescribed set -> set:<keys>.
 */
export function musicKeyFor(input: { heatKey: string; contestType: string | null | undefined; selectionMode: string | null | undefined; danceKeys: string[] }) {
  const exclusive =
    ROUTINE_MODES.includes(input.selectionMode ?? "") ||
    (EXCLUSIVE_CONTEST_TYPES as readonly string[]).includes(input.contestType ?? "") ||
    input.danceKeys.length === 0;
  if (exclusive) return `exclusive:${input.heatKey}`;
  const keys = input.danceKeys.map((key) => key.trim().toLowerCase());
  return keys.length === 1 ? `dance:${keys[0]}` : `set:${keys.join(",")}`;
}

export function isExclusiveMusic(key: string) {
  return key.startsWith("exclusive:");
}

function byOrder<T extends { sort_order?: number | null; name?: string; id: string }>(left: T, right: T) {
  return (Number(left.sort_order ?? 0) - Number(right.sort_order ?? 0)) || (left.name ?? "").localeCompare(right.name ?? "") || left.id.localeCompare(right.id);
}

function entryOrder(left: PlannerEntry, right: PlannerEntry) {
  const leftNumber = Number(left.entry_number);
  const rightNumber = Number(right.entry_number);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) return leftNumber - rightNumber;
  return left.display_name.localeCompare(right.display_name) || left.id.localeCompare(right.id);
}

/** Deterministic plan for an empty draft version. */
export function buildFloorPlan(input: PlannerInput): FloorPlan {
  const notes: string[] = [];
  const contestById = new Map(input.contests.map((contest) => [contest.id, contest]));
  const modeByContest = new Map(input.rules.map((rule) => [rule.contest_id, rule.dance_selection_mode]));
  const danceById = new Map(input.dances.map((dance) => [dance.id, dance]));
  const offeringById = new Map(input.offerings.map((offering) => [offering.id, offering]));
  const competitorsByEntry = new Map<string, Set<string>>();
  for (const participant of input.participants) {
    const set = competitorsByEntry.get(participant.entry_id) ?? new Set<string>();
    set.add(participant.competitor_id);
    competitorsByEntry.set(participant.entry_id, set);
  }
  const schedulable = input.entries.filter(isSchedulableEntry);
  const skippedEntryCount = input.entries.length - schedulable.length;
  const recommendation = input.floorRecommendation ?? DEFAULT_FLOOR_RECOMMENDATION;

  const divisions = [...input.divisions].sort((left, right) => {
    const leftContest = contestById.get(left.contest_id);
    const rightContest = contestById.get(right.contest_id);
    return (Number(leftContest?.sort_order ?? 0) - Number(rightContest?.sort_order ?? 0))
      || (leftContest?.name ?? "").localeCompare(rightContest?.name ?? "")
      || byOrder(left, right);
  });

  const scoringHeats: Array<PlannedScoringHeat & { competitors: Set<string> }> = [];
  for (const division of divisions) {
    const divisionEntries = schedulable.filter((entry) => entry.division_id === division.id).sort(entryOrder);
    if (divisionEntries.length === 0) continue;
    const round = input.rounds.filter((item) => item.division_id === division.id).sort((left, right) => left.sequence_number - right.sequence_number)[0];
    if (!round) {
      notes.push(`${division.name} has no round yet, so its entries were not scheduled.`);
      continue;
    }
    const contest = contestById.get(division.contest_id);
    const mode = modeByContest.get(division.contest_id) ?? "individual";
    const offerings = input.offerings.filter((item) => item.division_id === division.id && item.active !== false).sort((left, right) => byOrder(left, right));
    const capacity = scoringHeatCapacity(round);

    // Run units: one per dance for per-dance divisions, otherwise one for the whole division.
    const units: Array<{ dances: PlannerDance[]; entries: PlannerEntry[] }> = [];
    if (["individual", "choose_count"].includes(mode) && offerings.length > 0) {
      for (const offering of offerings) {
        const dance = danceById.get(offering.dance_id);
        if (!dance) continue;
        const registered = new Set(
          input.entryDances
            .filter((item) => item.status !== "scratched" && item.division_dance_id && offeringById.get(item.division_dance_id)?.dance_id === dance.id)
            .map((item) => item.entry_id),
        );
        const unitEntries = divisionEntries.filter((entry) => registered.has(entry.id));
        if (unitEntries.length > 0) units.push({ dances: [dance], entries: unitEntries });
      }
    } else {
      const dances = ROUTINE_MODES.includes(mode) ? [] : offerings.map((offering) => danceById.get(offering.dance_id)).filter((dance): dance is PlannerDance => Boolean(dance));
      units.push({ dances, entries: divisionEntries });
    }

    for (const unit of units) {
      // Split by capacity without putting one competitor into the same scoring heat twice.
      const buckets: Array<{ entries: PlannerEntry[]; competitors: Set<string> }> = [];
      const needed = Math.max(1, Math.ceil(unit.entries.length / capacity));
      for (let index = 0; index < needed; index += 1) buckets.push({ entries: [], competitors: new Set() });
      for (const entry of unit.entries) {
        const people = competitorsByEntry.get(entry.id) ?? new Set<string>();
        let bucket = buckets.find((item) => item.entries.length < capacity && ![...people].some((person) => item.competitors.has(person)));
        if (!bucket) {
          bucket = { entries: [], competitors: new Set() };
          buckets.push(bucket);
        }
        bucket.entries.push(entry);
        for (const person of people) bucket.competitors.add(person);
      }
      const nonEmpty = buckets.filter((bucket) => bucket.entries.length > 0);
      const danceLabel = unit.dances.map((dance) => dance.name).join(", ");
      nonEmpty.forEach((bucket, index) => {
        const sameRound = scoringHeats.filter((item) => item.roundId === round.id).length;
        const heatKey = `${division.id}:${round.id}:${sameRound + 1}`;
        const musicKey = musicKeyFor({ heatKey, contestType: contest?.contest_type, selectionMode: mode, danceKeys: unit.dances.map((dance) => dance.dance_key) });
        const base = [division.name, danceLabel].filter(Boolean).join(" — ");
        scoringHeats.push({
          divisionId: division.id,
          roundId: round.id,
          heatNumber: sameRound + 1,
          name: nonEmpty.length > 1 ? `${base} (${index + 1} of ${nonEmpty.length})` : base,
          danceIds: unit.dances.map((dance) => dance.id),
          entryIds: bucket.entries.map((entry) => entry.id),
          musicKey,
          musicLabel: isExclusiveMusic(musicKey) ? "Own music" : danceLabel,
          competitors: bucket.competitors,
        });
      });
    }
  }

  // Pack into the earliest compatible floor heat with no shared competitor and room (soft target).
  const floors: Array<PlannedFloorHeat & { competitors: Set<string>; entryCount: number }> = [];
  for (const heat of scoringHeats) {
    const target = isExclusiveMusic(heat.musicKey)
      ? undefined
      : floors.find((floor) =>
          floor.musicKey === heat.musicKey &&
          floor.entryCount + heat.entryIds.length <= recommendation &&
          ![...heat.competitors].some((person) => floor.competitors.has(person)));
    const floor = target ?? (() => {
      const created = { number: floors.length + 1, musicKey: heat.musicKey, musicLabel: heat.musicLabel, scoringHeats: [], competitors: new Set<string>(), entryCount: 0 };
      floors.push(created);
      return created;
    })();
    const { competitors, ...planned } = heat;
    floor.scoringHeats.push(planned);
    floor.entryCount += heat.entryIds.length;
    for (const person of competitors) floor.competitors.add(person);
  }

  return {
    floorHeats: floors.map((floor) => ({ number: floor.number, musicKey: floor.musicKey, musicLabel: floor.musicLabel, scoringHeats: floor.scoringHeats })),
    notes,
    scheduledEntryCount: new Set(scoringHeats.flatMap((heat) => heat.entryIds)).size,
    skippedEntryCount,
  };
}

/** The payload for public.apply_competition_floor_plan. */
export function toApplyPayload(plan: FloorPlan) {
  return {
    floorHeats: plan.floorHeats.map((floor) => ({
      number: floor.number,
      scoringHeats: floor.scoringHeats.map((heat) => ({
        divisionId: heat.divisionId, roundId: heat.roundId, heatNumber: heat.heatNumber, name: heat.name, danceIds: heat.danceIds, entryIds: heat.entryIds,
      })),
    })),
  };
}

/* ---------------------------------------------------------------- saved schedule analysis */

export type SavedFloorHeat = { id: string; heat_number: number; planned_start_at: string | null };
export type SavedScoringHeat = { id: string; floor_heat_id: string | null; division_id: string; name: string | null; musicKey: string; musicLabel: string };
export type SavedHeatEntry = { heat_id: string; entry_id: string; status: string };

export type FloorHeatProblem =
  | { kind: "competitor_conflict"; competitorId: string; name: string; message: string }
  | { kind: "incompatible_music"; message: string };

export type FloorHeatSummary = {
  floorHeat: SavedFloorHeat;
  scoringHeats: SavedScoringHeat[];
  musicLabel: string;
  entryCount: number;
  competitorCount: number;
  problems: FloorHeatProblem[];
  overRecommendation: boolean;
};

function competitorIndex(participants: PlannerParticipant[]) {
  const byEntry = new Map<string, PlannerParticipant[]>();
  for (const participant of participants) byEntry.set(participant.entry_id, [...(byEntry.get(participant.entry_id) ?? []), participant]);
  return byEntry;
}

/** Problems + counts for each saved floor heat (mirrors public._comp10d_floor_heat_problems). */
export function analyzeFloorSchedule(input: {
  floorHeats: SavedFloorHeat[];
  scoringHeats: SavedScoringHeat[];
  heatEntries: SavedHeatEntry[];
  participants: PlannerParticipant[];
  floorRecommendation?: number;
}): FloorHeatSummary[] {
  const byEntry = competitorIndex(input.participants);
  const recommendation = input.floorRecommendation ?? DEFAULT_FLOOR_RECOMMENDATION;
  return [...input.floorHeats].sort((left, right) => left.heat_number - right.heat_number).map((floorHeat) => {
    const scoringHeats = input.scoringHeats.filter((heat) => heat.floor_heat_id === floorHeat.id);
    const heatIds = new Set(scoringHeats.map((heat) => heat.id));
    const entryIds = [...new Set(input.heatEntries.filter((item) => heatIds.has(item.heat_id) && item.status !== "scratched").map((item) => item.entry_id))];
    const entriesByCompetitor = new Map<string, { name: string; entries: Set<string> }>();
    for (const entryId of entryIds) {
      for (const participant of byEntry.get(entryId) ?? []) {
        const current = entriesByCompetitor.get(participant.competitor_id) ?? { name: participant.display_name, entries: new Set<string>() };
        current.entries.add(entryId);
        entriesByCompetitor.set(participant.competitor_id, current);
      }
    }
    const problems: FloorHeatProblem[] = [];
    for (const [competitorId, item] of entriesByCompetitor) {
      if (item.entries.size > 1) {
        problems.push({ kind: "competitor_conflict", competitorId, name: item.name, message: `${item.name} is dancing in more than one entry in Heat ${floorHeat.heat_number}.` });
      }
    }
    const keys = [...new Set(scoringHeats.map((heat) => heat.musicKey))];
    if (keys.length > 1) {
      problems.push({ kind: "incompatible_music", message: `Heat ${floorHeat.heat_number} mixes ${[...new Set(scoringHeats.map((heat) => heat.musicLabel))].join(" and ")}. Divisions on the floor together must share the same dance or music.` });
    }
    const labels = [...new Set(scoringHeats.map((heat) => heat.musicLabel))];
    return {
      floorHeat,
      scoringHeats,
      musicLabel: labels.join(" / ") || "Empty",
      entryCount: entryIds.length,
      competitorCount: entriesByCompetitor.size,
      problems,
      overRecommendation: entryIds.length > recommendation,
    };
  });
}

export type MoveCheck = { ok: true; warning?: string } | { ok: false; reason: string };

/** Whether a scoring heat can move into a floor heat: hard blockers mirror the database; size is a warning. */
export function checkScoringHeatMove(input: {
  heat: SavedScoringHeat;
  target: SavedFloorHeat;
  scoringHeats: SavedScoringHeat[];
  heatEntries: SavedHeatEntry[];
  participants: PlannerParticipant[];
  floorRecommendation?: number;
}): MoveCheck {
  if (input.heat.floor_heat_id === input.target.id) return { ok: false, reason: "Already in this heat." };
  const others = input.scoringHeats.filter((item) => item.floor_heat_id === input.target.id);
  if (others.length > 0 && (isExclusiveMusic(input.heat.musicKey) || others.some((item) => item.musicKey !== input.heat.musicKey))) {
    return { ok: false, reason: `Heat ${input.target.heat_number} is ${others[0].musicLabel}; ${input.heat.musicLabel} needs its own music.` };
  }
  const byEntry = competitorIndex(input.participants);
  const entriesOf = (heatIds: Set<string>) => input.heatEntries.filter((item) => heatIds.has(item.heat_id) && item.status !== "scratched").map((item) => item.entry_id);
  const movingPeople = new Map<string, string>();
  for (const entryId of entriesOf(new Set([input.heat.id]))) for (const person of byEntry.get(entryId) ?? []) movingPeople.set(person.competitor_id, person.display_name);
  for (const entryId of entriesOf(new Set(others.map((item) => item.id)))) {
    for (const person of byEntry.get(entryId) ?? []) {
      if (movingPeople.has(person.competitor_id)) return { ok: false, reason: `${person.display_name} is already dancing in Heat ${input.target.heat_number}.` };
    }
  }
  const recommendation = input.floorRecommendation ?? DEFAULT_FLOOR_RECOMMENDATION;
  const total = entriesOf(new Set([...others.map((item) => item.id), input.heat.id])).length;
  return total > recommendation ? { ok: true, warning: `Heat ${input.target.heat_number} would have ${total} entries on the floor (recommended ${recommendation}).` } : { ok: true };
}
