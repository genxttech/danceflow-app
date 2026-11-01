/**
 * CF1 B5/B6: which Final rounds get a "set the Final's heat size" control on the schedule screen before the Final has a heat.
 * Pure selection only. set_competition_round_heat_capacity stays the authority (reason, round and heat state, callback freeze, F1, range).
 */
import { scoringHeatCapacity } from "./floorPlanner";

export type FinalCapacityRound = {
  id: string;
  name: string;
  division_id: string;
  sequence_number: number;
  round_type: string;
  scoring_method: string | null;
  status: string;
  configuration: Record<string, unknown> | null;
  target_advancement_count?: number | null;
};

export type FinalCapacityTarget = { roundId: string; name: string; capacity: number; callbackStatus: string; callbackTarget: number | null };

/** The callback round is "under way" once it leaves draft/scheduled/active; the database then refuses (frozen) except the F1 raise. */
export function finalCapacityTargets(rounds: readonly FinalCapacityRound[], roundIdsWithHeats: ReadonlySet<string>): FinalCapacityTarget[] {
  const out: FinalCapacityTarget[] = [];
  for (const round of rounds) {
    if (round.round_type !== "final" || !["draft", "scheduled"].includes(round.status) || roundIdsWithHeats.has(round.id)) continue;
    const source = rounds.find(
      (candidate) =>
        candidate.division_id === round.division_id &&
        candidate.sequence_number === round.sequence_number - 1 &&
        candidate.round_type === "preliminary" &&
        candidate.scoring_method === "callback_tally",
    );
    if (!source) continue;
    out.push({
      roundId: round.id,
      name: round.name,
      capacity: scoringHeatCapacity(round),
      callbackStatus: source.status,
      callbackTarget: typeof source.target_advancement_count === "number" ? source.target_advancement_count : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
