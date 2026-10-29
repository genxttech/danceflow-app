import { describe, expect, it } from "vitest";
import { canonicalBallot, canonicalJson, currentBallots, currentBallotsToEngineMarks, type BallotRecord } from "../canonical";
import { ballotFormatForScoring, findBallotFormat } from "../formats";
import { PROVISIONAL_RULES, validateBallot, validateCallbackBallot } from "../schemes";

const E = ["e1", "e2", "e3"];
const OR = { id: "ordinal_rank", version: 1 };
const TB = { id: "three_band", version: 1 };
const codes = (r: ReturnType<typeof validateBallot>) => (r.ok ? [] : r.errors.map((e) => e.code));

describe("ordinal_majority ballots", () => {
  it("accepts a full 1..N ranking and returns marks in entry order", () => {
    const r = validateBallot({
      format: OR,
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
      format: OR,
      expectedEntryIds: E,
      marks: [{ entryId: "e1", value: 1 }, { entryId: "e2", value: 1 }, { entryId: "e3", value: 3 }],
    });
    expect(codes(r)).toContain("COMP_BALLOT_JUDGE_TIE");
    if (!r.ok) expect(r.errors.find((e) => e.code === "COMP_BALLOT_JUDGE_TIE")?.decisionId).toBe("D-OM-4");
  });
  it("rejects partial rankings (D-OM-5)", () => {
    const r = validateBallot({ format: OR, expectedEntryIds: E, marks: [{ entryId: "e1", value: 1 }, { entryId: "e2", value: 2 }] });
    expect(codes(r)).toEqual(["COMP_BALLOT_INCOMPLETE"]);
  });
  it.each([0, 4, 1.5, "1", null, NaN, -1])("rejects out-of-range/non-integer rank %s", (v) => {
    const r = validateBallot({
      format: OR,
      expectedEntryIds: E,
      marks: [{ entryId: "e1", value: v }, { entryId: "e2", value: 2 }, { entryId: "e3", value: 3 }],
    });
    expect(codes(r)).toContain("COMP_BALLOT_MARK_OUT_OF_RANGE");
  });
  it("rejects duplicate marks, unknown entries and roles", () => {
    const full = [{ entryId: "e1", value: 1 }, { entryId: "e2", value: 2 }, { entryId: "e3", value: 3 }];
    expect(codes(validateBallot({ format: OR, expectedEntryIds: E, marks: [{ entryId: "e1", value: 2 }, ...full] }))).toContain("COMP_BALLOT_DUPLICATE_MARK");
    expect(codes(validateBallot({ format: OR, expectedEntryIds: E, marks: [{ entryId: "zz", value: 1 }, ...full] }))).toContain("COMP_BALLOT_UNKNOWN_ENTRY");
    expect(codes(validateBallot({ format: OR, expectedEntryIds: E, marks: [{ entryId: "e1", role: "leader", value: 1 }, full[1], full[2]] }))).toContain("COMP_BALLOT_ROLE_NOT_ALLOWED");
  });
  it("a single-entry heat ranks 1", () => {
    expect(validateBallot({ format: OR, expectedEntryIds: ["e1"], marks: [{ entryId: "e1", value: 1 }] }).ok).toBe(true);
  });
});

describe("three_band@1 (Gold/Silver/Bronze) is not approved", () => {
  it("fails closed for any marks", () => {
    const r = validateBallot({
      format: TB,
      expectedEntryIds: E,
      marks: [{ entryId: "e1", value: "Gold" }, { entryId: "e2", value: "Gold" }, { entryId: "e3", value: "Bronze" }],
    });
    expect(r).toMatchObject({ ok: false, errors: [{ code: "COMP_BALLOT_FORMAT_NOT_APPROVED" }] });
  });
  it("is registered but not approved; callback_yes and ordinal_rank are approved", () => {
    expect(findBallotFormat("three_band", 1)?.approved).toBe(false);
    expect(findBallotFormat("ordinal_rank", 1)?.approved).toBe(true);
    expect(findBallotFormat("callback_yes", 1)?.approved).toBe(true);
    expect(ballotFormatForScoring("proficiency_rating")).toEqual({ id: "three_band", version: 1 });
  });
});

describe("fail-closed schemes", () => {
  it("callback ballots are round-level: the per-heat validator refuses them", () => {
    const r = validateBallot({ format: { id: "callback_yes", version: 1 }, expectedEntryIds: E, marks: [{ entryId: "e1", value: true }] });
    expect(r).toMatchObject({ ok: false, errors: [{ code: "COMP_BALLOT_HEAT_INVALID" }] });
  });
  it("refuses unregistered formats and empty heats", () => {
    expect(codes(validateBallot({ format: { id: "ucwdc_proamm", version: 1 }, expectedEntryIds: E, marks: [] }))).toEqual(["COMP_BALLOT_SCORING_METHOD_UNSUPPORTED"]);
    expect(codes(validateBallot({ format: OR, expectedEntryIds: [], marks: [] }))).toEqual(["COMP_BALLOT_NO_ENTRIES"]);
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
  const base = { officialId: "o1", roundId: "r", heatId: "h" as string | null, ballotFormat: "ordinal_rank@1", version: 1, source: "judge_web" as const };
  it("is independent of mark order", () => {
    const a = canonicalBallot({ ...base, marks: [{ entryId: "e1", value: 1 }, { entryId: "e2", value: 2 }] });
    const b = canonicalBallot({ ...base, marks: [{ entryId: "e2", value: 2 }, { entryId: "e1", value: 1 }] });
    expect(a).toBe(b);
    expect(a).toBe(
      '{"ballot_format":"ordinal_rank@1","heat_id":"h","marks":[{"entry_id":"e1","role":null,"value":1},{"entry_id":"e2","role":null,"value":2}],"official_id":"o1","round_id":"r","source":"judge_web","version":1}',
    );
  });
  it("changes when any content changes", () => {
    const m = [{ entryId: "e1", value: 1 }];
    expect(canonicalBallot({ ...base, marks: m })).not.toBe(canonicalBallot({ ...base, version: 2, marks: m }));
    expect(canonicalBallot({ ...base, marks: m })).not.toBe(canonicalBallot({ ...base, ballotFormat: "three_band@1", marks: m }));
    expect(canonicalBallot({ ...base, heatId: null, marks: m })).toContain('"heat_id":null');
    expect(canonicalBallot({ ...base, marks: m })).not.toBe(canonicalBallot({ ...base, marks: [{ entryId: "e1", value: 2 }] }));
  });
  it("engine marks use current ballots only", () => {
    const b1: BallotRecord = { ...base, id: "b1", supersedesId: null, marks: [{ entryId: "e1", value: 1 }] };
    const b2: BallotRecord = { ...base, id: "b2", version: 2, supersedesId: "b1", marks: [{ entryId: "e1", value: 2 }] };
    expect(currentBallots([b1, b2]).map((b) => b.id)).toEqual(["b2"]);
    expect(currentBallotsToEngineMarks([b2, b1])).toEqual([{ officialId: "o1", entryId: "e1", role: null, value: 2 }]);
  });
});

describe("callback ballots (owner-approved D-CT-1 / D-CT-2 / D-CT-5)", () => {
  const eligible = ["a", "b", "c", "d", "e"];
  const run = (target: number | null, selected: string[]) => validateCallbackBallot({ target, eligibleEntryIds: eligible, selectedEntryIds: selected });
  it("accepts exactly T eligible couples across the round", () => {
    expect(run(2, ["d", "a"])).toEqual({ ok: true, entryIds: ["a", "d"] });
  });
  it("refuses fewer or more than T", () => {
    for (const sel of [[], ["a"], ["a", "b", "c"]]) {
      const r = run(2, sel);
      expect(r).toMatchObject({ ok: false, errors: [{ code: "COMP_CALLBACK_COUNT", decisionId: "D-CT-2" }] });
    }
  });
  it("refuses ineligible couples and duplicates", () => {
    expect(run(2, ["a", "zz"])).toMatchObject({ ok: false, errors: [{ code: "COMP_BALLOT_UNKNOWN_ENTRY" }] });
    expect(run(2, ["a", "a"])).toMatchObject({ ok: false, errors: [{ code: "COMP_BALLOT_DUPLICATE_MARK" }] });
  });
  it("refuses when T is unset", () => {
    expect(run(null, ["a"])).toMatchObject({ ok: false, errors: [{ code: "COMP_CALLBACK_TARGET_UNSET" }] });
  });
  it("refuses when T is not smaller than the eligible couples (round not danced)", () => {
    expect(run(5, eligible)).toMatchObject({ ok: false, errors: [{ code: "COMP_CALLBACK_NOT_DANCED", decisionId: "D-CT-5" }] });
    expect(run(6, eligible)).toMatchObject({ ok: false, errors: [{ code: "COMP_CALLBACK_NOT_DANCED" }] });
  });
});
