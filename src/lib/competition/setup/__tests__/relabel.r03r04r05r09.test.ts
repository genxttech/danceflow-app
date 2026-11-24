// R-03, R-04, R-05 and R-09 (owner ratified 2026-11-23): display wording and availability only. Identifiers, saved
// configurations, registration validation, pricing, scoring and stored results are unchanged.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STUDIO_CUSTOM_V3_DEFAULTS as P } from "../studioCustomV3";
import { withStudioCustomDisplayLabels } from "../studioCustomDisplay";
import { chooseAdjudication, chooseStyle, choosePurpose, deriveDraft, initialAnswers, restoreAnswers, setPricing, toggleDivisionValue } from "../draft";
import { PERSON_TYPES, calculateCompetitionRegistrationQuote } from "../../registrationPricing";
import { DANCEFLOW_ROLE_NOTE, RELATIONSHIP_ROLES, allowedRolesForFormat } from "../../participantRoles";
import { NOT_CALLED_BACK_LABEL } from "../../results/engines/studioCallbackTally";
import { NOT_CALLED_BACK_DISPLAY, STORED_NOT_CALLED_BACK_LABEL, displayResultLabel, notAdvancedWording } from "../../results/resultLabels";
import { placementLabel } from "../../results/viewer";
import { TEST_EVENT, withDivisions, withOfferings } from "./divisionTestHelpers";

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const D = withStudioCustomDisplayLabels(P);
const CONTEXT = { eventName: "Spring Classic", profileKey: "studio_simple", profileVersion: 3, requestKey: "request-key-0001" };
const EMPTY_CATALOG = { programs: [], contests: [], divisions: [], offerings: [], rules: [], feeRules: [] } as never;
const BODY = /\b(NDCA|UCWDC|WSDC|WDC|USDC)\b|Mixed Amateur|Mixed Professional/;

describe("R-03 displayed names and the Studio Open division", () => {
  it("Mixed, Pro/Am Theatrical and Exhibition names and descriptions carry no body implication", () => {
    for (const key of ["ndca_mixed_amateur", "ndca_mixed_professional", "ndca_pro_am_theatrical", "ndca_pro_am_exhibition", "ndca_showdance", "ndca_cabaret", "ndca_theatre_arts", "ndca_formation", "ndca_team_match"]) {
      expect(D.categoryTypes[key].label, key).toMatch(/^Studio\/Custom: /);
      expect(`${D.categoryTypes[key].label} ${D.categoryTypes[key].description} ${D.categoryTypes[key].eligibility_note ?? ""}`, key).not.toMatch(BODY);
    }
    expect(D.categoryTypes.ndca_mixed_amateur.description).toMatch(/does not check amateur status/);
  });

  it("every id, entry format, contest type, role set and the Open division scheme is unchanged", () => {
    expect(Object.keys(D.categoryTypes)).toEqual(Object.keys(P.categoryTypes));
    for (const key of Object.keys(P.categoryTypes)) {
      const { label: _a, description: _b, eligibility_note: _c, ...before } = P.categoryTypes[key];
      const { label: _d, description: _e, eligibility_note: _f, ...after } = D.categoryTypes[key];
      // The music note of Showcase is the only other displayed field the layer rewrites.
      const strip = (d: typeof before) => ({ ...d, music_source: { ...d.music_source, note: undefined } });
      expect(strip(after), key).toEqual(strip(before));
    }
    expect(D.divisionSchemes.open_only).toBe(P.divisionSchemes.open_only);
    expect(P.programs.ballroom.division_schemes.ndca_mixed_amateur).toBe("open_only");
    expect(D.divisionSchemes.open_only.axes[0].values.map((v) => v.label)).toEqual(["Open"]);
  });

  it("the Studio age axis is organizer-defined, discloses no age validation, and no longer offers Youth", () => {
    const axis = D.divisionSchemes.studio_generic.axes.find((a) => a.key === "age_group")!;
    expect(axis.values.map((v) => v.label)).toEqual(["Adult", "Senior"]);
    expect(axis.note).toMatch(/classifications you define, not governing-body age divisions/);
    expect(axis.note).toMatch(/does not automatically validate any age range/);
    expect(JSON.stringify(axis.values)).not.toMatch(/min_age|max_age|under_age/);
  });

  it("a saved configuration that already contains Youth still loads and derives", () => {
    let answers = chooseAdjudication(chooseStyle(choosePurpose(initialAnswers(undefined, TEST_EVENT), P, "competition"), P, "custom"), "custom", "adjudicated");
    answers = withOfferings(answers, P, "custom", ["studio_couples"]);
    answers = setPricing(answers, P, "custom", "studio_couples", "free");
    answers = toggleDivisionValue(answers, P, "custom", "studio_couples", "age_group", "Youth");
    const saved = JSON.parse(JSON.stringify(answers));
    expect(restoreAnswers(saved, D)).not.toBeNull();
    const draft = deriveDraft(withDivisions(answers, P), D, CONTEXT);
    expect(draft.errors).toEqual({});
    const divisions = draft.payload?.programs[0].categories[0].divisions.map((d) => d.name) ?? [];
    expect(divisions.some((name) => /Youth/.test(name))).toBe(true);
  });

  // The under-18 refusal itself is the OD-02 gate (PR 835), which is not on this base.
  it.todo("OD-02 gate refuses an under-18 competitor whatever the Studio age category (needs PR 835)");
});

describe("R-04 person types and relationship roles stay DanceFlow vocabulary", () => {
  it("identifier arrays and the allowed roles per entry format are unchanged", () => {
    expect([...PERSON_TYPES]).toEqual(["dancer", "student", "professional", "instructor", "team_member", "alternate", "other"]);
    expect([...RELATIONSHIP_ROLES]).toEqual(["dancer", "student", "professional", "instructor", "team_member", "alternate", "other"]);
    expect(Object.fromEntries(["pro_am", "pro_pro", "couple", "mixed_amateur", "random_partner", "professional", "team", "solo", "custom"].map((f) => [f, allowedRolesForFormat(f)]))).toEqual({
      pro_am: ["student", "professional"],
      pro_pro: ["instructor", "professional"],
      couple: ["dancer"],
      mixed_amateur: ["dancer"],
      random_partner: ["dancer"],
      professional: ["professional"],
      team: ["team_member"],
      solo: ["dancer", "student", "professional", "instructor", "alternate", "other"],
      custom: ["dancer", "student", "professional", "instructor", "alternate", "other"],
    });
  });

  it("the DanceFlow role note claims no body status and separates roster classes from body eligibility", () => {
    expect(DANCEFLOW_ROLE_NOTE).toMatch(/do not establish a governing-body professional registration, Pro\/Am Student status/);
    expect(DANCEFLOW_ROLE_NOTE).toMatch(/not a governing-body substitution or reserve procedure/);
  });

  it("the registration validation messages are unchanged", () => {
    const quote = calculateCompetitionRegistrationQuote(EMPTY_CATALOG, { registrationMode: "individual", buyerName: "A", buyerEmail: "a@b.co", people: [], entries: [] } as never);
    expect(quote.errors).toEqual(expect.arrayContaining(["Add at least one dancer or instructor.", "Add at least one competition entry."]));
    const bad = calculateCompetitionRegistrationQuote(EMPTY_CATALOG, { registrationMode: "individual", buyerName: "A", buyerEmail: "a@b.co", people: [{ clientId: "p1", firstName: "A", personType: "wizard" }], entries: [] } as never);
    expect(bad.errors).toContain("Choose a valid person type.");
  });
});

describe("R-05 Multi-Dance and Solo policy wording", () => {
  it("the Multi-Dance minimum of two dances is unchanged and described as DanceFlow policy", () => {
    for (const key of ["ndca_pro_am_multi", "ndca_amateur_multi"]) {
      expect(D.categoryTypes[key].min_dances, key).toBe(2);
      expect(D.categoryTypes[key].dance_selection_mode, key).toBe("prescribed_set");
      expect(D.categoryTypes[key].description, key).toMatch(/DanceFlow Studio policy: a Multi-Dance entry needs at least two dances/);
      expect(D.categoryTypes[key].description, key).toMatch(/Nine- and ten-dance events are not currently supported by DanceFlow/);
      expect(D.categoryTypes[key].registration_hold, key).toEqual(P.categoryTypes[key].registration_hold);
      expect(D.categoryTypes[key].default_pricing, key).toBe(P.categoryTypes[key].default_pricing);
      expect(D.categoryTypes[key].pricing_models, key).toEqual(P.categoryTypes[key].pricing_models);
    }
    expect(D.categoryTypes.ndca_amateur_multi.eligibility_note).toBe(P.categoryTypes.ndca_amateur_multi.eligibility_note);
    expect(D.categoryTypes.ndca_pro_am_multi.label).toBe("Pro/Am Multi-Dance");
  });

  it("Country Solo is DanceFlow's own format, not a Solo Medley or Showdance", () => {
    expect(D.categoryTypes.solo.label).toBe("Studio/Custom: Solo routine");
    expect(D.categoryTypes.solo.description).toMatch(/does not follow any governing body's Solo Medley or Showdance rules/);
    expect(D.categoryTypes.solo.entry_format).toBe("solo");
  });

  it("skipped-dance trace: Multi-Dance cannot open registration and no engine scores a multi-dance run", () => {
    const sql = readFileSync(join(ROOT, "src/lib/supabase/migrations/20261115090000_phase10c5_registration_isolation.sql"), "utf8");
    expect(sql).toContain("hc.configuration #>> '{setup,registration_hold}' is not null");
    expect(sql).toContain("COMP10C_REGISTRATION_HOLD");
    const engine = readFileSync(join(ROOT, "src/lib/competition/results/engines/common.ts"), "utf8");
    expect(engine).toContain("multi_dance_unsupported");
  });
});

describe("R-09 'Not called back' is a display mapping only", () => {
  it("the stored label and the engine constant are unchanged; the display maps it", () => {
    expect(NOT_CALLED_BACK_LABEL).toBe("Semi-final");
    expect(STORED_NOT_CALLED_BACK_LABEL).toBe(NOT_CALLED_BACK_LABEL);
    expect(displayResultLabel("Semi-final")).toBe("Not called back");
    expect(displayResultLabel("Final")).toBe("Final");
    expect(displayResultLabel(null)).toBeNull();
    expect(NOT_CALLED_BACK_DISPLAY).toBe("Not called back");
  });

  it("the PV-1 recompute still writes and compares the stored label (SQL and engine untouched)", () => {
    const sql = readFileSync(join(ROOT, "src/lib/supabase/migrations/20270215090000_competition_pv1_result_recompute.sql"), "utf8");
    expect((sql.match(/'label', 'Semi-final'/g) ?? []).length).toBeGreaterThanOrEqual(2);
    const engine = readFileSync(join(ROOT, "src/lib/competition/results/engines/studioCallbackTally.ts"), "utf8");
    expect(engine).toContain('export const NOT_CALLED_BACK_LABEL = "Semi-final";');
  });

  it("rows that did not advance read 'Not called back' in a callback preliminary only, and never carry a placement", () => {
    const row = { entryNumber: "1", displayName: null, placement: null, tieGroup: null, advanced: false, ratingBand: null, mine: false };
    expect(placementLabel(row, "preliminary")).toBe("Not called back");
    expect(placementLabel(row, "final")).toBe("Not advanced");
    expect(placementLabel(row)).toBe("Not advanced");
    expect(placementLabel({ ...row, advanced: true }, "preliminary")).toBe("Advanced");
    expect(placementLabel({ ...row, placement: 2, advanced: null }, "final")).toBe("2");
    expect(notAdvancedWording({ scoringMethod: "callback_tally", roundType: "preliminary" })).toBe("Not called back");
    expect(notAdvancedWording({ scoringMethod: "ordinal_majority", roundType: "final" })).toBe("Not advanced");
  });

  it("no result page or viewer copy calls an unsuccessful preliminary callback a Semi-final", () => {
    for (const file of [
      "src/app/events/[slug]/competition/results/page.tsx",
      "src/app/app/events/[id]/competition/results/[roundId]/page.tsx",
      "src/app/app/events/[id]/competition/results/[roundId]/CallbackPanels.tsx",
      "src/lib/competition/results/viewer.ts",
    ]) {
      expect(readFileSync(join(ROOT, file), "utf8"), file).not.toMatch(/semi-?final/i);
    }
  });
});
