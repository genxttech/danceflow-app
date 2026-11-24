// OD-19 (owner decision 2026-11-23, Option C): Studio/Custom display wording for the `custom` formats.
// Relabelling must not change identifiers, scoring, roles or any other behavior.
import { describe, expect, it } from "vitest";
import { STUDIO_CUSTOM_V3_DEFAULTS as P } from "../studioCustomV3";
import { STUDIO_CUSTOM_DISPLAY, STUDIO_CUSTOM_DISPLAY_KEYS, withStudioCustomDisplayLabels } from "../studioCustomDisplay";
import { chooseAdjudication, chooseStyle, choosePurpose, deriveDraft, initialAnswers, updateFormat, setPricing } from "../draft";
import { allowedRolesForFormat } from "../../participantRoles";
import { TEST_EVENT, withDivisions, withOfferings } from "./divisionTestHelpers";

const D = withStudioCustomDisplayLabels(P);
const CONTEXT = { eventName: "Spring Classic", profileKey: "studio_simple", profileVersion: 3, requestKey: "request-key-0001" };
const BODY_NAMES = /\b(NDCA|UCWDC|WSDC|WDC|USDC)\b|Student\/Student|Pro\/Am Student Competitor/i;
const DISPLAY_FIELDS = ["label", "description", "eligibility_note"] as const;

const TEAM_KEYS = ["team", "ndca_formation", "ndca_team_match", "studio_team"];
const customKeys = Object.entries(P.categoryTypes).filter(([k, d]) => d.entry_format === "custom" || TEAM_KEYS.includes(k)).map(([k]) => k);

describe("OD-19 Studio/Custom display labels", () => {
  it("covers exactly the custom entry formats (a new custom format must be reviewed here)", () => {
    expect([...STUDIO_CUSTOM_DISPLAY_KEYS].sort()).toEqual([...customKeys].sort());
    expect(customKeys.sort()).toEqual(["custom_routine", "ndca_cabaret", "ndca_formation", "ndca_showdance", "ndca_student_student", "ndca_team_match", "ndca_theatre_arts", "routine", "showcase", "spotlight", "studio_team", "team"]);
    // OD-28: the team formats are every team entry format in the profile.
    expect(Object.entries(P.categoryTypes).filter(([, d]) => d.entry_format === "team").map(([k]) => k).sort()).toEqual([...TEAM_KEYS].sort());
  });

  it("persisted ids and every non-display field are unchanged (before/after snapshot)", () => {
    expect(Object.keys(D.categoryTypes)).toEqual(Object.keys(P.categoryTypes));
    for (const [key, before] of Object.entries(P.categoryTypes)) {
      const after = D.categoryTypes[key];
      const strip = (d: typeof before) => {
        const { label: _l, description: _d, eligibility_note: _e, music_source, ...rest } = d;
        const { note: _n, ...musicRest } = music_source;
        return { ...rest, music_source: musicRest };
      };
      expect(strip(after), key).toEqual(strip(before));
    }
    const { categoryTypes: _a, ...restAfter } = D;
    const { categoryTypes: _b, ...restBefore } = P;
    expect(restAfter).toEqual(restBefore);
    // Format ids per style, enum-like fields and the persisted profile identity are byte-identical.
    expect(Object.fromEntries(Object.entries(D.programs).map(([k, v]) => [k, v.formats]))).toEqual(Object.fromEntries(Object.entries(P.programs).map(([k, v]) => [k, v.formats])));
    expect(Object.fromEntries(Object.entries(D.categoryTypes).map(([k, v]) => [k, [v.entry_format, v.contest_type]]))).toEqual(
      Object.fromEntries(Object.entries(P.categoryTypes).map(([k, v]) => [k, [v.entry_format, v.contest_type]])),
    );
  });

  it("does not mutate the seeded profile and is idempotent", () => {
    const before = JSON.stringify(P);
    withStudioCustomDisplayLabels(P);
    expect(JSON.stringify(P)).toBe(before);
    expect(withStudioCustomDisplayLabels(D)).toEqual(D);
  });

  it("custom formats read as DanceFlow Studio/Custom and imply no governing-body rule or certification", () => {
    for (const key of customKeys) {
      const definition = D.categoryTypes[key];
      expect(definition.label, key).toMatch(/^Studio\/Custom: /);
      for (const field of DISPLAY_FIELDS) expect(definition[field] ?? "", `${key}.${field}`).not.toMatch(BODY_NAMES);
      expect(definition.music_source.note ?? "", `${key}.music`).not.toMatch(BODY_NAMES);
      expect(`${definition.label} ${definition.description} ${definition.eligibility_note ?? ""}`, key).not.toMatch(/\b(certified|approved|sanctioned|official)\b/i);
    }
    // The old names were the problem this change removes.
    expect(P.categoryTypes.ndca_student_student.label).toBe("Student/Student");
    expect(D.categoryTypes.ndca_student_student.label).toBe("Studio/Custom: Student pair");
  });

  it("leaves non-custom formats (real role-enforced formats) untouched", () => {
    for (const key of Object.keys(P.categoryTypes).filter((k) => !customKeys.includes(k))) expect(D.categoryTypes[key]).toBe(P.categoryTypes[key]);
    expect(D.categoryTypes.ndca_pro_am.label).toBe("Pro/Am Single-Dance");
  });

  it("does not touch the sanction declaration, scoring or judging configuration", () => {
    expect(D.sanction).toEqual({ status: "none", claimable: false });
    expect(D.judging).toBe(P.judging);
    expect(D.adjudication).toBe(P.adjudication);
    expect(D.divisionSchemes).toBe(P.divisionSchemes);
  });

  it("keeps the flexible Studio/Custom participant-role behavior", () => {
    expect(allowedRolesForFormat("custom")).toEqual(["dancer", "student", "professional", "instructor", "alternate", "other"]);
    for (const key of customKeys) {
      expect(D.categoryTypes[key].participant_roles).toEqual(P.categoryTypes[key].participant_roles);
      expect(D.categoryTypes[key].minimum_participants).toBe(P.categoryTypes[key].minimum_participants);
      expect(D.categoryTypes[key].maximum_participants).toBe(P.categoryTypes[key].maximum_participants);
    }
  });

  it("only a custom entry_format is relabelled (a non-custom definition with a listed key is left alone)", () => {
    const odd = { ...P, categoryTypes: { ...P.categoryTypes, showcase: { ...P.categoryTypes.showcase, entry_format: "couple" } } };
    expect(withStudioCustomDisplayLabels(odd).categoryTypes.showcase.label).toBe("Showcase");
    const missing = { ...P, categoryTypes: Object.fromEntries(Object.entries(P.categoryTypes).filter(([k]) => k !== "spotlight")) };
    expect(Object.keys(withStudioCustomDisplayLabels(missing).categoryTypes)).not.toContain("spotlight");
  });

  it("the draft derives from the relabelled profile with unchanged category type ids, pricing and adjudication", () => {
    let answers = chooseAdjudication(chooseStyle(choosePurpose(initialAnswers(undefined, TEST_EVENT), P, "competition_showcase"), P, "ballroom"), "ballroom", "adjudicated");
    answers = withOfferings(answers, P, "ballroom", ["ndca_pro_am", "ndca_student_student", "ndca_showdance", "ndca_cabaret", "ndca_theatre_arts"], ["american_smooth"]);
    for (const format of ["ndca_pro_am", "ndca_student_student"]) answers = updateFormat(answers, "ballroom", format, { amount: "20" });
    for (const format of ["ndca_showdance", "ndca_cabaret", "ndca_theatre_arts"]) answers = setPricing(answers, P, "ballroom", format, "free");
    const fromSeed = deriveDraft(withDivisions(answers, P), P, CONTEXT);
    const fromDisplay = deriveDraft(withDivisions(answers, D), D, CONTEXT);
    expect(fromSeed.errors).toEqual({});
    expect(fromSeed.payload).not.toBeNull();
    expect(fromSeed.payload).toEqual(fromDisplay.payload);
    // The payload carries ids only: no display wording leaks into what is persisted by the wizard.
    expect(JSON.stringify(fromSeed.payload)).not.toMatch(new RegExp("Studio/Custom:|Student/Student"));
    expect(fromSeed.payload?.programs[0].categories.map((c) => c.type)).toEqual(
      expect.arrayContaining(["ndca_pro_am", "ndca_student_student", "ndca_showdance", "ndca_cabaret", "ndca_theatre_arts"]),
    );
    const labels = fromSeed.programs[0].categories.map((c) => c.label);
    expect(labels.some((l) => l.startsWith("Studio/Custom: Student pair"))).toBe(true);
    expect(labels.join(" | ")).not.toMatch(/Student\/Student/);
    expect(labels.some((l) => l.startsWith("Pro/Am Single-Dance"))).toBe(true);
  });
});
