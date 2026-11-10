import { describe, expect, it } from "vitest";
import { deriveUnresolvedTie, unresolvedTieSummary, type StoredResultRow } from "../unresolvedTie";

/**
 * CF1 B unresolved callback tie, read from VERIFIED data only (security review PV-1-1, 2026-11-10): the stored rows (which the database recomputes
 * and compares, PV-1) and the stored evidence's finalCapacity (built by the database). The caller-authored trace is never read, so a forged trace
 * can neither create nor shape the panel.
 */
const row = (id: string, tally: number, tie_status: string | null, advanced: boolean | null = null): StoredResultRow => ({
  entryId: id,
  label: `#${id} Couple ${id}`,
  advanced,
  output: tie_status ? { tally, callback_rank: 1, tie_status } : { tally },
});
const rows = [row("1", 7, "above_cut"), row("2", 6, "above_cut"), row("3", 6, "above_cut"), row("4", 5, "tied_at_cut"), row("5", 5, "tied_at_cut"), row("6", 5, "tied_at_cut"), row("7", 2, "below_cut")];

describe("deriveUnresolvedTie", () => {
  it("lists couples above the cut and tied at the cut from the stored rows, capacity from the stored evidence", () => {
    const tie = deriveUnresolvedTie({ rows, finalCapacity: 4 })!;
    expect(tie.aboveCut.map((c) => c.entryId)).toEqual(["1", "2", "3"]);
    expect(tie.tiedAtCut.map((c) => c.entryId)).toEqual(["4", "5", "6"]);
    expect(tie.tiedAtCut[0].tally).toBe(5);
    expect(tie.count).toBe(3);
    expect(tie.capacity).toBe(4);
    expect(tie.cutTally).toBe(5);
    expect(tie.listsAvailable).toBe(true);
    expect(unresolvedTieSummary(tie)).toBe(
      "The callback result is saved with its scores, but advancement is unresolved: 3 couples are tied at the cut-off and advancing them all would exceed the Final's capacity of 4.",
    );
  });

  it("an unknown capacity in the evidence gives the generic sentence", () => {
    const tie = deriveUnresolvedTie({ rows, finalCapacity: null })!;
    expect(tie.capacity).toBeNull();
    expect(unresolvedTieSummary(tie)).toContain("unresolved: a tie at the cut-off");
  });

  it("a forged trace cannot create the panel: ordinary decided rows are never unresolved, whatever a trace would say", () => {
    // The old reader trusted a trace step { step: "cut", outcome: "blocked_tie_over_capacity" }; the new signature has no trace at all.
    const decided = [row("1", 7, null, true), row("2", 3, null, false)];
    expect(deriveUnresolvedTie({ rows: decided, finalCapacity: 2 })).toBeNull();
    expect(deriveUnresolvedTie({ rows: [], finalCapacity: 4 })).toBeNull();
    expect(deriveUnresolvedTie({ rows, trace: [{ step: "cut", outcome: "blocked_tie_over_capacity", data: { finalCapacity: 99 } }], finalCapacity: 4 } as never)!.capacity).toBe(4);
  });

  it("rows without tie_status are not an unresolved tie (the engine always writes tie_status on unresolved rows)", () => {
    const plain = ["1", "2", "3"].map((id) => row(id, 5, null));
    expect(deriveUnresolvedTie({ rows: plain, finalCapacity: 2 })).toBeNull();
  });

  it("does not call it unresolved when a tied row already has an advance decision", () => {
    expect(deriveUnresolvedTie({ rows: [row("1", 5, "tied_at_cut", true), row("2", 5, "tied_at_cut", false)], finalCapacity: 1 })).toBeNull();
  });

  it("tolerates odd shapes: a non-numeric capacity is unknown, a row without output has no tally", () => {
    const tie = deriveUnresolvedTie({ rows: [{ entryId: "1", label: "A", advanced: null, output: { tie_status: "tied_at_cut" } }], finalCapacity: "4" as never })!;
    expect(tie.capacity).toBeNull();
    expect(tie.tiedAtCut[0].tally).toBeNull();
    expect(tie.cutTally).toBeNull();
  });
});
