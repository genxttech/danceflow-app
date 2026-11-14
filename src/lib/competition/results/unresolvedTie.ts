/**
 * CF1 package B: reads an UNRESOLVED callback tie from a stored result version. Pure, and it never recomputes anything.
 *
 * Owner policy: when a tie at the callback cut-off exceeds the Final's advancement capacity, the version is saved with its scores,
 * every row has `advanced = null`, and nobody is advanced. This module only describes that stored state. It does not pick, order or
 * advance a couple out of the tie.
 *
 * Stored shape (engine contract): each unresolved row's `output` has { tally, callback_rank, tie_status: "above_cut" | "tied_at_cut" | "below_cut" }.
 * The Final's capacity comes from the version's stored evidence (input.finalCapacity). The trace is not read (see deriveUnresolvedTie).
 */
export type StoredResultRow = { entryId: string; label: string; advanced: boolean | null; output: unknown };
export type TieCouple = { entryId: string; label: string; tally: number | null };

export type UnresolvedTie = {
  /** Couples strictly above the cut. */
  aboveCut: TieCouple[];
  tiedAtCut: TieCouple[];
  /** Number of couples tied at the cut-off. */
  count: number | null;
  /** The Final's capacity, from the stored evidence. Null when unknown. */
  capacity: number | null;
  cutTally: number | null;
  /** Always true now that the panel is read from the rows only (kept for the page contract). */
  listsAvailable: boolean;
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function tieStatus(output: unknown): string | null {
  const s = obj(output)?.tie_status;
  return typeof s === "string" ? s : null;
}

function couple(row: StoredResultRow): TieCouple {
  return { entryId: row.entryId, label: row.label, tally: num(obj(row.output)?.tally) };
}

function byTally(a: TieCouple, b: TieCouple) {
  return (b.tally ?? -Infinity) - (a.tally ?? -Infinity) || a.label.localeCompare(b.label);
}

/**
 * Null when the stored version is not an unresolved tie: a row is stored as `tied_at_cut` while no row has an advance decision (advanced is null on
 * every row). Reads VERIFIED data only (security review PV-1-1, owner decision PV-1 2026-11-10): the stored rows, which the database recomputes
 * and compares before storing and again before approving, and the Final's capacity from the stored evidence (built by the database). The
 * caller-authored trace is never read, so a forged trace can neither create nor shape this panel.
 */
export function deriveUnresolvedTie(input: { rows: readonly StoredResultRow[]; finalCapacity: unknown }): UnresolvedTie | null {
  const undecided = input.rows.length > 0 && input.rows.every((r) => r.advanced === null);
  const rowTied = input.rows.filter((r) => tieStatus(r.output) === "tied_at_cut");
  if (!undecided || rowTied.length === 0) return null;
  const tiedAtCut = rowTied.map(couple).sort(byTally);
  const aboveCut = input.rows.filter((r) => tieStatus(r.output) === "above_cut").map(couple).sort(byTally);
  return {
    aboveCut,
    tiedAtCut,
    count: tiedAtCut.length,
    capacity: num(input.finalCapacity),
    cutTally: tiedAtCut[0]?.tally ?? null,
    listsAvailable: true,
  };
}

/** The sentence that says why advancement is unresolved. Generic when the counts are not stored. */
export function unresolvedTieSummary(tie: UnresolvedTie): string {
  const base = "The callback result is saved with its scores, but advancement is unresolved";
  if (tie.count !== null && tie.capacity !== null) {
    return `${base}: ${tie.count} couple${tie.count === 1 ? " is" : "s are"} tied at the cut-off and advancing them all would exceed the Final's capacity of ${tie.capacity}.`;
  }
  return `${base}: a tie at the cut-off would exceed the Final's capacity.`;
}
