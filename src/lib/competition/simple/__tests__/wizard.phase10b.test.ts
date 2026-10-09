import { describe, expect, it } from "vitest";
import { STUDIO_SIMPLE_V1_DEFAULTS as defaults } from "@/lib/competition/simple/studioSimpleV1";
import type { PresetKey } from "@/lib/competition/simple/types";
import {
  LAST_STEP,
  addLevel,
  applyDivisionPreset,
  buildSpec,
  canAdvance,
  choosePreset,
  divisionList,
  goBack,
  goNext,
  goToStep,
  initialWizardState,
  parsePrice,
  removeLevel,
  setJudging,
  setPrice,
  stepErrors,
  toggleAgeBand,
  toggleCategory,
  toggleDance,
  validateSpec,
  wizardComplete,
  type WizardState,
} from "@/lib/competition/simple/wizard";

const PROFILE = { key: "studio_simple", version: 1 };
const KEY = "req-0123456789";

function priced(state: WizardState) {
  let next = state;
  for (const type of Object.keys(state.categories) as Array<keyof WizardState["categories"]>) next = setPrice(next, type as never, "25");
  return next;
}

function completed(preset: PresetKey) {
  return priced(choosePreset(initialWizardState("Spring Showcase"), defaults, preset));
}

describe("Simple Mode wizard: progression", () => {
  it("starts on step 1 with the event name and nothing chosen", () => {
    const state = initialWizardState("Spring Showcase");
    expect(state.step).toBe(0);
    expect(state.name).toBe("Spring Showcase");
    expect(state.preset).toBeNull();
    expect(stepErrors(state, 0, defaults)).toContain("Choose what you are creating.");
  });

  it("cannot leave the first step until a competition type is chosen", () => {
    const state = initialWizardState("Spring Showcase");
    expect(canAdvance(state, defaults)).toBe(false);
    expect(goNext(state, defaults).step).toBe(0);
    expect(goNext(choosePreset(state, defaults, "studio_competition"), defaults).step).toBe(1);
  });

  it("walks the five steps in order and stops at the last one", () => {
    let state = choosePreset(initialWizardState("Spring Showcase"), defaults, "studio_competition");
    const visited = [state.step];
    for (let index = 0; index < 6; index += 1) {
      state = goNext(state, defaults);
      if (visited[visited.length - 1] !== state.step) visited.push(state.step);
    }
    expect(visited).toEqual([0, 1, 2, 3, 4]);
    expect(state.step).toBe(LAST_STEP);
    expect(goNext(state, defaults).step).toBe(LAST_STEP);
  });

  it("blocks the last step and completion until every category has a valid price", () => {
    const state = { ...choosePreset(initialWizardState("Spring Showcase"), defaults, "studio_competition"), step: 4 };
    expect(wizardComplete(state, defaults)).toBe(false);
    expect(stepErrors(state, 4, defaults).length).toBeGreaterThan(0);
    expect(wizardComplete(priced(state), defaults)).toBe(true);
    expect(stepErrors(setPrice(priced(state), "pro_am", "abc"), 4, defaults).join(" ")).toContain("price for ProAm");
    expect(parsePrice("12.5")).toBe(12.5);
    expect(parsePrice("-1")).toBeNull();
    expect(parsePrice("")).toBeNull();
    expect(parsePrice("1,000")).toBeNull();
  });

  it("going back keeps every choice; jumping forward needs the steps in between to be valid", () => {
    let state = priced(choosePreset(initialWizardState("Spring Showcase"), defaults, "ballroom"));
    state = goToStep(state, defaults, 4);
    expect(state.step).toBe(4);
    const back = goBack(goBack(state));
    expect(back.step).toBe(2);
    expect(back.categories).toEqual(state.categories);
    expect(back.levels).toEqual(state.levels);
    expect(back.judging).toBe(state.judging);

    const broken = { ...state, step: 1, categories: {} };
    expect(goToStep(broken, defaults, 3).step).toBe(1);
    expect(goToStep(initialWizardState("x"), defaults, 2).step).toBe(0);
  });

  it("changing the competition type resets the downstream choices to that type's defaults", () => {
    const first = priced(choosePreset(initialWizardState("Spring Showcase"), defaults, "studio_competition"));
    const showcase = choosePreset({ ...first, step: 2 }, defaults, "showcase");
    expect(Object.keys(showcase.categories)).toEqual(["showcase"]);
    expect(showcase.judging).toBe("ratings");
    expect(showcase.levels).toEqual(["Open"]);
    expect(showcase.step).toBe(2);
  });
});

describe("Simple Mode wizard: choices", () => {
  it("only offers the categories of the chosen competition type", () => {
    const state = choosePreset(initialWizardState("x"), defaults, "west_coast_swing");
    expect(toggleCategory(state, defaults, "team")).toBe(state);
    expect(Object.keys(toggleCategory(state, defaults, "couples").categories).sort()).toEqual(["couples", "jack_and_jill"]);
  });

  it("dance-based categories need dances; routine categories do not", () => {
    let state = choosePreset(initialWizardState("x"), defaults, "studio_competition");
    expect(state.categories.pro_am?.dances.length).toBeGreaterThan(0);
    expect(state.categories.solo?.dances).toEqual([]);
    for (const dance of [...(state.categories.pro_am?.dances ?? [])]) state = toggleDance(state, "pro_am", dance);
    expect(stepErrors(state, 1, defaults).join(" ")).toContain("Choose at least one dance for ProAm");
    expect(stepErrors(state, 1, defaults).join(" ")).not.toContain("Solo");
    state = toggleDance(state, "pro_am", "waltz");
    expect(stepErrors(state, 1, defaults)).toEqual([]);
  });

  it("needs at least one category", () => {
    let state = choosePreset(initialWizardState("x"), defaults, "custom");
    state = toggleCategory(state, defaults, "solo");
    expect(stepErrors(state, 1, defaults)).toContain("Choose at least one category.");
  });

  it("builds divisions from levels, optional age groups and custom names without duplicates", () => {
    let state = choosePreset(initialWizardState("x"), defaults, "country");
    expect(divisionList(state).map((division) => division.name)).toEqual(["Beginner", "Intermediate", "Advanced"]);
    state = toggleAgeBand(toggleAgeBand(state, "Youth"), "Adult");
    expect(divisionList(state).map((division) => division.name)).toEqual([
      "Beginner · Youth", "Beginner · Adult", "Intermediate · Youth", "Intermediate · Adult", "Advanced · Youth", "Advanced · Adult",
    ]);
    expect(divisionList(state)[1]).toEqual({ name: "Beginner · Adult", skill_label: "Beginner", age_label: "Adult" });
    state = addLevel({ ...state, ageBands: [] }, defaults, "Pre-Competitive");
    expect(state.levels).toContain("Pre-Competitive");
    expect(addLevel(state, defaults, " pre-competitive ")).toBe(state);
    expect(addLevel(state, defaults, "   ")).toBe(state);
    state = removeLevel(state, "Beginner");
    expect(state.levels).not.toContain("Beginner");
    expect(stepErrors({ ...state, levels: [] }, 2, defaults)).toContain("Add at least one division.");
    expect(applyDivisionPreset(state, defaults, "levels_newcomer_gold").levels).toEqual(["Newcomer", "Bronze", "Silver", "Gold"]);
  });

  it("rejects too many divisions", () => {
    const levels = Array.from({ length: defaults.limits.divisions + 1 }, (_, index) => `Level ${index}`);
    expect(stepErrors({ ...initialWizardState("x"), levels }, 2, defaults).join(" ")).toContain("60 divisions or fewer");
  });

  it("registration dates are optional but must be ordered", () => {
    const state = { ...priced(choosePreset(initialWizardState("x"), defaults, "studio_competition")) };
    expect(stepErrors({ ...state, registrationOpens: "2027-01-05", registrationCloses: "2027-02-05" }, 4, defaults)).toEqual([]);
    expect(stepErrors({ ...state, registrationOpens: "2027-03-05", registrationCloses: "2027-02-05" }, 4, defaults)).toContain("Registration cannot close before it opens.");
    expect(stepErrors({ ...state, registrationOpens: "tomorrow" }, 4, defaults)).toContain("Registration dates must be valid dates.");
  });

  it("judging defaults come from the competition type and can be changed", () => {
    expect(choosePreset(initialWizardState("x"), defaults, "showcase").judging).toBe("ratings");
    const state = setJudging(choosePreset(initialWizardState("x"), defaults, "studio_competition"), "callbacks");
    expect(state.judging).toBe("callbacks");
    expect(stepErrors(state, 3, defaults)).toEqual([]);
  });
});

describe("Simple Mode wizard: specification", () => {
  it.each(["studio_competition", "showcase", "ballroom", "country", "west_coast_swing", "custom"] as PresetKey[])(
    "every default %s configuration completes the wizard into a valid specification",
    (preset) => {
      const state = completed(preset);
      expect(wizardComplete(state, defaults)).toBe(true);
      const spec = buildSpec(state, defaults, PROFILE, KEY);
      expect(validateSpec(spec, defaults)).toEqual([]);
      expect(spec.profile_key).toBe("studio_simple");
      expect(spec.profile_version).toBe(1);
    },
  );

  it("carries categories, prices, dances and divisions, and no engine names", () => {
    const state = setPrice(toggleCategory(completed("studio_competition"), defaults, "solo"), "pro_am", "30");
    const spec = buildSpec(state, defaults, PROFILE, KEY);
    expect(spec.categories).toEqual([{ type: "pro_am", price: 30, dances: ["waltz", "foxtrot", "cha_cha", "rumba"] }]);
    expect(spec.judging).toBe("placements");
    expect(spec.divisions).toHaveLength(4);
    expect(JSON.stringify(spec)).not.toMatch(/ordinal|majority|tally|proficiency_rating/i);
  });

  it("is deterministic so a retried submission is the same request", () => {
    const state = completed("ballroom");
    expect(buildSpec(state, defaults, PROFILE, KEY)).toEqual(buildSpec(state, defaults, PROFILE, KEY));
  });

  it("rejects what the database would reject", () => {
    const base = buildSpec(completed("country"), defaults, PROFILE, KEY);
    expect(validateSpec({ ...base, categories: [] }, defaults).join(" ")).toContain("categories");
    expect(validateSpec({ ...base, divisions: [] }, defaults).join(" ")).toContain("divisions");
    expect(validateSpec({ ...base, divisions: [{ name: "A" }, { name: " a " }] }, defaults).join(" ")).toContain("unique");
    expect(validateSpec({ ...base, categories: [{ type: "jack_and_jill", price: 5, dances: ["waltz"] }] }, defaults).join(" ")).toContain("not available");
    expect(validateSpec({ ...base, categories: [{ type: "couples", price: 5, dances: ["smooth_waltz"] }] }, defaults).join(" ")).toContain("not available");
    expect(validateSpec({ ...base, categories: [{ type: "couples", price: 5, dances: [] }] }, defaults).join(" ")).toContain("at least one dance");
    expect(validateSpec({ ...base, categories: [{ type: "couples", price: -1, dances: ["waltz"] }] }, defaults).join(" ")).toContain("valid price");
    expect(validateSpec({ ...base, judging: "relative_placement" as never }, defaults).join(" ")).toContain("judging");
    expect(validateSpec({ ...base, request_key: "x" }, defaults).join(" ")).toContain("request key");
    expect(validateSpec({ ...base, preset: "ndca" as never }, defaults)).toEqual(["Unknown competition type."]);
  });
});
