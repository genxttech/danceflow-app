import { describe, expect, it } from "vitest";
import { STUDIO_CUSTOM_V2_DEFAULTS as P } from "../studioCustomV2";
import {
  addCustomDance,
  chooseAdjudication,
  choosePurpose,
  chooseStyle,
  danceStyleOf,
  deriveDraft,
  formatCategories,
  formatDanceOptions,
  formatDivisions,
  formatStyleOptions,
  initialAnswers,
  offeringGroups,
  restoreAnswers,
  stepErrors,
  toggleDivisionValue,
  toggleFormat,
  toggleFormatDance,
  toggleFormatStyle,
  updateFormat,
  type SetupAnswers,
} from "../draft";
import { withDivisions, withOfferings } from "./divisionTestHelpers";

/**
 * 10C.5 Ballroom correction (NDCA June 2026): offerings are NDCA competition classifications, a couple is a
 * partnership rather than an offering, dance style is a category dimension that constrains dances, and age /
 * proficiency structures are classification-specific. Governing-body offerings are never shared across styles.
 */

const CONTEXT = { eventName: "Spring Classic", profileKey: "studio_simple", profileVersion: 2, requestKey: "request-key-0001" };
const labels = (scheme: string, axis: string) => P.divisionSchemes[scheme].axes.find((item) => item.key === axis)!.values.map((value) => value.label);
const YOUTH = ["Pre-Teen I", "Pre-Teen II", "Junior I", "Junior II", "Youth"];

function ballroom(purpose: "competition" | "showcase" | "competition_showcase" = "competition"): SetupAnswers {
  return chooseAdjudication(chooseStyle(choosePurpose(initialAnswers(), P, purpose), P, "ballroom"), "ballroom", "adjudicated");
}

describe("Ballroom offerings are NDCA competition classifications", () => {
  it("offers Pro/Am, Amateur, Mixed Amateur, Student/Student, Professional and Mixed Professional distinctly, and no generic Couples", () => {
    const formats = P.programs.ballroom.formats.map((format) => [format, P.categoryTypes[format].label, P.categoryTypes[format].entry_format]);
    expect(formats.slice(0, 6)).toEqual([
      ["ndca_pro_am", "Pro/Am", "pro_am"],
      ["ndca_amateur", "Amateur", "couple"],
      ["ndca_mixed_amateur", "Mixed Amateur", "mixed_amateur"],
      ["ndca_student_student", "Student/Student", "custom"],
      ["ndca_professional", "Professional", "professional"],
      ["ndca_mixed_professional", "Mixed Professional", "professional"],
    ]);
    const ballroomLabels = P.programs.ballroom.formats.map((format) => P.categoryTypes[format].label);
    expect(ballroomLabels).not.toContain("Couples");
    expect(ballroomLabels).not.toContain("ProAm");
    expect(ballroomLabels.filter((label) => /couple/i.test(label))).toEqual([]);
  });

  it("every Ballroom offering is NDCA-origin and cites the NDCA June 2026 rule book", () => {
    for (const format of P.programs.ballroom.formats) {
      const definition = P.categoryTypes[format];
      expect(definition.origin, format).toBe("ndca");
      expect(definition.sources?.length, format).toBeGreaterThan(0);
      for (const source of definition.sources ?? []) expect(source, format).toMatchObject({ document: "NDCA Rule Book", edition: "June 2026 (compiled)" });
    }
    expect(P.categoryTypes.ndca_amateur.sources?.map((source) => source.section)).toEqual(["II.A.2", "II.B.6", "X.A.6; X.C"]);
  });

  it("performances are separate offerings: Showdance, Cabaret, Theatre Arts Compulsory, Pro/Am Theatrical and Exhibition", () => {
    expect(offeringGroups(P, "ballroom", "competition").map((group) => [group.label, group.formats])).toEqual([
      ["Partnerships", ["ndca_pro_am", "ndca_amateur", "ndca_mixed_amateur", "ndca_student_student", "ndca_professional", "ndca_mixed_professional"]],
      ["Youth", ["ndca_solo_star"]],
      ["Performances", ["ndca_showdance", "ndca_cabaret", "ndca_theatre_arts", "ndca_pro_am_theatrical", "ndca_pro_am_exhibition"]],
      ["Teams", ["ndca_formation", "ndca_team_match"]],
    ]);
    expect(P.categoryTypes.ndca_cabaret).toMatchObject({ contest_type: "cabaret", kind: "special", music_source: { value: "entry_selected", basis: "source_grounded" } });
    expect(P.categoryTypes.ndca_theatre_arts.music_source).toMatchObject({ value: "profile_defined", basis: "source_grounded" });
    expect(P.categoryTypes.ndca_showdance).toMatchObject({ contest_type: "showdance", uses_styles: true, uses_dances: true, duration: { value: { max_seconds: 240 } } });
  });

  it("Pro/Am Theatrical and Exhibition are Pro/Am performance divisions, not levels, and their music is not invented", () => {
    for (const format of ["ndca_pro_am_theatrical", "ndca_pro_am_exhibition"]) {
      expect(P.categoryTypes[format]).toMatchObject({ entry_format: "pro_am", kind: "special", participant_roles: ["student", "professional"] });
      expect(P.categoryTypes[format].music_source).toMatchObject({ value: "not_specified", basis: "not_specified" });
      expect(P.categoryTypes[format].music_source.note).toContain("NOT SPECIFIED IN PROVIDED SOURCE");
      expect(P.categoryTypes[format].sources?.[0]?.section).toBe("II.B.7.c");
    }
    expect(labels("ballroom_proam", "skill_level")).not.toEqual(expect.arrayContaining(["Theatrical", "Exhibition"]));
  });

  it("Solo Star is a youth-only single-dancer offering; Student/Student and Professional carry their eligibility notes", () => {
    expect(P.categoryTypes.ndca_solo_star).toMatchObject({ entry_format: "solo", minimum_participants: 1, maximum_participants: 1, uses_styles: true });
    expect(P.categoryTypes.ndca_solo_star.eligibility_note).toContain("never Adult or Senior");
    expect(P.categoryTypes.ndca_student_student.eligibility_note).toContain("Adults only");
    expect(P.categoryTypes.ndca_student_student.eligibility_note).toContain("Not open to dancers who compete at the Open Amateur");
    expect(P.categoryTypes.ndca_professional.eligibility_note).toContain("16 years of age and older");
  });
});

describe("dance style is a category dimension that constrains dances", () => {
  it("the four primary NDCA styles plus Additional American Style Dances, each with only its own dances", () => {
    const styles = Object.fromEntries((P.programs.ballroom.styles ?? []).map((style) => [style.key, style]));
    expect(Object.keys(styles)).toEqual(["international_standard", "international_latin", "american_smooth", "american_rhythm", "american_additional"]);
    const names = (key: string) => styles[key].dances.map((dance) => P.dancePools.ballroom.find((item) => item.key === dance)?.name);
    expect(names("international_standard")).toEqual(["Waltz", "Tango", "Viennese Waltz", "Slow Foxtrot", "Quickstep"]);
    expect(names("international_latin")).toEqual(["Cha Cha", "Samba", "Rumba", "Paso Doble", "Jive"]);
    expect(names("american_smooth")).toEqual(["Waltz", "Tango", "Foxtrot", "Viennese Waltz"]);
    expect(names("american_rhythm")).toEqual(["Cha Cha", "Rumba", "Swing", "Bolero", "Mambo"]);
    expect(styles.american_additional).toMatchObject({ dances: [], allow_custom_dances: true });
    for (const style of Object.values(styles)) expect(style.sources?.[0]?.section).toMatch(/^IX\.A\.1\.[a-e]$/);
    const all = Object.values(styles).flatMap((style) => style.dances);
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(P.dancePools.ballroom.map((dance) => dance.key)));
  });

  it("Showdance is entered in the four primary styles only (NDCA XI.B)", () => {
    expect(formatStyleOptions(P, "ballroom", "ndca_showdance").map((style) => style.key)).toEqual(["international_standard", "international_latin", "american_smooth", "american_rhythm"]);
    expect(formatStyleOptions(P, "ballroom", "ndca_pro_am")).toHaveLength(5);
    expect(formatStyleOptions(P, "ballroom", "ndca_cabaret")).toEqual([]);
    expect(formatStyleOptions(P, "country", "pro_am")).toEqual([]);
  });

  it("nothing is pre-selected: a new offering has no styles, no dances and no divisions", () => {
    const answers = toggleFormat(ballroom(), P, "ballroom", "ndca_pro_am");
    expect(answers.programs.ballroom.formats.ndca_pro_am).toMatchObject({ danceStyles: [], dances: [], divisions: { skill_level: [], age_group: [] } });
    expect(formatDanceOptions(P, "ballroom", answers.programs.ballroom, "ndca_pro_am")).toEqual([]);
    expect(stepErrors(answers, P, "offerings")).toEqual(["Choose at least one style for Ballroom Pro/Am."]);
  });

  it("each chosen style becomes its own category holding only that style's dances", () => {
    let answers = withOfferings(ballroom(), P, "ballroom", ["ndca_pro_am"], ["american_smooth", "international_latin"]);
    answers = updateFormat(answers, "ballroom", "ndca_pro_am", { amount: "25" });
    answers = toggleDivisionValue(answers, P, "ballroom", "ndca_pro_am", "skill_level", "Bronze");
    answers = toggleDivisionValue(answers, P, "ballroom", "ndca_pro_am", "skill_level", "Silver");
    const draft = deriveDraft(answers, P, CONTEXT);
    expect(draft.errors).toEqual({});
    expect(draft.programs[0].categories.map((category) => [category.label, category.dances])).toEqual([
      ["Pro/Am — International Latin", ["Cha Cha", "Jive"]],
      ["Pro/Am — American Smooth", ["Waltz", "Tango", "Foxtrot"]],
    ]);
    expect(draft.payload!.programs[0].categories.map((category) => [category.type, category.style, category.dances])).toEqual([
      ["ndca_pro_am", "international_latin", ["latin_cha_cha", "latin_jive"]],
      ["ndca_pro_am", "american_smooth", ["smooth_waltz", "smooth_tango", "smooth_foxtrot"]],
    ]);
    expect(draft.counts).toMatchObject({ categories: 2, divisions: 4, offerings: 2 * 2 + 2 * 3 });
    expect(draft.pricingLines).toContain("Ballroom Pro/Am: $25.00 per dance");
  });

  it("a dance outside the chosen styles cannot be chosen, and withdrawing a style removes its dances", () => {
    let answers = withOfferings(ballroom(), P, "ballroom", ["ndca_pro_am"], ["american_smooth"]);
    expect(toggleFormatDance(answers, P, "ballroom", "ndca_pro_am", "rhythm_cha_cha")).toBe(answers);
    expect(toggleFormatDance(answers, P, "ballroom", "ndca_pro_am", "std_waltz")).toBe(answers);
    answers = toggleFormatStyle(answers, P, "ballroom", "ndca_pro_am", "american_rhythm");
    answers = toggleFormatDance(answers, P, "ballroom", "ndca_pro_am", "rhythm_mambo");
    expect(answers.programs.ballroom.formats.ndca_pro_am?.dances).toContain("rhythm_mambo");
    answers = toggleFormatStyle(answers, P, "ballroom", "ndca_pro_am", "american_rhythm");
    expect(answers.programs.ballroom.formats.ndca_pro_am).toMatchObject({ danceStyles: ["american_smooth"], dances: ["smooth_waltz", "smooth_tango", "smooth_foxtrot"] });
    expect(toggleFormatStyle(answers, P, "ballroom", "ndca_showdance", "american_additional")).toBe(answers);
  });

  it("every chosen style needs its own dances, and a tampered dance outside its styles is refused", () => {
    let answers = withOfferings(ballroom(), P, "ballroom", ["ndca_pro_am"], ["american_smooth"]);
    answers = toggleFormatStyle(answers, P, "ballroom", "ndca_pro_am", "international_standard");
    expect(stepErrors(answers, P, "dances")).toEqual(["Choose at least one dance for Ballroom Pro/Am — International Standard."]);
    const tampered = updateFormat(answers, "ballroom", "ndca_pro_am", { danceStyles: ["american_smooth"], dances: ["smooth_waltz", "rhythm_swing"] });
    expect(stepErrors(tampered, P, "dances")).toContain("A dance chosen for Ballroom Pro/Am is not part of its chosen styles.");
    expect(deriveDraft(withDivisions(updateFormat(tampered, "ballroom", "ndca_pro_am", { pricing: "free" }), P), P, CONTEXT).payload).toBeNull();
  });

  it("organizer-added Ballroom dances belong only to Additional American Style Dances", () => {
    let answers = withOfferings(ballroom(), P, "ballroom", ["ndca_pro_am"], ["american_smooth"]);
    answers = addCustomDance(answers, P, "ballroom", "Peabody");
    expect(danceStyleOf(P, "ballroom", "custom_peabody")?.key).toBe("american_additional");
    expect(toggleFormatDance(answers, P, "ballroom", "ndca_pro_am", "custom_peabody")).toBe(answers);
    answers = toggleFormatStyle(answers, P, "ballroom", "ndca_pro_am", "american_additional");
    answers = toggleFormatDance(answers, P, "ballroom", "ndca_pro_am", "custom_peabody");
    answers = updateFormat(withDivisions(answers, P), "ballroom", "ndca_pro_am", { pricing: "free" });
    const payload = deriveDraft(answers, P, CONTEXT).payload!;
    expect(payload.programs[0].categories.find((category) => category.style === "american_additional")?.dances).toEqual(["custom_peabody"]);
  });

  it("restore keeps valid dance styles and rejects unknown or missing ones", () => {
    const answers = withOfferings(ballroom(), P, "ballroom", ["ndca_pro_am"], ["american_rhythm"]);
    expect(restoreAnswers(JSON.parse(JSON.stringify(answers)), P)).toEqual(answers);
    const unknown = JSON.parse(JSON.stringify(answers));
    unknown.programs.ballroom.formats.ndca_pro_am.danceStyles = ["country_western"];
    expect(restoreAnswers(unknown, P)).toBeNull();
    const missing = JSON.parse(JSON.stringify(answers));
    delete missing.programs.ballroom.formats.ndca_pro_am.danceStyles;
    expect(restoreAnswers(missing, P)).toBeNull();
    const unstyled = JSON.parse(JSON.stringify(withOfferings(ballroom(), P, "ballroom", ["ndca_cabaret"])));
    unstyled.programs.ballroom.formats.ndca_cabaret.danceStyles = ["american_smooth"];
    expect(restoreAnswers(unstyled, P)).toBeNull();
  });

  it("every category carries the offering's divisions, so the draft total counts each dance style", () => {
    let answers = withOfferings(ballroom(), P, "ballroom", ["ndca_pro_am"], ["international_standard", "international_latin", "american_smooth", "american_rhythm"]);
    answers = updateFormat(answers, "ballroom", "ndca_pro_am", { divisions: { skill_level: Array.from({ length: 80 }, (_, index) => `Level ${index}`) } });
    expect(stepErrors(answers, P, "divisions")).toEqual(["This draft has 320 divisions; use 300 or fewer."]);
  });

  it("the per-program category limit counts one category per chosen dance style", () => {
    const tight = { ...P, limits: { ...P.limits, categories: 3 } };
    const answers = withOfferings(ballroom(), tight, "ballroom", ["ndca_pro_am", "ndca_cabaret"], ["american_smooth", "american_rhythm", "international_latin"]);
    expect(stepErrors(answers, tight, "offerings")).toEqual(["Ballroom has 4 categories; use 3 or fewer."]);
    expect(stepErrors(toggleFormat(answers, tight, "ballroom", "ndca_cabaret"), tight, "offerings")).toEqual([]);
  });

  it("selecting every Ballroom offering in every style stays within the category limit", () => {
    let answers = withOfferings(ballroom(), P, "ballroom", P.programs.ballroom.formats, (P.programs.ballroom.styles ?? []).map((style) => style.key));
    answers = addCustomDance(answers, P, "ballroom", "Peabody");
    const categories = P.programs.ballroom.formats.reduce((sum, format) => sum + Math.max(1, formatCategories(P, "ballroom", format, answers.programs.ballroom.formats[format]!).length), 0);
    expect(categories).toBe(7 * 5 + 4 + 6);
    expect(categories).toBeLessThanOrEqual(P.limits.categories);
    expect(stepErrors(answers, P, "offerings")).toEqual([]);
  });
});

describe("age and proficiency structures are classification-specific", () => {
  it("Pro/Am: levels required (II.B.7.c); ages optional -- youth amateur ages (II.B.8.a) and A–S4 (II.B.7.f)", () => {
    expect(P.programs.ballroom.division_schemes.ndca_pro_am).toBe("ballroom_proam");
    expect(labels("ballroom_proam", "skill_level")).toEqual(["Newcomer", "Beginner", "Intermediate", "Advanced", "Pre-Bronze", "Bronze", "Silver", "Gold", "Gold Star", "Supreme Gold"]);
    expect(labels("ballroom_proam", "age_group")).toEqual([...YOUTH, "A", "B", "C", "S1", "S2", "S3", "S4"]);
    expect(P.divisionSchemes.ballroom_proam.axes.map((axis) => [axis.key, axis.required])).toEqual([["skill_level", true], ["age_group", false]]);
    expect(P.divisionSchemes.ballroom_proam.axes[1].note).toContain("Multi-Dance");
    const youth = P.divisionSchemes.ballroom_proam.axes[1].values.find((value) => value.label === "Junior I");
    expect(youth?.sources?.map((source) => source.section)).toEqual(["II.B.8.a", "X.A.1"]);
  });

  it("Amateur: a proficiency level in an age category, both required (NDCA X)", () => {
    expect(labels("ballroom_amateur", "skill_level")).toEqual(["Bronze", "Silver", "Gold", "Novice", "Pre-Championship", "Open Amateur"]);
    expect(P.divisionSchemes.ballroom_amateur.axes[0].label).toBe("Proficiency levels");
    expect(labels("ballroom_amateur", "age_group")).toEqual([...YOUTH, "Adult", "Senior I", "Senior II", "Senior III", "Senior IV", "Pre-Teen", "Junior", "Senior", "Under 21"]);
    expect(P.divisionSchemes.ballroom_amateur.axes.every((axis) => axis.required)).toBe(true);
    let answers = withOfferings(ballroom(), P, "ballroom", ["ndca_amateur"], ["international_standard"]);
    answers = toggleDivisionValue(answers, P, "ballroom", "ndca_amateur", "skill_level", "Silver");
    expect(stepErrors(answers, P, "divisions")).toContain("Choose at least one age division for Ballroom Amateur.");
    answers = toggleDivisionValue(answers, P, "ballroom", "ndca_amateur", "age_group", "Adult");
    expect(formatDivisions(P, "ballroom", "ndca_amateur", answers.programs.ballroom.formats.ndca_amateur!).map((division) => division.name)).toEqual(["Silver · Adult"]);
  });

  it("Professional: Open Professional and Rising Star are separate contests with no age categories", () => {
    const scheme = P.divisionSchemes.ballroom_professional;
    expect(scheme).toMatchObject({ combination: "separate" });
    expect(scheme.axes.map((axis) => [axis.key, axis.required])).toEqual([["contest_type", true]]);
    const divisions = formatDivisions(P, "ballroom", "ndca_professional", { divisions: { contest_type: ["Open Professional", "Rising Star"] } });
    expect(divisions).toEqual([
      { name: "Open Professional", axes: { contest_type: "Open Professional" } },
      { name: "Rising Star", axes: { contest_type: "Rising Star" } },
    ]);
  });

  it("Solo Star: youth age categories only, required, and no proficiency axis", () => {
    expect(P.divisionSchemes.ballroom_solo_star.axes.map((axis) => [axis.key, axis.required])).toEqual([["age_group", true]]);
    expect(labels("ballroom_solo_star", "age_group")).toEqual(YOUTH);
  });

  it("Student/Student is one adult division and the youth conflict is recorded, unresolved, and fails closed", () => {
    expect(P.programs.ballroom.division_schemes.ndca_student_student).toBe("ballroom_adult_open");
    expect(labels("ballroom_adult_open", "skill_level")).toEqual(["Adult Open"]);
    const conflict = P.source_conflicts.find((item) => item.key === "ndca_student_student_youth");
    expect(conflict).toMatchObject({ status: "unresolved", material: true });
    expect(conflict?.references.map((reference) => reference.section)).toEqual(["II.A.6.b", "II.B.8"]);
    expect(P.categoryTypes.ndca_student_student.eligibility_note).toContain("Youth Student/Student is not offered");
    expect(P.source_conflicts.find((item) => item.key === "ndca_formation_scoring")?.references.map((reference) => [reference.section, reference.page])).toEqual([["III.D.11", "21"], ["XII.N.3", "52"]]);
  });

  it("Mixed Amateur, Mixed Professional, performances and teams have one open division (NDCA defines none)", () => {
    for (const format of ["ndca_mixed_amateur", "ndca_mixed_professional", "ndca_showdance", "ndca_cabaret", "ndca_theatre_arts", "ndca_pro_am_theatrical", "ndca_pro_am_exhibition", "ndca_formation", "ndca_team_match"]) {
      expect(P.programs.ballroom.division_schemes[format], format).toBe("open_only");
    }
  });
});

describe("no offering is shared across styles", () => {
  it("every offering belongs to exactly one style, with an origin that matches the style's governing body or Studio", () => {
    const allowed: Record<string, string> = { country: "ucwdc", west_coast_swing: "wsdc", ballroom: "ndca", custom: "studio" };
    const owners = new Map<string, string>();
    for (const [key, program] of Object.entries(P.programs)) {
      for (const format of program.formats) {
        expect(owners.has(format), `${format} in ${owners.get(format)} and ${key}`).toBe(false);
        owners.set(format, key);
        expect([allowed[key], "studio"], `${key} ${format}`).toContain(P.categoryTypes[format].origin);
      }
    }
    expect(owners.size).toBe(Object.keys(P.categoryTypes).length);
  });

  it("Studio offerings inside a governing-body style say so, and cite no governing-body source", () => {
    for (const key of ["country", "west_coast_swing", "ballroom"]) {
      for (const format of P.programs[key].formats.filter((item) => P.categoryTypes[item].origin === "studio")) {
        expect(P.categoryTypes[format].label, format).toMatch(/\(Studio\)$/);
        expect(P.categoryTypes[format].sources, format).toBeUndefined();
      }
    }
    for (const format of P.programs.custom.formats) expect(P.categoryTypes[format].origin).toBe("studio");
  });

  it("UCWDC offerings (Couples, Showcase, Spotlight) appear only in Country", () => {
    for (const format of ["couples", "showcase", "spotlight", "pro_am", "pro_pro"]) {
      expect(Object.entries(P.programs).filter(([, program]) => program.formats.includes(format)).map(([key]) => key)).toEqual(["country"]);
      expect(P.categoryTypes[format].origin).toBe("ucwdc");
    }
  });

  it("WSDC Jack & Jill stays distinct from the Studio WCS offerings", () => {
    expect(P.categoryTypes.jack_and_jill).toMatchObject({ origin: "wsdc", label: "Jack & Jill" });
    expect(P.programs.west_coast_swing.division_schemes).toEqual({ jack_and_jill: "wcs_contests", wcs_couples: "studio_wcs", wcs_pro_am: "studio_wcs", routine: "open_only" });
    for (const format of ["wcs_couples", "wcs_pro_am", "routine"]) expect(P.categoryTypes[format].origin).toBe("studio");
    expect(labels("studio_wcs", "skill_level")).not.toEqual(expect.arrayContaining(["All Star", "Champion"]));
    expect(P.divisionSchemes.studio_wcs.axes.map((axis) => axis.key)).toEqual(["skill_level"]);
    expect(P.categoryTypes.studio_jack_and_jill).toMatchObject({ origin: "studio", label: "Jack & Jill (Studio)" });
    expect(P.programs.custom.division_schemes.studio_jack_and_jill).toBe("studio_generic");
  });

  it("Country single-dancer Solo is a Studio routine, not UCWDC Solo Medley", () => {
    expect(P.categoryTypes.solo).toMatchObject({ label: "Solo routine (Studio)", origin: "studio", maximum_participants: 1 });
    expect(P.categoryTypes.solo.description).toContain("UCWDC Solo Medley is a couple's multi-dance Showcase routine");
    expect(Object.values(P.categoryTypes).map((definition) => definition.label)).not.toContain("Solo Medley");
  });
});
