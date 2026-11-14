import { describe, expect, it } from "vitest";
import { runStudioCallbackTally as cb } from "../studioCallbackTally";
import { runStudioOrdinalMajority as om } from "../studioOrdinalMajority";
import { callbackInput, entryKey as e, expectFail, expectOk, officialId, ordinalInput } from "./helpers";

const SEL = [[11, 12, 13, 14], [11, 12, 13, 15], [11, 12, 14, 16]];
const ENTRIES = [11, 12, 13, 14, 15, 16, 17, 18];

describe("reviewer findings (P1-1, P1-2, P2-4)", () => {
  it("duplicate excluded entries are refused, so conflicting reasons cannot make hashes order-dependent", () => {
    const input = callbackInput(SEL, ENTRIES, 4, 8);
    const f = expectFail(cb({ ...input, context: { ...input.context, excludedEntries: [{ entryId: e(18), reason: "scratched" }, { entryId: e(18), reason: "no_show" }] } }));
    expect(f.reason).toBe("duplicate_excluded_entry");
    const o = ordinalInput({ 11: [1, 1, 1], 12: [2, 2, 2] });
    expect(expectFail(om({ ...o, context: { ...o.context, excludedEntries: [{ entryId: e(12), reason: "scratched" }, { entryId: e(12), reason: "no_show" }] } })).reason).toBe("duplicate_excluded_entry");
  });
  it("duplicate heat ids are refused", () => {
    const input = callbackInput(SEL, ENTRIES, 4, 8);
    const f = expectFail(cb({ ...input, context: { ...input.context, heats: [input.context.heats[0], input.context.heats[0]] } }));
    expect(f.reason).toBe("duplicate_heat");
  });
  it("heat entries outside the round are refused", () => {
    const input = callbackInput(SEL, ENTRIES, 4, 8);
    const f = expectFail(cb({ ...input, context: { ...input.context, heats: [{ ...input.context.heats[0], entryIds: ["zz"] }] } }));
    expect(f.reason).toBe("heat_entry_not_in_round");
  });
  it("duplicate marks with different values: failure hashes do not depend on input order", () => {
    const input = callbackInput(SEL, ENTRIES, 4, 8);
    const extra = [{ officialId: officialId(1), entryId: e(11), value: true }, { officialId: officialId(1), entryId: e(11), value: "alternate" }];
    const a = cb({ ...input, marks: [...input.marks, extra[0], extra[1]] });
    const b = cb({ ...input, marks: [...input.marks, extra[1], extra[0]] });
    expect(expectFail(a).traceHash).toBe(expectFail(b).traceHash);
    expect(expectFail(a).inputHash).toBe(expectFail(b).inputHash);
  });
  it("X-3 option flags refuse a callback round that is not danced", () => {
    const input = callbackInput([[], [], []], [11, 12], 2, null);
    expect(expectFail(cb({ ...input, context: { ...input.context, chiefJudgeTiebreak: true } })).reason).toBe("x3_option_unsupported");
    expect(expectOk(cb(input)).rows).toHaveLength(2);
  });
});
