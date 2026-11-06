import { describe, expect, it } from "vitest";
import { ENGINE_INPUT_CAPS } from "../common";
import { runStudioCallbackTally } from "../studioCallbackTally";
import { runStudioOrdinalMajority } from "../studioOrdinalMajority";
import { callbackInput, entryKey as e, expectFail, expectOk, officialId, ordinalInput } from "./helpers";

// Independent security review of PR 337: P2-2 (chain / profile), P2-3 (input caps), P2-4 (heat coverage).

const F01 = [
  [11, 12, 13, 14],
  [11, 12, 13, 15],
  [11, 12, 14, 16],
];
const ENTRIES = [11, 12, 13, 14, 15, 16, 17, 18];
const OM = { 11: [1, 2, 1], 12: [2, 1, 2], 13: [3, 3, 3] };

describe("P2-2 callback engine fails closed on an unsupported tie-break chain or profile", () => {
  it("the empty chain on studio_simple@1 and @3 runs", () => {
    expectOk(runStudioCallbackTally(callbackInput(F01, ENTRIES, 4, 8)));
    expectOk(runStudioCallbackTally(callbackInput(F01, ENTRIES, 4, 8, { profile: { key: "studio_simple", version: 3 } })));
  });
  it("a non-empty chain is COMP_ENGINE_UNSPECIFIED_CASE / tie_break_chain_unsupported, no rows", () => {
    const f = expectFail(runStudioCallbackTally(callbackInput(F01, ENTRIES, 4, 8, { tieBreakChain: ["random_draw"] })));
    expect([f.code, f.reason]).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "tie_break_chain_unsupported"]);
    expect(f.trace.at(-1)?.step).toBe("failure");
  });
  it("also when every couple advances and the round is not danced (the chain is never silently dropped)", () => {
    const f = expectFail(runStudioCallbackTally(callbackInput(F01, ENTRIES, 8, 8, { tieBreakChain: ["random_draw"] })));
    expect(f.reason).toBe("tie_break_chain_unsupported");
  });
  it("another profile or an unknown version is profile_unsupported", () => {
    for (const profile of [
      { key: "ndca_skating", version: 1 },
      { key: "studio_simple", version: 2 },
      { key: "studio_simple", version: 99 },
    ]) {
      const f = expectFail(runStudioCallbackTally(callbackInput(F01, ENTRIES, 4, 8, { profile })));
      expect([f.code, f.reason]).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "profile_unsupported"]);
    }
  });
});

describe("P2-2 ordinal engine fails closed on an unsupported tie-break chain or profile", () => {
  it("a non-empty chain and a foreign profile are refused", () => {
    expectOk(runStudioOrdinalMajority(ordinalInput(OM)));
    const f = expectFail(runStudioOrdinalMajority(ordinalInput(OM, { tieBreakChain: ["skating_rule_11"] })));
    expect([f.code, f.reason]).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "tie_break_chain_unsupported"]);
    const g = expectFail(runStudioOrdinalMajority(ordinalInput(OM, { profile: { key: "wdsc", version: 3 } })));
    expect(g.reason).toBe("profile_unsupported");
  });
});

describe("P2-3 input size caps fail closed before the calculation", () => {
  const big = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it("too many entries", () => {
    const input = ordinalInput(OM);
    const ids = big(ENGINE_INPUT_CAPS.entries + 1, "x");
    const f = expectFail(runStudioOrdinalMajority({ ...input, entries: ids.map((entryId) => ({ entryId })) }));
    expect([f.code, f.reason, f.inputHash]).toEqual(["COMP_ENGINE_INVALID_INPUT", "input_too_large", null]);
  });
  it("too many marks, judges, heats, dances, excluded entries and chain entries", () => {
    const input = ordinalInput(OM);
    const marks = Array.from({ length: ENGINE_INPUT_CAPS.marks + 1 }, () => ({ officialId: officialId(1), entryId: e(11), value: 1 }));
    expect(expectFail(runStudioOrdinalMajority({ ...input, marks })).reason).toBe("input_too_large");
    const judges = big(ENGINE_INPUT_CAPS.judges + 1, "j").map((id) => ({ officialId: id, letter: id }));
    expect(expectFail(runStudioOrdinalMajority({ ...input, judges })).reason).toBe("input_too_large");
    const heats = big(ENGINE_INPUT_CAPS.heats + 1, "h").map((heatId) => ({ heatId, officialIds: [], entryIds: [] }));
    expect(expectFail(runStudioOrdinalMajority({ ...input, context: { ...input.context, heats } })).reason).toBe("input_too_large");
    expect(expectFail(runStudioOrdinalMajority({ ...input, context: { ...input.context, danceIds: big(ENGINE_INPUT_CAPS.danceIds + 1, "d") } })).reason).toBe("input_too_large");
    const excludedEntries = big(ENGINE_INPUT_CAPS.excludedEntries + 1, "x").map((entryId) => ({ entryId, reason: "scratched" as const }));
    expect(expectFail(runStudioOrdinalMajority({ ...input, context: { ...input.context, excludedEntries } })).reason).toBe("input_too_large");
    expect(expectFail(runStudioOrdinalMajority({ ...input, tieBreakChain: big(ENGINE_INPUT_CAPS.tieBreakChain + 1, "c") })).reason).toBe("input_too_large");
  });
  it("an oversized id", () => {
    const input = callbackInput(F01, ENTRIES, 4, 8);
    const f = expectFail(runStudioCallbackTally({ ...input, entries: [...input.entries, { entryId: "z".repeat(ENGINE_INPUT_CAPS.idLength + 1) }] }));
    expect([f.code, f.reason]).toEqual(["COMP_ENGINE_INVALID_INPUT", "input_too_large"]);
  });
  it("the failure trace names the field and the cap but carries no input data; a null collection is malformed, not a crash", () => {
    const input = ordinalInput(OM);
    const f = expectFail(runStudioOrdinalMajority({ ...input, marks: big(ENGINE_INPUT_CAPS.marks + 1, "m") as never }));
    const record = f.trace.at(-1)!;
    expect(JSON.stringify(record.data)).toContain('"field":"marks"');
    expect(JSON.stringify(record.data)).not.toContain("m49999");
    const g = expectFail(runStudioOrdinalMajority({ ...input, marks: null as never }));
    expect([g.code, g.reason]).toEqual(["COMP_ENGINE_INVALID_INPUT", "malformed_input"]);
  });
  it("inputs at the caps are not refused for size", () => {
    const input = ordinalInput(OM);
    const run = runStudioOrdinalMajority({ ...input, context: { ...input.context, danceIds: big(ENGINE_INPUT_CAPS.danceIds, "d") } });
    expect(run.ok ? "ok" : (run as { reason: string }).reason).not.toBe("input_too_large");
  });
});

describe("P2-4 every calculated entry is in exactly one heat", () => {
  const cb = () => callbackInput(F01, ENTRIES, 4, 8);
  const heatOf = (input: ReturnType<typeof cb>, entryIds: string[], heatId: string) => ({ heatId, officialIds: input.context.heats[0].officialIds, entryIds });

  it("a calculated entry missing from every heat is entry_heat_coverage naming it", () => {
    const input = cb();
    const f = expectFail(
      runStudioCallbackTally({ ...input, context: { ...input.context, heats: [{ ...input.context.heats[0], entryIds: input.context.heats[0].entryIds.filter((id) => id !== e(18)) }] } }),
    );
    expect([f.code, f.reason, f.offendingIds]).toEqual(["COMP_ENGINE_INVALID_INPUT", "entry_heat_coverage", [e(18)]]);
  });
  it("an entry in two heats is entry_heat_coverage naming it", () => {
    const input = cb();
    const all = input.context.heats[0].entryIds;
    const f = expectFail(
      runStudioCallbackTally({
        ...input,
        context: { ...input.context, heats: [heatOf(input, all, "heat-1"), heatOf(input, [e(11)], "heat-2")] },
      }),
    );
    expect([f.reason, f.offendingIds]).toEqual(["entry_heat_coverage", [e(11)]]);
  });
  it("the same entry listed twice in one heat is entry_heat_coverage", () => {
    const input = cb();
    const f = expectFail(
      runStudioCallbackTally({ ...input, context: { ...input.context, heats: [{ ...input.context.heats[0], entryIds: [...input.context.heats[0].entryIds, e(12)] }] } }),
    );
    expect([f.reason, f.offendingIds]).toEqual(["entry_heat_coverage", [e(12)]]);
  });
  it("an excluded entry may stay on a heat roster or be off it, and a disjoint split over two heats with one panel reaches the later multi-heat rule", () => {
    const input = ordinalInput(OM);
    const ctx = input.context;
    const withExcluded = runStudioOrdinalMajority({ ...input, entries: [...input.entries, { entryId: "e-gone" }], context: { ...ctx, excludedEntries: [{ entryId: "e-gone", reason: "no_show" }] } });
    expect(withExcluded.ok || withExcluded.reason !== "entry_heat_coverage").toBe(true);
    const split = expectFail(
      runStudioOrdinalMajority({ ...input, context: { ...ctx, heats: [{ ...ctx.heats[0], entryIds: [e(11)] }, { ...ctx.heats[0], heatId: "heat-2", entryIds: [e(12), e(13)] }] } }),
    );
    expect(split.reason).not.toBe("entry_heat_coverage");
  });
});

describe("contract alignment: approved refusals win over the coverage check; profile allow-list is @1/@3 only (X-1)", () => {
  const cb = () => callbackInput(F01, ENTRIES, 4, 8);
  it("a multi-dance round whose entries sit on two heats reports X-6 multi_dance_unsupported, not entry_heat_coverage", () => {
    const input = cb();
    const all = input.context.heats[0].entryIds;
    const f = expectFail(
      runStudioCallbackTally({
        ...input,
        context: { ...input.context, danceIds: ["d1", "d2"], heats: [{ ...input.context.heats[0], entryIds: all }, { ...input.context.heats[0], heatId: "heat-2", entryIds: [e(11)] }] },
      }),
    );
    expect([f.code, f.reason]).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "multi_dance_unsupported"]);
  });
  it("heats with different panels report X-7 heat_panel_mismatch even when an entry is on two heats", () => {
    const input = cb();
    const all = input.context.heats[0].entryIds;
    const f = expectFail(
      runStudioCallbackTally({
        ...input,
        context: { ...input.context, heats: [{ ...input.context.heats[0], entryIds: all }, { heatId: "heat-2", officialIds: [officialId(1), officialId(2)], entryIds: [e(11)] }] },
      }),
    );
    expect([f.code, f.reason]).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "heat_panel_mismatch"]);
  });
  it.each([
    ["studio_simple@2 (never released)", { key: "studio_simple", version: 2 }],
    ["studio_simple@4 (no approved spec yet)", { key: "studio_simple", version: 4 }],
    ["another profile key", { key: "ndca_custom", version: 1 }],
  ])("%s is COMP_ENGINE_UNSPECIFIED_CASE / profile_unsupported", (_n, profile) => {
    for (const run of [runStudioCallbackTally(callbackInput(F01, ENTRIES, 4, 8, { profile })), runStudioOrdinalMajority(ordinalInput(OM, { profile }))]) {
      const f = expectFail(run);
      expect([f.code, f.reason]).toEqual(["COMP_ENGINE_UNSPECIFIED_CASE", "profile_unsupported"]);
    }
  });
});
