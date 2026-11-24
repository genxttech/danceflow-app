// R-02 (owner ratified 2026-11-23) and OD-32 AE-08 wording: Studio/Custom partnership formats and the 'Other /
// Studio-defined' style carry no governing-body compliance claim; the UCWDC Masters under-18 partner exception is
// stated as unavailable. Display wording only: identifiers, configuration, pricing and scoring are untouched.
import { describe, expect, it } from "vitest";
import { STUDIO_CUSTOM_V3_DEFAULTS as P } from "../studioCustomV3";
import { STUDIO_PARTNERSHIP_DISPLAY, withStudioCustomDisplayLabels } from "../studioCustomDisplay";
import { chooseAdjudication, chooseStyle, choosePurpose, deriveDraft, initialAnswers, updateFormat, setPricing } from "../draft";
import { TEST_EVENT, withDivisions, withOfferings } from "./divisionTestHelpers";

const D = withStudioCustomDisplayLabels(P);
const CONTEXT = { eventName: "Spring Classic", profileKey: "studio_simple", profileVersion: 3, requestKey: "request-key-0001" };
const BODY = /\b(NDCA|UCWDC|WSDC|WDC|USDC)\b|Registry|defines no/i;

describe("R-02 Studio/Custom partnership formats", () => {
  it("every listed format is present with the entry format the display layer expects (so none is silently skipped)", () => {
    for (const [key, display] of Object.entries(STUDIO_PARTNERSHIP_DISPLAY)) {
      expect(P.categoryTypes[key]?.entry_format, key).toBe(display.entryFormat);
      expect(D.categoryTypes[key].label, key).toBe(display.label);
    }
    for (const key of ["wcs_couples", "wcs_pro_am", "studio_pro_am", "studio_pro_pro", "studio_couples", "studio_professional", "studio_jack_and_jill", "studio_solo", "custom_routine", "studio_team"]) {
      expect(P.categoryTypes[key], key).toBeDefined();
    }
  });

  it("the wcs_couples claim about WSDC is replaced with a neutral description of the Studio format", () => {
    expect(P.categoryTypes.wcs_couples.description).toContain("WSDC defines no Couples contest");
    expect(D.categoryTypes.wcs_couples.description).toBe("A couple contest you define, as a DanceFlow Studio/Custom format.");
    expect(D.categoryTypes.wcs_pro_am.description).not.toMatch(BODY);
    expect(D.categoryTypes.studio_jack_and_jill.description).not.toMatch(BODY);
  });

  it("no Studio partnership or 'Other / Studio-defined' format name or description names a governing body", () => {
    const studioKeys = Object.keys(P.categoryTypes).filter((k) => /^(studio_|wcs_)/.test(k) || ["custom_routine"].includes(k));
    for (const key of studioKeys) {
      expect(D.categoryTypes[key].label, key).not.toMatch(BODY);
      expect(D.categoryTypes[key].description, key).not.toMatch(BODY);
    }
    expect(P.programs.custom.formats.slice(0, 7).map((f) => D.categoryTypes[f].label)).toEqual([
      "Studio/Custom: Pro-Am", "Studio/Custom: Pro-Pro", "Studio/Custom: Couples", "Studio/Custom: Professional couples", "Studio/Custom: Jack & Jill",
      "Studio/Custom: Choreographed routine", "Studio/Custom: Solo",
    ]);
    expect(D.divisionSchemes.studio_wcs.note).not.toMatch(BODY);
  });

  it("identifiers, stored configuration, pricing and scoring selection are unchanged", () => {
    expect(Object.keys(D.categoryTypes)).toEqual(Object.keys(P.categoryTypes));
    expect(Object.fromEntries(Object.entries(D.programs).map(([k, v]) => [k, [v.formats, v.division_schemes, v.judging_options]]))).toEqual(
      Object.fromEntries(Object.entries(P.programs).map(([k, v]) => [k, [v.formats, v.division_schemes, v.judging_options]])),
    );
    expect(D.judging).toBe(P.judging);
    let answers = chooseAdjudication(chooseStyle(choosePurpose(initialAnswers(undefined, TEST_EVENT), P, "competition"), P, "custom"), "custom", "adjudicated");
    answers = withOfferings(answers, P, "custom", ["studio_pro_am", "studio_couples"]);
    answers = setPricing(answers, P, "custom", "studio_pro_am", "per_entry");
    answers = updateFormat(answers, "custom", "studio_pro_am", { amount: "35" });
    answers = setPricing(answers, P, "custom", "studio_couples", "free");
    const draft = deriveDraft(withDivisions(answers, P), P, CONTEXT);
    expect(draft.errors).toEqual({});
    expect(draft.payload?.programs[0].categories.map((c) => [c.type, c.pricing, c.adjudication])).toEqual([
      ["studio_pro_am", { model: "per_entry", amount: 35 }, "inherit"],
      ["studio_couples", { model: "free", amount: null }, "inherit"],
    ]);
    expect(JSON.stringify(draft.payload)).not.toMatch(/Studio\/Custom:/);
  });
});

describe("Studio age terminology (AE-26, FD-26, FD-37)", () => {
  const ageAxis = (scheme: typeof P) => scheme.divisionSchemes.studio_generic.axes.find((a) => a.key === "age_group")!;

  it("Youth, Adult and Senior stay plain labels with no thresholds and the note says they map to no body class", () => {
    expect(ageAxis(P).values.map((v) => v.label)).toEqual(["Youth", "Adult", "Senior"]);
    for (const value of ageAxis(D).values) expect(Object.keys(value).filter((k) => /age|min|max|threshold|from|to/i.test(k)), value.label).toEqual([]);
    expect(ageAxis(D).values).toEqual(ageAxis(P).values);
    const note = ageAxis(D).note ?? "";
    expect(note).toMatch(/no age thresholds/);
    expect(note).toMatch(/do not correspond to any governing-body class/);
    expect(note).toMatch(/18 or older whatever the label/);
    expect(note).not.toMatch(/NDCA|Senior I|UCWDC|WSDC/);
  });

  it("OD-02 gate against a Studio 'Youth' division: not testable on this base", () => {
    // minorsGate.ts (PR 835) is not on this branch. The test that belongs there: a registration whose division is Studio
    // 'Youth' and whose participant has a date of birth under 18 is refused with minors_not_permitted.
    expect(ageAxis(D).values.some((v) => v.label === "Youth")).toBe(true);
  });
});

describe("OD-32 AE-08: UCWDC Masters partner exception is stated as unavailable", () => {
  const axis = (scheme: typeof P) => scheme.divisionSchemes.country_couples.axes.find((a) => a.key === "age_group")!;

  it("the age axis note keeps the original text and adds the unavailability statement", () => {
    expect(axis(D).note?.startsWith(axis(P).note ?? "")).toBe(true);
    expect(axis(D).note).toMatch(/II\.D\.3\.a-b/);
    expect(axis(D).note).toMatch(/NOT available in this DanceFlow release/);
    expect(axis(D).note).toMatch(/prohibits all competitors under 18/);
    expect(axis(D).note).toMatch(/does not enforce UCWDC age eligibility/);
  });

  it("is idempotent, and the Masters and Open division values and the scheme layout are unchanged", () => {
    expect(withStudioCustomDisplayLabels(D).divisionSchemes.country_couples.axes.find((a) => a.key === "age_group")?.note).toBe(axis(D).note);
    expect(axis(D).values).toEqual(axis(P).values);
    expect(axis(D).values.map((v) => v.label)).toEqual(expect.arrayContaining(["Open", "Masters", "Masters Plus"]));
    expect(D.divisionSchemes.country_couples.combination).toBe(P.divisionSchemes.country_couples.combination);
  });

  it("the OD-02 gate still refuses under-18: not testable on this base", () => {
    // Belongs with PR 835: a Country Couples Masters entry with a 16-year-old partner (the UCWDC exception) is refused.
    expect(axis(D).note).toMatch(/under 18/);
  });
});
