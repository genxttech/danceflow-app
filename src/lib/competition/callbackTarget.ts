/**
 * Callback target (target_advancement_count) setup rules for "Callbacks + Final" rounds.
 *
 * Who sets the callback target T, any default for it, and what happens when T is not below the number
 * of entries are OPEN owner decisions (D-CT-5). Nothing here invents a default or a scoring rule: T stays
 * NULL until an organizer enters it, and an unset T is reported as a readiness blocker. This module is
 * setup validation only; it is not a scoring engine and must not import from the results/engine code.
 */

export const CALLBACK_SCORING_METHOD = "callback_tally";

/** OD-21: the smallest callback target that can produce a Final (the Final needs at least two couples). */
export const CALLBACK_TARGET_MINIMUM = 2;
export const CALLBACK_TARGET_BELOW_MINIMUM_CODE = "COMP_CALLBACK_TARGET_BELOW_MINIMUM";
export const CALLBACK_TARGET_EXCEEDS_CAPACITY_CODE = "COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY";

export type CallbackRoundRow = {
  id: string;
  division_id: string;
  name: string;
  round_type: string;
  scoring_method: string;
  target_advancement_count: number | null;
};

export type CallbackDivisionRow = { id: string; name: string; program_id?: string | null };

export function isCallbackRound(round: Pick<CallbackRoundRow, "scoring_method">) {
  return round.scoring_method === CALLBACK_SCORING_METHOD;
}

/** What the organizer sees when a callback target is below the minimum (the database refusal carries the same code). */
export function callbackTargetBelowMinimumMessage(): string {
  return `The callback target must be a whole number of ${CALLBACK_TARGET_MINIMUM} or more: a Final needs at least two couples.`;
}

/** TypeScript twin of the T >= 2 rule of `_cf1_callback_target_check` (CF1 A4a). A null target is allowed (it is set before ballots). */
export function callbackTargetBelowMinimum(target: number | null | undefined): boolean {
  return target != null && target < CALLBACK_TARGET_MINIMUM;
}

/** Twin of `_cf1_callback_target_check(T, capacity)`: the refusal code, or null. The minimum is checked first, as in the database. */
export function callbackTargetCheck(target: number | null | undefined, capacity: number): string | null {
  if (target == null) return null;
  if (target < CALLBACK_TARGET_MINIMUM) return CALLBACK_TARGET_BELOW_MINIMUM_CODE;
  if (target > capacity) return CALLBACK_TARGET_EXCEEDS_CAPACITY_CODE;
  return null;
}

export type CallbackConfigurationRound = {
  id: string;
  division_id: string;
  program_id: string;
  name: string;
  round_type: string;
  sequence_number: number;
  target_advancement_count: number | null;
};

/**
 * The scope of the database guard: a `preliminary` round of a program whose advancement method is `promote_callback`, whose successor
 * (sequence_number + 1, same division) is a `final` round. Final-only divisions, other round types, other programs and rounds without
 * that successor are never in scope, so a target below two there is not a violation.
 */
export function guardedCallbackRounds(args: {
  rounds: CallbackConfigurationRound[];
  promoteCallbackProgramIds: ReadonlySet<string>;
}): CallbackConfigurationRound[] {
  return args.rounds.filter(
    (round) =>
      round.round_type === "preliminary" &&
      args.promoteCallbackProgramIds.has(round.program_id) &&
      args.rounds.some((next) => next.division_id === round.division_id && next.sequence_number === round.sequence_number + 1 && next.round_type === "final"),
  );
}

/** Readiness findings for existing guarded rounds whose target is below two (existing rows are reported, never rewritten). */
export function callbackTargetBelowMinimumFindings(args: {
  rounds: CallbackConfigurationRound[];
  promoteCallbackProgramIds: ReadonlySet<string>;
}): CallbackConfigurationRound[] {
  return guardedCallbackRounds(args).filter((round) => callbackTargetBelowMinimum(round.target_advancement_count));
}

export type CallbackTargetParse = { ok: true; value: number | null } | { ok: false; error: string };

/**
 * Parses an organizer-entered callback target. Blank clears the target (it then blocks readiness again).
 * A value must be a whole number of 2 or more (OD-21) and, once the division has entries, strictly below that entry count.
 * With no entries yet the upper bound cannot be checked here; readiness re-checks it once entries exist.
 */
export function parseCallbackTarget(raw: string, entryCount: number): CallbackTargetParse {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };
  if (!/^[0-9]{1,6}$/.test(text)) return { ok: false, error: callbackTargetBelowMinimumMessage() };
  const value = Number(text);
  if (value < CALLBACK_TARGET_MINIMUM) return { ok: false, error: callbackTargetBelowMinimumMessage() };
  if (entryCount > 0 && value >= entryCount) {
    return { ok: false, error: `The callback target must be below the number of entries in this division (${entryCount}).` };
  }
  return { ok: true, value };
}

export type CallbackFinding = { divisionId: string; divisionName: string; roundId: string; roundName: string; detail: string };

export type CallbackTargetReport = {
  /** Callback rounds whose target is not set: blocks readiness (fail closed). */
  unset: CallbackFinding[];
  /** Callback rounds whose target is not below the division's confirmed entry count: needs organizer review. */
  notBelowEntries: CallbackFinding[];
  /** Callback-program divisions with no callback round and a Final scored "none" (pre-K1 add-division defect). Warning only. */
  unscoredFinals: CallbackFinding[];
};

/**
 * `callbackProgramIds` are programs whose scoring_method is callback_tally. `entriesByDivision` counts the
 * division's confirmed entries. Existing rows are only reported, never rewritten.
 */
export function callbackTargetReport(args: {
  rounds: CallbackRoundRow[];
  divisions: CallbackDivisionRow[];
  callbackProgramIds: ReadonlySet<string>;
  entriesByDivision: ReadonlyMap<string, number>;
}): CallbackTargetReport {
  const divisionName = new Map(args.divisions.map((division) => [division.id, division.name]));
  const finding = (round: CallbackRoundRow, detail: string): CallbackFinding => ({
    divisionId: round.division_id,
    divisionName: divisionName.get(round.division_id) ?? "Division",
    roundId: round.id,
    roundName: round.name,
    detail,
  });
  const report: CallbackTargetReport = { unset: [], notBelowEntries: [], unscoredFinals: [] };

  for (const round of args.rounds.filter(isCallbackRound)) {
    if (round.target_advancement_count == null) {
      report.unset.push(finding(round, "Callback target not set"));
      continue;
    }
    const entries = args.entriesByDivision.get(round.division_id) ?? 0;
    if (entries > 0 && round.target_advancement_count >= entries) {
      report.notBelowEntries.push(finding(round, `Target ${round.target_advancement_count} is not below ${entries} entries`));
    }
  }

  const callbackDivisions = new Set(args.rounds.filter(isCallbackRound).map((round) => round.division_id));
  for (const division of args.divisions) {
    if (!division.program_id || !args.callbackProgramIds.has(division.program_id) || callbackDivisions.has(division.id)) continue;
    const finals = args.rounds.filter((round) => round.division_id === division.id && round.round_type === "final" && round.scoring_method === "none");
    for (const round of finals) report.unscoredFinals.push(finding(round, "Final has no scoring method"));
  }
  return report;
}
