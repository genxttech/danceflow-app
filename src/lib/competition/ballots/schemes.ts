/**
 * E2: mark-scheme validators per `event_competition_rounds.scoring_method`.
 *
 * Fail-closed rule: a rule is enforced only if it comes from an APPROVED source or from the K1 "Default until
 * decided" column. Every provisional rule carries its K1 decision ID in `PROVISIONAL_RULES` and in the error's
 * `decisionId`, so it can change when the owner decides (docs/competition/engine-spec-*.md on
 * competition-k1-engine-specs). The SQL submit RPC enforces the same rules; the validators here are the shared
 * source for the UI and the unit tests, and the SQL suite pins parity.
 */

export const BALLOT_SCORING_METHODS = ["ordinal_majority", "proficiency_rating", "callback_tally"] as const;
export type BallotScoringMethod = (typeof BALLOT_SCORING_METHODS)[number];

export const PROFICIENCY_SCALE = ["Bronze", "Silver", "Gold"] as const; // S6 studio_simple@3 mark_scheme.scale

export type BallotErrorCode =
  | "COMP_BALLOT_SCHEME_NOT_AVAILABLE"
  | "COMP_BALLOT_SCORING_METHOD_UNSUPPORTED"
  | "COMP_BALLOT_NO_ENTRIES"
  | "COMP_BALLOT_UNKNOWN_ENTRY"
  | "COMP_BALLOT_DUPLICATE_MARK"
  | "COMP_BALLOT_INCOMPLETE"
  | "COMP_BALLOT_ROLE_NOT_ALLOWED"
  | "COMP_BALLOT_MARK_OUT_OF_RANGE"
  | "COMP_BALLOT_JUDGE_TIE"
  | "COMP_BALLOT_MARK_NOT_IN_SCALE";

export type BallotError = {
  code: BallotErrorCode;
  entryId?: string;
  detail: string;
  /** K1 decision whose default produced this refusal; absent for rules that come from approved sources. */
  decisionId?: string;
};

export type RawMark = { entryId: string; role?: string | null; value: unknown };
export type ValidMark = { entryId: string; role: null; value: unknown };

export type BallotValidation = { ok: true; marks: ValidMark[] } | { ok: false; errors: BallotError[] };

/** Every provisional rule and the K1 decision that may change it. Listed in the PR body. */
export const PROVISIONAL_RULES: ReadonlyArray<{
  rule: string;
  decisionId: string;
  scoringMethod: BallotScoringMethod;
  default: string;
}> = [
  { rule: "A judge may not give two entries the same ordinal", decisionId: "D-OM-4", scoringMethod: "ordinal_majority", default: "reject (judge_tie)" },
  { rule: "Every entry ranked 1…N, each value once (N = entries on the ballot's heat)", decisionId: "D-OM-5", scoringMethod: "ordinal_majority", default: "required; partial rankings rejected" },
  { rule: "Ordinal ballots rank the entries of one heat (heat = ballot unit)", decisionId: "X-7", scoringMethod: "ordinal_majority", default: "multi-heat rounds stay unspecified in the engine; ballots are per heat" },
  { rule: "Only Bronze/Silver/Gold; no 'no rating' outcome", decisionId: "D-PR-3", scoringMethod: "proficiency_rating", default: "three bands only; anything else rejected" },
  { rule: "Exactly one rating per assigned entry; every entry required", decisionId: "D-PR-5", scoringMethod: "proficiency_rating", default: "required; partial ballots rejected" },
  { rule: "Callback ballots are refused: mark shape and per-judge count are undecided", decisionId: "D-CT-1/D-CT-2", scoringMethod: "callback_tally", default: "engine not available -> ballots refused" },
];

const PR_DECISIONS = { scale: "D-PR-3", complete: "D-PR-5" } as const;

/**
 * Validate one judge's (or scorer's) ballot for one heat.
 * `expectedEntryIds` = the entries on the heat the ballot covers (server-resolved, never caller-supplied in SQL).
 * Studio marks are per entry (S6 `scored_by: entry`): a role on a mark is refused.
 */
export function validateBallot(input: {
  scoringMethod: string;
  expectedEntryIds: readonly string[];
  marks: readonly RawMark[];
}): BallotValidation {
  const { scoringMethod, expectedEntryIds, marks } = input;

  if (scoringMethod === "callback_tally") {
    return {
      ok: false,
      errors: [
        {
          code: "COMP_BALLOT_SCHEME_NOT_AVAILABLE",
          detail: "Callback ballots are not available until the owner decides the callback mark shape and count.",
          decisionId: "D-CT-1/D-CT-2",
        },
      ],
    };
  }
  if (scoringMethod !== "ordinal_majority" && scoringMethod !== "proficiency_rating") {
    return {
      ok: false,
      errors: [{ code: "COMP_BALLOT_SCORING_METHOD_UNSUPPORTED", detail: `No ballot scheme for scoring method "${scoringMethod}".` }],
    };
  }
  if (expectedEntryIds.length === 0) {
    return { ok: false, errors: [{ code: "COMP_BALLOT_NO_ENTRIES", detail: "The heat has no entries to mark." }] };
  }

  const errors: BallotError[] = [];
  const expected = new Set(expectedEntryIds);
  const seen = new Map<string, unknown>();
  const completeDecision = scoringMethod === "ordinal_majority" ? "D-OM-5" : PR_DECISIONS.complete;

  for (const m of marks) {
    if (m.role !== undefined && m.role !== null) {
      errors.push({ code: "COMP_BALLOT_ROLE_NOT_ALLOWED", entryId: m.entryId, detail: "Studio marks are per entry, not per role." });
      continue;
    }
    if (!expected.has(m.entryId)) {
      errors.push({ code: "COMP_BALLOT_UNKNOWN_ENTRY", entryId: m.entryId, detail: "Entry is not on this heat." });
      continue;
    }
    if (seen.has(m.entryId)) {
      errors.push({ code: "COMP_BALLOT_DUPLICATE_MARK", entryId: m.entryId, detail: "More than one mark for the same entry." });
      continue;
    }
    seen.set(m.entryId, m.value);
  }

  for (const id of expectedEntryIds) {
    if (!seen.has(id)) {
      errors.push({ code: "COMP_BALLOT_INCOMPLETE", entryId: id, detail: "Every entry on the heat needs a mark.", decisionId: completeDecision });
    }
  }

  if (scoringMethod === "ordinal_majority") {
    const n = expectedEntryIds.length;
    const byOrdinal = new Map<number, string[]>();
    for (const [entryId, value] of seen) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > n) {
        errors.push({ code: "COMP_BALLOT_MARK_OUT_OF_RANGE", entryId, detail: `Rank must be a whole number from 1 to ${n}.`, decisionId: "D-OM-5" });
        continue;
      }
      byOrdinal.set(value, [...(byOrdinal.get(value) ?? []), entryId]);
    }
    for (const [ordinal, ids] of byOrdinal) {
      if (ids.length > 1) {
        for (const entryId of ids) {
          errors.push({ code: "COMP_BALLOT_JUDGE_TIE", entryId, detail: `Rank ${ordinal} is given to more than one entry.`, decisionId: "D-OM-4" });
        }
      }
    }
  } else {
    for (const [entryId, value] of seen) {
      if (typeof value !== "string" || !(PROFICIENCY_SCALE as readonly string[]).includes(value)) {
        errors.push({ code: "COMP_BALLOT_MARK_NOT_IN_SCALE", entryId, detail: "Rating must be exactly Bronze, Silver or Gold.", decisionId: PR_DECISIONS.scale });
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, marks: expectedEntryIds.map((entryId) => ({ entryId, role: null, value: seen.get(entryId) })) };
}
