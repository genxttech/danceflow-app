import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), usePathname: () => "/", redirect: vi.fn(), notFound: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => createElement("a", { href, ...rest }, children as never),
}));
vi.mock("@/app/app/events/[id]/competition/simpleActions", () => ({ createCompetitionDraftAction: vi.fn(), uploadCompetitionCoverImageAction: vi.fn() }));

import { DanceCategoryChoices } from "@/app/app/events/[id]/competition/new/CompetitionSetupWizard";
import { STUDIO_CUSTOM_V2_DEFAULTS as P } from "../studioCustomV2";
import {
  addCustomDance,
  categoryDanceOptions,
  categorySelectedDances,
  chooseAdjudication,
  choosePurpose,
  chooseStyle,
  clearCategoryDances,
  initialAnswers,
  restoreAnswers,
  selectAllCategoryDances,
  stepErrors,
  toggleFormatDance,
  toggleFormatStyle,
  type SetupAnswers,
} from "../draft";
import { loadStoredSetup, saveStoredSetup } from "../persistence";
import { TEST_EVENT, withOfferings } from "./divisionTestHelpers";

/**
 * 10C.5 Dances: Check all / Clear all act on one category only (one offering, or one dance style of a styled
 * offering), and the Nightclub / Specialty presentation of NDCA Additional American Style Dances.
 */

const dances = (answers: SetupAnswers, key: string, format: string) => answers.programs[key].formats[format]!.dances;

function ballroom(): SetupAnswers {
  const answers = chooseAdjudication(chooseStyle(choosePurpose(initialAnswers(undefined, TEST_EVENT), P, "competition"), P, "ballroom"), "ballroom", "adjudicated");
  // Pro/Am in American Smooth and International Latin (one Latin dance picked), Amateur in American Smooth (nothing picked).
  let next = withOfferings(answers, P, "ballroom", ["ndca_pro_am"], ["american_smooth", "international_latin"]);
  next = { ...next, programs: { ...next.programs, ballroom: { ...next.programs.ballroom, formats: { ...next.programs.ballroom.formats, ndca_pro_am: { ...next.programs.ballroom.formats.ndca_pro_am!, dances: ["latin_jive"] } } } } };
  next = toggleFormatStyle(withOfferings(next, P, "ballroom", ["ndca_amateur"]), P, "ballroom", "ndca_amateur", "american_smooth");
  return next;
}

describe("Check all / Clear all are scoped to one category", () => {
  it("Check all selects every dance of that style only; the offering's other styles and other offerings are untouched", () => {
    const before = ballroom();
    const after = selectAllCategoryDances(before, P, "ballroom", "ndca_pro_am", "american_smooth");
    expect(dances(after, "ballroom", "ndca_pro_am")).toEqual(["latin_jive", "smooth_waltz", "smooth_tango", "smooth_foxtrot", "smooth_viennese_waltz"]);
    expect(categorySelectedDances(P, "ballroom", after.programs.ballroom, "ndca_pro_am", "international_latin")).toEqual(["latin_jive"]);
    expect(dances(after, "ballroom", "ndca_amateur")).toEqual([]);
    expect(after.programs.ballroom.formats.ndca_pro_am?.danceStyles).toEqual(before.programs.ballroom.formats.ndca_pro_am?.danceStyles);
  });

  it("Clear all clears that style only", () => {
    let answers = selectAllCategoryDances(ballroom(), P, "ballroom", "ndca_pro_am", "american_smooth");
    answers = selectAllCategoryDances(answers, P, "ballroom", "ndca_amateur", "american_smooth");
    answers = clearCategoryDances(answers, P, "ballroom", "ndca_pro_am", "international_latin");
    expect(dances(answers, "ballroom", "ndca_pro_am")).toEqual(["smooth_waltz", "smooth_tango", "smooth_foxtrot", "smooth_viennese_waltz"]);
    expect(dances(answers, "ballroom", "ndca_amateur")).toHaveLength(4);
    answers = clearCategoryDances(answers, P, "ballroom", "ndca_pro_am", "american_smooth");
    expect(dances(answers, "ballroom", "ndca_pro_am")).toEqual([]);
    expect(dances(answers, "ballroom", "ndca_amateur")).toHaveLength(4);
  });

  it("respects offering and style boundaries: an unchosen or disallowed style is a no-op", () => {
    const answers = ballroom();
    expect(selectAllCategoryDances(answers, P, "ballroom", "ndca_pro_am", "american_rhythm")).toBe(answers);
    expect(selectAllCategoryDances(answers, P, "ballroom", "ndca_pro_am", "country_western")).toBe(answers);
    expect(selectAllCategoryDances(answers, P, "ballroom", "ndca_cabaret", null)).toBe(answers);
    expect(clearCategoryDances(answers, P, "ballroom", "ndca_amateur", "american_smooth")).toBe(answers);
    expect(categoryDanceOptions(P, "ballroom", answers.programs.ballroom, "ndca_pro_am", "american_rhythm")).toEqual([]);
  });

  it("works for an offering without dance styles (Country ProAm)", () => {
    let answers = chooseAdjudication(chooseStyle(choosePurpose(initialAnswers(undefined, TEST_EVENT), P, "competition"), P, "country"), "country", "adjudicated");
    answers = withOfferings(answers, P, "country", ["pro_am", "couples"]);
    answers = clearCategoryDances(answers, P, "country", "pro_am", null);
    expect(dances(answers, "country", "pro_am")).toEqual([]);
    expect(dances(answers, "country", "couples").length).toBeGreaterThan(0);
    answers = selectAllCategoryDances(answers, P, "country", "pro_am", null);
    expect(dances(answers, "country", "pro_am")).toEqual(P.dancePools.country.map((dance) => dance.key));
  });

  it("the count reflects the category's own selections", () => {
    let answers = selectAllCategoryDances(ballroom(), P, "ballroom", "ndca_pro_am", "american_smooth");
    answers = toggleFormatDance(answers, P, "ballroom", "ndca_pro_am", "smooth_tango");
    expect(categorySelectedDances(P, "ballroom", answers.programs.ballroom, "ndca_pro_am", "american_smooth")).toEqual(["smooth_waltz", "smooth_foxtrot", "smooth_viennese_waltz"]);
    const html = renderToStaticMarkup(createElement(DanceCategoryChoices, {
      answers, defaults: P, styleKey: "ballroom", format: "ndca_pro_am", danceStyle: "american_smooth", label: "Pro/Am — American Smooth", update: () => undefined,
    }));
    expect(html).toContain("3 of 4 selected");
    expect(html).toContain(">Check all</button>");
    expect(html).toContain(">Clear all</button>");
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(3);
    expect(html).not.toContain("Jive");
  });

  it("selections survive persistence and a refresh unchanged", () => {
    const answers = clearCategoryDances(selectAllCategoryDances(ballroom(), P, "ballroom", "ndca_pro_am", "american_smooth"), P, "ballroom", "ndca_pro_am", "international_latin");
    expect(restoreAnswers(JSON.parse(JSON.stringify(answers)), P)).toEqual(answers);
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });
    saveStoredSetup("e1", { answers, step: "dances", requestKey: "request-key-0001" });
    const reloaded = restoreAnswers(loadStoredSetup("e1")?.answers, P);
    expect(reloaded?.programs.ballroom.formats.ndca_pro_am?.dances).toEqual(["smooth_waltz", "smooth_tango", "smooth_foxtrot", "smooth_viennese_waltz"]);
  });

  afterEach(() => vi.unstubAllGlobals());
});

describe("Nightclub / Specialty presentation of NDCA Additional American Style Dances", () => {
  const additional = P.programs.ballroom.styles!.find((style) => style.key === "american_additional")!;

  it("keeps the official NDCA category and labels Nightclub as presentation only", () => {
    expect(additional.label).toBe("Additional American Style Dances");
    expect(additional.presentation).toMatchObject({ label: "Nightclub / Specialty Dances", basis: "owner_operational" });
    expect(additional.presentation?.note).toContain("not an NDCA classification");
    expect(additional.presentation?.sources?.[0]).toMatchObject({ section: "IX.B.5.c", page: "41" });
    const labels = Object.values(P.categoryTypes).map((definition) => definition.label);
    expect(labels.filter((label) => /nightclub/i.test(label))).toEqual([]);
    expect(P.programs.ballroom.styles!.map((style) => style.label).filter((label) => /nightclub/i.test(label))).toEqual([]);
  });

  it("does not duplicate dance identities: no repeated names within a style, and listed dances cannot be re-added", () => {
    for (const style of P.programs.ballroom.styles!) {
      const names = style.dances.map((key) => P.dancePools.ballroom.find((dance) => dance.key === key)!.name.toLowerCase());
      expect(new Set(names).size, style.key).toBe(names.length);
    }
    const answers = ballroom();
    for (const name of ["Salsa", "salsa", "Night Club Two-Step", "Paso Doble", "West Coast Swing"]) expect(addCustomDance(answers, P, "ballroom", name)).toBe(answers);
    const added = addCustomDance(answers, P, "ballroom", "Carolina Shag");
    expect(added.programs.ballroom.customDances).toEqual([{ key: "custom_carolina_shag", name: "Carolina Shag", category: "Custom" }]);
  });

  it("nothing is offered or scheduled by default, and an organizer-added dance is marked Studio / Custom", () => {
    let answers = toggleFormatStyle(ballroom(), P, "ballroom", "ndca_pro_am", "american_additional");
    expect(categorySelectedDances(P, "ballroom", answers.programs.ballroom, "ndca_pro_am", "american_additional")).toEqual([]);
    answers = addCustomDance(answers, P, "ballroom", "Carolina Shag");
    const html = renderToStaticMarkup(createElement(DanceCategoryChoices, {
      answers, defaults: P, styleKey: "ballroom", format: "ndca_pro_am", danceStyle: "american_additional", label: "Pro/Am — Additional American Style Dances", update: () => undefined,
    }));
    expect(html).toContain("Nightclub / Specialty Dances");
    expect(html).toContain("0 of 17 selected");
    expect(html).toContain("(added · Studio / Custom)");
  });

  it("Check all on the 16 NDCA examples fits the per-category and per-program dance limits (the cap is per category, not per offering)", () => {
    let answers = toggleFormatStyle(ballroom(), P, "ballroom", "ndca_pro_am", "american_additional");
    answers = selectAllCategoryDances(answers, P, "ballroom", "ndca_pro_am", "american_additional");
    answers = selectAllCategoryDances(answers, P, "ballroom", "ndca_pro_am", "american_smooth");
    answers = selectAllCategoryDances(answers, P, "ballroom", "ndca_pro_am", "international_latin");
    answers = selectAllCategoryDances(answers, P, "ballroom", "ndca_amateur", "american_smooth");
    expect(stepErrors(answers, P, "dances")).toEqual([]);
    expect(P.limits).toMatchObject({ dances: 20, programDances: 60 });
  });
});
