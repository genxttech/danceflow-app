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
  restoreAnswers,
  selectRecommended,
  stepErrors,
  toggleDivisionValue,
  type SetupAnswers,
} from "../draft";
import type { DivisionAxis } from "../types";

/** 10C.5 Divisions: which divisions are OFFERED, per entry format, multi-select per axis, with provenance. */

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

describe("Country Studio / Custom divisions", () => {
  it("offers multiple skill levels at once by default (not one preset)", () => {
    const answers = country();
    expect(answers.programs.country.formats.pro_am?.divisions.skill_level).toEqual(["Newcomer", "Novice", "Intermediate", "Advanced", "Open"]);
    expect(formatDivisions(P, "country", "pro_am", answers.programs.country.formats.pro_am!).map((division) => division.name)).toEqual([
      "Newcomer · Open", "Novice · Open", "Intermediate · Open", "Advanced · Open", "Open Level · Open",
    ]);
  });

  it("multiple age divisions can be selected, and the divisions are level × age (UCWDC II.A.7)", () => {
    let answers = country();
    for (const age of ["Crystal", "Diamond", "Silver"]) answers = toggleDivisionValue(answers, P, "country", "pro_am", "age_group", age);
    answers = toggleDivisionValue(answers, P, "country", "pro_am", "skill_level", "Open");
    const divisions = formatDivisions(P, "country", "pro_am", answers.programs.country.formats.pro_am!);
    expect(divisions).toHaveLength(4 * 4);
    expect(divisions[0]).toEqual({ name: "Newcomer · Open", skill_label: "Newcomer", age_label: "Open", axes: { skill_level: "Newcomer", age_group: "Open" } });
    expect(divisions.map((division) => division.age_label).slice(0, 4)).toEqual(["Open", "Crystal", "Diamond", "Silver"]);
  });

  it("Country age options are the UCWDC ages, not the old generic Youth / Adult / Senior list", () => {
    expect(labels("country_proam", "age_group")).toEqual(["Junior Primary", "Junior Youth", "Junior Teen", "Open", "Crystal", "Diamond", "Silver", "Gold", "Platinum", "Pearl"]);
    expect(axis("country_proam", "age_group").recommended).toEqual(["open", "crystal", "diamond", "silver", "gold", "platinum", "pearl"]);
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

  it("ProAm, ProPro and Couples have different division options", () => {
    expect(P.programs.country.division_schemes).toMatchObject({ pro_am: "country_proam", pro_pro: "country_propro", couples: "country_couples" });
    expect(labels("country_propro", "skill_level")).toEqual(["ProPro II", "ProPro I", "Open"]);
    expect(P.divisionSchemes.country_propro.axes.map((item) => item.key)).toEqual(["skill_level", "age_group"]);
    expect(labels("country_couples", "skill_level")).toEqual(expect.arrayContaining(["Classic III", "Classic II", "Classic II/I", "Classic I"]));
    expect(labels("country_proam", "skill_level")).not.toContain("Classic III");
    expect(labels("country_couples", "age_group")).not.toContain("Pearl");
    expect(labels("country_couples", "age_group")).toEqual(expect.arrayContaining(["Masters", "Masters Plus", "Crown", "Crown Plus"]));
    const answers = country();
    expect(answers.programs.country.formats.pro_pro?.divisions.skill_level).toEqual(["ProPro II", "ProPro I"]);
  });

  it("UCWDC granularity is available but not forced: Newcomer IV–I and AllStars sit under More options", () => {
    const proam = axis("country_proam", "skill_level");
    expect(proam.recommended).toEqual(["newcomer", "novice", "intermediate", "advanced", "open"]);
    expect(labels("country_proam", "skill_level")).toEqual(["Newcomer", "Newcomer IV", "Newcomer III", "Newcomer II", "Newcomer I", "Novice", "Intermediate", "Advanced", "AllStars", "Open"]);
    let answers = toggleDivisionValue(country(), P, "country", "pro_am", "skill_level", "Newcomer III");
    expect(answers.programs.country.formats.pro_am?.divisions.skill_level).toContain("Newcomer III");
    answers = toggleDivisionValue(answers, P, "country", "pro_am", "skill_level", "Classic III");
    expect(answers.programs.country.formats.pro_am?.divisions.skill_level).not.toContain("Classic III");
  });

  it("Select all, Clear and organizer-defined values", () => {
    let answers = clearAxis(country(), P, "country", "pro_am", "age_group");
    expect(answers.programs.country.formats.pro_am?.divisions.age_group).toEqual([]);
    answers = selectRecommended(answers, P, "country", "pro_am", "age_group");
    expect(answers.programs.country.formats.pro_am?.divisions.age_group).toEqual(["Open", "Crystal", "Diamond", "Silver", "Gold", "Platinum", "Pearl"]);
    answers = addCustomDivisionValue(answers, P, "country", "pro_am", "skill_level", "Rising Star");
    expect(formatDivisions(P, "country", "pro_am", answers.programs.country.formats.pro_am!).at(-1)?.name).toBe("Rising Star · Pearl");
    expect(addCustomDivisionValue(answers, P, "country", "pro_am", "skill_level", "novice")).toBe(answers);
  });

  it("selection survives persistence (restore) unchanged", () => {
    const answers = toggleDivisionValue(toggleDivisionValue(country(), P, "country", "pro_am", "age_group", "Gold"), P, "country", "couples", "age_group", "Crystal");
    const restored = restoreAnswers(JSON.parse(JSON.stringify(answers)), P);
    expect(restored?.programs.country.formats.pro_am?.divisions).toEqual(answers.programs.country.formats.pro_am?.divisions);
    expect(restored?.programs.country.formats.couples?.divisions.age_group).toEqual(["Open", "Crystal"]);
    const broken = JSON.parse(JSON.stringify(answers));
    broken.programs.country.formats.pro_am.divisions = { skill_level: "Novice" };
    expect(restoreAnswers(broken, P)).toBeNull();
    expect(restoreAnswers({ ...answers, version: 2 }, P)).toBeNull();
  });

  it("Review and the payload reflect every selected division with its axes", () => {
    let answers = toggleDivisionValue(country(), P, "country", "pro_am", "age_group", "Diamond");
    answers = toggleDivisionValue(answers, P, "country", "couples", "age_group", "Crystal");
    const draft = deriveDraft(answers, P, CONTEXT);
    expect(draft.errors).toEqual({});
    const proam = draft.programs[0].categories.find((category) => category.label === "ProAm")!;
    expect(proam.divisions).toHaveLength(10);
    expect(proam.divisions).toContain("Intermediate · Diamond");
    const payload = draft.payload!.programs[0].categories.find((category) => category.type === "pro_am")!;
    expect(payload.divisions.find((division) => division.name === "Intermediate · Diamond")).toEqual({
      name: "Intermediate · Diamond", skill_label: "Intermediate", age_label: "Diamond", axes: { skill_level: "Intermediate", age_group: "Diamond" },
    });
    expect(draft.counts.divisions).toBe(10 + 2 + 5 * 2);
  });

  it("the Divisions UI renders multi-select chips per axis, with More options, Select all and Clear", () => {
    const html = renderToStaticMarkup(createElement(DivisionChoices, { answers: country(), defaults: P, styleKey: "country", format: "pro_am", update: () => undefined }));
    expect(html).toContain("Levels");
    expect(html).toContain("Age divisions");
    for (const label of ["Newcomer", "Novice", "Intermediate", "Advanced", "Crystal", "Pearl"]) expect(html).toContain(`>${label}</button>`);
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(6);
    expect(html).toContain("More options");
    expect(html).toContain("Newcomer IV");
    expect(html.match(/>Select all</g)?.length).toBe(2);
    expect(html.match(/>Clear</g)?.length).toBe(2);
    expect(html).toContain("5 divisions");
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
    expect(axis("country_propro", "age_group").recommended).toEqual(["open", "crystal", "diamond", "silver", "gold", "platinum", "pearl"]);
    expect(axis("country_propro", "age_group").defaults).toEqual(["open"]);
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
    let answers = toggleDivisionValue(country(), P, "country", "pro_pro", "age_group", "Crystal");
    answers = toggleDivisionValue(answers, P, "country", "pro_pro", "age_group", "Diamond");
    expect(formatDivisions(P, "country", "pro_pro", answers.programs.country.formats.pro_pro!).map((division) => division.name)).toEqual([
      "ProPro II · Open", "ProPro II · Crystal", "ProPro II · Diamond", "ProPro I · Open", "ProPro I · Crystal", "ProPro I · Diamond",
    ]);
    const restored = restoreAnswers(JSON.parse(JSON.stringify(answers)), P);
    expect(restored?.programs.country.formats.pro_pro?.divisions).toEqual({ skill_level: ["ProPro II", "ProPro I"], age_group: ["Open", "Crystal", "Diamond"] });
    const draft = deriveDraft(restored!, P, CONTEXT);
    expect(draft.programs[0].categories.find((category) => category.label === "ProPro")?.divisions).toContain("ProPro I · Crystal");
    const payload = draft.payload!.programs[0].categories.find((category) => category.type === "pro_pro")!;
    expect(payload.divisions.find((division) => division.name === "ProPro I · Crystal")).toEqual({
      name: "ProPro I · Crystal", skill_label: "ProPro I", age_label: "Crystal", axes: { skill_level: "ProPro I", age_group: "Crystal" },
    });
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
    expect(labels("wcs_contests", "skill_level")).toEqual(["Newcomer", "Novice", "Intermediate", "Advanced", "All Star", "Champion"]);
    expect(labels("wcs_contests", "age_group")).toEqual(["Juniors", "Sophisticated", "Masters"]);
    expect(value("wcs_contests", "age_group", "Sophisticated").eligibility).toEqual({ min_age: 35 });
    const divisions = formatDivisions(P, "west_coast_swing", "jack_and_jill", { divisions: { skill_level: ["Novice", "Advanced"], age_group: ["Sophisticated", "Masters"] } });
    expect(divisions.map((division) => division.name)).toEqual(["Novice", "Advanced", "Sophisticated", "Masters"]);
    expect(divisions[2]).toEqual({ name: "Sophisticated", age_label: "Sophisticated", axes: { age_group: "Sophisticated" } });
  });

  it("NDCA lists are permissive and source-backed; Studio picks the defaults", () => {
    expect(value("ballroom_proam", "skill_level", "Gold Star").sources?.[0]).toMatchObject({ section: "II.B.7.c" });
    expect(value("ballroom_proam", "age_group", "B").eligibility).toEqual({ min_age: 36 });
    expect(value("ballroom_amateur", "age_group", "Senior II").eligibility?.note).toContain("45+");
    expect(P.divisionSchemes.ballroom_proam.note).toContain("no universal division list");
    expect(axis("ballroom_proam", "age_group").defaults).toEqual([]);
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
  it("Divisions step errors are per format and a cleared format must offer something", () => {
    let answers = clearAxis(clearAxis(country(), P, "country", "pro_pro", "skill_level"), P, "country", "pro_pro", "age_group");
    expect(stepErrors(answers, P, "divisions")).toEqual(["Add at least one division for Country ProPro."]);
    answers = toggleDivisionValue(answers, P, "country", "pro_pro", "skill_level", "ProPro I");
    expect(stepErrors(answers, P, "divisions")).toEqual([]);
  });

  it("a format without a scheme falls back to one open division", () => {
    expect(divisionScheme(P, "country", "team").label).toBe("One open division");
  });
});
