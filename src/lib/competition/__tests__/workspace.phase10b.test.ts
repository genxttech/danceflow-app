import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canManageCompetition } from "@/lib/competition/access";
import { buildLifecycleInput, computeLifecycle, structureProblems, type LifecycleInput, type LifecycleProgram } from "@/lib/competition/lifecycle";
import { activeNavKey, competitionNav } from "@/lib/competition/workspaceNav";
import { shouldShowCompetitionWorkspaceLink } from "@/lib/competition/workspaceLink";

const ROOT = join(__dirname, "..", "..", "..", "..");
const WORKSPACE = join(ROOT, "src/app/app/events/[id]/competition");
const EVENT = "11111111-1111-1111-1111-111111111111";

function read(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" || name === "node_modules" || name === "migrations" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const draftProgram: LifecycleProgram = { id: "p1", name: "Spring", status: "draft", rulesProfileKey: "studio_simple", rulesProfileVersion: 1, profileLocked: false };
const publishedProgram: LifecycleProgram = { ...draftProgram, status: "configured", profileLocked: true };
const legacyProgram: LifecycleProgram = { ...draftProgram, rulesProfileKey: null, rulesProfileVersion: null };

function input(overrides: Partial<LifecycleInput> = {}): LifecycleInput {
  return {
    eventId: EVENT,
    program: draftProgram,
    categoryCount: 2,
    categoriesWithoutDivisions: 0,
    divisionCount: 4,
    divisionsWithoutRound: 0,
    divisionsMissingDances: 0,
    registrationOpen: false,
    registrationEverOpened: false,
    entryCount: 0,
    heatCount: 0,
    ...overrides,
  };
}

describe("workspace authorization (shared with the action guard and the database helper)", () => {
  it("allows platform admins, studio owners/admins and organizer roles", () => {
    expect(canManageCompetition({ isPlatformAdmin: true, studioRole: null, organizerUserRole: null })).toBe(true);
    for (const studioRole of ["studio_owner", "studio_admin"]) expect(canManageCompetition({ isPlatformAdmin: false, studioRole, organizerUserRole: null })).toBe(true);
    for (const organizerUserRole of ["organizer_owner", "organizer_admin", "organizer_staff"]) {
      expect(canManageCompetition({ isPlatformAdmin: false, studioRole: null, organizerUserRole })).toBe(true);
    }
  });

  it("refuses everyone else", () => {
    for (const studioRole of ["front_desk", "instructor", "independent_instructor", "", null, undefined]) {
      expect(canManageCompetition({ isPlatformAdmin: false, studioRole, organizerUserRole: null })).toBe(false);
    }
    expect(canManageCompetition({ isPlatformAdmin: false, studioRole: "front_desk", organizerUserRole: "viewer" })).toBe(false);
  });

  it("the event-detail link and the workspace use the same rule", () => {
    const base = { eventType: "competition", hasCompetitionProgram: false, isPlatformAdmin: false, studioRole: "front_desk", organizerUserRole: null };
    expect(shouldShowCompetitionWorkspaceLink(base)).toBe(false);
    expect(shouldShowCompetitionWorkspaceLink({ ...base, studioRole: "studio_admin" })).toBe(true);
  });

  it("every workspace page and layout enforces the manager guard; every action does too", () => {
    const pages = ["layout.tsx", "page.tsx", "new/page.tsx", "divisions/page.tsx", "settings/page.tsx"];
    for (const page of pages) expect(readFileSync(join(WORKSPACE, page), "utf8"), page).toContain("requireCompetitionWorkspace(");
    const actions = readFileSync(join(WORKSPACE, "simpleActions.ts"), "utf8");
    const exported = [...actions.matchAll(/export async function (\w+)/g)].map((match) => match[1]);
    expect(exported.sort()).toEqual(["addDivisionAction", "createSimpleCompetitionAction", "publishCompetitionAction", "removeDivisionAction", "setCompetitionRegistrationAction", "updateDivisionAction"]);
    expect(actions.match(/requireCompetitionManager\(eventId\)/g)?.length).toBe(exported.length);
    const server = read("src/lib/competition/workspaceServer.ts");
    expect(server).toContain("if (!workspace.canManage) notFound();");
    expect(server).toContain("canManageCompetition({");
    expect(server).toContain(".eq(\"studio_id\", context.studioId)");
  });
});

describe("workspace navigation", () => {
  const items = competitionNav(EVENT);

  it("lists the target sections in order, with check-in nested under entries", () => {
    expect(items.map((item) => item.label)).toEqual(["Overview", "Entries", "Check-in", "Divisions", "Schedule & Heats", "Officials", "Scoring", "Results", "Awards", "Settings"]);
    expect(items.find((item) => item.key === "check_in")?.child).toBe(true);
  });

  it("does not link future areas: they are disabled with an explanation", () => {
    for (const key of ["officials", "scoring", "results", "awards"]) {
      const item = items.find((candidate) => candidate.key === key)!;
      expect(item.available, key).toBe(false);
      expect(item.href, key).toBeNull();
      expect(item.note, key).toMatch(/later/i);
    }
  });

  it("links every available area inside the competition workspace", () => {
    for (const item of items.filter((candidate) => candidate.available)) {
      expect(item.href).toMatch(new RegExp(`^/app/events/${EVENT}/competition(/[a-z-]+)?$`));
    }
  });

  it("highlights the right section, keeping readiness/generation/advanced under their parents", () => {
    const base = `/app/events/${EVENT}/competition`;
    expect(activeNavKey(EVENT, base)).toBe("overview");
    expect(activeNavKey(EVENT, `${base}/new`)).toBe("overview");
    expect(activeNavKey(EVENT, `${base}/registrations`)).toBe("entries");
    expect(activeNavKey(EVENT, `${base}/checkin/abc`)).toBe("check_in");
    expect(activeNavKey(EVENT, `${base}/divisions`)).toBe("divisions");
    expect(activeNavKey(EVENT, `${base}/schedule`)).toBe("schedule");
    expect(activeNavKey(EVENT, `${base}/readiness`)).toBe("schedule");
    expect(activeNavKey(EVENT, `${base}/generation/run-1`)).toBe("schedule");
    expect(activeNavKey(EVENT, `${base}/settings`)).toBe("settings");
    expect(activeNavKey(EVENT, `${base}/advanced`)).toBe("settings");
  });

  it("the nav component never renders a link for an unavailable item", () => {
    const nav = read("src/app/app/events/[id]/competition/CompetitionNav.tsx");
    expect(nav).toContain("if (!item.available || !item.href)");
    expect(nav).toContain("aria-disabled=\"true\"");
  });
});

describe("Overview lifecycle and the one next action", () => {
  it("starts with Create competition when nothing exists", () => {
    const lifecycle = computeLifecycle(input({ program: null, categoryCount: 0, divisionCount: 0 }));
    expect(lifecycle.primaryAction).toMatchObject({ kind: "link", label: "Create competition", href: `/app/events/${EVENT}/competition/new` });
    expect(lifecycle.stages[0]).toMatchObject({ key: "create", state: "current" });
    expect(lifecycle.problems).toEqual([]);
  });

  it("asks to complete setup while the structure has gaps, listing what is missing", () => {
    const lifecycle = computeLifecycle(input({ categoriesWithoutDivisions: 1, divisionsWithoutRound: 2, divisionsMissingDances: 1 }));
    expect(lifecycle.structureReady).toBe(false);
    expect(lifecycle.primaryAction).toMatchObject({ kind: "link", label: "Complete setup", href: `/app/events/${EVENT}/competition/divisions` });
    expect(lifecycle.problems).toEqual(["1 category needs a division.", "2 divisions need a round.", "1 division needs a dance."]);
    expect(lifecycle.stages.find((stage) => stage.state === "current")?.key).toBe("divisions");
  });

  it("never offers publish without a complete structure", () => {
    for (const gap of [{ categoryCount: 0 }, { categoriesWithoutDivisions: 1 }, { divisionsWithoutRound: 1 }, { divisionsMissingDances: 1 }]) {
      expect(computeLifecycle(input(gap)).primaryAction.kind, JSON.stringify(gap)).not.toBe("publish");
    }
  });

  it("offers a single Publish competition action when the structure is ready", () => {
    const lifecycle = computeLifecycle(input());
    expect(lifecycle.primaryAction).toMatchObject({ kind: "publish", label: "Publish competition", programId: "p1" });
    expect(lifecycle.stages.find((stage) => stage.state === "current")?.key).toBe("publish");
  });

  it("after publishing, the next step is opening registration (10C)", () => {
    const lifecycle = computeLifecycle(input({ program: publishedProgram }));
    expect(lifecycle.published).toBe(true);
    expect(lifecycle.primaryAction).toMatchObject({ kind: "registration", mode: "open", label: "Open registration", programId: "p1" });
    const registration = lifecycle.stages.find((stage) => stage.key === "open_registration")!;
    expect(registration.actionable).toBe(true);
    expect(registration.state).toBe("current");
  });

  it("while registration is open, the next step is closing it; after closing, the schedule (10C)", () => {
    const open = computeLifecycle(input({ program: { ...publishedProgram, registrationStatus: "open", registrationOpenedAt: "2026-10-09T00:00:00Z" }, registrationOpen: true, registrationEverOpened: true }));
    expect(open.primaryAction).toMatchObject({ kind: "registration", mode: "close", label: "Close registration" });
    expect(open.stages.find((stage) => stage.key === "open_registration")?.state).toBe("done");
    expect(open.stages.find((stage) => stage.key === "close_registration")).toMatchObject({ state: "current", actionable: true });
    const closed = computeLifecycle(input({ program: { ...publishedProgram, registrationStatus: "closed", registrationOpenedAt: "2026-10-09T00:00:00Z" }, registrationOpen: false, registrationEverOpened: true }));
    expect(closed.primaryAction).toMatchObject({ kind: "link", label: "Plan schedule & heats" });
    expect(closed.stages.find((stage) => stage.key === "close_registration")?.state).toBe("done");
  });

  it("the Overview offers an open/close control for every published competition, including Advanced-mode ones (10C)", () => {
    const page = read("src/app/app/events/[id]/competition/page.tsx");
    expect(page).toContain(`{primary && lifecycle.published && action.kind !== "registration" ? (`);
    expect(page).toContain(`mode={primary.registration_status === "open" ? "close" : "open"}`);
    expect(computeLifecycle(input({ program: { ...legacyProgram, status: "configured" } })).published).toBe(true);
  });

  it("an unpublished competition cannot open registration (10C)", () => {
    const lifecycle = computeLifecycle(input());
    expect(lifecycle.stages.find((stage) => stage.key === "open_registration")?.actionable).toBe(false);
    expect(lifecycle.primaryAction.kind).not.toBe("registration");
  });

  it("leaves competitions set up with Advanced settings to Advanced settings", () => {
    const lifecycle = computeLifecycle(input({ program: legacyProgram }));
    expect(lifecycle.primaryAction).toMatchObject({ kind: "link", label: "Continue in Advanced settings", href: `/app/events/${EVENT}/competition/advanced` });
    expect(lifecycle.stages.find((stage) => stage.key === "publish")?.actionable).toBe(false);
  });

  it("only the stages that work today are actionable; the rest are upcoming", () => {
    const stages = computeLifecycle(input({ program: publishedProgram })).stages;
    expect(stages.map((stage) => stage.key)).toEqual(["create", "divisions", "publish", "open_registration", "close_registration", "build_heats", "assign_officials", "run", "review_results", "publish_results"]);
    expect(stages.find((stage) => stage.key === "open_registration")?.actionable).toBe(true);
    for (const key of ["close_registration", "assign_officials", "run", "review_results", "publish_results"]) {
      expect(stages.find((stage) => stage.key === key)?.actionable, key).toBe(false);
    }
    expect(stages.filter((stage) => stage.state === "current")).toHaveLength(1);
  });

  it("exactly one stage is current and everything before it is done", () => {
    for (const lifecycle of [computeLifecycle(input({ program: null })), computeLifecycle(input()), computeLifecycle(input({ program: publishedProgram, heatCount: 3 }))]) {
      const current = lifecycle.stages.findIndex((stage) => stage.state === "current");
      expect(current).toBeGreaterThanOrEqual(0);
      expect(lifecycle.stages.slice(0, current).every((stage) => stage.state === "done")).toBe(true);
    }
  });

  it("derives readiness counts from the canonical rows", () => {
    const built = buildLifecycleInput({
      eventId: EVENT,
      program: draftProgram,
      rows: {
        contests: [{ id: "c1" }, { id: "c2" }, { id: "c3" }],
        divisions: [
          { id: "d1", contest_id: "c1" },
          { id: "d2", contest_id: "c1" },
          { id: "d3", contest_id: "c2" },
        ],
        rounds: [{ division_id: "d1" }, { division_id: "d3" }],
        rules: [
          { contest_id: "c1", dance_selection_mode: "individual", registration_open: false },
          { contest_id: "c2", dance_selection_mode: "routine", registration_open: false },
          { contest_id: "c3", dance_selection_mode: "individual", registration_open: true },
        ],
        offerings: [{ division_id: "d1" }],
      },
      entryCount: 2,
      heatCount: 1,
    });
    // 10C: a toggled contest rule alone does not mean registration is open; the program lifecycle does.
    expect(built).toMatchObject({ categoryCount: 3, categoriesWithoutDivisions: 1, divisionCount: 3, divisionsWithoutRound: 1, divisionsMissingDances: 1, registrationOpen: false, registrationEverOpened: false, entryCount: 2, heatCount: 1 });
    expect(buildLifecycleInput({ eventId: EVENT, program: { ...draftProgram, registrationStatus: "open", registrationOpenedAt: "2026-10-09T00:00:00Z" }, rows: { contests: [], divisions: [], rounds: [], rules: [], offerings: [] }, entryCount: 0, heatCount: 0 }))
      .toMatchObject({ registrationOpen: true, registrationEverOpened: true });
    expect(structureProblems(built)).toHaveLength(3);
  });
});

describe("Simple and Advanced mode share one canonical model", () => {
  it("Simple Mode writes only through the database functions, never directly into the competition tables", () => {
    const actions = read("src/app/app/events/[id]/competition/simpleActions.ts");
    expect(actions).toContain("rpc(\"create_simple_competition\"");
    expect(actions).toContain("rpc(\"publish_competition_program\"");
    expect(actions).toContain("rpc(\"add_competition_division\"");
    expect(actions).toContain("rpc(\"remove_competition_division\"");
    for (const table of ["event_competition_programs", "event_competition_contests", "event_competition_rounds", "event_competition_division_dances", "event_competition_dances", "event_competition_contest_registration_rules"]) {
      expect(actions, table).not.toMatch(new RegExp(`from\\("${table}"\\)\\s*\\.(insert|upsert|delete)`));
    }
    expect(actions).not.toMatch(/from\("event_competition_programs"\)\s*\.update/);
  });

  it("the wizard and boards keep their state in React/props only, with no browser storage as a data model", () => {
    for (const file of ["new/CreateCompetitionWizard.tsx", "divisions/DivisionsBoard.tsx", "PublishForm.tsx"]) {
      const source = readFileSync(join(WORKSPACE, file), "utf8");
      expect(source, file).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    }
  });

  it("Advanced settings still exposes every original setup action (switching modes removes nothing)", () => {
    const advanced = read("src/app/app/events/[id]/competition/advanced/page.tsx");
    for (const action of [
      "addCompetitionDivisionDanceAction", "applyCompetitionTemplateAction", "createCompetitionContestAction", "createCompetitionDanceAction",
      "createCompetitionDivisionAction", "createCompetitionProgramAction", "createCompetitionRoundAction", "restartCompetitionSetupAction",
      "setCompetitionDivisionRegistrationStatusAction", "updateCompetitionContestRegistrationAction", "updateCompetitionDivisionDanceAction", "updateWsdcProgramProfileAction",
    ]) {
      expect(advanced, action).toContain(`action={${action}}`);
      expect(advanced.match(new RegExp(action, "g"))?.length, action).toBeGreaterThanOrEqual(2);
    }
    expect(advanced).toContain("Back to overview");
  });

  it("no Simple Mode screen can restart, delete or recreate the setup", () => {
    for (const file of ["page.tsx", "new/CreateCompetitionWizard.tsx", "divisions/DivisionsBoard.tsx", "settings/page.tsx", "simpleActions.ts"]) {
      const source = readFileSync(join(WORKSPACE, file), "utf8");
      expect(source, file).not.toContain("restartCompetitionSetupAction");
      expect(source, file).not.toContain("restart_event_competition_setup");
    }
  });

  it("opening registration in Advanced settings requires the competition to be published first", () => {
    const actions = read("src/app/app/events/[id]/competition/actions.ts");
    expect(actions).toContain("Publish this competition from the Overview before opening registration.");
  });

  it("the Overview and Settings keep Advanced settings one click away", () => {
    expect(read("src/app/app/events/[id]/competition/page.tsx")).toContain("/competition/advanced");
    expect(read("src/app/app/events/[id]/competition/settings/page.tsx")).toContain("/competition/advanced");
    expect(read("src/app/app/events/[id]/competition/new/CreateCompetitionWizard.tsx")).toContain("/competition/advanced");
  });

  it("organizer-facing screens avoid database and engine vocabulary", () => {
    const files = ["page.tsx", "new/CreateCompetitionWizard.tsx", "divisions/DivisionsBoard.tsx", "divisions/page.tsx", "settings/page.tsx", "PublishForm.tsx"];
    for (const file of files) {
      const source = readFileSync(join(WORKSPACE, file), "utf8");
      const visible = [...source.matchAll(/>([^<>{}\n]{3,})</g)].map((match) => match[1]).concat([...source.matchAll(/"([A-Z][^"\n]{12,})"/g)].map((match) => match[1]));
      for (const text of visible) {
        expect(text, `${file}: ${text}`).not.toMatch(/ordinal_majority|proficiency_rating|callback_tally|\bcontests?\b|\bprograms?\b/i);
      }
    }
  });

  it("the wizard is honest about what is not running yet and about the generic rating levels", () => {
    const wizard = read("src/app/app/events/[id]/competition/new/CreateCompetitionWizard.tsx");
    expect(wizard).toContain("Judging and results are set up now and run in a later update.");
    expect(wizard).toContain("own simple rating levels");
    expect(wizard).toContain("Online registration for dancers opens in a later update; nothing is sold yet.");
    expect(wizard).toContain("registration window for the whole event, including any tickets");
    expect(wizard).not.toMatch(/UCWDC|medal/i);
  });

  it("the settings screen states that a rules profile is not a sanction", () => {
    const settings = read("src/app/app/events/[id]/competition/settings/page.tsx");
    expect(settings).toContain("Following a rules profile never means an organization sanctioned the event.");
    const wizard = read("src/app/app/events/[id]/competition/new/CreateCompetitionWizard.tsx");
    expect(wizard).toContain("sanctioning organization");
    for (const file of sourceFiles(join(ROOT, "src/app/app/events/[id]/competition")).filter((path) => !path.includes("advanced"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/NDCA sanctioned|UCWDC sanctioned|WSDC sanctioned/i);
    }
  });
});

describe("public registration stays off in 10B", () => {
  const FLAG = "NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED";

  it("is read in exactly the reviewed places and only ever compared to the string 'true'", () => {
    const uses = sourceFiles(join(ROOT, "src")).filter((file) => readFileSync(file, "utf8").includes(FLAG));
    expect(uses.map((file) => file.replaceAll("\\", "/").split("/src/")[1]).sort()).toEqual([
      "app/api/events/[slug]/competition/checkout/route.ts",
      "app/api/events/[slug]/competition/release/route.ts",
      "app/api/events/[slug]/competition/resume/route.ts",
      "app/events/[slug]/competition/register/page.tsx",
      "app/events/[slug]/competition/register/status/page.tsx",
      "app/events/[slug]/page.tsx",
    ]);
    for (const file of uses) {
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(new RegExp(`process\\.env\\.${FLAG} === "true"`));
      expect(source).not.toMatch(new RegExp(`${FLAG}\\s*=\\s*["']true`));
    }
  });

  it("the public event page only advertises competition registration while the flag is on", () => {
    const page = read("src/app/events/[slug]/page.tsx");
    expect(page).toContain("competitionRegistrationEnabled &&");
    const link = page.indexOf("/competition/register");
    expect(link).toBeGreaterThan(-1);
    const gate = page.lastIndexOf("competitionRegistrationEnabled &&", link);
    expect(gate).toBeGreaterThan(-1);
    expect(link - gate).toBeLessThan(1500);
    expect(page.match(/\/competition\/register/g)?.length).toBe(1);
  });

  it("is not enabled by any checked-in environment, config or deployment file", () => {
    for (const file of [".env.example", ".env.e2e.example", "next.config.ts", "next.config.js", "next.config.mjs", "vercel.json", "package.json"]) {
      let source = "";
      try {
        source = read(file);
      } catch {
        continue;
      }
      expect(source, file).not.toContain(FLAG);
    }
  });

  it("10B code does not link to, import or open the public registration builder", () => {
    for (const file of sourceFiles(WORKSPACE).filter((path) => !path.includes("advanced") && !path.includes("registrations") && !path.includes("checkin") && !path.includes("schedule") && !path.includes("readiness") && !path.includes("generation"))) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("competition/register");
      expect(source, file).not.toContain("CompetitionRegistrationBuilder");
    }
    expect(read("src/app/app/events/[id]/competition/simpleActions.ts")).not.toMatch(/registration_open"?\s*:\s*true/);
  });
});
