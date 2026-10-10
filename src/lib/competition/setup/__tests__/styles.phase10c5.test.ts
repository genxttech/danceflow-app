import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), usePathname: () => "/", redirect: vi.fn(), notFound: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => createElement("a", { href, ...rest }, children as never),
}));
vi.mock("@/app/app/events/[id]/competition/simpleActions", () => ({ createCompetitionDraftAction: vi.fn() }));

import { StyleChoices } from "@/app/app/events/[id]/competition/new/CompetitionSetupWizard";
import { chooseStyle, choosePurpose, initialAnswers, nextStep, setupProfileProblems, stepErrors, styleOptions, visibleSteps, type Purpose } from "../draft";
import { loadStoredSetup } from "../persistence";
import type { SetupProfileDefaults } from "../types";

/**
 * 10C.5 walkthrough regression: the Styles step showed no styles. The page reads studio_simple@2 from the
 * database, where jsonb reorders object keys -- so these tests use the migration seed reshaped the way the
 * database returns it, not the TypeScript constant, and render the real Styles choices for every purpose.
 */

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** jsonb stores object keys shorter-first, then bytewise; arrays keep their order. */
function asJsonb(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(asJsonb);
  if (!value || typeof value !== "object") return value;
  const keys = Object.keys(value).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(keys.map((key) => [key, asJsonb((value as Record<string, unknown>)[key])]));
}

const SEED = read("src/lib/supabase/migrations/20261113090000_phase10c5_competition_draft.sql").match(/\$profile\$([\s\S]*?)\$profile\$/)![1];
const DB_PROFILE = asJsonb(JSON.parse(SEED)) as SetupProfileDefaults;
const PURPOSES: Purpose[] = ["competition", "showcase", "competition_showcase"];
const STYLE_LABELS = ["Ballroom", "Country", "West Coast Swing", "Other / Studio-defined"];

describe("Styles step (walkthrough regression)", () => {
  it("the database-shaped profile is a compatible schema-2 setup profile", () => {
    expect(setupProfileProblems(DB_PROFILE)).toEqual([]);
    expect(Object.keys(DB_PROFILE.programs)).toEqual(["custom", "country", "ballroom", "west_coast_swing"]);
  });

  it.each(PURPOSES)("Purpose %s -> Continue reaches Styles, which offers every supported style plus Multiple styles", (purpose) => {
    const answers = choosePurpose(initialAnswers(), DB_PROFILE, purpose);
    expect(stepErrors(answers, DB_PROFILE, "purpose")).toEqual([]);
    expect(nextStep(answers, DB_PROFILE, "purpose")).toBe("styles");
    expect(visibleSteps(answers, DB_PROFILE)).toContain("adjudication");
    expect(styleOptions(DB_PROFILE).map((key) => DB_PROFILE.programs[key].label)).toEqual(STYLE_LABELS);

    const html = renderToStaticMarkup(createElement(StyleChoices, { answers, defaults: DB_PROFILE, update: () => undefined }));
    const titles = [...html.matchAll(/<span class="text-sm font-semibold[^"]*">([^<]+)<\/span>/g)].map((match) => match[1]);
    expect(titles).toEqual([...STYLE_LABELS, "Multiple styles"]);
    expect(html.match(/<button/g)?.length).toBe(5);
    expect(html).not.toContain("disabled");

    const chosen = chooseStyle(answers, DB_PROFILE, "country");
    expect(stepErrors(chosen, DB_PROFILE, "styles")).toEqual([]);
    expect(nextStep(chosen, DB_PROFILE, "styles")).toBe("adjudication");
  });

  it("the style list does not depend on per-program fields the profile does not carry (the earlier purpose filter)", () => {
    for (const program of Object.values(DB_PROFILE.programs)) expect(program).not.toHaveProperty("purpose");
    expect(read("src/lib/competition/setup/draft.ts")).not.toMatch(/programs\[key\]\.purpose/);
  });

  it("a profile/code mismatch is refused loudly instead of rendering an empty step", () => {
    const oldShape = { schema: 2, programs: { country: { label: "Country", purpose: "competition", formats: ["pro_am"] } }, categoryTypes: { pro_am: {} }, judging: {} };
    expect(setupProfileProblems(oldShape)).toEqual(["Style country has no valid result options.", "Style country has no programming metadata."]);
    expect(setupProfileProblems({ ...DB_PROFILE, programs: {} })).toEqual(["The profile offers no styles."]);
    expect(setupProfileProblems(null)).toEqual(["The profile is not schema 2."]);
    expect(read("src/app/app/events/[id]/competition/new/page.tsx")).toContain("setupProfileProblems(profile.defaults).length > 0");
    expect(read("src/app/app/events/[id]/competition/simpleActions.ts")).toContain("setupProfileProblems(profile.defaults).length > 0");
  });
});

describe("stale wizard state from the earlier candidate", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("removes only this event's legacy v1 setup and resumes with a fresh, usable wizard", () => {
    const store = new Map<string, string>([
      ["danceflow.competition-setup.v1:e1", JSON.stringify({ answers: { version: 1, purpose: "showcase", styles: [], programs: { showcase: {} } }, step: "styles", requestKey: "request-key-0001" })],
      ["danceflow.competition-setup.v1:e2", "other event"],
      ["unrelated.app.state", "keep"],
    ]);
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });
    expect(loadStoredSetup("e1")).toBeNull();
    expect([...store.keys()]).toEqual(["danceflow.competition-setup.v1:e2", "unrelated.app.state"]);
    const fresh = choosePurpose(initialAnswers(), DB_PROFILE, "showcase");
    expect(styleOptions(DB_PROFILE)).toHaveLength(4);
    expect(nextStep(fresh, DB_PROFILE, "purpose")).toBe("styles");
  });
});
