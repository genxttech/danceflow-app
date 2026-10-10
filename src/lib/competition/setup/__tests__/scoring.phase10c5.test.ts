import { describe, expect, it } from "vitest";
import { STUDIO_CUSTOM_V2_DEFAULTS as P } from "../studioCustomV2";
import { GOVERNING_BODY_REFERENCES, NDCA_REFERENCE, NOT_SPECIFIED, SCORING_ENGINES, UCWDC_REFERENCE, WSDC_REFERENCE, blockingConflicts } from "../scoringReference";
import type { ScoringModel } from "../types";

/**
 * 10C.5: proves the staged scoring contract can represent each supplied governing-body source without
 * flattening it, and that nothing is falsely marked implemented. These are reference descriptions only.
 */

const stage = (model: ScoringModel, key: string) => model.stages.find((item) => item.key === key)!;

describe("scoring stages", () => {
  it("scoring stages vary by round family", () => {
    expect(UCWDC_REFERENCE.stages.map((item) => `${item.key}:${item.family}:${item.ballot.input}`)).toEqual([
      "prelim:advancement:callback_yes_alternates",
      "semifinal:advancement:callback_retire",
      "final:final:medal_marks",
      "overall:overall:none",
    ]);
    expect(stage(UCWDC_REFERENCE, "prelim").direction).toBe("promote");
    expect(stage(UCWDC_REFERENCE, "semifinal").direction).toBe("retire");
  });

  it("UCWDC prelim, final and overall engines differ, with separate tie-break chains", () => {
    const engines = ["prelim", "final", "overall"].map((key) => stage(UCWDC_REFERENCE, key).engine.key);
    expect(engines).toEqual(["callback_tally", "majority_rules_medal", "majority_rules_overall"]);
    expect(stage(UCWDC_REFERENCE, "final").tie_break.chain.slice(0, 5)).toEqual(["R4 majority size", "R5 majority sum", "R6 look-ahead", "R7 look-behind", "R8 head-to-head"]);
    expect(stage(UCWDC_REFERENCE, "overall").tie_break.chain[0]).toBe("R10 head-to-head on placements");
  });

  it("WSDC prelim and final engines differ; the Chief Judge tie-break is prelim-only; prelims are scored by role", () => {
    const prelim = stage(WSDC_REFERENCE, "prelim");
    const final = stage(WSDC_REFERENCE, "final");
    expect(prelim.engine.key).toBe("callback_tally");
    expect(final.engine.key).toBe("relative_placement");
    expect(prelim.ballot).toMatchObject({ values: { yes: 10, alt1: 4.5, alt2: 4.3, alt3: 4.2, no: 0 }, scored_by: "role" });
    expect(prelim.tie_break.chain[0]).toContain("Chief Judge");
    expect(final.tie_break.chain).toEqual([NOT_SPECIFIED]);
  });

  it("engine parameters come from the profile/version, not the engine (UCWDC vs WSDC callback values differ)", () => {
    expect(stage(UCWDC_REFERENCE, "prelim").ballot.values).toEqual({ yes: 10.0, alt1: 5.0, alt2: 4.6, alt3: 4.3, alt4: 4.1, alt5: 4.0 });
    expect(stage(WSDC_REFERENCE, "prelim").ballot.values).not.toEqual(stage(UCWDC_REFERENCE, "prelim").ballot.values);
    expect(stage(UCWDC_REFERENCE, "prelim").engine.key).toBe(stage(WSDC_REFERENCE, "prelim").engine.key);
    expect(stage(UCWDC_REFERENCE, "overall").engine.params).toMatchObject({ ascension_weights: { waltz: 3, two_step: 3, solo_medley: 4 } });
  });

  it("more than one result output is representable, with a primary output", () => {
    expect(stage(UCWDC_REFERENCE, "final").outputs.map((output) => [output.type, output.primary])).toEqual([["placement", true], ["medal_threshold", false]]);
    expect(stage(WSDC_REFERENCE, "final").outputs.map((output) => output.type)).toEqual(["placement", "registry_points"]);
    expect(stage(UCWDC_REFERENCE, "prelim").outputs[0].type).toBe("advancement_ranking");
  });

  it("multiple penalty/adjudication stages are representable in order; NDCA raw and penalty-adjusted results are separate", () => {
    expect(NDCA_REFERENCE.adjudication_stages.map((item) => item.timing)).toEqual([
      "ballot_or_recall_alteration",
      "per_dance_final_adjustment",
      "post_multi_dance_adjustment",
      "post_result_adjustment",
    ]);
    expect(stage(NDCA_REFERENCE, "overall").outputs[0].label).toBe("Raw Skating result before penalties");
    expect(NDCA_REFERENCE.adjudication_stages.find((item) => item.timing === "post_multi_dance_adjustment")?.description).toContain("then adjust it to reflect penalties");
    expect(UCWDC_REFERENCE.adjudication_stages.map((item) => item.timing)).toEqual(["disqualification"]);
    expect(WSDC_REFERENCE.adjudication_stages).toEqual([]);
  });

  it("NDCA Skating is required but not defined by the rulebook, and is not implemented", () => {
    expect(stage(NDCA_REFERENCE, "final").engine).toMatchObject({ key: "skating_single", status: "not_implemented" });
    expect(stage(NDCA_REFERENCE, "overall").engine.key).toBe("skating_multi");
    expect(NDCA_REFERENCE.note).toContain("does not define the Skating algorithm");
  });

  it("source references are retained on stages and adjudication stages", () => {
    for (const model of Object.values(GOVERNING_BODY_REFERENCES)) {
      for (const item of model.stages) {
        expect(item.sources.length, item.key).toBeGreaterThan(0);
        for (const source of item.sources) expect(source.document && source.edition && source.section).toBeTruthy();
      }
      for (const item of model.adjudication_stages) expect(item.sources.length).toBeGreaterThan(0);
    }
    expect(stage(WSDC_REFERENCE, "prelim").sources[0]).toMatchObject({ document: "WSDC Registry Event Rules", edition: "Version 2026.1C" });
    expect(stage(UCWDC_REFERENCE, "final").sources[0]).toMatchObject({ edition: "2026 v16.9b" });
  });

  it("the NDCA Formation conflict is recorded unresolved and blocks activation", () => {
    const conflicts = blockingConflicts(NDCA_REFERENCE);
    expect(conflicts.map((conflict) => conflict.key)).toEqual(["ndca_formation_scoring"]);
    expect(conflicts[0].references.map((reference) => reference.section)).toEqual(["III.D.11", "XII.N.3"]);
    expect(conflicts[0]).toMatchObject({ status: "unresolved", material: true });
    expect(blockingConflicts(UCWDC_REFERENCE)).toEqual([]);
    expect(blockingConflicts(WSDC_REFERENCE)).toEqual([]);
  });

  it("no governing-body engine is marked implemented anywhere", () => {
    for (const [key, engine] of Object.entries(SCORING_ENGINES)) expect(engine.implemented, key).toBe(key === "none");
    for (const model of Object.values(GOVERNING_BODY_REFERENCES)) {
      for (const item of model.stages) expect(item.engine.status, item.key).toBe("not_implemented");
      expect(model.basis).toBe("governing_body_reference");
    }
    for (const judging of Object.values(P.judging)) {
      for (const item of judging.scoring.stages) expect(["placeholder", "not_applicable"]).toContain(item.engine.status);
    }
  });

  it("the Studio profile carries no governing-body reference model (references are not profiles)", () => {
    expect(JSON.stringify(P)).not.toMatch(/majority_rules|relative_placement|skating_|callback_tally|governing_body_reference/);
  });
});
