/** Shapes returned by competition_round_ballot_status / competition_judge_ballot_sheet (E2 migration 20270102090000). */

export type BallotEntry = { entry_id: string; entry_number: string | null; display_name: string };

export type SheetBallot = {
  ballot_id: string;
  version: number;
  source: "judge_web" | "scorer_paper";
  submitted_at: string;
  marks: Record<string, unknown>;
};

export type JudgeSheet = {
  round: { id: string; name: string; status: string; scoring_method: string };
  judge_letter: string;
  absent: boolean;
  scheme_available: boolean;
  heats: Array<{ heat_id: string; heat_number: number; entries: BallotEntry[]; ballot: SheetBallot | null }>;
};

export type BoardBallot = { heat_id: string; ballot_id: string; version: number; source: string; submitted_at: string };

export type BallotBoard = {
  viewer_role: "manager" | "chair" | "scorer";
  round: { id: string; name: string; status: string; scoring_method: string };
  scheme_available: boolean;
  heats: Array<{ heat_id: string; heat_number: number; lock_state: string; entry_count: number; entries: BallotEntry[] }>;
  judges: Array<{
    official_id: string;
    judge_letter: string;
    official_status: string;
    name: string;
    absent: boolean;
    ballots: BoardBallot[];
  }>;
  blockers: {
    heats: string[];
    heats_not_locked: string[];
    missing_ballots: Array<{ official_id: string; judge_letter: string; heat_id: string }>;
    judges: number;
    judges_present: number;
    ready: boolean;
  };
};

/** What a person can still do to unblock the lock, in plain words. */
export function lockBlockerSummary(board: BallotBoard): string[] {
  const out: string[] = [];
  if (board.blockers.heats.length === 0) out.push("The round has no heat to ballot.");
  if (board.blockers.judges_present === 0) out.push("No judge is present on the panel.");
  if (board.blockers.missing_ballots.length > 0) {
    out.push(`${board.blockers.missing_ballots.length} ballot(s) missing: each present judge needs one per heat, or an absence must be recorded.`);
  }
  if (board.blockers.heats_not_locked.length > 0) out.push(`${board.blockers.heats_not_locked.length} heat(s) not locked yet.`);
  if (!board.scheme_available) out.push("Ballots for this scoring method are not available yet.");
  return out;
}
