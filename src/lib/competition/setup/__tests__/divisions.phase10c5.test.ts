import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), usePathname: () => "/", redirect: vi.fn(), notFound: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => createElement("a", { href, ...rest }, children as never),
}));
vi.mock("@/app/app/events/[id]/competition/simpleActions", () => ({ createCompetitionDraftAction: vi.fn() }));

import { DivisionChoices } from "@/app/app/events/[id]/competition/new/CompetitionSetupWizard";
import { STUDIO_CUSTOM_V2_DEFAULTS as P } from "../studioCustomV2";
import {
  addCustomDivisionValue,
  chooseAdjudication,
  choosePurpose,
  chooseStyle,
  clearAxis,
  deriveDraft,
  divisionScheme,
  formatDivisions,
  initialAnswers,
  missingRequiredAxes,
  restoreAnswers,
  selectAllValues,
  stepErrors,
  toggleDivisionValue,
  type SetupAnswers,
} from "../draft";
import type { DivisionAxis, DivisionAxisKey } from "../types";

/**
 * 10C.5 Divisions: which divisions are OFFERED, per entry format, multi-select per axis, with provenance.
 * Owner decisions: nothing is pre-selected, every value is shown, and an empty required axis never
 * produces level-only or age-only divisions by accident.
 */

const CONTEXT = { eventName: "Spring Classic", profileKey: "studio_simple", profileVersion: 2, requestKey: "request-key-0001" };
const axis = (scheme: string, key: string) => P.divisionSchemes[scheme].axes.find((item) => item.key === key) as DivisionAxis;
const value = (scheme: string, key: string, label: string) => axis(scheme, key).values.find((item) => item.label === label)!;
const labels = (scheme: string, key: string) => axis(scheme, key).values.map((item) => item.label);

function country(): SetupAnswers {
  let answers = chooseStyle(choosePurpose(initialAnswers(), P, "competition"), P, "country");
  answers = chooseAdjudication(answers, "country", "adjudicated");
  for (const format of ["pro_am", "pro_pro", "couples"]) answers = { ...answers, programs: { ...answers.programs, country: { ...answers.programs.country, formats: { ...answers.programs.country.formats, [format]: { ...answers.programs.country.formats[format]!, pricing: "free" } } } } };
  return answers;
}

function pick(answers: SetupAnswers, format: string, axisKey: DivisionAxisKey, values: string[]) {
  return values.reduce((current, label) => toggleDivisionValue(current, P, "country", format, axisKey, label), answers);
}

describe("Country Studio / Custom divisions", () => {
  it("nothing is pre-selected: no levels and no age divisions, not even Open", () => {
    const answers = country();
    for (const format of ["pro_am", "pro_pro", "couples"]) {
      expect(answers.programs.country.formats[format]?.divisions).toEqual({ skill_level: [], age_group: [] });
      expect(formatDivisions(P, "country", format, answers.programs.country.formats[format]!)).toEqual([]);
    }
    for (const scheme of Object.values(P.divisionSchemes)) for (const item of scheme.axes) expect(item).not.toHaveProperty("defaults");
  });

  it("multiple skill levels and multiple age divisions are selected independently; divisions are level × age (UCWDC II.A.7)", () => {
    let answers = pick(country(), "pro_am", "skill_level", ["Newcomer", "Novice", "Intermediate", "Advanced", "Open"]);
    answers = pick(answers, "pro_am", "age_group", ["Open", "Crystal", "Diamond"]);
    const divisions = formatDivisions(P, "country", "pro_am", answers.programs.country.formats.pro_am!);
    expect(divisions).toHaveLength(5 * 3);
    expect(divisions[0]).toEqual({ name: "Newcomer · Open", skill_label: "Newcomer", age_label: "Open", axes: { skill_level: "Newcomer", age_group: "Open" } });
    expect(divisions.at(-1)?.name).toBe("Open Level · Diamond");
  });

  it("an empty required axis never yields level-only or age-only divisions", () => {
    const levelsOnly = pick(country(), "pro_am", "skill_level", ["Novice", "Advanced"]);
    expect(formatDivisions(P, "country", "pro_am", levelsOnly.programs.country.formats.pro_am!)).toEqual([]);
    expect(stepErrors(levelsOnly, P, "divisions")).toContain("Choose at least one age division for Country ProAm.");
    const agesOnly = pick(country(), "pro_am", "age_group", ["Crystal"]);
    expect(formatDivisions(P, "country", "pro_am", agesOnly.programs.country.formats.pro_am!)).toEqual([]);
    expect(stepErrors(agesOnly, P, "divisions")).toContain("Choose at least one level for Country ProAm.");
    expect(deriveDraft(levelsOnly, P, CONTEXT).payload).toBeNull();
    expect(missingRequiredAxes(divisionScheme(P, "country", "pro_am"), { skill_level: ["Novice"], age_group: [] }).map((item) => item.key)).toEqual(["age_group"]);
  });

  it("optional axes still split only when chosen (Studio / Ballroom ages) and WSDC contests need no partner axis", () => {
    expect(formatDivisions(P, "ballroom", "pro_am", { divisions: { skill_level: ["Bronze", "Silver"], age_group: [] } }).map((division) => division.name)).toEqual(["Bronze", "Silver"]);
    expect(formatDivisions(P, "ballroom", "pro_am", { divisions: { skill_level: [], age_group: ["B"] } })).toEqual([]);
    expect(formatDivisions(P, "west_coast_swing", "jack_and_jill", { divisions: { skill_level: [], age_group: ["Masters"] } }).map((division) => division.name)).toEqual(["Masters"]);
  });

  it("Country age options are the UCWDC ages, not the old generic Youth / Adult / Senior list", () => {
    expect(labels("country_proam", "age_group")).toEqual(["Junior Primary", "Junior Youth", "Junior Teen", "Open", "Crystal", "Diamond", "Silver", "Gold", "Platinum", "Pearl"]);
    expect(JSON.stringify(P)).not.toContain('"ageBands"');
    for (const scheme of ["country_proam", "country_couples", "country_routine"]) {
      expect(labels(scheme, "age_group")).not.toEqual(expect.arrayContaining(["Youth", "Adult", "Senior"]));
    }
  });

  it("Open age is distinct from the Studio / Custom Open skill level", () => {
    const openAge = value("country_proam", "age_group", "Open");
    const openSkill = value("country_proam", "skill_level", "Open");
    expect(openAge).toMatchObject({ basis: "source_grounded", eligibility: { min_age: 18 } });
    expect(openAge.sources?.[0]).toMatchObject({ section: "II.D" });
    expect(openSkill).toMatchObject({ basis: "studio_recommendation", name_label: "Open Level" });
    expect(openSkill.eligibility?.note).toContain("UCWDC uses Open only as an age division, not a ProAm skill level");
    expect(openSkill.sources).toBeUndefined();
  });

  it("Crystal / Diamond / Silver / Gold / Platinum / Pearl carry the UCWDC thresholds", () => {
    const thresholds = ["Crystal", "Diamond", "Silver", "Gold", "Platinum", "Pearl"].map((label) => value("country_proam", "age_group", label).eligibility?.min_age);
    expect(thresholds).toEqual([30, 40, 50, 60, 70, 80]);
    expect(value("country_proam", "age_group", "Junior Youth").eligibility).toEqual({ min_age: 10, under_age: 14 });
  });

  it("ProAm, ProPro and Couples have different division options and are all required level × age", () => {
    expect(P.programs.country.division_schemes).toMatchObject({ pro_am: "country_proam", pro_pro: "country_propro", couples: "country_couples" });
    for (const scheme of ["country_proam", "country_propro", "country_couples"]) {
      expect(P.divisionSchemes[scheme].axes.map((item) => [item.key, item.required])).toEqual([["skill_level", true], ["age_group", true]]);
    }
    expect(labels("country_couples", "skill_level")).toEqual(expect.arrayContaining(["Classic III", "Classic II", "Classic II/I", "Classic I"]));
    expect(labels("country_proam", "skill_level")).not.toContain("Classic III");
    expect(labels("country_couples", "age_group")).not.toContain("Pearl");
    expect(labels("country_couples", "age_group")).toEqual(expect.arrayContaining(["Masters", "Masters Plus", "Crown", "Crown Plus"]));
  });

  it("UCWDC granularity is selectable directly (Newcomer IV–I, AllStars); values from another ladder are not", () => {
    expect(labels("country_proam", "skill_level")).toEqual(["Newcomer", "Newcomer IV", "Newcomer III", "Newcomer II", "Newcomer I", "Novice", "Intermediate", "Advanced", "AllStars", "Open"]);
    let answers = pick(country(), "pro_am", "skill_level", ["Newcomer III"]);
    expect(answers.programs.country.formats.pro_am?.divisions.skill_level).toEqual(["Newcomer III"]);
    answers = toggleDivisionValue(answers, P, "country", "pro_am", "skill_level", "Classic III");
    expect(answers.programs.country.formats.pro_am?.divisions.skill_level).toEqual(["Newcomer III"]);
  });

  it("Select all selects every value, Clear empties, organizer-defined values are allowed", () => {
    let answers = selectAllValues(country(), P, "country", "pro_am", "age_group");
    expect(answers.programs.country.formats.pro_am?.divisions.age_group).toEqual(labels("country_proam", "age_group"));
    answers = clearAxis(answers, P, "country", "pro_am", "age_group");
    expect(answers.programs.country.formats.pro_am?.divisions.age_group).toEqual([]);
    answers = pick(answers, "pro_am", "age_group", ["Pearl"]);
    answers = addCustomDivisionValue(answers, P, "country", "pro_am", "skill_level", "Rising Star");
    expect(formatDivisions(P, "country", "pro_am", answers.programs.country.formats.pro_am!).map((division) => division.name)).toEqual(["Rising Star · Pearl"]);
    expect(addCustomDivisionValue(answers, P, "country", "pro_am", "skill_level", "novice")).toBe(answers);
  });

  it("selections survive persistence (restore) unchanged", () => {
    let answers = pick(pick(country(), "pro_am", "skill_level", ["Novice"]), "pro_am", "age_group", ["Gold"]);
    answers = pick(answers, "couples", "age_group", ["Crystal"]);
    const restored = restoreAnswers(JSON.parse(JSON.stringify(answers)), P);
    expect(restored?.programs.country.formats.pro_am?.divisions).toEqual({ skill_level: ["Novice"], age_group: ["Gold"] });
    expect(restored?.programs.country.formats.couples?.divisions).toEqual({ skill_level: [], age_group: ["Crystal"] });
    const broken = JSON.parse(JSON.stringify(answers));
    broken.programs.country.formats.pro_am.divisions = { skill_level: "Novice" };
    expect(restoreAnswers(broken, P)).toBeNull();
    expect(restoreAnswers({ ...answers, version: 2 }, P)).toBeNull();
  });

  it("Review and the payload reflect every selected division with its axes", () => {
    let answers = pick(pick(country(), "pro_am", "skill_level", ["Newcomer", "Intermediate"]), "pro_am", "age_group", ["Open", "Diamond"]);
    answers = pick(pick(answers, "pro_pro", "skill_level", ["ProPro I"]), "pro_pro", "age_group", ["Open"]);
    answers = pick(pick(answers, "couples", "skill_level", ["Novice"]), "couples", "age_group", ["Crystal", "Silver"]);
    const draft = deriveDraft(answers, P, CONTEXT);
    expect(draft.errors).toEqual({});
    expect(draft.programs[0].categories.find((category) => category.label === "ProAm")?.divisions).toEqual([
      "Newcomer · Open", "Newcomer · Diamond", "Intermediate · Open", "Intermediate · Diamond",
    ]);
    const payload = draft.payload!.programs[0].categories.find((category) => category.type === "pro_am")!;
    expect(payload.divisions.find((division) => division.name === "Intermediate · Diamond")).toEqual({
      name: "Intermediate · Diamond", skill_label: "Intermediate", age_label: "Diamond", axes: { skill_level: "Intermediate", age_group: "Diamond" },
    });
    expect(draft.counts.divisions).toBe(4 + 1 + 2);
  });

  it("the Divisions UI shows every value immediately as unselected multi-select chips (no More options)", () => {
    const html = renderToStaticMarkup(createElement(DivisionChoices, { answers: country(), defaults: P, styleKey: "country", format: "pro_am", update: () => undefined }));
    for (const label of [...labels("country_proam", "skill_level"), ...labels("country_proam", "age_group")]) expect(html).toContain(`>${label}</button>`);
    expect(html).not.toContain('aria-pressed="true"');
    expect(html.match(/aria-pressed="false"/g)?.length).toBe(20);
    expect(html).not.toContain("More options");
    expect(html).not.toContain("<details");
    expect(html.match(/>Select all</g)?.length).toBe(2);
    expect(html.match(/>Clear</g)?.length).toBe(2);
    expect(html.match(/choose at least one/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("0 divisions");
    expect(html).not.toMatch(/type="radio"/);
  });
});

describe("source contracts", () => {
  it("UCWDC ProAm ladder and ProPro ladder are source-backed; Studio Open skill is not claimed official", () => {
    const proam = axis("country_proam", "skill_level").values.filter((item) => item.basis === "source_grounded").map((item) => item.label);
    expect(proam).toEqual(["Newcomer IV", "Newcomer III", "Newcomer II", "Newcomer I", "Novice", "Intermediate", "Advanced", "AllStars"]);
    expect(value("country_proam", "skill_level", "Novice").sources?.[0]).toMatchObject({ section: "II.E.1", page: "4", edition: "2026 (v1-26-2026)" });
    expect(value("country_propro", "skill_level", "ProPro I").sources?.[0]).toMatchObject({ section: "II.E.2" });
    for (const scheme of ["country_proam", "country_propro", "country_couples"]) expect(value(scheme, "skill_level", "Open").basis).toBe("studio_recommendation");
  });

  it("Country ProPro: its own ProPro II / I levels plus the shared ProPro/ProAm II.D age divisions", () => {
    expect(labels("country_propro", "skill_level")).toEqual(["ProPro II", "ProPro I", "Open"]);
    expect(labels("country_propro", "skill_level")).not.toEqual(expect.arrayContaining(["Novice", "Newcomer IV", "AllStars"]));
    expect(labels("country_propro", "age_group")).toEqual(labels("country_proam", "age_group"));
    for (const label of labels("country_propro", "age_group")) {
      expect(value("country_propro", "age_group", label).sources?.[0]).toMatchObject({
        document: "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
        section: "II.D",
      });
    }
    expect(value("country_propro", "age_group", "Pearl").eligibility).toEqual({ min_age: 80 });
    expect(P.divisionSchemes.country_propro.note).not.toMatch(/NOT SPECIFIED/);
  });

  it("ProPro age selections drive the divisions and survive persistence and Review", () => {
    let answers = pick(country(), "pro_pro", "skill_level", ["ProPro II", "ProPro I"]);
    answers = pick(answers, "pro_pro", "age_group", ["Open", "Crystal", "Diamond"]);
    expect(formatDivisions(P, "country", "pro_pro", answers.programs.country.formats.pro_pro!).map((division) => division.name)).toEqual([
      "ProPro II · Open", "ProPro II · Crystal", "ProPro II · Diamond", "ProPro I · Open", "ProPro I · Crystal", "ProPro I · Diamond",
    ]);
    const restored = restoreAnswers(JSON.parse(JSON.stringify(answers)), P)!;
    expect(restored.programs.country.formats.pro_pro?.divisions).toEqual({ skill_level: ["ProPro II", "ProPro I"], age_group: ["Open", "Crystal", "Diamond"] });
    expect(deriveDraft(restored, P, CONTEXT).programs[0].categories.find((category) => category.label === "ProPro")?.divisions).toContain("ProPro I · Crystal");
  });

  it("UCWDC Couples differs: its own ladder, no Pearl, ascension divisions with age floors", () => {
    expect(value("country_couples", "skill_level", "Classic II/I")).toMatchObject({ basis: "source_grounded" });
    expect(value("country_couples", "age_group", "Masters Plus").eligibility).toMatchObject({ min_age: 45 });
    expect(value("country_couples", "age_group", "Crown Plus").eligibility?.note).toContain("Ascension");
    expect(value("country_couples", "age_group", "Junior Teen").eligibility?.note).toBe("Older partner's age.");
  });

  it("WSDC skill levels and age-based contests are separate contests, not skill × age combinations", () => {
    const scheme = P.divisionSchemes.wcs_contests;
    expect(scheme.combination).toBe("separate");
    expect(scheme.axes.map((item) => item.required)).toEqual([false, false]);
    expect(labels("wcs_contests", "skill_level")).toEqual(["Newcomer", "Novice", "Intermediate", "Advanced", "All Star", "Champion"]);
    expect(labels("wcs_contests", "age_group")).toEqual(["Juniors", "Sophisticated", "Masters"]);
    expect(value("wcs_contests", "age_group", "Sophisticated").eligibility).toEqual({ min_age: 35 });
    const divisions = formatDivisions(P, "west_coast_swing", "jack_and_jill", { divisions: { skill_level: ["Novice", "Advanced"], age_group: ["Sophisticated", "Masters"] } });
    expect(divisions.map((division) => division.name)).toEqual(["Novice", "Advanced", "Sophisticated", "Masters"]);
    expect(divisions[2]).toEqual({ name: "Sophisticated", age_label: "Sophisticated", axes: { age_group: "Sophisticated" } });
  });

  it("NDCA lists are permissive and source-backed; ages are optional", () => {
    expect(value("ballroom_proam", "skill_level", "Gold Star").sources?.[0]).toMatchObject({ section: "II.B.7.c" });
    expect(value("ballroom_proam", "age_group", "B").eligibility).toEqual({ min_age: 36 });
    expect(value("ballroom_amateur", "age_group", "Senior II").eligibility?.note).toContain("45+");
    expect(P.divisionSchemes.ballroom_proam.note).toContain("no universal division list");
    expect(axis("ballroom_proam", "age_group").required).toBe(false);
    expect(axis("ballroom_proam", "skill_level").required).toBe(true);
  });

  it("every source-grounded division value cites a section; Studio values cite none", () => {
    for (const [key, scheme] of Object.entries(P.divisionSchemes)) {
      for (const item of scheme.axes.flatMap((entry) => entry.values)) {
        if (item.basis === "source_grounded") expect(item.sources?.[0]?.section, `${key} ${item.label}`).toBeTruthy();
        else expect(item.sources, `${key} ${item.label}`).toBeUndefined();
      }
    }
  });
});

describe("regressions", () => {
  it("limits stay 80 divisions per format and 300 overall", () => {
    expect(P.limits.divisions).toBe(80);
    expect(P.limits.totalDivisions).toBe(300);
  });

  it("a format without a scheme falls back to one open division that must still be chosen", () => {
    const scheme = divisionScheme(P, "country", "team");
    expect(scheme.label).toBe("One open division");
    expect(formatDivisions(P, "country", "team", { divisions: {} })).toEqual([]);
    expect(formatDivisions(P, "country", "team", { divisions: { skill_level: ["Open"] } }).map((division) => division.name)).toEqual(["Open"]);
  });
});
