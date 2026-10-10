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
  addLevel,
  chooseAdjudication,
  chooseJudging,
  choosePurpose,
  chooseSingleStyleMode,
  chooseStyle,
  deriveDraft,
  initialAnswers,
  nextStep,
  previousStep,
  removeCustomDance,
  restoreAnswers,
  resumeStep,
  setPricing,
  setRegistration,
  setRegistrationFee,
  stepErrors,
  toggleAgeBand,
  toggleFormat,
  updateFormat,
  visibleSteps,
  type SetupAnswers,
} from "../draft";
import { clearStoredSetup, loadStoredSetup, saveStoredSetup } from "../persistence";

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const MIGRATION = join(ROOT, "src/lib/supabase/migrations/20261113090000_phase10c5_competition_draft.sql");
const CONTEXT = { eventName: "Spring Classic", profileKey: "studio_simple", profileVersion: 2, requestKey: "request-key-0001" };

/** A complete Competition + Showcase answer set: Country (adjudicated placements) plus the separate showcase. */
function fullAnswers(): SetupAnswers {
  let answers = choosePurpose(initialAnswers(), P, "competition_showcase");
  answers = chooseStyle(answers, P, "country");
  answers = chooseAdjudication(answers, P, "adjudicated");
  answers = updateFormat(answers, "country", "pro_am", { amount: "25" });
  answers = setPricing(answers, P, "country", "pro_pro", "per_entry");
  answers = updateFormat(answers, "country", "pro_pro", { amount: "60" });
  answers = setPricing(answers, P, "country", "couples", "included");
  answers = setRegistrationFee(answers, "country", "40");
  answers = updateFormat(answers, "showcase", "showcase", { amount: "35" });
  answers = setPricing(answers, P, "showcase", "solo", "later");
  return setRegistration(answers, { opens: "2026-11-01", closes: "2026-12-01" });
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

  it("entry formats are profile-derived per discipline, never one universal list", () => {
    expect(P.programs.country.formats).toEqual(["pro_am", "pro_pro", "couples", "solo", "team"]);
    expect(P.programs.country.recommended_formats).toEqual(["pro_am", "pro_pro", "couples"]);
    expect(P.programs.country.formats).not.toContain("professional");
    expect(P.programs.ballroom.formats).toContain("professional");
    expect(P.programs.west_coast_swing.formats).not.toContain("professional");
    expect(P.programs.west_coast_swing.formats).toContain("jack_and_jill");
    expect(P.programs.custom.formats).toContain("professional");
    expect(P.programs.showcase).toMatchObject({ purpose: "showcase", adjudication: "non_adjudicated" });
  });

  it("formats carry participant and lead/follow rules (10C.4) and their allowed pricing", () => {
    expect(P.categoryTypes.pro_pro).toMatchObject({ entry_format: "pro_pro", participant_roles: ["instructor", "professional"], dance_roles: "pair" });
    expect(P.categoryTypes.professional).toMatchObject({ entry_format: "professional", participant_roles: ["professional"] });
    expect(P.categoryTypes.jack_and_jill.dance_roles).toBe("single");
    for (const format of ["solo", "showcase", "jack_and_jill", "team"]) expect(P.categoryTypes[format].pricing_models).not.toContain("per_dance");
    for (const format of Object.keys(P.categoryTypes)) {
      expect(P.categoryTypes[format].pricing_models).toEqual(expect.arrayContaining(["included", "free", "later"]));
      expect(P.divisionPresets[P.categoryTypes[format].division_preset]).toBeDefined();
    }
  });

  it("Non-Adjudicated maps to exhibition with a single Performance and no scoring", () => {
    expect(P.adjudication.non_adjudicated.judging).toBe("non_adjudicated");
    expect(P.judging.non_adjudicated).toMatchObject({ competition_mode: "exhibition", advancement_method: "none" });
    expect(P.judging.non_adjudicated.rounds).toEqual([{ round_type: "exhibition", name: "Performance", scoring_method: "none" }]);
    expect(P.adjudication.adjudicated.judging_options).toEqual(["placements", "ratings"]);
    for (const key of ["placements", "ratings"]) expect(P.judging[key].rounds.map((round) => round.round_type)).toEqual(["final"]);
  });

  it("every recommended dance exists in its program's pool", () => {
    for (const program of Object.values(P.programs)) {
      const pool = new Set(P.dancePools[program.dance_pool].map((dance) => dance.key));
      for (const dance of program.recommended_dances) expect(pool.has(dance), dance).toBe(true);
    }
  });
});

describe("answers and steps", () => {
  it("only Studio / Custom Rules can be chosen; governing bodies are visible but unavailable", () => {
    expect(RULE_OPTIONS.filter((option) => option.available).map((option) => option.key)).toEqual(["studio_custom"]);
    expect(RULE_OPTIONS.filter((option) => !option.available).map((option) => option.label)).toEqual(["UCWDC", "WSDC", "NDCA"]);
    expect(initialAnswers().rules).toBe("studio_custom");
  });

  it("one program per discipline, plus a separate showcase program when applicable", () => {
    let answers = choosePurpose(initialAnswers(), P, "competition");
    answers = chooseStyle(answers, P, "multiple");
    answers = chooseStyle(answers, P, "country");
    answers = chooseStyle(answers, P, "ballroom");
    expect(activeProgramKeys(answers, P)).toEqual(["country", "ballroom"]);
    answers = choosePurpose(answers, P, "competition_showcase");
    expect(activeProgramKeys(answers, P)).toEqual(["country", "ballroom", "showcase"]);
    expect(activeProgramKeys(choosePurpose(answers, P, "showcase"), P)).toEqual(["showcase"]);
    expect(activeProgramKeys(chooseSingleStyleMode(answers, P), P)).toEqual(["country", "showcase"]);
  });

  it("a single style replaces the previous one; the showcase is never a style", () => {
    let answers = choosePurpose(initialAnswers(), P, "competition");
    answers = chooseStyle(answers, P, "country");
    answers = chooseStyle(answers, P, "west_coast_swing");
    expect(answers.styles).toEqual(["west_coast_swing"]);
    expect(chooseStyle(answers, P, "showcase")).toBe(answers);
  });

  it("new programs are seeded with the profile recommendations; existing answers survive style changes", () => {
    let answers = choosePurpose(initialAnswers(), P, "competition");
    answers = chooseStyle(answers, P, "country");
    expect(Object.keys(answers.programs.country.formats)).toEqual(["pro_am", "pro_pro", "couples"]);
    expect(answers.programs.country.formats.pro_am).toMatchObject({ pricing: "per_dance", levels: ["Newcomer", "Bronze", "Silver", "Gold"] });
    expect(answers.programs.country.formats.pro_pro?.levels).toEqual(["Open"]);
    answers = addLevel(answers, P, "country", "pro_am", "Platinum");
    answers = chooseStyle(answers, P, "multiple");
    answers = chooseStyle(answers, P, "ballroom");
    expect(answers.programs.country.formats.pro_am?.levels).toContain("Platinum");
    expect(answers.programs.ballroom.formats.pro_am?.dances).toEqual(P.programs.ballroom.recommended_dances);
  });

  it("formats outside the program's profile list cannot be added", () => {
    let answers = chooseStyle(choosePurpose(initialAnswers(), P, "competition"), P, "country");
    expect(toggleFormat(answers, P, "country", "professional")).toBe(answers);
    answers = toggleFormat(answers, P, "country", "team");
    expect(answers.programs.country.formats.team?.pricing).toBe("per_entry");
    expect(setPricing(answers, P, "country", "team", "per_dance")).toBe(answers);
  });

  it("showcase-only skips Styles and Adjudicated?; Sanction is never asked for Studio / Custom", () => {
    const showcase = choosePurpose(initialAnswers(), P, "showcase");
    expect(visibleSteps(showcase, P)).toEqual(["purpose", "rules", "offerings", "divisions", "rounds", "registration", "pricing", "review"]);
    const full = fullAnswers();
    expect(visibleSteps(full, P)).toEqual(["purpose", "styles", "adjudication", "rules", "offerings", "divisions", "dances", "rounds", "registration", "pricing", "review"]);
    expect(visibleSteps(full, P)).not.toContain("sanction");
  });

  it("Continue stops on an invalid step and Back always works", () => {
    const answers = choosePurpose(initialAnswers(), P, "competition");
    expect(stepErrors(answers, P, "styles")).toEqual(["Choose at least one style."]);
    expect(nextStep(answers, P, "styles")).toBe("styles");
    expect(previousStep(answers, P, "styles")).toBe("purpose");
    expect(nextStep(initialAnswers(), P, "purpose")).toBe("purpose");
    expect(nextStep(answers, P, "purpose")).toBe("styles");
  });

  it("Adjudicated asks for placements or ratings; Non-Adjudicated needs nothing more", () => {
    let answers = chooseStyle(choosePurpose(initialAnswers(), P, "competition"), P, "country");
    expect(stepErrors(answers, P, "adjudication")).toEqual(["Choose Adjudicated or Non-Adjudicated."]);
    answers = chooseAdjudication(answers, P, "adjudicated");
    expect(answers.judging).toBe("placements");
    expect(chooseJudging(answers, P, "ratings").judging).toBe("ratings");
    expect(chooseJudging(answers, P, "non_adjudicated")).toBe(answers);
    answers = chooseAdjudication(answers, P, "non_adjudicated");
    expect(answers.judging).toBe("non_adjudicated");
    expect(stepErrors(answers, P, "adjudication")).toEqual([]);
  });
});

describe("deriveDraft: the single derivation authority", () => {
  it("produces the reviewed payload for Competition + Showcase", () => {
    const draft = deriveDraft(fullAnswers(), P, CONTEXT);
    expect(draft.errors).toEqual({});
    expect(draft.payload).toMatchObject({
      request_key: "request-key-0001",
      profile_key: "studio_simple",
      profile_version: 2,
      purpose: "competition_showcase",
      adjudication: "adjudicated",
      registration: { opens_at: "2026-11-01", closes_at: "2026-12-01", account_required: false },
    });
    const [country, showcase] = draft.payload!.programs;
    expect(country).toMatchObject({ key: "country", name: "Spring Classic — Country", judging: "placements", registration_fee: 40 });
    expect(country.categories.map((category) => [category.type, category.pricing])).toEqual([
      ["pro_am", { model: "per_dance", amount: 25 }],
      ["pro_pro", { model: "per_entry", amount: 60 }],
      ["couples", { model: "included", amount: null }],
    ]);
    expect(country.dances.map((dance) => dance.key)).toEqual(P.programs.country.recommended_dances);
    expect(showcase).toMatchObject({ key: "showcase", name: "Spring Classic — Showcase / Performance", judging: "non_adjudicated", registration_fee: null, dances: [] });
    expect(showcase.categories.map((category) => [category.type, category.pricing.model, category.dances])).toEqual([
      ["showcase", "per_entry", []],
      ["solo", "later", []],
    ]);
  });

  it("Review counts, labels and pricing come from the same derivation as the payload", () => {
    const draft = deriveDraft(fullAnswers(), P, CONTEXT);
    const payload = draft.payload!;
    const divisions = payload.programs.flatMap((program) => program.categories.flatMap((category) => category.divisions));
    expect(draft.counts).toEqual({
      programs: 2,
      categories: 5,
      divisions: divisions.length,
      rounds: divisions.length,
      dances: payload.programs.reduce((sum, program) => sum + program.dances.length, 0),
      offerings: payload.programs.flatMap((program) => program.categories).reduce((sum, category) => sum + category.divisions.length * category.dances.length, 0),
    });
    expect(draft.programs[0]).toMatchObject({ name: "Spring Classic — Country", judgingLabel: "Placements", registrationFee: "$40.00 per competitor" });
    expect(draft.programs[1].categories[0].rounds).toEqual(["Performance"]);
    expect(draft.pricingLines).toContain("Country ProAm: $25.00 per dance");
    expect(draft.pricingLines).toContain("Country Couples: Included with the $40.00 registration fee");
    expect(draft.pricingPending).toBe(true);
    expect(draft.pricingLines.at(-1)).toBe(PRICING_PENDING_TEXT);
    expect(PRICING_PENDING_TEXT).toBe("Pricing requires completion before registration can open.");
  });

  it("is deterministic, so a retried request hashes identically", () => {
    expect(JSON.stringify(deriveDraft(fullAnswers(), P, CONTEXT).payload)).toBe(JSON.stringify(deriveDraft(fullAnswers(), P, CONTEXT).payload));
  });

  it("a single program uses the event name; Non-Adjudicated applies to every program", () => {
    let answers = chooseStyle(choosePurpose(initialAnswers(), P, "competition"), P, "west_coast_swing");
    answers = chooseAdjudication(answers, P, "non_adjudicated");
    answers = updateFormat(answers, "west_coast_swing", "jack_and_jill", { amount: "15" });
    answers = updateFormat(answers, "west_coast_swing", "couples", { amount: "20" });
    const draft = deriveDraft(answers, P, CONTEXT);
    expect(draft.payload?.adjudication).toBe("non_adjudicated");
    expect(draft.payload?.programs).toHaveLength(1);
    expect(draft.payload?.programs[0]).toMatchObject({ name: "Spring Classic", judging: "non_adjudicated" });
    expect(draft.payload?.programs[0].categories[0]).toMatchObject({ type: "jack_and_jill", dances: ["west_coast_swing"] });
    expect(draft.programs[0].judgingLabel).toBe("Non-Adjudicated");
  });

  it("showcase-only sends the fixed Non-Adjudicated adjudication", () => {
    let answers = choosePurpose(initialAnswers(), P, "showcase");
    answers = updateFormat(answers, "showcase", "showcase", { amount: "30" });
    answers = updateFormat(answers, "showcase", "solo", { amount: "30" });
    expect(deriveDraft(answers, P, CONTEXT).payload).toMatchObject({ purpose: "showcase", adjudication: "non_adjudicated", programs: [{ key: "showcase" }] });
  });

  it("Configure later creates the draft but marks pricing incomplete", () => {
    let answers = chooseStyle(choosePurpose(initialAnswers(), P, "competition"), P, "country");
    answers = chooseAdjudication(answers, P, "adjudicated");
    for (const format of ["pro_am", "pro_pro", "couples"]) answers = setPricing(answers, P, "country", format, "later");
    const draft = deriveDraft(answers, P, CONTEXT);
    expect(draft.payload).not.toBeNull();
    expect(draft.payload?.programs[0].categories.every((category) => category.pricing.model === "later" && category.pricing.amount === null)).toBe(true);
    expect(draft.programs[0].categories.every((category) => category.pricingPending)).toBe(true);
  });

  it("pricing errors: missing or zero prices and a missing registration fee", () => {
    let answers = chooseStyle(choosePurpose(initialAnswers(), P, "competition"), P, "country");
    answers = chooseAdjudication(answers, P, "adjudicated");
    expect(stepErrors(answers, P, "pricing")).toContain("Enter a price for Country ProAm, or choose Free or Configure later.");
    answers = updateFormat(answers, "country", "pro_am", { amount: "0" });
    expect(stepErrors(answers, P, "pricing")).toContain("Enter a price for Country ProAm, or choose Free or Configure later.");
    answers = updateFormat(answers, "country", "pro_am", { amount: "12.345" });
    expect(stepErrors(answers, P, "pricing")).toContain("Enter a price for Country ProAm, or choose Free or Configure later.");
    answers = setPricing(answers, P, "country", "pro_am", "included");
    expect(stepErrors(answers, P, "pricing")).toContain("Enter the Country registration fee.");
    expect(deriveDraft(answers, P, CONTEXT).payload).toBeNull();
  });

  it("division rules: per-format lists, age groups, duplicates and the total cap", () => {
    let answers = chooseStyle(choosePurpose(initialAnswers(), P, "competition"), P, "custom");
    answers = toggleAgeBand(answers, "custom", "pro_am", "Adult");
    expect(deriveDraft(answers, P, CONTEXT).programs[0].categories[0].divisions).toEqual(["Newcomer · Adult", "Bronze · Adult", "Silver · Adult", "Gold · Adult"]);
    expect(addLevel(answers, P, "custom", "pro_am", "bronze")).toBe(answers);
    answers = updateFormat(answers, "custom", "pro_am", { levels: [] });
    expect(stepErrors(answers, P, "divisions")).toContain("Add at least one division for Other / Studio-defined ProAm.");
    answers = updateFormat(answers, "custom", "pro_am", { levels: Array.from({ length: 31 }, (_, index) => `Level ${index}`), ageBands: [] });
    expect(stepErrors(answers, P, "divisions")).toContain("Use 30 divisions or fewer for Other / Studio-defined ProAm.");
    for (const format of P.programs.custom.formats) {
      if (!answers.programs.custom.formats[format]) answers = toggleFormat(answers, P, "custom", format);
      answers = updateFormat(answers, "custom", format, { levels: Array.from({ length: 30 }, (_, index) => `Level ${index}`), ageBands: [] });
    }
    expect(stepErrors(answers, P, "divisions")).toContain("This draft has 240 divisions; use 200 or fewer.");
  });

  it("custom dances only where the profile allows them, and removing one clears it everywhere", () => {
    let answers = chooseStyle(choosePurpose(initialAnswers(), P, "competition"), P, "country");
    answers = addCustomDance(answers, P, "country", "Line Polka");
    expect(answers.programs.country.customDances).toEqual([{ key: "custom_line_polka", name: "Line Polka", category: "Custom" }]);
    expect(addCustomDance(answers, P, "country", "line polka")).toBe(answers);
    expect(addCustomDance(answers, P, "country", "Two Step")).toBe(answers);
    answers = updateFormat(answers, "country", "couples", { dances: ["custom_line_polka"] });
    answers = chooseAdjudication(answers, P, "adjudicated");
    answers = updateFormat(answers, "country", "pro_am", { amount: "10" });
    answers = updateFormat(answers, "country", "pro_pro", { amount: "10" });
    answers = updateFormat(answers, "country", "couples", { amount: "10" });
    const dances = deriveDraft(answers, P, CONTEXT).payload?.programs[0].dances;
    expect(dances?.at(-1)).toEqual({ key: "custom_line_polka", name: "Line Polka", category: "Custom" });
    answers = removeCustomDance(answers, "country", "custom_line_polka");
    expect(answers.programs.country.formats.couples?.dances).toEqual([]);
    const wcs = chooseStyle(choosePurpose(initialAnswers(), P, "competition"), P, "west_coast_swing");
    expect(addCustomDance(wcs, P, "west_coast_swing", "Slow Swing")).toBe(wcs);
  });
});

describe("persistence and resume", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("restores valid answers and rejects malformed or out-of-profile ones", () => {
    const answers = fullAnswers();
    expect(restoreAnswers(JSON.parse(JSON.stringify(answers)), P)).toEqual(answers);
    expect(restoreAnswers(null, P)).toBeNull();
    expect(restoreAnswers({ ...answers, version: 2 }, P)).toBeNull();
    expect(restoreAnswers({ ...answers, programs: { ucwdc: answers.programs.country } }, P)).toBeNull();
    const bad = JSON.parse(JSON.stringify(answers));
    bad.programs.country.formats.professional = bad.programs.country.formats.pro_am;
    expect(restoreAnswers(bad, P)).toBeNull();
    expect(restoreAnswers({ ...answers, rules: "ucwdc" }, P)?.rules).toBe("studio_custom");
  });

  it("resumes at the stored step only when it is still reachable", () => {
    const answers = fullAnswers();
    expect(resumeStep(answers, P, "pricing")).toBe("pricing");
    expect(resumeStep(answers, P, "sanction")).toBe("review");
    const partial = choosePurpose(initialAnswers(), P, "competition");
    expect(resumeStep(partial, P, "review")).toBe("styles");
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
    expect(loadStoredSetup("e2")).toBeNull();
    store.set("danceflow.competition-setup.v1:e3", JSON.stringify({ answers: {}, step: "review", requestKey: "bad key" }));
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
