import { describe, expect, it } from "vitest";
import { buildFloorPlan } from "../../floorPlanner";
import { STUDIO_CUSTOM_V3_DEFAULTS as P } from "../studioCustomV3";
import {
  chooseAdjudication,
  choosePurpose,
  chooseStyle,
  deriveDraft,
  formatCategories,
  formatStyleOptions,
  initialAnswers,
  restoreAnswers,
  selectAllCategoryDances,
  stepErrors,
  toggleDivisionValue,
  toggleFormatDance,
  toggleFormatStyle,
  updateFormat,
  type SetupAnswers,
} from "../draft";
import { TEST_EVENT, withDivisions, withOfferings } from "./divisionTestHelpers";

/**
 * 10C.5 NDCA Multi-Dance (III.A.3.b): one entry dances an explicit prescribed set of one primary style's dances, in
 * the style's order. It is never expanded into Single-Dance entries, combined results are not computed, and the
 * category cannot open registration yet.
 */

const CONTEXT = { eventName: "Spring Classic", profileKey: "studio_simple", profileVersion: 3, requestKey: "request-key-0001" };

function ballroom(): SetupAnswers {
  return chooseAdjudication(chooseStyle(choosePurpose(initialAnswers(undefined, TEST_EVENT), P, "competition"), P, "ballroom"), "ballroom", "adjudicated");
}

function proAmMulti(dances: string[]): SetupAnswers {
  let answers = toggleFormatStyle(withOfferings(ballroom(), P, "ballroom", ["ndca_pro_am_multi"]), P, "ballroom", "ndca_pro_am_multi", "american_smooth");
  answers = updateFormat(answers, "ballroom", "ndca_pro_am_multi", { dances: [], amount: "60" });
  for (const dance of dances) answers = toggleFormatDance(answers, P, "ballroom", "ndca_pro_am_multi", dance);
  answers = toggleDivisionValue(answers, P, "ballroom", "ndca_pro_am_multi", "skill_level", "Bronze");
  return toggleDivisionValue(answers, P, "ballroom", "ndca_pro_am_multi", "age_group", "B");
}

describe("NDCA Multi-Dance offerings", () => {
  it("Single-Dance and Multi-Dance are distinct offerings, both source-cited", () => {
    expect(P.categoryTypes.ndca_pro_am).toMatchObject({ label: "Pro/Am Single-Dance", event_form: "single_dance", contest_type: "single_dance", dance_selection_mode: "individual" });
    expect(P.categoryTypes.ndca_pro_am_multi).toMatchObject({
      label: "Pro/Am Multi-Dance", event_form: "multi_dance", contest_type: "multi_dance", dance_selection_mode: "prescribed_set",
      entry_format: "pro_am", min_dances: 2, default_pricing: "per_entry",
    });
    expect(P.categoryTypes.ndca_amateur_multi).toMatchObject({ label: "Amateur Multi-Dance", event_form: "multi_dance", entry_format: "couple" });
    expect(P.categoryTypes.ndca_pro_am_multi.sources?.map((source) => source.section)).toEqual(["III.A.3.b", "II.B.7.f"]);
    expect(P.categoryTypes.ndca_pro_am_multi.pricing_models).not.toContain("per_dance");
    for (const definition of Object.values(P.categoryTypes)) {
      if (definition.contest_type === "multi_dance") expect(definition.event_form).toBe("multi_dance");
    }
  });

  it("only the four primary styles: no organizer-added dances, no nine- or ten-dance events", () => {
    expect(formatStyleOptions(P, "ballroom", "ndca_pro_am_multi").map((style) => style.key)).toEqual(["international_standard", "international_latin", "american_smooth", "american_rhythm"]);
    const answers = withOfferings(ballroom(), P, "ballroom", ["ndca_pro_am_multi"]);
    expect(toggleFormatStyle(answers, P, "ballroom", "ndca_pro_am_multi", "american_additional")).toBe(answers);
    expect(P.categoryTypes.ndca_pro_am_multi.future_requirements?.map((rule) => rule.key)).toEqual(
      expect.arrayContaining(["ndca_ten_dance", "ndca_multi_dance_recalls", "ndca_multi_dance_result", "ndca_omit_dance_early_rounds", "ndca_closed_multi_dance_winner"]),
    );
  });

  it("the set is danced in the style's order whatever order it was picked in, and stays inside its style", () => {
    const answers = proAmMulti(["smooth_foxtrot", "smooth_waltz", "smooth_tango"]);
    expect(formatCategories(P, "ballroom", "ndca_pro_am_multi", answers.programs.ballroom.formats.ndca_pro_am_multi!)[0].dances).toEqual(["smooth_waltz", "smooth_tango", "smooth_foxtrot"]);
    expect(toggleFormatDance(answers, P, "ballroom", "ndca_pro_am_multi", "rhythm_cha_cha")).toBe(answers);
  });

  it("one entry represents the prescribed set: one category, one payload category, never Single-Dance entries", () => {
    const draft = deriveDraft(proAmMulti(["smooth_foxtrot", "smooth_waltz"]), P, CONTEXT);
    expect(draft.errors).toEqual({});
    expect(draft.payload!.programs[0].categories).toEqual([
      expect.objectContaining({ type: "ndca_pro_am_multi", style: "american_smooth", dances: ["smooth_waltz", "smooth_foxtrot"], pricing: { model: "per_entry", amount: 60 } }),
    ]);
    expect(draft.payload!.programs[0].categories.some((category) => category.type === "ndca_pro_am")).toBe(false);
    expect(draft.counts).toMatchObject({ categories: 1, divisions: 1 });
    const review = draft.programs[0].categories[0];
    expect(review).toMatchObject({ label: "Pro/Am Multi-Dance — American Smooth", multiDance: true, dances: ["Waltz", "Foxtrot"] });
    expect(review.registrationHold).toContain("combined results and accumulated-mark recalls (NDCA III.D.44) are not computed");
    expect(draft.payload!.programs[0].categories[0].divisions[0].name).toBe("Bronze · B");
  });

  it("a set needs at least two dances", () => {
    expect(stepErrors(proAmMulti(["smooth_waltz"]), P, "dances")).toEqual([
      "A Multi-Dance set needs at least 2 dances: choose more for Ballroom Pro/Am Multi-Dance — American Smooth.",
    ]);
  });

  it("A–S4 are Multi-Dance age categories: required for Pro/Am Multi-Dance, not offered for Single-Dance", () => {
    let multi = toggleFormatStyle(withOfferings(ballroom(), P, "ballroom", ["ndca_pro_am_multi"]), P, "ballroom", "ndca_pro_am_multi", "american_smooth");
    multi = toggleDivisionValue(multi, P, "ballroom", "ndca_pro_am_multi", "skill_level", "Silver");
    expect(stepErrors(multi, P, "divisions")).toContain("Choose at least one multi-dance age category for Ballroom Pro/Am Multi-Dance.");
    const single = withOfferings(ballroom(), P, "ballroom", ["ndca_pro_am"], ["american_smooth"]);
    expect(toggleDivisionValue(single, P, "ballroom", "ndca_pro_am", "age_group", "B")).toBe(single);
  });

  it("Open Amateur is Multi-Dance only and dances every dance of its style (NDCA X.B.4)", () => {
    const single = withOfferings(ballroom(), P, "ballroom", ["ndca_amateur"], ["international_latin"]);
    expect(toggleDivisionValue(single, P, "ballroom", "ndca_amateur", "skill_level", "Open Amateur")).toBe(single);
    let answers = toggleFormatStyle(withOfferings(ballroom(), P, "ballroom", ["ndca_amateur_multi"]), P, "ballroom", "ndca_amateur_multi", "international_latin");
    answers = updateFormat(answers, "ballroom", "ndca_amateur_multi", { dances: ["latin_cha_cha", "latin_rumba"] });
    answers = toggleDivisionValue(answers, P, "ballroom", "ndca_amateur_multi", "skill_level", "Open Amateur");
    answers = toggleDivisionValue(answers, P, "ballroom", "ndca_amateur_multi", "age_group", "Adult");
    expect(stepErrors(answers, P, "dances")).toEqual(["Open Amateur dances every International Latin dance: choose all 5 for Ballroom Amateur Multi-Dance — International Latin."]);
    answers = selectAllCategoryDances(answers, P, "ballroom", "ndca_amateur_multi", "international_latin");
    expect(stepErrors(answers, P, "dances")).toEqual([]);
    expect(formatCategories(P, "ballroom", "ndca_amateur_multi", answers.programs.ballroom.formats.ndca_amateur_multi!)[0].dances).toEqual(
      ["latin_cha_cha", "latin_samba", "latin_rumba", "latin_paso_doble", "latin_jive"],
    );
    answers = toggleDivisionValue(answers, P, "ballroom", "ndca_amateur_multi", "skill_level", "Open Amateur");
    answers = toggleDivisionValue(answers, P, "ballroom", "ndca_amateur_multi", "skill_level", "Novice");
    answers = toggleFormatDance(answers, P, "ballroom", "ndca_amateur_multi", "latin_jive");
    expect(stepErrors(answers, P, "dances")).toEqual([]);
  });

  it("the set survives persistence and a refresh unchanged", () => {
    const answers = proAmMulti(["smooth_tango", "smooth_waltz"]);
    expect(restoreAnswers(JSON.parse(JSON.stringify(answers)), P)).toEqual(answers);
  });

  it("schedules as one heat holding the whole set in order (10D prescribed-set planning)", () => {
    const dances = [
      { id: "d1", dance_key: "smooth_waltz", name: "Waltz" },
      { id: "d2", dance_key: "smooth_tango", name: "Tango" },
      { id: "d3", dance_key: "smooth_foxtrot", name: "Foxtrot" },
    ];
    const plan = buildFloorPlan({
      contests: [{ id: "c1", name: "Pro/Am Multi-Dance — American Smooth", contest_type: "multi_dance" }],
      divisions: [{ id: "v1", name: "Bronze · B", contest_id: "c1", program_id: "p1" }],
      rules: [{ contest_id: "c1", dance_selection_mode: P.categoryTypes.ndca_pro_am_multi.dance_selection_mode }],
      rounds: [{ id: "r1", division_id: "v1", sequence_number: 1, round_type: "final" }],
      dances,
      // create_competition_draft writes the set's offerings in style order (sort_order 10, 20, 30).
      offerings: dances.map((dance, index) => ({ id: `o${index}`, division_id: "v1", dance_id: dance.id, sort_order: (index + 1) * 10 })),
      entries: ["e1", "e2"].map((id) => ({ id, division_id: "v1", display_name: id, entry_number: null, status: "confirmed", eligibility_status: "eligible" })),
      entryDances: [],
      participants: [],
    });
    const heats = plan.floorHeats.flatMap((floor) => floor.scoringHeats);
    expect(heats).toHaveLength(1);
    expect(heats[0]).toMatchObject({ danceIds: ["d1", "d2", "d3"], entryIds: ["e1", "e2"], musicKey: "set:smooth_waltz,smooth_tango,smooth_foxtrot" });
  });

  it("no rule is presented as operational that is not", () => {
    for (const format of ["ndca_pro_am_multi", "ndca_amateur_multi"]) {
      const definition = P.categoryTypes[format];
      expect(definition.registration_hold?.key).toBe("multi_dance_results_not_operational");
      for (const rule of definition.future_requirements ?? []) expect(rule.sources[0]?.section, rule.key).toBeTruthy();
    }
    const draft = deriveDraft(withDivisions(proAmMulti(["smooth_waltz", "smooth_tango"]), P), P, CONTEXT);
    expect(draft.programs[0].categories[0].registrationHold).toContain("no official advancement or combined result is produced");
    expect(draft.programs[0].categories[0].rounds).toEqual(["Final"]);
  });
});
