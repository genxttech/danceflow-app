import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCORING_REGISTRY, selectableMethods } from "../registry";
import {
  STUDIO_PRESETS,
  legacyValueFor,
  planStudioScoring,
  resolvePreset,
  selectablePresets,
  type ConfigureInput,
  type SetupOp,
  type SetupRound,
} from "../studioSetup";
import { buildHeatPlan } from "../../heatPlanner";
import { publishScoringBlockers, studioScoringReadiness, type ReadinessRound } from "../studioReadiness";

const draftProgram = { id: "p1", status: "draft", profile_locked_at: null, rules_profile_key: "studio_simple" };
const finalOnly = (over: Partial<SetupRound> = {}): SetupRound => ({
  id: "r-final", name: "Final", round_type: "final", sequence_number: 1, scoring_method: "custom", status: "draft", pairing_mode: "fixed",
  scoring_override_key: null, scoring_override_version: null, ...over,
});
const input = (over: Partial<ConfigureInput> = {}): ConfigureInput => ({
  presetKey: "callbacks_final",
  program: draftProgram,
  division: { id: "d1", scoring_method_key: null, scoring_method_version: null },
  rounds: [finalOnly()],
  entryCount: 0,
  ...over,
});

/** Applies a plan to an in-memory division, as the server action does, to prove idempotency. */
function apply(ops: SetupOp[], rounds: SetupRound[], division: ConfigureInput["division"]) {
  const next = rounds.map((r) => ({ ...r }));
  const div = { ...division };
  for (const op of ops) {
    if (op.op === "set_division_selection") { div.scoring_method_key = op.key; div.scoring_method_version = op.version; }
    else if (op.op === "update_round") Object.assign(next.find((r) => r.id === op.roundId)!, op.patch);
    else next.push({ id: `new-${next.length}`, status: "draft", ...op.row });
  }
  return { rounds: next, division: div };
}

describe("SS1 presets resolve only through approved registry methods", () => {
  it("offers exactly the two studio presets and resolves their methods, legacy values and ballot formats", () => {
    expect(selectablePresets().map((p) => p.key)).toEqual(["callbacks_final", "final_only"]);
    const cf = resolvePreset("callbacks_final");
    expect(cf.ok && cf.slots.map((s) => [s.slot, s.engineId, s.legacy, s.ballotFormat])).toEqual([
      ["callback", "studio_callback_tally@1", "callback_tally", "callback_yes@1"],
      ["final", "studio_ordinal_majority@1", "ordinal_majority", "ordinal_rank@1"],
    ]);
  });

  it("never names a method that is not approved and selectable", () => {
    const selectable = new Set(selectableMethods().map((m) => `${m.key}@${m.version}`));
    for (const preset of STUDIO_PRESETS) for (const slot of preset.slots) expect(selectable.has(`${slot.key}@${slot.version}`)).toBe(true);
    for (const entry of SCORING_REGISTRY.filter((e) => e.status !== "approved")) {
      expect(selectable.has(`${entry.key}@${entry.version}`)).toBe(false);
      expect(STUDIO_PRESETS.some((p) => p.slots.some((s) => s.key === entry.key))).toBe(false);
    }
  });

  it("refuses every preset key that is not one of the listed studio presets (UCWDC, proficiency, NDCA, WSDC, injection)", () => {
    for (const key of ["ucwdc_majority_rules", "ucwdc_majority_rules@v16.9b", "proficiency_rating", "proficiency", "ndca_skating", "wsdc_relative_placement", "majority_rules", "", "__proto__", "callbacks_final ", "CALLBACKS_FINAL"]) {
      const r = resolvePreset(key);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.code).toBe("COMP_SCORING_PRESET_UNKNOWN");
      expect(planStudioScoring(input({ presetKey: key })).ok).toBe(false);
    }
  });

  it("has a legacy value only for approved studio methods (the rejected proficiency key is not a selectable scoring value)", () => {
    expect(legacyValueFor("studio_callback_tally", "1")).toBe("callback_tally");
    expect(legacyValueFor("studio_ordinal_majority", "1")).toBe("ordinal_majority");
    expect(legacyValueFor("ucwdc_majority_rules", "v16.9b")).toBeNull();
    expect(legacyValueFor("ndca_skating", "unpinned")).toBeNull();
  });
});

describe("SS1 planning", () => {
  it("callbacks + final from a Final-only division: selection, Final moved to 2 and rescored, callback round inserted at 1 with the override", () => {
    const plan = planStudioScoring(input());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.ops).toEqual([
      { op: "update_round", roundId: "r-final", patch: { sequence_number: 2, scoring_method: "ordinal_majority", scoring_override_key: null, scoring_override_version: null } },
      { op: "insert_round", row: { name: "Callback round", round_type: "preliminary", sequence_number: 1, scoring_method: "callback_tally", pairing_mode: "fixed", scoring_override_key: "studio_callback_tally", scoring_override_version: "1" } },
      { op: "set_division_selection", key: "studio_ordinal_majority", version: "1" },
    ]);
    // The move frees sequence 1 before the insert uses it (unique(division_id, sequence_number)).
    expect(plan.ops.findIndex((o) => o.op === "update_round")).toBeLessThan(plan.ops.findIndex((o) => o.op === "insert_round"));
  });

  it("is idempotent: re-planning an already configured division writes nothing", () => {
    const first = planStudioScoring(input());
    if (!first.ok) throw new Error("plan failed");
    const after = apply(first.ops, [finalOnly()], input().division);
    const again = planStudioScoring(input({ rounds: after.rounds, division: after.division }));
    expect(again).toEqual({ ok: true, ops: [], programAdvancement: "promote_callback" });
    const done = planStudioScoring(input({ rounds: after.rounds, division: after.division, program: { ...draftProgram, advancement_method: "promote_callback" } }));
    expect(done).toEqual({ ok: true, ops: [], programAdvancement: null });
  });

  it("final only: rescoring the Final and selecting ordinal majority, no extra round", () => {
    const plan = planStudioScoring(input({ presetKey: "final_only" }));
    expect(plan.ok && plan.ops.map((o) => o.op)).toEqual(["update_round", "set_division_selection"]);
  });

  it("refuses a locked, published or non-draft program and never reshapes it (S4-7)", () => {
    for (const program of [
      { ...draftProgram, profile_locked_at: "2026-10-01T00:00:00Z" },
      { ...draftProgram, status: "configured" },
      { ...draftProgram, status: "open" },
    ]) {
      const r = planStudioScoring(input({ program }));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.code).toBe("COMP_SCORING_PROGRAM_LOCKED");
    }
  });

  it("refuses non-studio programs, divisions with entries, started rounds and customised round structures", () => {
    const code = (over: Partial<ConfigureInput>) => { const r = planStudioScoring(input(over)); return r.ok ? "ok" : r.code; };
    expect(code({ program: { ...draftProgram, rules_profile_key: null } })).toBe("COMP_SCORING_NOT_STUDIO");
    expect(code({ entryCount: 1 })).toBe("COMP_SCORING_DIVISION_HAS_ENTRIES");
    expect(code({ rounds: [finalOnly({ status: "scheduled" })] })).toBe("COMP_SCORING_ROUND_STARTED");
    expect(code({ rounds: [finalOnly(), finalOnly({ id: "r2", sequence_number: 2 })] })).toBe("COMP_SCORING_ROUNDS_CUSTOMIZED");
    expect(code({ rounds: [] })).toBe("COMP_SCORING_ROUNDS_CUSTOMIZED");
    expect(code({ rounds: [finalOnly({ scoring_method: "proficiency_rating" })] })).toBe("COMP_SCORING_ROUNDS_CUSTOMIZED");
    expect(code({ cancelledSequences: [2] })).toBe("COMP_SCORING_ROUNDS_CUSTOMIZED");
    expect(code({ presetKey: "final_only", rounds: [finalOnly({ id: "c", round_type: "preliminary" }), finalOnly({ sequence_number: 2 })] })).toBe("COMP_SCORING_ROUNDS_CUSTOMIZED");
  });
});

// ---------------------------------------------------------------------------------------------------------------
const division = (over: Record<string, unknown> = {}) => ({ id: "d1", program_id: "p1", name: "Newcomer", scoring_method_key: null as string | null, scoring_method_version: null as string | null, ...over });
const round = (over: Partial<ReadinessRound> = {}): ReadinessRound => ({
  id: "r1", division_id: "d1", name: "Final", round_type: "final", scoring_method: "ordinal_majority", status: "draft", scoring_override_key: null, scoring_override_version: null, ...over,
});
const report = (over: Partial<Parameters<typeof studioScoringReadiness>[0]> = {}) =>
  studioScoringReadiness({
    programs: [{ id: "p1", name: "Country", status: "draft", profile_locked_at: null, advancement_method: "promote_callback" }],
    divisions: [division({ scoring_method_key: "studio_ordinal_majority", scoring_method_version: "1" })],
    rounds: [round()],
    heatsByRound: new Map(),
    ...over,
  });

describe("SS1 readiness", () => {
  it("is clean for a configured callbacks + final division", () => {
    const r = report({
      rounds: [
        round({ id: "cb", name: "Callback round", round_type: "preliminary", scoring_method: "callback_tally", scoring_override_key: "studio_callback_tally", scoring_override_version: "1" }),
        round(),
      ],
    });
    expect(r.blockers).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(r.configuredRounds).toBe(2);
  });

  it("blocks a selected method whose legacy ballot-driving value disagrees (stale or half-applied setup)", () => {
    const r = report({ rounds: [round({ scoring_method: "custom" })] });
    expect(r.blockers.map((b) => b.code)).toEqual(["COMP_SCORING_LEGACY_MISMATCH"]);
  });

  it("blocks a method that cannot produce the round's purpose (callback tally on a Final)", () => {
    const r = report({ divisions: [division({ scoring_method_key: "studio_callback_tally", scoring_method_version: "1" })], rounds: [round({ scoring_method: "callback_tally" })] });
    expect(r.blockers.map((b) => b.code)).toEqual(["COMP_METHOD_PURPOSE_MISMATCH", "COMP_SCORING_CALLBACK_CONFIG"]);
    const ordinalOnPrelim = report({ rounds: [round({ round_type: "preliminary" })] });
    expect(ordinalOnPrelim.blockers.map((b) => b.code)).toEqual(["COMP_METHOD_PURPOSE_MISMATCH"]);
  });

  it("blocks an unavailable selection on a draft (defence in depth behind the database guard)", () => {
    const r = report({ divisions: [division({ scoring_method_key: "ucwdc_majority_rules", scoring_method_version: "v16.9b" })] });
    expect(r.blockers.map((b) => b.code)).toEqual(["COMP_ENGINE_NOT_AVAILABLE"]);
    const unknown = report({ divisions: [division({ scoring_method_key: "nope", scoring_method_version: "1" })] });
    expect(unknown.blockers.map((b) => b.code)).toEqual(["COMP_METHOD_UNKNOWN"]);
  });

  it("blocks an ordinal round with more than one heat, and only more than one", () => {
    expect(report({ heatsByRound: new Map([["r1", 1]]) }).blockers).toEqual([]);
    expect(report({ heatsByRound: new Map([["r1", 2]]) }).blockers.map((b) => b.code)).toEqual(["COMP_ORDINAL_MULTI_HEAT"]);
  });

  it("treats unscored rounds as nothing to calculate and unsupported rounds as non-blocking notices", () => {
    const none = report({ divisions: [division()], rounds: [round({ scoring_method: "none" }), round({ id: "r2", scoring_method: "feedback_only" })] });
    expect(none.blockers).toEqual([]);
    expect(none.notices).toEqual([]);
    const medal = report({ divisions: [division()], rounds: [round({ scoring_method: "custom" })] });
    expect(medal.blockers).toEqual([]);
    expect(medal.notices.map((n) => n.code)).toEqual(["COMP_SCORING_NO_METHOD"]);
    const ratings = report({ divisions: [division()], rounds: [round({ scoring_method: "proficiency_rating" })] });
    expect(ratings.blockers).toEqual([]);
    expect(ratings.notices).toHaveLength(1);
  });

  it("the legacy wizard Placements/Callbacks programs (no selection) stay ready: the legacy map is approved", () => {
    const r = report({ divisions: [division()], rounds: [round()] });
    expect(r.blockers).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(r.configuredRounds).toBe(1);
  });

  it("locked programs get notices, never blockers, for missing or unusable pins (no silent rewrite)", () => {
    const programs = [{ id: "p1", name: "Country", status: "configured", profile_locked_at: "2026-10-01T00:00:00Z" }];
    const unpinned = report({ programs, effective: new Map() });
    expect(unpinned.blockers).toEqual([]);
    expect(unpinned.notices.map((n) => n.code)).toEqual(["COMP_SCORING_NOT_PINNED"]);
    const rejected = report({ programs, effective: new Map([["r1", { method_key: "proficiency_rating", method_version: "1", selectable: false, pinned: true, registry_status: "rejected" }]]) });
    expect(rejected.blockers).toEqual([]);
    expect(rejected.notices.map((n) => n.code)).toEqual(["COMP_ENGINE_NOT_AVAILABLE"]);
    const custom = report({ programs, divisions: [division()], rounds: [round({ scoring_method: "custom" })] });
    expect(custom.blockers).toEqual([]);
    expect(custom.notices.map((n) => n.code)).toEqual(["COMP_SCORING_LOCKED_UNSUPPORTED"]);
    const pinned = report({ programs, effective: new Map([["r1", { method_key: "studio_ordinal_majority", method_version: "1", selectable: true, pinned: true, registry_status: "approved" }]]) });
    expect(pinned.blockers).toEqual([]);
    expect(pinned.notices).toEqual([]);
  });

  it("a locked round whose live scoring value was edited away from its pin is a blocker (wrong ballots)", () => {
    const programs = [{ id: "p1", name: "Country", status: "configured", profile_locked_at: "2026-10-01T00:00:00Z" }];
    const r = report({ programs, rounds: [round({ scoring_method: "callback_tally" })], effective: new Map([["r1", { method_key: "studio_ordinal_majority", method_version: "1", selectable: true, pinned: true, registry_status: "approved" }]]) });
    expect(r.blockers.map((b) => b.code)).toEqual(["COMP_SCORING_LEGACY_MISMATCH"]);
  });

  it("publishScoringBlockers only returns the program's own blockers", () => {
    const r = report({ rounds: [round({ scoring_method: "custom" })] });
    expect(publishScoringBlockers(r, "p1")).toHaveLength(1);
    expect(publishScoringBlockers(r, "other")).toHaveLength(0);
  });
});

describe("SS1 heat planning: ordinal majority is a single-heat method", () => {
  const start = "2026-11-01T10:00:00.000Z";
  const plan = (capacity: number, scoring_method: string) =>
    buildHeatPlan({
      eventId: "e",
      scheduleVersionId: "v",
      seed: "seed-1",
      contests: [{ id: "c1", name: "Country", contest_type: "single_dance" }],
      divisions: [{ id: "d1", contest_id: "c1", name: "Bronze" }],
      rounds: [{ id: "r1", division_id: "d1", name: "Final", round_type: "final", sequence_number: 1, target_advancement_count: null, scoring_method }],
      dances: [{ id: "w", dance_key: "waltz", name: "Waltz" }],
      offerings: [{ division_id: "d1", dance_id: "w", required: true, sort_order: 1 }],
      entries: ["a", "b", "c", "d", "e"].map((id) => ({ id, division_id: "d1", display_name: id.toUpperCase(), entry_number: null })),
      entryDances: [],
      participants: [],
      blocks: [{ id: "b1", name: "Morning", starts_at: start, ends_at: "2026-11-01T12:00:00.000Z", floor_id: "f1", floor_name_snapshot: "Main", floor_capacity_snapshot: capacity }],
      assignments: [{ block_id: "b1", contest_id: "c1", planned_round_type: null, sort_order: 1 }],
      constraints: [],
    });

  it("blocks a plan that would split an ordinal-majority round over several heats", () => {
    const multi = plan(2, "ordinal_majority");
    expect(multi.conflicts.some((c) => c.conflict_type === "round" && c.severity === "blocker")).toBe(true);
  });

  it("allows the same round in one heat, and does not apply the rule to other scoring values", () => {
    expect(plan(5, "ordinal_majority").conflicts.filter((c) => c.conflict_type === "round")).toEqual([]);
    expect(plan(2, "custom").conflicts.filter((c) => c.conflict_type === "round")).toEqual([]);
  });
});

describe("SS1 readiness heat counting across schedule versions is done by the loader (largest per-version count)", () => {
  it("the loader takes the max per version, not the sum", () => {
    const src = readFileSync(join(__dirname, "..", "studioReadinessServer.ts"), "utf8");
    expect(src).toContain("Math.max(...versions.values())");
  });
});

// Mirror of the F1 callback-tally precondition (results/engines/studioCallbackTally.ts V2; F2 passes advancementMethod from the
// PROGRAM row). Kept here as the contract SS1 must satisfy; the full-stack run exercises the real engine.
const engineAcceptsCallbackRound = (roundType: string, programAdvancement: string | null | undefined) =>
  roundType === "preliminary" && programAdvancement === "promote_callback";

describe("SS1 callback preset yields a program the callback engine accepts", () => {
  it("sets the callback round to preliminary and asks for the program advancement_method promote_callback", () => {
    const plan = planStudioScoring(input({ program: { ...draftProgram, advancement_method: "none" } }));
    if (!plan.ok) throw new Error("plan failed");
    const after = apply(plan.ops, [finalOnly()], input().division);
    const callback = after.rounds.find((r) => r.scoring_method === "callback_tally")!;
    expect(plan.programAdvancement).toBe("promote_callback");
    // once the action writes the program value, the engine precondition holds
    expect(engineAcceptsCallbackRound(callback.round_type, plan.programAdvancement)).toBe(true);
    // without that write (the defect: wizard programs start as "none") the engine refuses the round
    expect(engineAcceptsCallbackRound(callback.round_type, "none")).toBe(false);
  });

  it("final-only never touches the program advancement_method", () => {
    const plan = planStudioScoring(input({ presetKey: "final_only", program: { ...draftProgram, advancement_method: "none" } }));
    expect(plan.ok && plan.programAdvancement).toBeNull();
  });

  it("readiness blocks a callback round in a draft whose program is not promote_callback, and only notices on a published one", () => {
    const cb = round({ id: "cb", name: "Callback round", round_type: "preliminary", scoring_method: "callback_tally", scoring_override_key: "studio_callback_tally", scoring_override_version: "1" });
    const draft = report({ rounds: [cb, round()], programs: [{ id: "p1", name: "Country", status: "draft", profile_locked_at: null, advancement_method: "none" }] });
    expect(draft.blockers.map((b) => b.code)).toEqual(["COMP_SCORING_CALLBACK_CONFIG"]);
    const locked = report({
      rounds: [cb, round()],
      programs: [{ id: "p1", name: "Country", status: "configured", profile_locked_at: "2026-10-01T00:00:00Z", advancement_method: "none" }],
      effective: new Map([
        ["cb", { method_key: "studio_callback_tally", method_version: "1", selectable: true, pinned: true, registry_status: "approved" }],
        ["r1", { method_key: "studio_ordinal_majority", method_version: "1", selectable: true, pinned: true, registry_status: "approved" }],
      ]),
    });
    expect(locked.blockers).toEqual([]);
    expect(locked.notices.map((n) => n.code)).toEqual(["COMP_SCORING_CALLBACK_CONFIG"]);
    const wrongType = report({ rounds: [{ ...cb, round_type: "qualifying" }, round()] });
    expect(wrongType.blockers.map((b) => b.code)).toContain("COMP_SCORING_CALLBACK_CONFIG");
  });
});
