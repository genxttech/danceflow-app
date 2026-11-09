import { describe, expect, it } from "vitest";
import { deriveUnresolvedTie, findCutStep, unresolvedTieSummary, type StoredResultRow } from "../unresolvedTie";

const cutTrace = (data: Record<string, unknown> = {}, outcome = "blocked_tie_over_capacity") => [
  { step: "tally", outcome: "ok", data: {} },
  { step: "cut", outcome, data: { cutTally: 5, target: 4, finalCapacity: 4, advancingIfAllTied: 6, tiedAtCut: 3, aboveCut: 3, unresolved: true, ...data } },
];
const row = (id: string, tally: number, tie_status: string | null, advanced: boolean | null = null): StoredResultRow => ({
  entryId: id,
  label: `#${id} Couple ${id}`,
  advanced,
  output: tie_status ? { tally, callback_rank: 1, tie_status } : { tally },
});
const rows = [row("1", 7, "above_cut"), row("2", 6, "above_cut"), row("3", 6, "above_cut"), row("4", 5, "tied_at_cut"), row("5", 5, "tied_at_cut"), row("6", 5, "tied_at_cut"), row("7", 2, "below_cut")];

describe("deriveUnresolvedTie", () => {
  it("lists couples above the cut and tied at the cut from the stored rows", () => {
    const tie = deriveUnresolvedTie({ rows, trace: cutTrace() })!;
    expect(tie.aboveCut.map((c) => c.entryId)).toEqual(["1", "2", "3"]);
    expect(tie.tiedAtCut.map((c) => c.entryId)).toEqual(["4", "5", "6"]);
    expect(tie.tiedAtCut[0].tally).toBe(5);
    expect(tie.count).toBe(3);
    expect(tie.capacity).toBe(4);
    expect(tie.listsAvailable).toBe(true);
    expect(unresolvedTieSummary(tie)).toBe(
      "The callback result is saved with its scores, but advancement is unresolved: 3 couples are tied at the cut-off and advancing them all would exceed the Final's capacity of 4.",
    );
  });
  it("works from the rows alone when the trace is missing", () => {
    const tie = deriveUnresolvedTie({ rows, trace: null })!;
    expect(tie.count).toBe(3);
    expect(tie.capacity).toBeNull();
    expect(unresolvedTieSummary(tie)).toContain("unresolved: a tie at the cut-off");
  });
  it("falls back to trace id lists when rows have no tie_status", () => {
    const plain = ["1", "2", "3", "4", "5", "6", "7"].map((id) => row(id, 5, null));
    const tie = deriveUnresolvedTie({ rows: plain, trace: cutTrace({ tiedAtCut: ["4", { entry_id: "5" }, "missing"], aboveCut: ["1"] }) })!;
    expect(tie.tiedAtCut.map((c) => c.entryId)).toEqual(["4", "5"]);
    expect(tie.aboveCut.map((c) => c.entryId)).toEqual(["1"]);
    expect(tie.count).toBe(2);
  });
  it("gives a generic result without lists when only counts are stored", () => {
    const plain = ["1", "2"].map((id) => row(id, 5, null));
    const tie = deriveUnresolvedTie({ rows: plain, trace: cutTrace() })!;
    expect(tie.listsAvailable).toBe(false);
    expect(tie.aboveCut).toEqual([]);
    expect(tie.count).toBe(3);
    expect(tie.capacity).toBe(4);
  });
  it("is generic when neither rows nor trace carry details", () => {
    const tie = deriveUnresolvedTie({ rows: [], trace: [{ step: "cut", outcome: "blocked_tie_over_capacity" }] })!;
    expect(tie.listsAvailable).toBe(false);
    expect(tie.count).toBeNull();
    expect(unresolvedTieSummary(tie)).toBe("The callback result is saved with its scores, but advancement is unresolved: a tie at the cut-off would exceed the Final's capacity.");
  });
  it("is null for a resolved or ordinary version", () => {
    expect(deriveUnresolvedTie({ rows: [row("1", 7, "above_cut", true), row("2", 3, "below_cut", false)], trace: cutTrace({ unresolved: false }, "cut_clean") })).toBeNull();
    expect(deriveUnresolvedTie({ rows: [], trace: [] })).toBeNull();
    expect(deriveUnresolvedTie({ rows: [row("1", 7, null, true)], trace: "garbage" })).toBeNull();
  });
  it("does not call it unresolved when a tied row already has an advance decision", () => {
    expect(deriveUnresolvedTie({ rows: [row("1", 5, "tied_at_cut", true), row("2", 5, "tied_at_cut", false)], trace: [] })).toBeNull();
  });
  it("tolerates odd shapes", () => {
    expect(findCutStep([null, 3, { step: "cut", data: "x" }])).toEqual({ outcome: null, data: {} });
    expect(findCutStep({})).toBeNull();
    const tie = deriveUnresolvedTie({
      rows: [{ entryId: "1", label: "A", advanced: null, output: null }],
      trace: [{ name: "cut", outcome: "blocked_tie_over_capacity", data: { finalCapacity: "4", tiedAtCut: [5] } }],
    })!;
    expect(tie.capacity).toBeNull();
    expect(tie.listsAvailable).toBe(false);
  });
});
