import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../contract";
import { NOT_CALLED_BACK_LABEL, runStudioCallbackTally as run } from "../studioCallbackTally";
import { callbackInput, entryKey as e, expectFail, expectOk, mulberry32, officialId, shuffled, shuffleInput } from "./helpers";

const ENTRIES = [11, 12, 13, 14, 15, 16, 17, 18];
const F01 = [
  [11, 12, 13, 14],
  [11, 12, 13, 15],
  [11, 12, 14, 16],
];
const F02 = [
  [11, 12, 13, 14],
  [11, 12, 13, 15],
  [11, 12, 14, 15],
];

const advancedIds = (run_: ReturnType<typeof run>) =>
  expectOk(run_)
    .rows.filter((r) => r.advanced === true)
    .map((r) => r.entryId);

describe("studio_callback_tally@1 golden fixtures (engine-spec-callback-tally.md §9)", () => {
  it("F-CT-01 clean cut: 11–14 advance, tallies 3,3,2,2,1,1,0,0, positions 1,1,3,3,5,5,7,7", () => {
    const result = expectOk(run(callbackInput(F01, ENTRIES, 4, 8)));
    expect(advancedIds(run(callbackInput(F01, ENTRIES, 4, 8)))).toEqual([11, 12, 13, 14].map(e));
    const byEntry = Object.fromEntries(result.rows.map((r) => [r.entryId, r]));
    expect(ENTRIES.map((n) => byEntry[e(n)].output?.tally)).toEqual([3, 3, 2, 2, 1, 1, 0, 0]);
    expect(ENTRIES.map((n) => byEntry[e(n)].output?.callback_rank)).toEqual([1, 1, 3, 3, 5, 5, 7, 7]);
    for (const n of [15, 16, 17, 18]) {
      expect(byEntry[e(n)].advanced).toBe(false);
      expect(byEntry[e(n)].placement).toBeUndefined();
      expect(byEntry[e(n)].output?.label).toBe("Semi-final");
      expect(NOT_CALLED_BACK_LABEL).toBe("Semi-final");
    }
    for (const n of [11, 12, 13, 14]) {
      expect(byEntry[e(n)].placement).toBeUndefined();
      expect(byEntry[e(n)].output).not.toHaveProperty("label");
    }
    // capacity does not matter when no tie extends the cut
    expect(advancedIds(run(callbackInput(F01, ENTRIES, 4, null)))).toEqual([11, 12, 13, 14].map(e));
    expect(advancedIds(run(callbackInput(F01, ENTRIES, 4, 1)))).toEqual([11, 12, 13, 14].map(e));
  });

  it("F-CT-02 tie at the cutoff: tallies 3,3,2,2,2,0,0,0; all five advance when cap ≥ 5", () => {
    const result = expectOk(run(callbackInput(F02, ENTRIES, 4, 8)));
    expect(result.rows.filter((r) => r.advanced).map((r) => r.entryId)).toEqual([11, 12, 13, 14, 15].map(e));
    expect(Object.fromEntries(result.rows.map((r) => [r.entryId, r.output?.tally]))).toMatchObject({ [e(13)]: 2, [e(14)]: 2, [e(15)]: 2, [e(16)]: 0 });
    expect(advancedIds(run(callbackInput(F02, ENTRIES, 4, 5)))).toHaveLength(5);
  });

  it("F-CT-02 cap < 5: advancement blocked (tie_over_capacity), entries 13, 14, 15 listed, no rows, no manager pick", () => {
    for (const cap of [4, 1]) {
      const f = expectFail(run(callbackInput(F02, ENTRIES, 4, cap)));
      expect([f.code, f.reason, f.offendingIds]).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "tie_over_capacity", [13, 14, 15].map(e)]);
      expect("rows" in f).toBe(false);
      expect(f.trace[f.trace.length - 1].step).toBe("failure");
    }
  });

  it("F-CT-03 target not set: COMP_ENGINE_UNSPECIFIED_CASE", () => {
    const f = expectFail(run(callbackInput(F01, ENTRIES, null, 8)));
    expect([f.code, f.reason]).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "target_unset"]);
  });

  it("F-CT-04 target covers everyone: all four advance, round not danced, no ballots needed", () => {
    const input = callbackInput([[], [], []], [11, 12, 13, 14], 4, 8);
    const result = expectOk(run(input));
    expect(result.rows.map((r) => [r.entryId, r.advanced])).toEqual([11, 12, 13, 14].map((n) => [e(n), true]));
    expect(result.rows[0].output).toEqual({ not_danced: true });
    // T above the entry count behaves the same
    expect(advancedIds(run(callbackInput([[], [], []], [11, 12, 13, 14], 9, null)))).toHaveLength(4);
  });

  it("F-CT-05 wrong number of callbacks: J2 selects 5 or 3 → callback_count", () => {
    for (const j2 of [
      [11, 12, 13, 15, 16],
      [11, 12, 13],
    ]) {
      const f = expectFail(run(callbackInput([F01[0], j2, F01[2]], ENTRIES, 4, 8)));
      expect([f.code, f.reason, f.offendingIds]).toEqual(["COMP_ENGINE_INVALID_INPUT", "callback_count", [officialId(2)]]);
    }
  });

  it("F-CT-06 alternate mark → mark_not_in_scheme", () => {
    const input = callbackInput(F01, ENTRIES, 4, 8);
    for (const value of ["alternate", 1, false, null]) {
      const marks = input.marks.map((m, i) => (i === 0 ? { ...m, value } : m));
      const f = expectFail(run({ ...input, marks }));
      expect([f.code, f.reason]).toEqual(["COMP_ENGINE_INVALID_INPUT", "mark_not_in_scheme"]);
    }
  });

  it("F-CT-07 two heats, same panel: counted across the round (2 + 2 per judge is not required)", () => {
    const selections = [
      [11, 12, 15, 16],
      [11, 13, 15, 17],
      [12, 14, 16, 18],
    ];
    const input = callbackInput(selections, ENTRIES, 4, 8);
    const panel = input.judges.map((j) => j.officialId);
    const twoHeats = {
      ...input,
      context: {
        ...input.context,
        heats: [
          { heatId: "heat-1", officialIds: panel, entryIds: [11, 12, 13, 14].map(e) },
          { heatId: "heat-2", officialIds: panel, entryIds: [15, 16, 17, 18].map(e) },
        ],
      },
    };
    const result = expectOk(run(twoHeats));
    // tallies: 11=2 12=2 13=1 14=1 15=2 16=2 17=1 18=1 → 4th highest is 2 → 11,12,15,16 advance (exactly T)
    expect(result.rows.filter((r) => r.advanced).map((r) => r.entryId)).toEqual([11, 12, 15, 16].map(e));
    // unequal selection per heat is fine: J1 has 2 per heat here, J3 has 2 in heat 1 and 2 in heat 2; unequal split:
    const lopsided = callbackInput([[11, 12, 13, 14], [11, 12, 13, 15], [11, 12, 14, 15]], ENTRIES, 4, 8);
    expect(expectOk(run({ ...lopsided, context: { ...lopsided.context, heats: twoHeats.context.heats } })).rows).toHaveLength(8);
  });

  it("F-CT-07 two heats with different panels → COMP_ENGINE_UNSPECIFIED_CASE (X-7)", () => {
    const input = callbackInput(F01, ENTRIES, 4, 8);
    const panel = input.judges.map((j) => j.officialId);
    const f = expectFail(
      run({
        ...input,
        context: {
          ...input.context,
          heats: [
            { heatId: "heat-1", officialIds: panel, entryIds: [11, 12, 13, 14].map(e) },
            { heatId: "heat-2", officialIds: [panel[0], panel[1], "official-7"], entryIds: [15, 16, 17, 18].map(e) },
          ],
        },
      }),
    );
    expect([f.code, f.reason, f.offendingIds]).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "heat_panel_mismatch", ["heat-2"]]);
  });

  describe("F-CT-08 invalid inputs (each starts from F-CT-01)", () => {
    const base = () => callbackInput(F01, ENTRIES, 4, 8);
    it("a: mark for entry 99 → entry_not_in_round", () => {
      const input = base();
      const f = expectFail(run({ ...input, marks: [...input.marks, { officialId: officialId(1), entryId: e(99), value: true }] }));
      expect([f.code, f.reason, f.offendingIds]).toEqual(["COMP_ENGINE_INVALID_INPUT", "entry_not_in_round", [e(99)]]);
    });
    it("b: J1 calls back 11 twice → duplicate_mark", () => {
      const input = base();
      const f = expectFail(run({ ...input, marks: [...input.marks, { officialId: officialId(1), entryId: e(11), value: true }] }));
      expect([f.code, f.reason]).toEqual(["COMP_ENGINE_INVALID_INPUT", "duplicate_mark"]);
    });
    it("c: mark from official J9 → official_not_on_panel", () => {
      const input = base();
      const f = expectFail(run({ ...input, marks: [...input.marks, { officialId: "official-9", entryId: e(11), value: true }] }));
      expect([f.code, f.reason, f.offendingIds]).toEqual(["COMP_ENGINE_INVALID_INPUT", "official_not_on_panel", ["official-9"]]);
    });
    it("d: an alternate mark → mark_not_in_scheme", () => {
      const input = base();
      const f = expectFail(run({ ...input, marks: input.marks.map((m, i) => (i === 3 ? { ...m, value: "alternate" } : m)) }));
      expect(f.reason).toBe("mark_not_in_scheme");
    });
    it("e: scheme scored_by role / callback_retire / alternates → COMP_ENGINE_UNSPECIFIED_CASE", () => {
      for (const markScheme of [
        { scored_by: "role" },
        { input: "callback_retire", scored_by: "entry" },
        { input: "callback_yes_alternates", scored_by: "entry" },
        "x",
      ]) {
        const f = expectFail(run({ ...base(), markScheme }));
        expect(f.code).toBe("COMP_ENGINE_UNSPECIFIED_CASE");
      }
    });
    it("e: a yes-only by-entry scheme or none is accepted", () => {
      expect(expectOk(run({ ...base(), markScheme: { input: "callback_yes", scored_by: "entry" } })).rows).toHaveLength(8);
      expect(expectOk(run({ ...base(), markScheme: null })).rows).toHaveLength(8);
    });
    it("e: per-role marks → COMP_ENGINE_UNSPECIFIED_CASE", () => {
      const input = base();
      const f = expectFail(run({ ...input, marks: input.marks.map((m, i) => (i === 0 ? { ...m, role: "follower" as const } : m)) }));
      expect([f.code, f.reason]).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "role_marks_not_supported"]);
    });
    it("f: round type final / wrong advancement method → COMP_ENGINE_UNSPECIFIED_CASE", () => {
      const input = base();
      expect(expectFail(run({ ...input, round: { ...input.round, roundType: "final" } })).code).toBe("COMP_ENGINE_UNSPECIFIED_CASE");
      expect(expectFail(run({ ...input, round: { ...input.round, advancementMethod: "none" } })).code).toBe("COMP_ENGINE_UNSPECIFIED_CASE");
      expect(expectFail(run({ ...input, round: { ...input.round, advancementMethod: null } })).code).toBe("COMP_ENGINE_UNSPECIFIED_CASE");
    });
    it("g: entry 13 scratched → J1 and J2 have 3 eligible selections → callback_count; J3 unaffected", () => {
      const input = base();
      const f = expectFail(run({ ...input, context: { ...input.context, excludedEntries: [{ entryId: e(13), reason: "scratched" }] } }));
      expect([f.code, f.reason, f.offendingIds]).toEqual(["COMP_ENGINE_INVALID_INPUT", "callback_count", [officialId(1), officialId(2)]]);
    });
    it("g: after corrected ballots the scratched entry is excluded and gets no row", () => {
      const corrected = callbackInput(
        [
          [11, 12, 14, 15],
          [11, 12, 15, 16],
          [11, 12, 14, 16],
        ],
        ENTRIES,
        4,
        8,
      );
      const withScratch = { ...corrected, marks: [...corrected.marks, { officialId: officialId(1), entryId: e(13), value: true }] };
      const result = expectOk(run({ ...withScratch, context: { ...withScratch.context, excludedEntries: [{ entryId: e(13), reason: "no_show" }] } }));
      expect(result.rows.find((r) => r.entryId === e(13))).toBeUndefined();
      expect(result.rows).toHaveLength(7);
      expect(result.warnings).toEqual([`excluded_entries:${e(13)}`]);
    });
    it("h: cap not supplied is fine without a tie and fails closed when a tie needs it", () => {
      expect(advancedIds(run(callbackInput(F01, ENTRIES, 4, null)))).toHaveLength(4);
      for (const cap of [null, undefined, 0, 2.5]) {
        const input = callbackInput(F02, ENTRIES, 4, null);
        const f = expectFail(run({ ...input, context: { ...input.context, finalCapacity: cap as never } }));
        expect([f.code, f.reason]).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "tie_over_capacity"]);
      }
    });
  });

  it("F-CT-09 determinism: shuffled marks (and every other array) → identical output and trace hash", () => {
    const input = callbackInput(F01, ENTRIES, 4, 8);
    const base = expectOk(run(input));
    for (let seed = 1; seed <= 25; seed++) {
      const out = expectOk(run(shuffleInput(input, mulberry32(seed))));
      expect(out.inputHash).toBe(base.inputHash);
      expect(out.traceHash).toBe(base.traceHash);
      expect(out.outputHash).toBe(base.outputHash);
      expect(canonicalJson(out.trace)).toBe(canonicalJson(base.trace));
    }
  });
});

describe("studio_callback_tally@1 fail-closed cases", () => {
  const base = () => callbackInput(F01, ENTRIES, 4, 8);
  const code = (input: ReturnType<typeof base>) => {
    const f = expectFail(run(input));
    return [f.code, f.reason] as const;
  };

  it("V1 unknown engine key / version → COMP_ENGINE_NOT_AVAILABLE", () => {
    expect(code({ ...base(), engineKey: "ordinal_majority" })).toEqual(["COMP_ENGINE_NOT_AVAILABLE", "engine_not_available"]);
    expect(code({ ...base(), engineVersion: "2" })).toEqual(["COMP_ENGINE_NOT_AVAILABLE", "engine_not_available"]);
  });
  it("target zero, negative, fractional → unspecified", () => {
    for (const t of [0, -1, 2.5]) expect(code(callbackInput(F01, ENTRIES, t, 8))).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "target_invalid"]);
  });
  it("X-3 even panel, panel below 3, chief-judge tiebreak, per-role scoring → unspecified", () => {
    expect(code(callbackInput([F01[0], F01[1]], ENTRIES, 4, 8))).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "panel_size"]);
    expect(code(callbackInput([F01[0], F01[1], F01[2], F01[0]], ENTRIES, 4, 8))).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "panel_size"]);
    expect(code({ ...base(), context: { ...base().context, chiefJudgeTiebreak: true } })).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "x3_option_unsupported"]);
    expect(code({ ...base(), context: { ...base().context, scoreRolesSeparately: true } })).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "x3_option_unsupported"]);
  });
  it("X-7 missing heat panels → unspecified", () => {
    expect(code({ ...base(), context: { ...base().context, heats: [] } })).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "heat_panels_missing"]);
  });
  it("X-6 none or several dances → unspecified (also for a round that is not danced)", () => {
    expect(code({ ...base(), context: { ...base().context, danceIds: ["waltz", "tango"] } })).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "multi_dance_unsupported"]);
    const notDanced = callbackInput([[], [], []], [11, 12], 2, null);
    expect(code({ ...notDanced, context: { ...notDanced.context, danceIds: [] } })).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "multi_dance_unsupported"]);
  });
  it("V12 assigned judge with no ballot → unspecified", () => {
    const input = base();
    const f = expectFail(run({ ...input, marks: input.marks.filter((m) => m.officialId !== officialId(2)) }));
    expect([f.code, f.reason, f.offendingIds]).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "judge_without_ballot", [officialId(2)]]);
  });
  it("no eligible entries → unspecified", () => {
    const input = base();
    expect(code({ ...input, context: { ...input.context, excludedEntries: input.entries.map((x) => ({ entryId: x.entryId, reason: "scratched" as const })) } })).toEqual([
      "COMP_ENGINE_UNSPECIFIED_CASE",
      "no_eligible_entries",
    ]);
  });
  it("duplicate judges / entries → invalid", () => {
    const input = base();
    expect(code({ ...input, judges: [...input.judges, input.judges[0]] })).toEqual(["COMP_ENGINE_INVALID_INPUT", "duplicate_judge"]);
    expect(code({ ...input, entries: [...input.entries, input.entries[0]] })).toEqual(["COMP_ENGINE_INVALID_INPUT", "duplicate_entry"]);
  });
  it("malformed envelope → fail closed, never a throw", () => {
    const input = base();
    expect(code({ ...input, marks: undefined as never })).toEqual(["COMP_ENGINE_INVALID_INPUT", "malformed_input"]);
    expect(code({ ...input, round: undefined as never })).toEqual(["COMP_ENGINE_INVALID_INPUT", "malformed_input"]);
  });
  it("marks on a round that is not danced are ignored with a warning, never used", () => {
    const input = callbackInput(F01, [11, 12, 13, 14], 4, 8);
    const result = expectOk(run(input));
    expect(result.warnings).toContain("marks_ignored_round_not_danced");
    expect(result.rows.every((r) => r.advanced === true)).toBe(true);
  });
  it("a tie within the called-back set (all above the cut) needs no capacity", () => {
    // T = 2; J1 {11,12}, J2 {11,12}, J3 {11,12}: both tally 3, exactly T.
    expect(advancedIds(run(callbackInput([[11, 12], [11, 12], [11, 12]], [11, 12, 13, 14], 2, null)))).toEqual([11, 12].map(e));
  });
  it("tie below the cut does not matter", () => {
    // tallies: 11=3, 12=2, 13=1, 14=1 (T=2) → 11,12 advance; the 13/14 tie is outside the cut.
    const result = run(callbackInput([[11, 12], [11, 12], [11, 13]], [11, 12, 13, 14], 2, null));
    expect(advancedIds(result)).toEqual([11, 12].map(e));
  });
});

describe("studio_callback_tally@1 properties", () => {
  function randomCase(rand: () => number) {
    const n = 4 + Math.floor(rand() * 8);
    const entries = Array.from({ length: n }, (_, i) => 11 + i);
    const T = 1 + Math.floor(rand() * (n - 2));
    const judges = [3, 5][Math.floor(rand() * 2)];
    const selections = Array.from({ length: judges }, () => shuffled(entries, rand).slice(0, T));
    return { entries, T, selections, cap: 1 + Math.floor(rand() * n) };
  }

  it("shuffled input gives identical output (success or failure) and hashes (300 random rounds)", () => {
    const rand = mulberry32(2024);
    for (let i = 0; i < 300; i++) {
      const c = randomCase(rand);
      const input = callbackInput(c.selections, c.entries, c.T, c.cap);
      expect(canonicalJson(run(shuffleInput(input, rand)))).toBe(canonicalJson(run(input)));
    }
  });

  it("advancing set is exactly the entries at or above the T-th tally, or the run is blocked", () => {
    const rand = mulberry32(31337);
    let advanced = 0;
    let blocked = 0;
    for (let i = 0; i < 300; i++) {
      const c = randomCase(rand);
      const result = run(callbackInput(c.selections, c.entries, c.T, c.cap));
      const tally = new Map(c.entries.map((n) => [n, c.selections.filter((s) => s.includes(n)).length]));
      const sorted = [...tally.values()].sort((a, b) => b - a);
      const cutTally = sorted[c.T - 1];
      const above = c.entries.filter((n) => tally.get(n)! >= cutTally);
      if (above.length > c.T && above.length > c.cap) {
        blocked++;
        const f = expectFail(result);
        expect(f.reason).toBe("tie_over_capacity");
        expect(f.offendingIds).toEqual(c.entries.filter((n) => tally.get(n) === cutTally).map(e).sort());
      } else {
        advanced++;
        expect(advancedIds(result)).toEqual(above.map(e));
        expect(above.length).toBeGreaterThanOrEqual(c.T);
        // a lower tally never advances past a higher one
        for (const r of expectOk(result).rows) expect(r.placement).toBeUndefined();
      }
    }
    expect(advanced).toBeGreaterThan(20);
    expect(blocked).toBeGreaterThan(5);
  });
});
