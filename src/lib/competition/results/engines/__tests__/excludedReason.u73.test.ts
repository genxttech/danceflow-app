import { describe, expect, it } from "vitest";
import { runStudioCallbackTally as runCallback } from "../studioCallbackTally";
import { runStudioOrdinalMajority as runOrdinal } from "../studioOrdinalMajority";
import { callbackInput, entryKey as e, expectOk, officialId, ordinalInput, placements } from "./helpers";

// CF1 gate U73: the engines and their adapter accept reason "excluded" in context.excludedEntries (CF1 A3 exclusion action).
// The reason is evidence only: a couple excluded after dancing is dropped exactly like a no_show one, with the same warning.

describe("U73: engines accept reason 'excluded' in excludedEntries", () => {
  it("studio_ordinal_majority@1: excluded behaves exactly like no_show (ranked without the entry, same warning)", () => {
    const input = ordinalInput({ 11: [1, 1, 1], 12: [2, 2, 2], 13: [3, 3, 3], 14: [4, 4, 4] });
    const corrected = { ...input, marks: input.marks.filter((m) => m.entryId !== e(14)) };
    const withReason = (reason: "excluded" | "no_show") => ({ ...corrected, context: { ...corrected.context, excludedEntries: [{ entryId: e(14), reason }] } });
    const excluded = expectOk(runOrdinal(withReason("excluded")));
    const noShow = expectOk(runOrdinal(withReason("no_show")));
    expect(placements(excluded)).toEqual({ [e(11)]: 1, [e(12)]: 2, [e(13)]: 3 });
    expect(excluded.rows).toEqual(noShow.rows);
    expect(excluded.warnings).toEqual([`excluded_entries:${e(14)}`]);
    expect(excluded.warnings).toEqual(noShow.warnings);
  });

  it("studio_callback_tally@1: excluded behaves exactly like no_show and records the reason in the evidence", () => {
    const corrected = callbackInput(
      [
        [11, 12, 14, 15],
        [11, 12, 15, 16],
        [11, 12, 14, 16],
      ],
      [11, 12, 13, 14, 15, 16, 17, 18],
      4,
      8,
    );
    const withReason = (reason: "excluded" | "no_show") => ({
      ...corrected,
      marks: [...corrected.marks, { officialId: officialId(1), entryId: e(13), value: true }],
      context: { ...corrected.context, excludedEntries: [{ entryId: e(13), reason }] },
    });
    const excluded = expectOk(runCallback(withReason("excluded")));
    const noShow = expectOk(runCallback(withReason("no_show")));
    expect(excluded.rows.find((r) => r.entryId === e(13))).toBeUndefined();
    expect(excluded.rows).toEqual(noShow.rows);
    expect(excluded.warnings).toEqual([`excluded_entries:${e(13)}`]);
    expect(JSON.stringify(excluded)).toContain('"reason":"excluded"');
  });
});
