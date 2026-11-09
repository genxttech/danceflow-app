/**
 * CF1 package B: reads an UNRESOLVED callback tie from a stored result version. Pure, and it never recomputes anything.
 *
 * Owner policy: when a tie at the callback cut-off exceeds the Final's advancement capacity, the version is saved with its scores,
 * every row has `advanced = null`, and nobody is advanced. This module only describes that stored state. It does not pick, order or
 * advance a couple out of the tie.
 *
 * Stored shape (engine contract): each row's `output` has { tally, callback_rank, tie_status: "above_cut" | "tied_at_cut" | "below_cut" };
 * the version trace holds a step { step: "cut", outcome: "blocked_tie_over_capacity", data: { cutTally, target, finalCapacity,
 * advancingIfAllTied, tiedAtCut, aboveCut, unresolved: true } }. `tiedAtCut` / `aboveCut` in the trace may be a count or a list of entry ids.
 */
export type StoredResultRow = { entryId: string; label: string; advanced: boolean | null; output: unknown };
export type TieCouple = { entryId: string; label: string; tally: number | null };

export type UnresolvedTie = {
  /** Couples strictly above the cut. Empty when neither the rows nor the trace name them. */
  aboveCut: TieCouple[];
  tiedAtCut: TieCouple[];
  /** Number of couples tied at the cut-off (list length, or the trace count when there is no list). Null when unknown. */
  count: number | null;
  /** The Final's capacity, from the trace. Null when unknown. */
  capacity: number | null;
  cutTally: number | null;
  /** False when neither rows nor trace named the couples: the page then shows the generic message without lists. */
  listsAvailable: boolean;
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The "cut" step of a trace, tolerant of the step name living under `step`, `name`, `id` or `kind`. */
export function findCutStep(trace: unknown): { outcome: string | null; data: Record<string, unknown> } | null {
  if (!Array.isArray(trace)) return null;
  for (const item of trace) {
    const s = obj(item);
    if (!s) continue;
    if (![s.step, s.name, s.id, s.kind].includes("cut")) continue;
    return { outcome: typeof s.outcome === "string" ? s.outcome : null, data: obj(s.data) ?? {} };
  }
  return null;
}

function tieStatus(output: unknown): string | null {
  const s = obj(output)?.tie_status;
  return typeof s === "string" ? s : null;
}

function couple(row: StoredResultRow): TieCouple {
  return { entryId: row.entryId, label: row.label, tally: num(obj(row.output)?.tally) };
}

/** Trace lists may hold entry ids or { entry_id } objects. Returns null when the value is not a list. */
function traceIds(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const ids: string[] = [];
  for (const item of v) {
    if (typeof item === "string") ids.push(item);
    else {
      const o = obj(item);
      const id = o?.entry_id ?? o?.entryId;
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

function byTally(a: TieCouple, b: TieCouple) {
  return (b.tally ?? -Infinity) - (a.tally ?? -Infinity) || a.label.localeCompare(b.label);
}

/**
 * Null when the stored version is not an unresolved tie. Unresolved means the trace's cut step says so, or a row is stored as
 * `tied_at_cut` while no row has an advance decision (advanced is null on every row).
 */
export function deriveUnresolvedTie(input: { rows: readonly StoredResultRow[]; trace: unknown }): UnresolvedTie | null {
  const cut = findCutStep(input.trace);
  const traceSays = cut?.outcome === "blocked_tie_over_capacity" || cut?.data.unresolved === true;
  const undecided = input.rows.length > 0 && input.rows.every((r) => r.advanced === null);
  const rowTied = input.rows.filter((r) => tieStatus(r.output) === "tied_at_cut");
  if (!traceSays && !(undecided && rowTied.length > 0)) return null;

  const data = cut?.data ?? {};
  let tiedAtCut: TieCouple[] = [];
  let aboveCut: TieCouple[] = [];
  const anyStatus = input.rows.some((r) => tieStatus(r.output) !== null);
  if (anyStatus) {
    tiedAtCut = rowTied.map(couple).sort(byTally);
    aboveCut = input.rows.filter((r) => tieStatus(r.output) === "above_cut").map(couple).sort(byTally);
  } else {
    // No tie_status on the rows: fall back to the lists the trace names, matched to the saved rows.
    const find = (ids: string[] | null) =>
      (ids ?? []).map((id) => input.rows.find((r) => r.entryId === id)).filter((r): r is StoredResultRow => !!r).map(couple).sort(byTally);
    tiedAtCut = find(traceIds(data.tiedAtCut));
    aboveCut = find(traceIds(data.aboveCut));
  }
  const count = tiedAtCut.length > 0 ? tiedAtCut.length : num(data.tiedAtCut);
  return {
    aboveCut,
    tiedAtCut,
    count,
    capacity: num(data.finalCapacity),
    cutTally: num(data.cutTally),
    listsAvailable: tiedAtCut.length > 0,
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
