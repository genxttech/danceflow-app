import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../contract";
import { runStudioOrdinalMajority as run } from "../studioOrdinalMajority";
import { entryKey, expectFail, expectOk, mulberry32, officialId, ordinalInput, placements, shuffleInput } from "./helpers";

const F01 = { 11: [1, 1, 1], 12: [2, 2, 2], 13: [3, 3, 3], 14: [4, 4, 4] };
const F02 = { 11: [1, 1, 4], 12: [2, 2, 1], 13: [3, 3, 2], 14: [4, 4, 3] };
const F03 = { 11: [1, 3, 2], 12: [2, 1, 3], 13: [3, 2, 1] };
const F09 = { 11: [1, 2, 4], 12: [2, 1, 3], 13: [3, 3, 1], 14: [4, 4, 2] };
const F10 = { 11: [1, 2, 3], 12: [2, 3, 2], 13: [3, 4, 1], 14: [4, 1, 4] };

const e = entryKey;

describe("studio_ordinal_majority@1 golden fixtures (engine-spec-ordinal-majority.md §9)", () => {
  it("F-OM-01 unanimous: 11→1, 12→2, 13→3, 14→4", () => {
    expect(placements(run(ordinalInput(F01)))).toEqual({ [e(11)]: 1, [e(12)]: 2, [e(13)]: 3, [e(14)]: 4 });
  });

  it("F-OM-02 majority at the lowest cutoff (OM-A, not lowest total): 11→1, 12→2, 13→3, 14→4", () => {
    const result = expectOk(run(ordinalInput(F02)));
    expect(placements(result)).toEqual({ [e(11)]: 1, [e(12)]: 2, [e(13)]: 3, [e(14)]: 4 });
    // 11 wins place 1 at cutoff 1 with two judges although 12 has the lower total.
    expect(result.rows.find((r) => r.entryId === e(11))?.output).toMatchObject({ cutoff: 1, judges_at_cutoff: 2 });
  });

  it("F-OM-03 circular preferences: all three share 1st in one tie_group", () => {
    const result = expectOk(run(ordinalInput(F03)));
    expect(placements(result)).toEqual({ [e(11)]: 1, [e(12)]: 1, [e(13)]: 1 });
    expect(new Set(result.rows.map((r) => r.tieGroup)).size).toBe(1);
    expect(result.rows.every((r) => r.tieGroup)).toBe(true);
  });

  it("F-OM-04 four judges: refused (X-3: even panel); the m=3 arithmetic is not reachable", () => {
    const failure = expectFail(run(ordinalInput({ 11: [1, 1, 2, 3], 12: [2, 2, 1, 1], 13: [3, 3, 3, 2] })));
    expect(failure.code).toBe("COMP_ENGINE_UNSPECIFIED_CASE");
    expect(failure.reason).toBe("panel_size");
  });

  it("F-OM-05 one entry: 11→1", () => {
    expect(placements(run(ordinalInput({ 11: [1, 1, 1] })))).toEqual({ [e(11)]: 1 });
  });

  it("F-OM-06 one judge: COMP_ENGINE_UNSPECIFIED_CASE (X-3)", () => {
    const failure = expectFail(run(ordinalInput({ 11: [1], 12: [2], 13: [3] })));
    expect([failure.code, failure.reason]).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "panel_size"]);
  });

  describe("F-OM-07 invalid inputs (each starts from F-OM-01)", () => {
    const base = () => ordinalInput(F01);
    const withMarks = (edit: (marks: ReturnType<typeof base>["marks"]) => ReturnType<typeof base>["marks"]) => {
      const input = base();
      return { ...input, marks: edit(input.marks) };
    };
    const setMark = (marks: ReturnType<typeof base>["marks"], judge: number, entry: number, value: unknown) =>
      marks.map((m) => (m.officialId === officialId(judge) && m.entryId === e(entry) ? { ...m, value } : m));

    it("a: J2 marks 11 = 1 and 12 = 1 → judge_tie", () => {
      const f = expectFail(run(withMarks((m) => setMark(setMark(m, 2, 12, 1), 2, 11, 1))));
      expect([f.code, f.reason]).toEqual(["COMP_ENGINE_INVALID_INPUT", "judge_tie"]);
    });
    it("b: J3 has no mark for 14 → incomplete_ballot", () => {
      const f = expectFail(run(withMarks((m) => m.filter((x) => !(x.officialId === officialId(3) && x.entryId === e(14))))));
      expect([f.code, f.reason, f.offendingIds]).toEqual(["COMP_ENGINE_INVALID_INPUT", "incomplete_ballot", [officialId(3)]]);
    });
    it.each([5, 0, 2.5])("c: J1 marks 14 = %s → mark_out_of_range", (value) => {
      const f = expectFail(run(withMarks((m) => setMark(m, 1, 14, value))));
      expect([f.code, f.reason]).toEqual(["COMP_ENGINE_INVALID_INPUT", "mark_out_of_range"]);
    });
    it("c: non-numeric mark values → mark_out_of_range", () => {
      for (const value of ["2", true, null]) {
        const f = expectFail(run(withMarks((m) => setMark(m, 1, 14, value))));
        expect(f.reason).toBe("mark_out_of_range");
      }
    });
    it("d: mark for entry 99 → entry_not_in_round", () => {
      const f = expectFail(run(withMarks((m) => [...m, { officialId: officialId(1), entryId: e(99), value: 5 }])));
      expect([f.code, f.reason, f.offendingIds]).toEqual(["COMP_ENGINE_INVALID_INPUT", "entry_not_in_round", [e(99)]]);
    });
    it("e: mark from official J9 → official_not_on_panel", () => {
      const f = expectFail(run(withMarks((m) => [...m, { officialId: "official-9", entryId: e(11), value: 1 }])));
      expect([f.code, f.reason, f.offendingIds]).toEqual(["COMP_ENGINE_INVALID_INPUT", "official_not_on_panel", ["official-9"]]);
    });
    it("f: J1 appears twice for entry 11 → duplicate_mark", () => {
      const f = expectFail(run(withMarks((m) => [...m, { officialId: officialId(1), entryId: e(11), value: 1 }])));
      expect([f.code, f.reason]).toEqual(["COMP_ENGINE_INVALID_INPUT", "duplicate_mark"]);
    });
    it("g: mark_scheme.input = medal_marks → scheme_mismatch", () => {
      const f = expectFail(run({ ...base(), markScheme: { input: "medal_marks", scored_by: "entry" } }));
      expect([f.code, f.reason]).toEqual(["COMP_ENGINE_INVALID_INPUT", "scheme_mismatch"]);
    });
    it("g: scored_by role / ties_allowed / non-object scheme → scheme_mismatch", () => {
      for (const scheme of [{ input: "placement_marks", scored_by: "role" }, { input: "placement_marks", scored_by: "entry", ties_allowed: true }, "x", []]) {
        expect(expectFail(run({ ...base(), markScheme: scheme })).reason).toBe("scheme_mismatch");
      }
    });
    it("g: a missing stored scheme is the engine @1 default (allowed)", () => {
      expect(expectOk(run({ ...base(), markScheme: null })).rows).toHaveLength(4);
    });
    it("h: heats 1 and 2 have different panels → COMP_ENGINE_UNSPECIFIED_CASE", () => {
      const input = base();
      const f = expectFail(
        run({
          ...input,
          context: {
            ...input.context,
            heats: [input.context.heats[0], { heatId: "heat-2", officialIds: [officialId(1), officialId(2), "official-7"], entryIds: [e(11)] }],
          },
        }),
      );
      expect([f.code, f.reason, f.offendingIds]).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "heat_panel_mismatch", ["heat-2"]]);
    });
    it("h: same panel in both heats → combination not specified, fail closed", () => {
      const input = base();
      const f = expectFail(
        run({ ...input, context: { ...input.context, heats: [input.context.heats[0], { ...input.context.heats[0], heatId: "heat-2" }] } }),
      );
      expect([f.code, f.reason]).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "multi_heat_combination_unspecified"]);
    });
    it("i: entry 14 scratched but ballots still rank it → mark_out_of_range (never renumbered)", () => {
      const input = base();
      const f = expectFail(run({ ...input, context: { ...input.context, excludedEntries: [{ entryId: e(14), reason: "scratched" }] } }));
      expect([f.code, f.reason]).toEqual(["COMP_ENGINE_INVALID_INPUT", "mark_out_of_range"]);
    });
    it("i: entry 14 scratched with corrected 1…3 ballots → ranked without 14, no row for 14", () => {
      const input = ordinalInput({ 11: [1, 1, 1], 12: [2, 2, 2], 13: [3, 3, 3], 14: [4, 4, 4] });
      const corrected = {
        ...input,
        marks: input.marks.filter((m) => m.entryId !== e(14)),
        context: { ...input.context, excludedEntries: [{ entryId: e(14), reason: "no_show" as const }] },
      };
      const result = expectOk(run(corrected));
      expect(placements(result)).toEqual({ [e(11)]: 1, [e(12)]: 2, [e(13)]: 3 });
      expect(result.warnings).toEqual([`excluded_entries:${e(14)}`]);
    });
    it("i: a ballot that ranks the excluded entry and happens to be 1…N+1 minus a gap is still refused", () => {
      const input = ordinalInput({ 11: [1, 1, 1], 12: [2, 2, 2], 13: [3, 3, 3], 14: [2, 2, 2] });
      const f = expectFail(run({ ...input, context: { ...input.context, excludedEntries: [{ entryId: e(14), reason: "scratched" }] } }));
      expect(f.code).toBe("COMP_ENGINE_INVALID_INPUT");
    });
  });

  it("F-OM-08 determinism: shuffled input → identical output and trace hash", () => {
    const base = expectOk(run(ordinalInput(F02)));
    for (let seed = 1; seed <= 25; seed++) {
      const out = expectOk(run(shuffleInput(ordinalInput(F02), mulberry32(seed))));
      expect(out.inputHash).toBe(base.inputHash);
      expect(out.traceHash).toBe(base.traceHash);
      expect(canonicalJson(out.rows)).toBe(canonicalJson(base.rows));
      expect(canonicalJson(out.trace)).toBe(canonicalJson(base.trace));
    }
  });

  it("F-OM-09 shared placement skips the number: 11→1, 12→1, 13→3, 14→4", () => {
    const result = expectOk(run(ordinalInput(F09)));
    expect(placements(result)).toEqual({ [e(11)]: 1, [e(12)]: 1, [e(13)]: 3, [e(14)]: 4 });
    const groups = Object.fromEntries(result.rows.map((r) => [r.entryId, r.tieGroup]));
    expect(groups[e(11)]).toBe(groups[e(12)]);
    expect(groups[e(11)]).toBeTruthy();
    expect(groups[e(13)]).toBeNull();
  });

  it("F-OM-10 chain step (2) decides: 11→1, 12→2, 13→3, 14→4", () => {
    const result = expectOk(run(ordinalInput(F10)));
    expect(placements(result)).toEqual({ [e(11)]: 1, [e(12)]: 2, [e(13)]: 3, [e(14)]: 4 });
    expect(result.rows.every((r) => r.tieGroup === null)).toBe(true);
    expect(result.trace.some((r) => r.step === "tie_break")).toBe(true);
  });

  it("numbering 2, 2, 4 for a shared second place (D-OM-3b)", () => {
    // 10 wins outright; 11 and 12 tie exactly for 2nd (F-OM-09 shifted down one place); 13 is 4th, 14 is 5th.
    const result = expectOk(run(ordinalInput({ 10: [1, 1, 1], 11: [2, 3, 5], 12: [3, 2, 4], 13: [4, 4, 2], 14: [5, 5, 3] })));
    expect(placements(result)).toEqual({ [e(10)]: 1, [e(11)]: 2, [e(12)]: 2, [e(13)]: 4, [e(14)]: 5 });
  });

  it("chain step (1): more judges at the cutoff places higher (four-judge arithmetic is refused, so use five judges)", () => {
    // J = 5, m = 3. At cutoff 2: entry 11 has 3 judges, entry 12 has 4 → 12 first.
    const result = expectOk(run(ordinalInput({ 11: [1, 1, 2, 3, 3], 12: [2, 2, 1, 1, 2], 13: [3, 3, 3, 2, 1] })));
    // Place 1 cutoff 1: 11 has 2, 12 has 2, 13 has 1 → none. Cutoff 2: 11: 3, 12: 4, 13: 1 → 11, 12 qualify; 12 higher.
    expect(placements(result)).toEqual({ [e(12)]: 1, [e(11)]: 2, [e(13)]: 3 });
  });
});

describe("studio_ordinal_majority@1 fail-closed cases", () => {
  const base = () => ordinalInput(F01);
  const code = (input: ReturnType<typeof base>) => {
    const f = expectFail(run(input));
    return [f.code, f.reason] as const;
  };

  it("V1 unknown engine key / version → COMP_ENGINE_NOT_AVAILABLE", () => {
    expect(code({ ...base(), engineKey: "callback_tally" })).toEqual(["COMP_ENGINE_NOT_AVAILABLE", "engine_not_available"]);
    expect(code({ ...base(), engineVersion: "2" })).toEqual(["COMP_ENGINE_NOT_AVAILABLE", "engine_not_available"]);
  });
  it("round type other than final → unspecified", () => {
    for (const roundType of ["preliminary", "semifinal", "quarterfinal"]) {
      expect(code({ ...base(), round: { ...base().round, roundType } })).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "round_type_not_final"]);
    }
  });
  it("X-3 even panel, panel below 3, chief-judge tiebreak, per-role scoring → unspecified", () => {
    expect(code(ordinalInput({ 11: [1, 1], 12: [2, 2] }))).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "panel_size"]);
    expect(code(ordinalInput({ 11: [1, 1, 1, 1], 12: [2, 2, 2, 2] }))).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "panel_size"]);
    expect(code({ ...base(), context: { ...base().context, chiefJudgeTiebreak: true } })).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "x3_option_unsupported"]);
    expect(code({ ...base(), context: { ...base().context, scoreRolesSeparately: true } })).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "x3_option_unsupported"]);
  });
  it("X-7 missing heat panels → unspecified", () => {
    expect(code({ ...base(), context: { ...base().context, heats: [] } })).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "heat_panels_missing"]);
  });
  it("X-6 none or several dances → unspecified", () => {
    expect(code({ ...base(), context: { ...base().context, danceIds: ["waltz", "tango"] } })).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "multi_dance_unsupported"]);
    expect(code({ ...base(), context: { ...base().context, danceIds: [] } })).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "multi_dance_unsupported"]);
  });
  it("V10 assigned judge with no ballot → unspecified", () => {
    const input = base();
    const f = expectFail(run({ ...input, marks: input.marks.filter((m) => m.officialId !== officialId(2)) }));
    expect([f.code, f.reason, f.offendingIds]).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "judge_without_ballot", [officialId(2)]]);
  });
  it("per-role marks → role_not_allowed", () => {
    const input = base();
    expect(code({ ...input, marks: input.marks.map((m, i) => (i === 0 ? { ...m, role: "leader" as const } : m)) })).toEqual(["COMP_ENGINE_INVALID_INPUT", "role_not_allowed"]);
  });
  it("all entries excluded → unspecified", () => {
    const input = base();
    expect(code({ ...input, context: { ...input.context, excludedEntries: input.entries.map((x) => ({ entryId: x.entryId, reason: "scratched" as const })) } })).toEqual([
      "COMP_ENGINE_UNSPECIFIED_CASE",
      "no_calculated_entries",
    ]);
  });
  it("duplicate judges / entries, excluded entry outside the round → invalid", () => {
    const input = base();
    expect(code({ ...input, judges: [...input.judges, input.judges[0]] })).toEqual(["COMP_ENGINE_INVALID_INPUT", "duplicate_judge"]);
    expect(code({ ...input, entries: [...input.entries, input.entries[0]] })).toEqual(["COMP_ENGINE_INVALID_INPUT", "duplicate_entry"]);
    expect(code({ ...input, context: { ...input.context, excludedEntries: [{ entryId: "e99", reason: "scratched" }] } })).toEqual([
      "COMP_ENGINE_INVALID_INPUT",
      "excluded_entry_not_in_round",
    ]);
  });
  it("malformed envelope or non-finite mark → fail closed, never a throw", () => {
    const input = base();
    expect(code({ ...input, marks: undefined as never })).toEqual(["COMP_ENGINE_INVALID_INPUT", "malformed_input"]);
    expect(code({ ...input, context: undefined as never })).toEqual(["COMP_ENGINE_INVALID_INPUT", "malformed_input"]);
    expect(code({ ...input, marks: input.marks.map((m, i) => (i === 0 ? { ...m, value: Number.NaN } : m)) })).toEqual(["COMP_ENGINE_INVALID_INPUT", "malformed_input"]);
  });
  it("a failure returns no rows and a trace ending in a failure record", () => {
    const f = expectFail(run(ordinalInput({ 11: [1], 12: [2], 13: [3] })));
    expect("rows" in f).toBe(false);
    expect(f.trace[f.trace.length - 1].step).toBe("failure");
  });
  it("ignores the stored tie-break chain (engine @1 default) and the entry order", () => {
    const a = expectOk(run({ ...ordinalInput(F03), tieBreakChain: [] }));
    const b = expectOk(run({ ...ordinalInput(F03), tieBreakChain: ["random_draw"] }));
    expect(placements(a)).toEqual(placements(b));
  });
});

describe("studio_ordinal_majority@1 properties", () => {
  function randomRanking(rand: () => number, n: number): number[] {
    const values = Array.from({ length: n }, (_, i) => i + 1);
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }
    return values;
  }

  function randomTable(rand: () => number, judges: number, n: number) {
    const rankings = Array.from({ length: judges }, () => randomRanking(rand, n));
    return Object.fromEntries(Array.from({ length: n }, (_, k) => [11 + k, rankings.map((r) => r[k])]));
  }

  it("shuffled input gives byte-identical rows, trace and hashes (200 random ballots)", () => {
    const rand = mulberry32(12345);
    for (let i = 0; i < 200; i++) {
      const judges = [3, 5, 7][Math.floor(rand() * 3)];
      const n = 1 + Math.floor(rand() * 8);
      const input = ordinalInput(randomTable(rand, judges, n));
      const base = run(input);
      const other = run(shuffleInput(input, rand));
      expect(canonicalJson(other)).toBe(canonicalJson(base));
    }
  });

  it("placements are a valid competition numbering: every entry placed, 1 first, gaps equal the tie size", () => {
    const rand = mulberry32(777);
    for (let i = 0; i < 200; i++) {
      const judges = [3, 5][Math.floor(rand() * 2)];
      const n = 1 + Math.floor(rand() * 7);
      const result = expectOk(run(ordinalInput(randomTable(rand, judges, n))));
      expect(result.rows).toHaveLength(n);
      const sizes = new Map<number, number>();
      for (const r of result.rows) sizes.set(r.placement as number, (sizes.get(r.placement as number) ?? 0) + 1);
      let next = 1;
      for (const place of [...sizes.keys()].sort((a, b) => a - b)) {
        expect(place).toBe(next);
        next += sizes.get(place)!;
      }
      expect(next).toBe(n + 1);
      for (const r of result.rows) expect(r.tieGroup !== null).toBe(sizes.get(r.placement as number)! > 1);
    }
  });

  it("unanimous full rankings reproduce that ranking", () => {
    const rand = mulberry32(99);
    for (let i = 0; i < 50; i++) {
      const n = 1 + Math.floor(rand() * 8);
      const ranking = randomRanking(rand, n);
      const table = Object.fromEntries(ranking.map((r, k) => [11 + k, [r, r, r]]));
      const result = placements(run(ordinalInput(table)));
      ranking.forEach((r, k) => expect(result[entryKey(11 + k)]).toBe(r));
    }
  });

  it("entry ids and names do not influence placements (relabelling is equivariant)", () => {
    const rand = mulberry32(4242);
    for (let i = 0; i < 50; i++) {
      const n = 2 + Math.floor(rand() * 6);
      const table = randomTable(rand, 3, n);
      const a = placements(run(ordinalInput(table)));
      const relabelled = Object.fromEntries(Object.entries(table).map(([k, v]) => [Number(k) + 1000 * (n - (Number(k) - 10)), v]));
      const b = placements(run(ordinalInput(relabelled)));
      Object.keys(table).forEach((k) => expect(b[entryKey(Number(k) + 1000 * (n - (Number(k) - 10)))]).toBe(a[entryKey(k)]));
    }
  });
});
