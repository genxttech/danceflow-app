/**
 * E2: canonical ballot serialization.
 *
 * `canonicalJson` is byte-for-byte the K0 algorithm (docs/competition/scoring-results-contract.md §5,
 * `src/lib/competition/results/contract.ts` on branch competition-k0-results-contract): sorted keys, undefined
 * dropped, non-finite numbers refused. K0 is not on main yet, so it is mirrored here; once K0 merges this module
 * should re-export it (a golden test pins the output so the swap is a no-op).
 *
 * No scoring happens here. `currentBallotsToEngineMarks` only reshapes current, non-superseded ballots into the
 * K0 `EngineMark[]` the F1 engines will hash via `canonicalEngineInput`.
 */

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort(cmp);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type BallotMark = { entryId: string; role?: "leader" | "follower" | null; value: unknown };

export type BallotSource = "judge_web" | "scorer_paper";

export type BallotRecord = {
  id: string;
  officialId: string;
  roundId: string;
  heatId: string;
  version: number;
  source: BallotSource;
  supersedesId: string | null;
  marks: BallotMark[];
};

const roleKey = (r: BallotMark["role"]) => r ?? "";

/** Marks sorted by (entry_id, role) so read order never changes the serialization. */
export function sortMarks<T extends BallotMark>(marks: readonly T[]): T[] {
  return [...marks].sort((a, b) => cmp(a.entryId, b.entryId) || cmp(roleKey(a.role), roleKey(b.role)));
}

/**
 * Canonical string of one ballot's content. Identity fields (id, supersedes, timestamps, submitter) are excluded on
 * purpose: two ballots with the same official/round/heat/version/source/marks serialize identically.
 */
export function canonicalBallot(
  b: Pick<BallotRecord, "officialId" | "roundId" | "heatId" | "version" | "source" | "marks">,
): string {
  return canonicalJson({
    official_id: b.officialId,
    round_id: b.roundId,
    heat_id: b.heatId,
    version: b.version,
    source: b.source,
    marks: sortMarks(b.marks).map((m) => ({ entry_id: m.entryId, role: m.role ?? null, value: m.value })),
  });
}

/** Current ballot per (official, heat): the version that nothing supersedes. */
export function currentBallots(ballots: readonly BallotRecord[]): BallotRecord[] {
  const superseded = new Set(ballots.map((b) => b.supersedesId).filter((x): x is string => !!x));
  return ballots.filter((b) => !superseded.has(b.id));
}

/** Reshape current ballots into K0 EngineMark[] (the engine input marks). Superseded versions are never input. */
export function currentBallotsToEngineMarks(ballots: readonly BallotRecord[]) {
  return currentBallots(ballots).flatMap((b) =>
    b.marks.map((m) => ({ officialId: b.officialId, entryId: m.entryId, role: m.role ?? null, value: m.value })),
  );
}
