import { describe, expect, it } from "vitest";
import { finalCapacityTargets, type FinalCapacityRound } from "../finalCapacity";

const round = (over: Partial<FinalCapacityRound>): FinalCapacityRound => ({
  id: "x", name: "Round", division_id: "d1", sequence_number: 1, round_type: "preliminary", scoring_method: "callback_tally",
  status: "draft", configuration: null, target_advancement_count: 6, ...over,
});
const callback = round({ id: "cb", name: "Callback" });
const final = round({ id: "f", name: "Final", sequence_number: 2, round_type: "final", scoring_method: "skating_final", status: "scheduled", configuration: { max_entries_per_heat: 12 } });

describe("CF1 B5/B6: Final capacity form targets", () => {
  it("lists a callback target Final with no heat, with its current capacity and callback target", () => {
    expect(finalCapacityTargets([callback, final], new Set())).toEqual([{ roundId: "f", name: "Final", capacity: 12, callbackStatus: "draft", callbackTarget: 6 }]);
  });
  it("defaults the capacity when the round has no configured size", () => {
    expect(finalCapacityTargets([callback, { ...final, configuration: null }], new Set())[0].capacity).toBe(8);
  });
  it("omits a Final that already has a heat, has started, or follows a non-callback round", () => {
    expect(finalCapacityTargets([callback, final], new Set(["f"]))).toEqual([]);
    expect(finalCapacityTargets([callback, { ...final, status: "active" }], new Set())).toEqual([]);
    expect(finalCapacityTargets([{ ...callback, scoring_method: "skating_prelim" }, final], new Set())).toEqual([]);
    expect(finalCapacityTargets([callback, { ...final, division_id: "d2" }], new Set())).toEqual([]);
    expect(finalCapacityTargets([final], new Set())).toEqual([]);
  });
  it("ignores a non-final round after a callback", () => {
    expect(finalCapacityTargets([callback, { ...final, round_type: "semi_final" }], new Set())).toEqual([]);
  });
});
