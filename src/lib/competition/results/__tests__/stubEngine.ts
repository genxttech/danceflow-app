/**
 * TEST ONLY. A deliberately trivial stand-in for an F1 engine so the F2 lifecycle can be exercised before F1 lands.
 * It ranks entries by the sum of their ordinal marks (lower is better) with NO tie handling beyond entry order; it is NOT
 * a scoring method and must never be imported by application code or registered in REGISTERED_ENGINES.
 */
import type { ResultEngine } from "../engineAdapter";

export const stubEngine: ResultEngine = {
  key: "studio_ordinal_majority",
  version: "1",
  run(input) {
    const totals = new Map<string, number>();
    for (const entry of input.entries) totals.set(entry.entryId, 0);
    for (const mark of input.marks) totals.set(mark.entryId, (totals.get(mark.entryId) ?? 0) + Number(mark.value));
    const ordered = [...totals.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
    return {
      rows: ordered.map(([entryId, total], index) => ({ entryId, placement: index + 1, output: { total } })),
      trace: ordered.map(([entryId, total]) => ({ entryId, total })),
      warnings: ["test stub engine"],
    };
  },
};
