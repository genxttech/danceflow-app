import { describe, expect, it } from "vitest";
import {
  CALLBACK_TARGET_BELOW_MINIMUM_CODE,
  CALLBACK_TARGET_EXCEEDS_CAPACITY_CODE,
  CALLBACK_TARGET_MINIMUM,
  callbackTargetBelowMinimum,
  callbackTargetBelowMinimumFindings,
  callbackTargetBelowMinimumMessage,
  callbackTargetCheck,
  guardedCallbackRounds,
  parseCallbackTarget,
  type CallbackConfigurationRound,
} from "../callbackTarget";

const round = (over: Partial<CallbackConfigurationRound>): CallbackConfigurationRound => ({
  id: "r",
  division_id: "d1",
  program_id: "p1",
  name: "Callback",
  round_type: "preliminary",
  sequence_number: 1,
  target_advancement_count: null,
  ...over,
});
const final = (over: Partial<CallbackConfigurationRound> = {}) => round({ id: "f", name: "Final", round_type: "final", sequence_number: 2, ...over });
const programs = new Set(["p1"]);

describe("callbackTargetCheck (twin of _cf1_callback_target_check)", () => {
  it("refuses a target below two, checked before the capacity", () => {
    for (const t of [1, 0, -3]) expect(callbackTargetCheck(t, 8)).toBe(CALLBACK_TARGET_BELOW_MINIMUM_CODE);
    expect(callbackTargetCheck(1, 1)).toBe(CALLBACK_TARGET_BELOW_MINIMUM_CODE);
  });
  it("keeps the capacity refusal and allows 2..capacity and null", () => {
    expect(callbackTargetCheck(9, 8)).toBe(CALLBACK_TARGET_EXCEEDS_CAPACITY_CODE);
    for (const t of [2, 5, 8]) expect(callbackTargetCheck(t, 8)).toBeNull();
    expect(callbackTargetCheck(2, 2)).toBeNull();
    expect(callbackTargetCheck(null, 8)).toBeNull();
    expect(callbackTargetCheck(undefined, 8)).toBeNull();
  });
  it("uses the code the database raises", () => {
    expect(CALLBACK_TARGET_BELOW_MINIMUM_CODE).toBe("COMP_CALLBACK_TARGET_BELOW_MINIMUM");
    expect(CALLBACK_TARGET_MINIMUM).toBe(2);
  });
});

describe("callbackTargetBelowMinimum", () => {
  it("is true only for a set target below two", () => {
    expect(callbackTargetBelowMinimum(1)).toBe(true);
    expect(callbackTargetBelowMinimum(0)).toBe(true);
    expect(callbackTargetBelowMinimum(2)).toBe(false);
    expect(callbackTargetBelowMinimum(null)).toBe(false);
    expect(callbackTargetBelowMinimum(undefined)).toBe(false);
  });
});

describe("guardedCallbackRounds (the database guard scope)", () => {
  it("includes a preliminary round of a promote_callback program with a successor Final", () => {
    const rounds = [round({ target_advancement_count: 1 }), final()];
    expect(guardedCallbackRounds({ rounds, promoteCallbackProgramIds: programs }).map((r) => r.id)).toEqual(["r"]);
  });
  it("excludes a Final-only division, the Final itself and a one-couple Final-only division", () => {
    const rounds = [final({ sequence_number: 1, target_advancement_count: 1 })];
    expect(guardedCallbackRounds({ rounds, promoteCallbackProgramIds: programs })).toEqual([]);
  });
  it("excludes non-callback programs, non-preliminary rounds, a missing or non-adjacent Final and a Final in another division", () => {
    const base = round({ target_advancement_count: 1 });
    expect(guardedCallbackRounds({ rounds: [base, final()], promoteCallbackProgramIds: new Set(["other"]) })).toEqual([]);
    expect(guardedCallbackRounds({ rounds: [round({ round_type: "qualifying" }), final()], promoteCallbackProgramIds: programs })).toEqual([]);
    expect(guardedCallbackRounds({ rounds: [base], promoteCallbackProgramIds: programs })).toEqual([]);
    expect(guardedCallbackRounds({ rounds: [base, final({ sequence_number: 3 })], promoteCallbackProgramIds: programs })).toEqual([]);
    expect(guardedCallbackRounds({ rounds: [base, final({ round_type: "semifinal" })], promoteCallbackProgramIds: programs })).toEqual([]);
    expect(guardedCallbackRounds({ rounds: [base, final({ division_id: "d2" })], promoteCallbackProgramIds: programs })).toEqual([]);
  });
});

describe("callbackTargetBelowMinimumFindings", () => {
  it("reports only guarded rounds with a target below two", () => {
    const rounds = [
      round({ id: "a", target_advancement_count: 1 }),
      final(),
      round({ id: "b", division_id: "d2", target_advancement_count: 2 }),
      final({ id: "f2", division_id: "d2" }),
      round({ id: "c", division_id: "d3", target_advancement_count: null }),
      final({ id: "f3", division_id: "d3" }),
      round({ id: "d", division_id: "d4", round_type: "qualifying", target_advancement_count: 1 }),
      final({ id: "f4", division_id: "d4", sequence_number: 1, target_advancement_count: 1 }),
    ];
    expect(callbackTargetBelowMinimumFindings({ rounds, promoteCallbackProgramIds: programs }).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("parseCallbackTarget (OD-21 minimum)", () => {
  it("rejects 0 and 1 with the minimum message and accepts 2", () => {
    for (const bad of ["0", "1", " 1 "]) {
      expect(parseCallbackTarget(bad, 0)).toEqual({ ok: false, error: callbackTargetBelowMinimumMessage() });
    }
    expect(parseCallbackTarget("2", 0)).toEqual({ ok: true, value: 2 });
    expect(parseCallbackTarget("2", 3)).toEqual({ ok: true, value: 2 });
  });
  it("still clears on blank and keeps the below-entries bound", () => {
    expect(parseCallbackTarget("", 10)).toEqual({ ok: true, value: null });
    expect(parseCallbackTarget("10", 10).ok).toBe(false);
  });
  it("tells the organizer why", () => {
    expect(callbackTargetBelowMinimumMessage()).toContain("at least two couples");
  });
});
