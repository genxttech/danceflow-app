import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CF1 dark gate. Competition Finals (officials, ballots, judging desk, day-of, studio scoring, callback targets, results and the
 * public results page) must be unreachable unless COMPETITION_FINALS_ENABLED is exactly "true" on the server.
 *
 * Every CF1 page and server action is imported for real and called with the flag unset (and with near-miss values). Each one must
 * answer notFound() before it creates a database client, reads a session or touches the studio workspace: those are spies that fail
 * the test if they are reached.
 */

const touched: string[] = [];
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error(NOT_FOUND);
  },
  redirect: (url: string) => {
    touched.push(`redirect:${url}`);
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
  usePathname: () => "/",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => touched.push(`revalidatePath:${p}`),
  unstable_noStore: () => undefined,
}));
vi.mock("next/headers", () => ({
  cookies: async () => {
    touched.push("cookies");
    throw new Error("cookies read");
  },
  headers: async () => {
    touched.push("headers");
    throw new Error("headers read");
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    touched.push("supabase.server.createClient");
    throw new Error("database client created");
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    touched.push("supabase.admin.createAdminClient");
    throw new Error("admin client created");
  },
}));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => {
    touched.push("getCurrentStudioContext");
    throw new Error("studio context read");
  },
}));
vi.mock("@/lib/competition/workspaceServer", () => ({
  loadCompetitionWorkspace: async () => {
    touched.push("loadCompetitionWorkspace");
    throw new Error("workspace loaded");
  },
  requireCompetitionWorkspace: async () => {
    touched.push("requireCompetitionWorkspace");
    throw new Error("workspace loaded");
  },
  requireCompetitionManager: async () => {
    touched.push("requireCompetitionManager");
    throw new Error("workspace loaded");
  },
}));

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const COMPETITION = "src/app/app/events/[id]/competition";
const JUDGING = "src/app/app/judging";
const PUBLIC_RESULTS = "src/app/events/[slug]/competition/results/page.tsx";

/** Every CF1-only directory: any page.tsx or actions.ts under it is a CF1 entry point. */
const CF1_DIRS = [`${COMPETITION}/ballots`, `${COMPETITION}/day-of`, `${COMPETITION}/officials`, `${COMPETITION}/results`, JUDGING];
/** CF1-only entry-point files outside those directories. */
const CF1_FILES = [`${COMPETITION}/scoringActions.ts`, PUBLIC_RESULTS];

function walk(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((item) => {
    const rel = `${dir}/${item.name}`;
    if (item.isDirectory()) return item.name === "__tests__" ? [] : walk(rel);
    return /^(page\.tsx|actions\.ts|route\.ts|layout\.tsx)$/.test(item.name) ? [rel] : [];
  });
}

function entryPointFiles(): string[] {
  return [...CF1_DIRS.flatMap(walk), ...CF1_FILES].sort();
}

/** Exported names Next treats as entry points: default page components and every exported function of a "use server" module. */
function entryExports(mod: Record<string, unknown>): Array<[string, (...args: unknown[]) => unknown]> {
  return Object.entries(mod).filter((entry): entry is [string, (...args: unknown[]) => unknown] => typeof entry[1] === "function");
}

const ID = "11111111-1111-4111-8111-111111111111";
function callArgs(name: string): unknown[] {
  if (name === "default") {
    const params = Promise.resolve({ id: ID, eventId: ID, roundId: ID, slug: "studio-event" });
    return [{ params, searchParams: Promise.resolve({}) }];
  }
  const form = new FormData();
  for (const key of ["eventId", "roundId", "heatId", "officialId", "userId", "requestId", "programId", "divisionId", "entryId", "resultId"]) form.set(key, ID);
  form.set("reason", "a reason that is long enough to pass any length check");
  // Server actions with useActionState receive (previousState, formData).
  return name === "configureStudioScoringAction" ? [{ ok: false }, form] : [form];
}

async function expectNotFound(fn: () => unknown) {
  let outcome: unknown = "returned";
  try {
    await fn();
  } catch (error) {
    outcome = error;
  }
  expect(outcome instanceof Error ? outcome.message : outcome).toBe(NOT_FOUND);
}

const ENV_KEYS = ["COMPETITION_FINALS_ENABLED", "COMPETITION_PUBLIC_RESULTS_ENABLED", "NEXT_PUBLIC_COMPETITION_FINALS_ENABLED"] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  touched.length = 0;
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("CF1 dark gate: flag parsing", () => {
  it("is off when unset, empty or anything but exactly \"true\"", async () => {
    const { competitionFinalsEnabled, competitionPublicResultsEnabled } = await import("@/lib/competition/finalsGate");
    expect(competitionFinalsEnabled()).toBe(false);
    for (const value of ["", "1", "TRUE", "True", " true", "true ", "yes", "on", "false"]) {
      process.env.COMPETITION_FINALS_ENABLED = value;
      expect(competitionFinalsEnabled(), JSON.stringify(value)).toBe(false);
    }
    process.env.COMPETITION_FINALS_ENABLED = "true";
    expect(competitionFinalsEnabled()).toBe(true);
    expect(competitionPublicResultsEnabled()).toBe(false);
  });

  it("ignores a NEXT_PUBLIC_ look-alike: only the server variable counts", async () => {
    const { competitionFinalsEnabled } = await import("@/lib/competition/finalsGate");
    process.env.NEXT_PUBLIC_COMPETITION_FINALS_ENABLED = "true";
    expect(competitionFinalsEnabled()).toBe(false);
  });

  it("public results need both flags; the public flag alone opens nothing", async () => {
    const { competitionPublicResultsEnabled } = await import("@/lib/competition/finalsGate");
    process.env.COMPETITION_PUBLIC_RESULTS_ENABLED = "true";
    expect(competitionPublicResultsEnabled()).toBe(false);
    process.env.COMPETITION_FINALS_ENABLED = "true";
    expect(competitionPublicResultsEnabled()).toBe(true);
  });

  it("the gate module is server-only and reads no NEXT_PUBLIC_ variable", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/lib/competition/finalsGate.ts"), "utf8");
    expect(source).toMatch(/^import "server-only";/m);
    expect(source).not.toMatch(/process.env.NEXT_PUBLIC_/);
  });
});

describe("CF1 dark gate: inventory", () => {
  it("covers exactly the known CF1 entry points (a new CF1 page or action must be added here and gated)", () => {
    expect(entryPointFiles()).toEqual([
      `${COMPETITION}/ballots/[roundId]/page.tsx`,
      `${COMPETITION}/ballots/actions.ts`,
      `${COMPETITION}/ballots/page.tsx`,
      `${COMPETITION}/day-of/actions.ts`,
      `${COMPETITION}/day-of/page.tsx`,
      `${COMPETITION}/officials/actions.ts`,
      `${COMPETITION}/officials/page.tsx`,
      `${COMPETITION}/results/[roundId]/page.tsx`,
      `${COMPETITION}/results/actions.ts`,
      `${COMPETITION}/results/page.tsx`,
      `${COMPETITION}/scoringActions.ts`,
      `${JUDGING}/[eventId]/rounds/[roundId]/ballot/desk/actions.ts`,
      `${JUDGING}/[eventId]/rounds/[roundId]/ballot/desk/page.tsx`,
      `${JUDGING}/[eventId]/rounds/[roundId]/ballot/page.tsx`,
      `${JUDGING}/page.tsx`,
      PUBLIC_RESULTS,
    ].sort());
  });

  it("every exported function of every CF1 entry point calls the gate as its first statement", () => {
    for (const file of entryPointFiles()) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      const gate = file === PUBLIC_RESULTS ? "requireCompetitionPublicResults" : "requireCompetitionFinals";
      const exported = [...source.matchAll(/^export (?:default )?async function (\w+)[\s\S]*?\)(?:\s*:\s*[^{\n]+)?\s*\{\r?\n(.*)$/gm)];
      expect(exported.length, file).toBeGreaterThan(0);
      for (const match of exported) expect(match[2].trim(), `${file} ${match[1]}`).toBe(`${gate}();`);
      // No non-function export (route segment config aside) can be an unguarded entry point.
      const otherExports = [...source.matchAll(/^export (?!default async function|async function|const dynamic|const metadata|type )(.*)$/gm)].map((m) => m[1]);
      expect(otherExports, file).toEqual([]);
    }
  });
});

describe("CF1 dark gate: every page and server action answers notFound() with the flag off", () => {
  const files = entryPointFiles();
  for (const file of files) {
    for (const flag of [undefined, "", "1", "TRUE"] as const) {
      it(`${file} (COMPETITION_FINALS_ENABLED=${JSON.stringify(flag)})`, async () => {
        if (flag !== undefined) process.env.COMPETITION_FINALS_ENABLED = flag;
        // The public results flag alone must never open anything.
        process.env.COMPETITION_PUBLIC_RESULTS_ENABLED = "true";
        const mod = (await import(/* @vite-ignore */ path.join(ROOT, file))) as Record<string, unknown>;
        const exports = entryExports(mod);
        expect(exports.length, file).toBeGreaterThan(0);
        for (const [name, fn] of exports) {
          await expectNotFound(() => fn(...callArgs(name)));
        }
        expect(touched, file).toEqual([]);
      }, 60_000); // the first import of a page compiles its whole module graph; slow under a full parallel suite
    }
  }

  it("the public results page stays notFound() with Finals on but public results off", async () => {
    process.env.COMPETITION_FINALS_ENABLED = "true";
    const mod = (await import(/* @vite-ignore */ path.join(ROOT, PUBLIC_RESULTS))) as Record<string, unknown>;
    await expectNotFound(() => (mod.default as (...a: unknown[]) => unknown)(...callArgs("default")));
    expect(touched).toEqual([]);
  });

  it("with the flag on, CF1 pages and actions get past the gate (they reach the workspace or a client)", async () => {
    process.env.COMPETITION_FINALS_ENABLED = "true";
    const mod = (await import(/* @vite-ignore */ path.join(ROOT, `${COMPETITION}/officials/page.tsx`))) as Record<string, unknown>;
    await expect((mod.default as (...a: unknown[]) => Promise<unknown>)(...callArgs("default"))).rejects.toThrow("workspace loaded");
    expect(touched).toContain("requireCompetitionWorkspace");
  });

  it("the callback-target action added to the live settings actions refuses with the flag off", async () => {
    const mod = await import("@/app/app/events/[id]/competition/actions");
    await expectNotFound(() => mod.updateCompetitionCallbackTargetAction(callArgs("x")[0] as FormData));
    expect(touched).toEqual([]);
  });
});

describe("CF1 dark gate: navigation", () => {
  it("off (the default) is exactly the live release navigation", async () => {
    const { competitionNav } = await import("@/lib/competition/workspaceNav");
    const live = [
      ["overview", "Overview", true], ["entries", "Entries", true], ["check_in", "Check-in", true], ["divisions", "Divisions", true],
      ["schedule", "Schedule & Heats", true], ["officials", "Officials", false], ["scoring", "Scoring", false], ["results", "Results", false],
      ["awards", "Awards", false], ["settings", "Settings", true],
    ];
    for (const items of [competitionNav("e1"), competitionNav("e1", false)]) {
      expect(items.map((item) => [item.key, item.label, item.available])).toEqual(live);
      expect(items.some((item) => /day-of|officials|ballots|results|judging/.test(item.href ?? ""))).toBe(false);
    }
  });

  it("on lists Day-of, Officials and Ballots", async () => {
    const { competitionNav } = await import("@/lib/competition/workspaceNav");
    const items = competitionNav("e1", true);
    expect(items.map((item) => item.label)).toEqual(["Overview", "Entries", "Check-in", "Divisions", "Schedule & Heats", "Day-of", "Officials", "Ballots", "Results", "Awards", "Settings"]);
    expect(items.find((item) => item.key === "results")?.href).toBeNull();
  });

  it("the workspace layout passes the server flag to the navigation (never a client-side read)", () => {
    const layout = fs.readFileSync(path.join(ROOT, `${COMPETITION}/layout.tsx`), "utf8");
    expect(layout).toContain("<CompetitionNav eventId={id} finalsEnabled={competitionFinalsEnabled()} />");
    const nav = fs.readFileSync(path.join(ROOT, `${COMPETITION}/CompetitionNav.tsx`), "utf8");
    expect(nav).not.toMatch(/process\.env/);
  });
});
