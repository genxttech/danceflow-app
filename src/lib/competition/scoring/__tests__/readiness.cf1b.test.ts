import { describe, expect, it } from "vitest";
import { callbackTargetMinimumReadiness } from "../studioReadiness";

const round = (over: Partial<Parameters<typeof callbackTargetMinimumReadiness>[0]["rounds"][number]>) => ({
  id: "r1", division_id: "d1", program_id: "p1", name: "Callbacks", round_type: "preliminary", sequence_number: 1, target_advancement_count: 1, ...over,
});
const final = { id: "r2", division_id: "d1", program_id: "p1", name: "Final", round_type: "final", sequence_number: 2, target_advancement_count: null };
const programs = [{ id: "p1", advancement_method: "promote_callback" }];

describe("CF1 B: readiness refusal for a callback target below two (OD-21)", () => {
  it("refuses an existing target of 1 on a guarded round and says what to do", () => {
    const findings = callbackTargetMinimumReadiness({ rounds: [round({}), final], programs });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ roundId: "r1", target: 1 });
    expect(findings[0].detail).toMatch(/2 or more/);
  });

  it("also refuses 0", () => {
    expect(callbackTargetMinimumReadiness({ rounds: [round({ target_advancement_count: 0 }), final], programs })).toHaveLength(1);
  });

  it("passes 2 and above, and a target that is not set (that has its own readiness row)", () => {
    expect(callbackTargetMinimumReadiness({ rounds: [round({ target_advancement_count: 2 }), final], programs })).toEqual([]);
    expect(callbackTargetMinimumReadiness({ rounds: [round({ target_advancement_count: null }), final], programs })).toEqual([]);
  });

  it("is out of scope for a Final-only division, a program that is not promote_callback, and a preliminary without a successor Final (U77)", () => {
    expect(callbackTargetMinimumReadiness({ rounds: [{ ...final, target_advancement_count: 1, sequence_number: 1 }], programs })).toEqual([]);
    expect(callbackTargetMinimumReadiness({ rounds: [round({}), final], programs: [{ id: "p1", advancement_method: "none" }] })).toEqual([]);
    expect(callbackTargetMinimumReadiness({ rounds: [round({})], programs })).toEqual([]);
  });
});
