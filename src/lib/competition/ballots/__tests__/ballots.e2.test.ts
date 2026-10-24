import { describe, expect, it } from "vitest";
import { canonicalBallot, canonicalJson, currentBallots, currentBallotsToEngineMarks, type BallotRecord } from "../canonical";
import { PROVISIONAL_RULES, validateBallot } from "../schemes";

const E = ["e1", "e2", "e3"];
const codes = (r: ReturnType<typeof validateBallot>) => (r.ok ? [] : r.errors.map((e) => e.code));

describe("ordinal_majority ballots", () => {
  it("accepts a full 1..N ranking and returns marks in entry order", () => {
    const r = validateBallot({
      scoringMethod: "ordinal_majority",
      expectedEntryIds: E,
      marks: [{ entryId: "e3", value: 1 }, { entryId: "e1", value: 3 }, { entryId: "e2", value: 2 }],
    });
    expect(r).toEqual({
      ok: true,
      marks: [{ entryId: "e1", role: null, value: 3 }, { entryId: "e2", role: null, value: 2 }, { entryId: "e3", role: null, value: 1 }],
    });
  });
  it("rejects judge ties (D-OM-4)", () => {
    const r = validateBallot({
      scoringMethod: "ordinal_majority",
      expectedEntryIds: E,
      marks: [{ entryId: "e1", value: 1 }, { entryId: "e2", value: 1 }, { entryId: "e3", value: 3 }],
    });
    expect(codes(r)).toContain("COMP_BALLOT_JUDGE_TIE");
    if (!r.ok) expect(r.errors.find((e) => e.code === "COMP_BALLOT_JUDGE_TIE")?.decisionId).toBe("D-OM-4");
  });
  it("rejects partial rankings (D-OM-5)", () => {
    const r = validateBallot({ scoringMethod: "ordinal_majority", expectedEntryIds: E, marks: [{ entryId: "e1", value: 1 }, { entryId: "e2", value: 2 }] });
    expect(codes(r)).toEqual(["COMP_BALLOT_INCOMPLETE"]);
  });
  it.each([0, 4, 1.5, "1", null, NaN, -1])("rejects out-of-range/non-integer rank %s", (v) => {
    const r = validateBallot({
      scoringMethod: "ordinal_majority",
      expectedEntryIds: E,
      marks: [{ entryId: "e1", value: v }, { entryId: "e2", value: 2 }, { entryId: "e3", value: 3 }],
    });
    expect(codes(r)).toContain("COMP_BALLOT_MARK_OUT_OF_RANGE");
  });
  it("rejects duplicate marks, unknown entries and roles", () => {
    const full = [{ entryId: "e1", value: 1 }, { entryId: "e2", value: 2 }, { entryId: "e3", value: 3 }];
    expect(codes(validateBallot({ scoringMethod: "ordinal_majority", expectedEntryIds: E, marks: [{ entryId: "e1", value: 2 }, ...full] }))).toContain("COMP_BALLOT_DUPLICATE_MARK");
    expect(codes(validateBallot({ scoringMethod: "ordinal_majority", expectedEntryIds: E, marks: [{ entryId: "zz", value: 1 }, ...full] }))).toContain("COMP_BALLOT_UNKNOWN_ENTRY");
    expect(codes(validateBallot({ scoringMethod: "ordinal_majority", expectedEntryIds: E, marks: [{ entryId: "e1", role: "leader", value: 1 }, full[1], full[2]] }))).toContain("COMP_BALLOT_ROLE_NOT_ALLOWED");
  });
  it("a single-entry heat ranks 1", () => {
    expect(validateBallot({ scoringMethod: "ordinal_majority", expectedEntryIds: ["e1"], marks: [{ entryId: "e1", value: 1 }] }).ok).toBe(true);
  });
});

describe("proficiency_rating ballots", () => {
  it("accepts one band per entry", () => {
    const r = validateBallot({
      scoringMethod: "proficiency_rating",
      expectedEntryIds: E,
      marks: [{ entryId: "e1", value: "Gold" }, { entryId: "e2", value: "Gold" }, { entryId: "e3", value: "Bronze" }],
    });
    expect(r.ok).toBe(true);
  });
  it.each(["gold", "G", "No rating", "", 1, null])("rejects %s (D-PR-3, exact labels only)", (v) => {
    const r = validateBallot({
      scoringMethod: "proficiency_rating",
      expectedEntryIds: E,
      marks: [{ entryId: "e1", value: v }, { entryId: "e2", value: "Silver" }, { entryId: "e3", value: "Silver" }],
    });
    expect(codes(r)).toEqual(["COMP_BALLOT_MARK_NOT_IN_SCALE"]);
  });
  it("requires every entry (D-PR-5)", () => {
    expect(codes(validateBallot({ scoringMethod: "proficiency_rating", expectedEntryIds: E, marks: [{ entryId: "e1", value: "Gold" }] }))).toEqual([
      "COMP_BALLOT_INCOMPLETE",
      "COMP_BALLOT_INCOMPLETE",
    ]);
  });
});

describe("fail-closed schemes", () => {
  it("refuses callback_tally (D-CT-1/D-CT-2)", () => {
    const r = validateBallot({ scoringMethod: "callback_tally", expectedEntryIds: E, marks: [{ entryId: "e1", value: true }] });
    expect(r).toMatchObject({ ok: false, errors: [{ code: "COMP_BALLOT_SCHEME_NOT_AVAILABLE", decisionId: "D-CT-1/D-CT-2" }] });
  });
  it("refuses unknown methods and empty heats", () => {
    expect(codes(validateBallot({ scoringMethod: "relative_placement", expectedEntryIds: E, marks: [] }))).toEqual(["COMP_BALLOT_SCORING_METHOD_UNSUPPORTED"]);
    expect(codes(validateBallot({ scoringMethod: "ordinal_majority", expectedEntryIds: [], marks: [] }))).toEqual(["COMP_BALLOT_NO_ENTRIES"]);
  });
  it("every provisional rule names a decision", () => {
    for (const r of PROVISIONAL_RULES) expect(r.decisionId.length).toBeGreaterThan(0);
  });
});

describe("canonical serialization", () => {
  it("matches the K0 canonicalJson golden output", () => {
    expect(canonicalJson({ b: 1, a: [{ z: undefined, y: null, x: "s" }] })).toBe('{"a":[{"x":"s","y":null}],"b":1}');
    expect(() => canonicalJson({ a: Infinity })).toThrow();
  });
  const base = { officialId: "o1", roundId: "r", heatId: "h", version: 1, source: "judge_web" as const };
  it("is independent of mark order", () => {
    const a = canonicalBallot({ ...base, marks: [{ entryId: "e1", value: 1 }, { entryId: "e2", value: 2 }] });
    const b = canonicalBallot({ ...base, marks: [{ entryId: "e2", value: 2 }, { entryId: "e1", value: 1 }] });
    expect(a).toBe(b);
    expect(a).toBe(
      '{"heat_id":"h","marks":[{"entry_id":"e1","role":null,"value":1},{"entry_id":"e2","role":null,"value":2}],"official_id":"o1","round_id":"r","source":"judge_web","version":1}',
    );
  });
  it("changes when any content changes", () => {
    const m = [{ entryId: "e1", value: 1 }];
    expect(canonicalBallot({ ...base, marks: m })).not.toBe(canonicalBallot({ ...base, version: 2, marks: m }));
    expect(canonicalBallot({ ...base, marks: m })).not.toBe(canonicalBallot({ ...base, marks: [{ entryId: "e1", value: 2 }] }));
  });
  it("engine marks use current ballots only", () => {
    const b1: BallotRecord = { ...base, id: "b1", supersedesId: null, marks: [{ entryId: "e1", value: 1 }] };
    const b2: BallotRecord = { ...base, id: "b2", version: 2, supersedesId: "b1", marks: [{ entryId: "e1", value: 2 }] };
    expect(currentBallots([b1, b2]).map((b) => b.id)).toEqual(["b2"]);
    expect(currentBallotsToEngineMarks([b2, b1])).toEqual([{ officialId: "o1", entryId: "e1", role: null, value: 2 }]);
  });
});
