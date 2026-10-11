import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STUDIO_CUSTOM_PROFILE, STUDIO_CUSTOM_V2_DEFAULTS as P } from "../studioCustomV2";
import { STUDIO_SIMPLE_V1_DEFAULTS } from "../../simple/studioSimpleV1";
import {
  PRICING_PENDING_TEXT,
  RULE_OPTIONS,
  activeProgramKeys,
  addCustomDance,
  addCustomDivisionValue,
  availableFormats,
  chooseAdjudication,
  chooseJudging,
  choosePurpose,
  chooseSingleStyleMode,
  chooseStyle,
  deriveDraft,
  formatJudging,
  initialAnswers,
  judgingSummary,
  nextStep,
  previousStep,
  programJudging,
  removeCustomDance,
  restoreAnswers,
  resumeStep,
  setFormatAdjudication,
  setPricing,
  setRegistration,
  setRegistrationFee,
  stepErrors,
  toggleDivisionValue,
  toggleFormat,
  updateFormat,
  visibleSteps,
  type SetupAnswers,
} from "../draft";
import { clearStoredSetup, loadStoredSetup, saveStoredSetup } from "../persistence";
import { TEST_DANCES, withDivisions, withOfferings } from "./divisionTestHelpers";

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const MIGRATION = join(ROOT, "src/lib/supabase/migrations/20261113090000_phase10c5_competition_draft.sql");
const CONTEXT = { eventName: "Spring Classic", profileKey: "studio_simple", profileVersion: 2, requestKey: "request-key-0001" };

/** Competition + Showcase / Performance in Country (adjudicated Medal Marks) with a Non-Adjudicated Showcase override. */
function fullAnswers(): SetupAnswers {
  let answers = choosePurpose(initialAnswers(), P, "competition_showcase");
  answers = chooseStyle(answers, P, "country");
  answers = chooseAdjudication(answers, "country", "adjudicated");
  answers = withOfferings(answers, P, "country", ["pro_am", "pro_pro", "couples", "showcase", "spotlight"]);
  answers = updateFormat(answers, "country", "pro_am", { amount: "25" });
  answers = setPricing(answers, P, "country", "pro_pro", "per_entry");
  answers = updateFormat(answers, "country", "pro_pro", { amount: "60" });
  answers = setPricing(answers, P, "country", "couples", "included");
  answers = setRegistrationFee(answers, "country", "40");
  answers = updateFormat(answers, "country", "showcase", { amount: "30", dances: ["two_step", "waltz"] });
  answers = setFormatAdjudication(answers, P, "country", "showcase", "non_adjudicated");
  answers = setPricing(answers, P, "country", "spotlight", "later");
  return withDivisions(setRegistration(answers, { opens: "2026-11-01", closes: "2026-12-01" }), P);
}

/** The offerings each test style chooses explicitly (the wizard pre-selects none). */
const TEST_OFFERINGS: Record<string, string[]> = {
  country: ["pro_am", "pro_pro", "couples"],
  west_coast_swing: ["jack_and_jill", "wcs_couples"],
  ballroom: ["ndca_pro_am", "ndca_amateur"],
  custom: ["studio_pro_am", "studio_couples"],
};

function competitionIn(style: string, adjudication: "adjudicated" | "non_adjudicated" = "adjudicated") {
  const answers = chooseAdjudication(chooseStyle(choosePurpose(initialAnswers(), P, "competition"), P, style), style, adjudication);
  return withOfferings(answers, P, style, TEST_OFFERINGS[style], style === "ballroom" ? ["american_smooth"] : []);
}

describe("studio_simple@2 profile (Studio / Custom Rules)", () => {
  it("the TypeScript mirror is byte-equal to the migration seed (drift guard)", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const seed = sql.match(/\$profile\$([\s\S]*?)\$profile\$/);
    expect(seed).not.toBeNull();
    expect(JSON.parse(seed![1])).toEqual(P);
    expect(STUDIO_CUSTOM_PROFILE).toEqual({ key: "studio_simple", version: 2 });
  });

  it("is a new append-only version: v1 is untouched and v2 is schema 2, unsanctioned", () => {
    expect((STUDIO_SIMPLE_V1_DEFAULTS as unknown as { schema: number }).schema).toBe(1);
    expect(P.schema).toBe(2);
    expect(P.sanction).toEqual({ status: "none", claimable: false });
    expect(P.label).toBe("Studio / Custom Rules");
  });

  it("entry formats are profile-derived per style; Showcase-type offerings live inside the style", () => {
    expect(P.programs.country.formats).toEqual(["pro_am", "pro_pro", "couples", "showcase", "spotlight", "solo", "team"]);
    expect(P.programs.west_coast_swing.formats).toEqual(["jack_and_jill", "wcs_couples", "wcs_pro_am", "routine"]);
    expect(P.programs.ballroom.formats).toEqual([
      "ndca_pro_am", "ndca_amateur", "ndca_mixed_amateur", "ndca_student_student", "ndca_professional", "ndca_mixed_professional",
      "ndca_solo_star", "ndca_showdance", "ndca_cabaret", "ndca_theatre_arts", "ndca_pro_am_theatrical", "ndca_pro_am_exhibition",
      "ndca_formation", "ndca_team_match",
    ]);
    expect(P.programs.custom.formats).toEqual(["studio_pro_am", "studio_pro_pro", "studio_couples", "studio_professional", "studio_jack_and_jill", "custom_routine", "studio_solo", "studio_team"]);
    expect(Object.keys(P.programs)).toEqual(["country", "west_coast_swing", "ballroom", "custom"]);
    // Nothing is recommended or pre-selected: the profile carries no recommendation lists.
    expect(JSON.stringify(P.programs)).not.toMatch(/recommended_/);
  });

  it("10C.4 relationship and lead/follow semantics are unchanged", () => {
    expect(P.categoryTypes.pro_am).toMatchObject({ entry_format: "pro_am", participant_roles: ["student", "professional"], dance_roles: "pair" });
    expect(P.categoryTypes.pro_pro).toMatchObject({ entry_format: "pro_pro", participant_roles: ["instructor", "professional"], dance_roles: "pair" });
    expect(P.categoryTypes.couples).toMatchObject({ participant_roles: ["dancer"], dance_roles: "pair" });
    expect(P.categoryTypes.ndca_professional).toMatchObject({ entry_format: "professional", participant_roles: ["professional"], dance_roles: "pair" });
    expect(P.categoryTypes.ndca_pro_am).toMatchObject({ entry_format: "pro_am", participant_roles: ["student", "professional"], dance_roles: "pair" });
    expect(P.categoryTypes.jack_and_jill).toMatchObject({ participant_roles: ["dancer"], dance_roles: "single" });
    expect(P.categoryTypes.team).toMatchObject({ participant_roles: ["team_member"] });
  });

  it("Country Showcase follows UCWDC: set music per dance, source-grounded, judged on interpretation", () => {
    const showcase = P.categoryTypes.showcase;
    expect(showcase.kind).toBe("special");
    expect(showcase.music_source.value).toBe("profile_defined");
    expect(showcase.music_source.basis).toBe("source_grounded");
    expect(showcase.music_source.sources?.[0]).toMatchObject({ section: "II.G.2.a", edition: "2026 (v1-26-2026)" });
    expect(showcase.uses_dances).toBe(true);
    expect(showcase.adjudication_override).toBe(true);
  });

  it("Country Spotlight follows UCWDC: competitor-selected music, ProAm / ProPro, 2½–4 minutes", () => {
    const spotlight = P.categoryTypes.spotlight;
    expect(spotlight.music_source.value).toBe("entry_selected");
    expect(spotlight.music_source.basis).toBe("source_grounded");
    expect(spotlight.music_source.sources?.map((source) => source.section)).toEqual(["II.A.20", "II.K.8"]);
    expect(spotlight.duration?.value).toEqual({ min_seconds: 150, max_seconds: 240 });
    expect(spotlight.participant_roles).toEqual(["student", "professional", "instructor"]);
    expect(spotlight.contest_type).toBe("spotlight");
  });

  it("does not assert floor counts the supplied UCWDC source never established", () => {
    for (const format of ["showcase", "spotlight"]) {
      expect(P.categoryTypes[format].floor_mode.value).toBe("not_specified");
      expect(P.categoryTypes[format].floor_mode.basis).toBe("not_specified");
      expect(P.categoryTypes[format].floor_mode.note).toContain("NOT SPECIFIED IN PROVIDED SOURCE");
    }
    const json = JSON.stringify(P);
    expect(json).not.toMatch(/multiple couples|several couples|one couple on the floor/i);
  });

  it("custom routines stay distinct from official terminology and are organizer-configurable", () => {
    const routine = P.categoryTypes.custom_routine;
    expect(routine.label).toBe("Choreographed Routine");
    expect(routine.music_source.basis).toBe("studio_recommendation");
    expect(routine.organizer_configurable).toEqual(["label", "music_source", "duration", "adjudication", "floor_mode", "program_placement"]);
    expect(P.programs.custom.formats).toContain("custom_routine");
    expect(P.programs.custom.formats).not.toContain("showcase");
    expect(P.programs.custom.formats).not.toContain("spotlight");
    for (const format of ["routine", "studio_solo", "solo"]) expect(P.categoryTypes[format].music_source.basis).toBe("studio_recommendation");
  });

  it("adjudicated result terms are per style: Country Medal Marks, Ballroom/WCS Placements, Other may rate", () => {
    expect(P.programs.country.judging_options).toEqual(["medal_marks"]);
    expect(P.programs.ballroom.judging_options).toEqual(["placements"]);
    expect(P.programs.west_coast_swing.judging_options).toEqual(["placements"]);
    expect(P.programs.custom.judging_options).toEqual(["placements", "ratings"]);
    const countryTerms = JSON.stringify([P.programs.country, P.judging.medal_marks]);
    expect(countryTerms).not.toMatch(/"Ratings"|Gold \/ Silver/);
  });

  it("Medal Marks are the judge input and Placement is the result -- never the same concept", () => {
    const medal = P.judging.medal_marks;
    const final = medal.scoring.stages.find((stage) => stage.family === "final")!;
    expect(final.ballot.input).toBe("medal_marks");
    expect(final.outputs).toEqual([{ type: "placement", primary: true }]);
    expect(medal.input_label).toBe("Medal Marks");
    expect(medal.result_label).toBe("Placement");
    expect(final.engine).toMatchObject({ key: "studio_placeholder", status: "placeholder" });
    expect(medal.engine.key).toBe("custom");
    expect(JSON.stringify(medal.scoring)).not.toContain("cumulative_points");
    expect(judgingSummary(medal)).toBe("Adjudicated · Judge input: Medal Marks · Final result: Placement");
  });

  it("Studio placeholders never claim a governing-body engine", () => {
    for (const key of ["placements", "medal_marks", "ratings"]) {
      for (const stage of P.judging[key].scoring.stages) {
        expect(stage.engine.key).toBe("studio_placeholder");
        expect(stage.engine.status).toBe("placeholder");
      }
      expect(P.judging[key].scoring.basis).toBe("studio_custom");
    }
    expect(P.judging.placements.scoring.note).toContain("not NDCA Skating or WSDC Relative Placement");
  });

  it("programming metadata separates source-grounded rules from Studio and owner knowledge", () => {
    const country = P.programs.country.programming;
    expect(country.hierarchy).toMatchObject({ value: ["level", "age", "dance"], basis: "owner_operational" });
    expect(country.dance_sequence.basis).toBe("source_grounded");
    expect(country.dance_sequence.value).toEqual(["triple_two", "nightclub", "waltz", "polka", "cha_cha", "east_coast_swing", "two_step", "west_coast_swing"]);
    expect(country.dance_sequence.sources?.[0]).toMatchObject({ section: "II.M.1.a-b" });
    expect(country.special_boundary).toMatchObject({ value: "age", basis: "owner_operational" });
    const ballroom = P.programs.ballroom.programming;
    expect(ballroom.hierarchy).toMatchObject({ value: ["style", "level", "age", "event"], basis: "owner_operational" });
    expect(ballroom.hierarchy.note).toContain("Not mandated by the supplied NDCA rules");
    expect(ballroom.dance_sequence).toMatchObject({ basis: "source_grounded" });
    expect(P.programs.ballroom.styles?.map((style) => style.label)).toEqual([
      "International Standard", "International Latin", "American Smooth", "American Rhythm", "Additional American Style Dances",
    ]);
    expect(ballroom.special_boundary.value).toBe("style");
    const wcs = P.programs.west_coast_swing.programming;
    expect(wcs.hierarchy).toMatchObject({ value: ["contest_format", "division", "round"], basis: "owner_operational" });
    expect(wcs.special_boundary.value).toBe("contest_format");
    expect(P.programs.custom.programming.hierarchy.basis).toBe("studio_recommendation");
  });

  it("special offerings run at program boundaries; regular formats run in the sequence", () => {
    for (const [key, format] of Object.entries(P.categoryTypes)) {
      expect(format.program_placement.value, key).toBe(format.kind === "special" ? "block_boundary" : "within_sequence");
    }
  });

  it("every sequenced dance exists in its style's pool", () => {
    for (const program of Object.values(P.programs)) {
      const pool = new Set(P.dancePools[program.dance_pool].map((dance) => dance.key));
      for (const dance of program.programming.dance_sequence.value) expect(pool.has(dance), dance).toBe(true);
    }
  });
});

describe("answers and steps", () => {
  it("only Studio / Custom Rules can be chosen; governing bodies are visible but unavailable", () => {
    expect(RULE_OPTIONS.filter((option) => option.available).map((option) => option.key)).toEqual(["studio_custom"]);
    expect(RULE_OPTIONS.filter((option) => !option.available).map((option) => option.label)).toEqual(["UCWDC", "WSDC", "NDCA"]);
    expect(initialAnswers().rules).toBe("studio_custom");
  });

  it("Showcase / Performance still asks Style and Adjudicated?; Sanction is never asked for Studio / Custom", () => {
    const showcase = chooseStyle(choosePurpose(initialAnswers(), P, "showcase"), P, "country");
    expect(visibleSteps(showcase, P)).toEqual(["purpose", "styles", "adjudication", "rules", "offerings", "divisions", "rounds", "registration", "pricing", "review"]);
    expect(visibleSteps(withOfferings(showcase, P, "country", ["showcase"]), P)).toContain("dances");
    expect(stepErrors(showcase, P, "adjudication")).toEqual(["Choose Adjudicated or Non-Adjudicated for Country."]);
    expect(visibleSteps(fullAnswers(), P)).not.toContain("sanction");
  });

  it("Showcase / Performance offers only performance formats and pre-selects none of them", () => {
    expect(availableFormats(P, "country", "showcase")).toEqual(["showcase", "spotlight", "solo", "team"]);
    expect(availableFormats(P, "ballroom", "showcase")).toEqual(["ndca_showdance", "ndca_cabaret", "ndca_theatre_arts", "ndca_pro_am_theatrical", "ndca_pro_am_exhibition", "ndca_formation"]);
    for (const purpose of ["competition", "showcase", "competition_showcase"] as const) {
      for (const style of Object.keys(P.programs)) {
        const answers = chooseStyle(choosePurpose(initialAnswers(), P, purpose), P, style);
        expect(answers.programs[style].formats, `${purpose} ${style}`).toEqual({});
      }
    }
    const answers = chooseStyle(choosePurpose(initialAnswers(), P, "showcase"), P, "country");
    expect(stepErrors(answers, P, "offerings")).toEqual(["Choose at least one offering for Country."]);
    expect(toggleFormat(answers, P, "country", "pro_am")).toBe(answers);
    const added = toggleFormat(answers, P, "country", "showcase").programs.country.formats.showcase!;
    expect(added).toMatchObject({ danceStyles: [], dances: [], divisions: { age_group: [] } });
  });

  it("an adjudicated Showcase / Performance is not forced to Non-Adjudicated", () => {
    let answers = chooseStyle(choosePurpose(initialAnswers(), P, "showcase"), P, "country");
    answers = chooseAdjudication(answers, "country", "adjudicated");
    answers = withOfferings(answers, P, "country", ["showcase", "spotlight"]);
    answers = updateFormat(answers, "country", "showcase", { amount: "30" });
    answers = updateFormat(answers, "country", "spotlight", { amount: "40" });
    const draft = deriveDraft(withDivisions(answers, P), P, CONTEXT);
    expect(draft.payload?.programs[0]).toMatchObject({ key: "country", adjudication: "adjudicated", judging: "medal_marks" });
    expect(draft.programs[0].categories.map((category) => category.judging)).toEqual([
      "Adjudicated · Judge input: Medal Marks · Final result: Placement",
      "Adjudicated · Judge input: Medal Marks · Final result: Placement",
    ]);
    expect(draft.programs[0].categories[0].rounds).toEqual(["Final"]);
  });

  it("changing purpose keeps the style and its offerings, adds none and drops what the purpose cannot offer", () => {
    let answers = withOfferings(chooseStyle(choosePurpose(initialAnswers(), P, "competition"), P, "country"), P, "country", ["pro_am", "pro_pro", "couples"]);
    answers = toggleDivisionValue(answers, P, "country", "pro_am", "age_group", "Platinum");
    answers = choosePurpose(answers, P, "competition_showcase");
    expect(Object.keys(answers.programs.country.formats)).toEqual(["pro_am", "pro_pro", "couples"]);
    expect(answers.programs.country.formats.pro_am?.divisions.age_group).toContain("Platinum");
    answers = withOfferings(answers, P, "country", ["spotlight"]);
    answers = choosePurpose(answers, P, "showcase");
    expect(Object.keys(answers.programs.country.formats)).toEqual(["spotlight"]);
  });

  it("one program per style; multiple styles; no separate showcase program", () => {
    let answers = choosePurpose(initialAnswers(), P, "competition_showcase");
    answers = chooseStyle(answers, P, "multiple");
    answers = chooseStyle(answers, P, "country");
    answers = chooseStyle(answers, P, "ballroom");
    expect(activeProgramKeys(answers, P)).toEqual(["country", "ballroom"]);
    expect(activeProgramKeys(chooseSingleStyleMode(answers, P), P)).toEqual(["country"]);
  });

  it("style-level adjudication is inherited; Showcase and Spotlight can override, ordinary formats cannot", () => {
    let answers = fullAnswers();
    expect(programJudging(answers, P, "country")).toBe("medal_marks");
    expect(formatJudging(answers, P, "country", "pro_am")).toBe("medal_marks");
    expect(formatJudging(answers, P, "country", "spotlight")).toBe("medal_marks");
    expect(formatJudging(answers, P, "country", "showcase")).toBe("non_adjudicated");
    expect(setFormatAdjudication(answers, P, "country", "pro_am", "non_adjudicated")).toBe(answers);
    answers = setFormatAdjudication(answers, P, "country", "spotlight", "non_adjudicated");
    expect(formatJudging(answers, P, "country", "spotlight")).toBe("non_adjudicated");
    let social = competitionIn("country", "non_adjudicated");
    social = withOfferings(choosePurpose(social, P, "competition_showcase"), P, "country", ["showcase"]);
    social = setFormatAdjudication(social, P, "country", "showcase", "adjudicated");
    expect(formatJudging(social, P, "country", "couples")).toBe("non_adjudicated");
    expect(formatJudging(social, P, "country", "showcase")).toBe("medal_marks");
  });

  it("Other may choose Gold / Silver / Bronze; Country and Ballroom cannot", () => {
    const other = chooseJudging(competitionIn("custom"), P, "custom", "ratings");
    expect(programJudging(other, P, "custom")).toBe("ratings");
    expect(judgingSummary(P.judging.ratings)).toBe("Adjudicated · Gold / Silver / Bronze ratings");
    const ballroom = competitionIn("ballroom");
    expect(chooseJudging(ballroom, P, "ballroom", "ratings")).toBe(ballroom);
    expect(judgingSummary(P.judging[programJudging(ballroom, P, "ballroom")])).toBe("Adjudicated · Placements");
    const country = competitionIn("country");
    expect(chooseJudging(country, P, "country", "placements")).toBe(country);
  });

  it("a stored answer with a result option the style does not offer is not used", () => {
    const tampered = competitionIn("country");
    tampered.programs.country.judging = "placements";
    expect(programJudging(tampered, P, "country")).toBe("");
    expect(stepErrors(tampered, P, "adjudication")).toEqual(["Choose how Country results are given."]);
    expect(deriveDraft(withDivisions(tampered, P), P, CONTEXT).payload).toBeNull();
  });

  it("Continue stops on an invalid step and Back always works", () => {
    const answers = choosePurpose(initialAnswers(), P, "competition");
    expect(stepErrors(answers, P, "styles")).toEqual(["Choose at least one style."]);
    expect(nextStep(answers, P, "styles")).toBe("styles");
    expect(previousStep(answers, P, "styles")).toBe("purpose");
    expect(nextStep(initialAnswers(), P, "purpose")).toBe("purpose");
    expect(nextStep(answers, P, "purpose")).toBe("styles");
  });

  it("Competition + Showcase / Performance needs both kinds of offering", () => {
    let answers = choosePurpose(chooseStyle(choosePurpose(initialAnswers(), P, "competition"), P, "ballroom"), P, "competition_showcase");
    answers = withOfferings(answers, P, "ballroom", ["ndca_pro_am"], ["american_smooth"]);
    expect(stepErrors(answers, P, "offerings")).toContain("Add a showcase or performance offering, or choose Competition as the purpose.");
    answers = withOfferings(toggleFormat(answers, P, "ballroom", "ndca_pro_am"), P, "ballroom", ["ndca_cabaret"]);
    expect(stepErrors(answers, P, "offerings")).toContain("Add a competition entry format, or choose Showcase / Performance as the purpose.");
  });
});

describe("deriveDraft: the single derivation authority", () => {
  it("produces the reviewed payload for Competition + Showcase / Performance", () => {
    const draft = deriveDraft(fullAnswers(), P, CONTEXT);
    expect(draft.errors).toEqual({});
    expect(draft.payload).toMatchObject({
      request_key: "request-key-0001",
      profile_key: "studio_simple",
      profile_version: 2,
      purpose: "competition_showcase",
      registration: { opens_at: "2026-11-01", closes_at: "2026-12-01", account_required: false },
    });
    expect(draft.payload).not.toHaveProperty("adjudication");
    const [country] = draft.payload!.programs;
    expect(draft.payload!.programs).toHaveLength(1);
    expect(country).toMatchObject({ key: "country", name: "Spring Classic", adjudication: "adjudicated", judging: "medal_marks", registration_fee: 40 });
    expect(country.categories.map((category) => [category.type, category.adjudication, category.pricing])).toEqual([
      ["pro_am", "inherit", { model: "per_dance", amount: 25 }],
      ["pro_pro", "inherit", { model: "per_entry", amount: 60 }],
      ["couples", "inherit", { model: "included", amount: null }],
      ["showcase", "non_adjudicated", { model: "per_dance", amount: 30 }],
      ["spotlight", "inherit", { model: "later", amount: null }],
    ]);
    expect(country.dances.map((dance) => dance.key)).toEqual(TEST_DANCES.country);
  });

  it("Review distinguishes adjudicated Medal Marks, a Non-Adjudicated Showcase and Ballroom Placements", () => {
    const country = deriveDraft(fullAnswers(), P, CONTEXT).programs[0];
    const byLabel = Object.fromEntries(country.categories.map((category) => [category.label, category]));
    expect(byLabel.ProAm.judging).toBe("Adjudicated · Judge input: Medal Marks · Final result: Placement");
    expect(byLabel.Showcase.judging).toBe("Non-Adjudicated · Performance / exhibition · No official competitive result");
    expect(byLabel.Showcase.rounds).toEqual(["Performance"]);
    expect(byLabel.Showcase.runNote).toBe("Set music for each dance · runs after each age group's dances");
    expect(byLabel.Spotlight.runNote).toBe("Music chosen by the dancers · 2.5–4 minutes · runs after each age group's dances");
    let ballroom = choosePurpose(chooseAdjudication(chooseStyle(choosePurpose(initialAnswers(), P, "competition"), P, "ballroom"), "ballroom", "adjudicated"), P, "competition_showcase");
    ballroom = withOfferings(ballroom, P, "ballroom", ["ndca_pro_am", "ndca_amateur", "ndca_showdance"], ["american_smooth"]);
    for (const format of ["ndca_pro_am", "ndca_amateur", "ndca_showdance"]) ballroom = updateFormat(ballroom, "ballroom", format, { amount: "20" });
    const derived = deriveDraft(withDivisions(ballroom, P), P, CONTEXT);
    expect(derived.errors).toEqual({});
    expect(derived.programs[0].categories.map((category) => category.label)).toEqual([
      "Pro/Am — American Smooth", "Amateur — American Smooth", "Showdance — American Smooth",
    ]);
    expect(derived.programs[0].categories.find((category) => category.label === "Showdance — American Smooth")?.judging).toBe("Adjudicated · Placements");
  });

  it("Review counts, labels and pricing come from the same derivation as the payload", () => {
    const draft = deriveDraft(fullAnswers(), P, CONTEXT);
    const payload = draft.payload!;
    const categories = payload.programs.flatMap((program) => program.categories);
    const divisions = categories.flatMap((category) => category.divisions);
    expect(draft.counts).toEqual({
      programs: 1,
      categories: 5,
      divisions: divisions.length,
      rounds: divisions.length,
      dances: payload.programs.reduce((sum, program) => sum + program.dances.length, 0),
      offerings: categories.reduce((sum, category) => sum + category.divisions.length * category.dances.length, 0),
    });
    expect(draft.pricingLines).toContain("Country ProAm: $25.00 per dance");
    expect(draft.pricingLines).toContain("Country Couples: Included with the $40.00 registration fee");
    expect(draft.pricingPending).toBe(true);
    expect(draft.pricingLines.at(-1)).toBe(PRICING_PENDING_TEXT);
    expect(PRICING_PENDING_TEXT).toBe("Pricing requires completion before registration can open.");
  });

  it("is deterministic, so a retried request hashes identically", () => {
    expect(JSON.stringify(deriveDraft(fullAnswers(), P, CONTEXT).payload)).toBe(JSON.stringify(deriveDraft(fullAnswers(), P, CONTEXT).payload));
  });

  it("multiple styles name each program after the style; Non-Adjudicated applies per style", () => {
    let answers = choosePurpose(initialAnswers(), P, "competition");
    answers = chooseStyle(answers, P, "multiple");
    answers = chooseStyle(answers, P, "country");
    answers = chooseStyle(answers, P, "west_coast_swing");
    answers = chooseAdjudication(answers, "country", "adjudicated");
    answers = chooseAdjudication(answers, "west_coast_swing", "non_adjudicated");
    answers = withOfferings(answers, P, "country", ["pro_am", "pro_pro", "couples"]);
    answers = withOfferings(answers, P, "west_coast_swing", ["jack_and_jill", "wcs_couples"]);
    for (const format of ["pro_am", "pro_pro", "couples"]) answers = setPricing(answers, P, "country", format, "free");
    answers = updateFormat(answers, "west_coast_swing", "jack_and_jill", { amount: "15" });
    answers = updateFormat(answers, "west_coast_swing", "wcs_couples", { amount: "20" });
    const draft = deriveDraft(withDivisions(answers, P), P, CONTEXT);
    expect(draft.payload?.programs.map((program) => [program.name, program.adjudication, program.judging])).toEqual([
      ["Spring Classic — Country", "adjudicated", "medal_marks"],
      ["Spring Classic — West Coast Swing", "non_adjudicated", "non_adjudicated"],
    ]);
    expect(draft.payload?.programs[1].categories[0]).toMatchObject({ type: "jack_and_jill", dances: ["west_coast_swing"] });
  });

  it("Configure later creates the draft but marks pricing incomplete", () => {
    let answers = competitionIn("country");
    for (const format of ["pro_am", "pro_pro", "couples"]) answers = setPricing(answers, P, "country", format, "later");
    const draft = deriveDraft(withDivisions(answers, P), P, CONTEXT);
    expect(draft.payload).not.toBeNull();
    expect(draft.payload?.programs[0].categories.every((category) => category.pricing.model === "later" && category.pricing.amount === null)).toBe(true);
    expect(draft.programs[0].categories.every((category) => category.pricingPending)).toBe(true);
  });

  it("pricing errors: missing or zero prices and a missing registration fee", () => {
    let answers = competitionIn("country");
    expect(stepErrors(answers, P, "pricing")).toContain("Enter a price for Country ProAm, or choose Free or Configure later.");
    answers = updateFormat(answers, "country", "pro_am", { amount: "0" });
    expect(stepErrors(answers, P, "pricing")).toContain("Enter a price for Country ProAm, or choose Free or Configure later.");
    answers = updateFormat(answers, "country", "pro_am", { amount: "12.345" });
    expect(stepErrors(answers, P, "pricing")).toContain("Enter a price for Country ProAm, or choose Free or Configure later.");
    answers = setPricing(answers, P, "country", "pro_am", "included");
    expect(stepErrors(answers, P, "pricing")).toContain("Enter the Country registration fee.");
    expect(deriveDraft(withDivisions(answers, P), P, CONTEXT).payload).toBeNull();
  });

  it("division rules: per-format selections, empty selections, the per-format cap and the total cap", () => {
    let answers = competitionIn("custom");
    expect(answers.programs.custom.formats.studio_pro_am?.divisions).toEqual({ skill_level: [], age_group: [] });
    expect(stepErrors(answers, P, "divisions")).toContain("Choose at least one level for Other / Studio-defined ProAm (Studio).");
    answers = toggleDivisionValue(answers, P, "custom", "studio_pro_am", "age_group", "Adult");
    expect(deriveDraft(answers, P, CONTEXT).programs[0].categories[0].divisions).toEqual([]);
    for (const level of ["Newcomer", "Novice", "Intermediate", "Advanced"]) {
      answers = toggleDivisionValue(answers, P, "custom", "studio_pro_am", "skill_level", level);
      answers = toggleDivisionValue(answers, P, "custom", "studio_couples", "skill_level", level);
    }
    expect(deriveDraft(answers, P, CONTEXT).programs[0].categories[0].divisions).toEqual(["Newcomer · Adult", "Novice · Adult", "Intermediate · Adult", "Advanced · Adult"]);
    expect(deriveDraft(answers, P, CONTEXT).programs[0].categories[1].divisions).toEqual(["Newcomer", "Novice", "Intermediate", "Advanced"]);
    expect(addCustomDivisionValue(answers, P, "custom", "studio_pro_am", "skill_level", "novice")).toBe(answers);
    answers = updateFormat(answers, "custom", "studio_pro_am", { divisions: { skill_level: [], age_group: [] } });
    expect(stepErrors(answers, P, "divisions")).toContain("Choose at least one level for Other / Studio-defined ProAm (Studio).");
    const many = (count: number) => Array.from({ length: count }, (_, index) => `Level ${index}`);
    answers = updateFormat(answers, "custom", "studio_pro_am", { divisions: { skill_level: many(81) } });
    expect(stepErrors(answers, P, "divisions")).toContain("Use 80 divisions or fewer for Other / Studio-defined ProAm (Studio).");
    for (const format of ["studio_pro_am", "studio_pro_pro", "studio_couples", "studio_professional"]) {
      if (!answers.programs.custom.formats[format]) answers = toggleFormat(answers, P, "custom", format);
      answers = updateFormat(answers, "custom", format, { divisions: { skill_level: many(80) } });
    }
    expect(stepErrors(answers, P, "divisions")).toContain("This draft has 320 divisions; use 300 or fewer.");
  });

  it("custom dances only where the profile allows them, and removing one clears it everywhere", () => {
    let answers = competitionIn("country");
    answers = addCustomDance(answers, P, "country", "Line Polka");
    expect(answers.programs.country.customDances).toEqual([{ key: "custom_line_polka", name: "Line Polka", category: "Custom" }]);
    expect(addCustomDance(answers, P, "country", "line polka")).toBe(answers);
    expect(addCustomDance(answers, P, "country", "Two Step")).toBe(answers);
    answers = updateFormat(answers, "country", "couples", { dances: ["custom_line_polka"] });
    for (const format of ["pro_am", "pro_pro", "couples"]) answers = updateFormat(answers, "country", format, { amount: "10" });
    expect(deriveDraft(withDivisions(answers, P), P, CONTEXT).payload?.programs[0].dances.at(-1)).toEqual({ key: "custom_line_polka", name: "Line Polka", category: "Custom" });
    answers = removeCustomDance(answers, "country", "custom_line_polka");
    expect(answers.programs.country.formats.couples?.dances).toEqual([]);
    const wcs = competitionIn("west_coast_swing");
    expect(addCustomDance(wcs, P, "west_coast_swing", "Slow Swing")).toBe(wcs);
  });
});

describe("persistence and resume", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("restores valid answers and rejects malformed or out-of-profile ones", () => {
    const answers = fullAnswers();
    expect(restoreAnswers(JSON.parse(JSON.stringify(answers)), P)).toEqual(answers);
    expect(restoreAnswers(null, P)).toBeNull();
    expect(restoreAnswers({ ...answers, version: 3 }, P)).toBeNull();
    expect(restoreAnswers({ ...answers, purpose: "gala" }, P)).toBeNull();
    expect(restoreAnswers({ ...answers, programs: { ucwdc: answers.programs.country } }, P)).toBeNull();
    const badFormat = JSON.parse(JSON.stringify(answers));
    badFormat.programs.country.formats.professional = badFormat.programs.country.formats.pro_am;
    expect(restoreAnswers(badFormat, P)).toBeNull();
    const badOverride = JSON.parse(JSON.stringify(answers));
    badOverride.programs.country.formats.showcase.adjudication = "sanctioned";
    expect(restoreAnswers(badOverride, P)).toBeNull();
    expect(restoreAnswers({ ...answers, rules: "ucwdc" }, P)?.rules).toBe("studio_custom");
  });

  it("resumes at the stored step only when it is still reachable", () => {
    const answers = fullAnswers();
    expect(resumeStep(answers, P, "pricing")).toBe("pricing");
    expect(resumeStep(answers, P, "sanction")).toBe("review");
    expect(resumeStep(choosePurpose(initialAnswers(), P, "competition"), P, "review")).toBe("styles");
  });

  it("stores the unsent setup in sessionStorage only, and survives blocked storage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });
    saveStoredSetup("e1", { answers: fullAnswers(), step: "pricing", requestKey: "request-key-0001" });
    expect(loadStoredSetup("e1")).toMatchObject({ step: "pricing", requestKey: "request-key-0001" });
    expect([...store.keys()]).toEqual(["danceflow.competition-setup.v4:e1"]);
    expect(loadStoredSetup("e2")).toBeNull();
    store.set("danceflow.competition-setup.v3:e1", "{}");
    store.set("danceflow.competition-setup.v3:e9", "{}");
    loadStoredSetup("e1");
    expect(store.has("danceflow.competition-setup.v3:e1")).toBe(false);
    expect(store.has("danceflow.competition-setup.v3:e9")).toBe(true);
    store.set("danceflow.competition-setup.v4:e3", JSON.stringify({ answers: {}, step: "review", requestKey: "bad key" }));
    expect(loadStoredSetup("e3")).toBeNull();
    clearStoredSetup("e1");
    expect(loadStoredSetup("e1")).toBeNull();

    vi.stubGlobal("window", {
      get sessionStorage(): Storage {
        throw new Error("blocked");
      },
    });
    expect(() => saveStoredSetup("e1", { answers: {}, step: "purpose", requestKey: "request-key-0001" })).not.toThrow();
    expect(loadStoredSetup("e1")).toBeNull();
    expect(() => clearStoredSetup("e1")).not.toThrow();
  });
});
