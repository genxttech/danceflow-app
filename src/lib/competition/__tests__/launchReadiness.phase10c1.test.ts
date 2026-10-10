import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildStudioSections } from "@/app/app/layout";
import { isActivePath, normalizeSections } from "@/components/app/sidebar/navUtils";
import {
  competitionSetupHref,
  competitionWorkspaceHref,
  continuesToCompetitionSetup,
  createEventSubmitLabel,
  COMPETITIONS_HREF,
  NEW_COMPETITION_HREF,
} from "@/lib/competition/workspaceLink";
import { canSeeCompetitionsList, describeCompetitionRow } from "@/lib/competition/competitionsList";
import { computeLifecycle } from "@/lib/competition/lifecycle";

const ROOT = join(__dirname, "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const EVENT = "11111111-1111-1111-1111-111111111111";

function navSections(role: string, isPlatformAdmin = false) {
  const sections = buildStudioSections({
    unreadNotificationsCount: 0,
    leadsBadgeCount: 0,
    role,
    isPlatformAdmin,
    portalHref: "/portal/test-studio",
    publicProfileHref: "/studios/test-studio",
    hasLinkedPortalAccess: false,
  } as Parameters<typeof buildStudioSections>[0]);
  return normalizeSections(sections, { role, hasOrganizerSuite: false });
}

function navHrefs(role: string, isPlatformAdmin = false) {
  return navSections(role, isPlatformAdmin).flatMap((section) => section.items.map((item) => item.href));
}

describe("10C.1 Create Event -> Competition setup", () => {
  it("selecting Competition changes the primary action; other types keep Create Event", () => {
    expect(createEventSubmitLabel("competition")).toBe("Create Event & Set Up Competition");
    for (const type of ["workshop", "group_class", "social_dance", "showcase", "", null, undefined]) {
      expect(createEventSubmitLabel(type)).toBe("Create Event");
    }
    expect(read("src/app/app/events/EventForm.tsx")).toContain(": createSubmitLabel(eventType)}");
  });

  it("only Competition continues into setup", () => {
    expect(continuesToCompetitionSetup("competition")).toBe(true);
    expect(continuesToCompetitionSetup(" Competition ")).toBe(true);
    expect(continuesToCompetitionSetup("showcase")).toBe(false);
    expect(continuesToCompetitionSetup("workshop")).toBe(false);
  });

  it("a Competition event redirects into competition setup; every other event still returns to the events list", () => {
    const actions = read("src/app/app/events/actions.ts");
    const create = actions.slice(actions.indexOf("export async function createEventAction("), actions.indexOf("export async function updateEventAction("));
    expect(create).toContain("if (continuesToCompetitionSetup(normalizeDbEventType(effectivePayload.eventType))) {");
    expect(create).toContain("competitionSetupEventId = event.id;");
    const setupRedirect = create.indexOf("redirect(competitionSetupHref(competitionSetupEventId));");
    const listRedirect = create.lastIndexOf(`redirect("/app/events");`);
    expect(setupRedirect).toBeGreaterThan(-1);
    expect(listRedirect).toBeGreaterThan(setupRedirect);
    // One insert: the competition path does not create a second event.
    expect(create.match(/\.from\("events"\)\s*\.insert\(/g)?.length).toBe(1);
    expect(competitionSetupHref(EVENT)).toBe(`/app/events/${EVENT}/competition/new`);
  });

  it("New Competition reuses the canonical Create Event form, preselected to Competition", () => {
    expect(NEW_COMPETITION_HREF).toBe("/app/events/new?type=competition");
    const page = read("src/app/app/events/new/page.tsx");
    expect(page).toContain(`const startAsCompetition = (await searchParams)?.type === "competition";`);
    expect(page).toContain(`...(startAsCompetition ? { eventType: "competition" } : {}),`);
    expect(page).toContain("<EventForm");
    const competitions = read("src/app/app/competitions/page.tsx");
    expect(competitions).toContain("href={NEW_COMPETITION_HREF}");
    expect(competitions).not.toMatch(/\.insert\(|createEventAction|EventForm/);
  });
});

describe("10C.1 Competitions entry", () => {
  it("owners and admins see Competitions in the Events section; instructors and front desk do not", () => {
    expect(navHrefs("studio_owner")).toContain(COMPETITIONS_HREF);
    expect(navHrefs("studio_admin")).toContain(COMPETITIONS_HREF);
    expect(navHrefs("studio_owner", true)).toContain(COMPETITIONS_HREF);
    expect(navHrefs("instructor")).not.toContain(COMPETITIONS_HREF);
    expect(navHrefs("front_desk")).not.toContain(COMPETITIONS_HREF);
    const events = navSections("studio_owner").find((section) => section.items.some((item) => item.href === COMPETITIONS_HREF));
    const hrefs = events?.items.map((item) => item.href) ?? [];
    expect(hrefs.slice(0, 3)).toEqual(["/app/events", "/app/events/new", COMPETITIONS_HREF]);
  });

  it("Competitions stays highlighted inside every competition workspace, not on plain event pages", () => {
    expect(isActivePath("/app/competitions", COMPETITIONS_HREF)).toBe(true);
    expect(isActivePath(`/app/events/${EVENT}/competition`, COMPETITIONS_HREF)).toBe(true);
    expect(isActivePath(`/app/events/${EVENT}/competition/divisions`, COMPETITIONS_HREF)).toBe(true);
    expect(isActivePath(`/app/events/${EVENT}`, COMPETITIONS_HREF)).toBe(false);
    expect(isActivePath(`/app/events/${EVENT}/competition`, "/app/events")).toBe(false);
  });

  it("the list is visible to event managers only", () => {
    for (const role of ["studio_owner", "studio_admin", "organizer_owner", "organizer_admin"]) expect(canSeeCompetitionsList(role, false)).toBe(true);
    for (const role of ["instructor", "front_desk", "independent_instructor", "organizer_staff", null]) expect(canSeeCompetitionsList(role, false)).toBe(false);
    expect(canSeeCompetitionsList(null, true)).toBe(true);
    expect(read("src/app/app/competitions/page.tsx")).toContain(`if (!canSeeCompetitionsList(context.studioRole, Boolean(context.isPlatformAdmin))) redirect("/app");`);
  });

  it("every row resolves to the one canonical workspace; events without setup go to setup", () => {
    const base = { status: "configured", rules_profile_key: "studio_simple", profile_locked_at: "2026-10-09T00:00:00Z", registration_status: "closed", registration_opened_at: null };
    expect(describeCompetitionRow({ eventId: EVENT, eventStatus: "draft", program: null })).toMatchObject({ actionLabel: "Set up competition", href: competitionSetupHref(EVENT) });
    expect(describeCompetitionRow({ eventId: EVENT, eventStatus: "published", program: { ...base, profile_locked_at: null, status: "draft" } })).toMatchObject({ stateLabel: "Setup in progress", href: competitionWorkspaceHref(EVENT) });
    expect(describeCompetitionRow({ eventId: EVENT, eventStatus: "published", program: base })).toMatchObject({ actionLabel: "Open registration", href: competitionWorkspaceHref(EVENT) });
    expect(describeCompetitionRow({ eventId: EVENT, eventStatus: "published", program: { ...base, registration_status: "open", registration_opened_at: "x" } })).toMatchObject({ stateLabel: "Registration open" });
    expect(describeCompetitionRow({ eventId: EVENT, eventStatus: "published", program: { ...base, registration_opened_at: "x" } })).toMatchObject({ stateLabel: "Registration closed" });
    expect(describeCompetitionRow({ eventId: EVENT, eventStatus: "published", program: { ...base, rules_profile_key: null, profile_locked_at: null } })).toMatchObject({ actionLabel: "Open registration" });
    expect(describeCompetitionRow({ eventId: EVENT, eventStatus: "cancelled", program: base })).toMatchObject({ stateLabel: "Event cancelled" });
  });

  it("the event page offers Set up competition when nothing exists yet, otherwise opens the workspace", () => {
    const detail = read("src/app/app/events/[id]/page.tsx");
    expect(detail).toContain(`{Number(competitionProgramCount ?? 0) > 0 ? "Competition" : "Set up competition"}`);
    expect(detail).toContain("competitionSetupHref(typedEvent.id)");
  });
});

describe("10C.1 Competition workspace", () => {
  it("the empty workspace has exactly one primary action and no Advanced-settings line", () => {
    const lifecycle = computeLifecycle({ eventId: EVENT, program: null, categoryCount: 0, categoriesWithoutDivisions: 0, divisionCount: 0, divisionsWithoutRound: 0, divisionsMissingDances: 0, registrationOpen: false, registrationEverOpened: false, entryCount: 0, heatCount: 0 });
    expect(lifecycle.primaryAction).toMatchObject({ kind: "link", label: "Create competition", href: competitionSetupHref(EVENT) });
    const overview = read("src/app/app/events/[id]/competition/page.tsx");
    expect(overview).toContain("This event doesn't have a competition set up yet.");
    const advanced = overview.lastIndexOf("Need more control?");
    expect(overview.lastIndexOf("{programs.length > 0 ? (", advanced)).toBeGreaterThan(-1);
    expect(advanced - overview.lastIndexOf("{programs.length > 0 ? (", advanced)).toBeLessThan(200);
  });

  it("finishing the wizard lands on the Overview, and the workspace links back to Competitions and the event", () => {
    // 10C.5: the draft action returns the Overview link; the wizard clears its unsent draft and navigates there.
    expect(read("src/app/app/events/[id]/competition/simpleActions.ts")).toContain("return { ok: true, href: `${competitionWorkspaceHref(eventId)}?created=1` };");
    expect(read("src/app/app/events/[id]/competition/new/CompetitionSetupWizard.tsx")).toContain("router.replace(action.href);");
    expect(read("src/app/app/events/[id]/competition/new/page.tsx")).toContain("competitionWorkspaceHref(id)");
    const layout = read("src/app/app/events/[id]/competition/layout.tsx");
    expect(layout).toContain("requireCompetitionWorkspace(id)");
    expect(layout).toContain("href={COMPETITIONS_HREF}");
    expect(layout).toContain("href={`/app/events/${id}`}");
  });

  it("buyer-facing status copy avoids provider jargon", () => {
    const status = read("src/app/events/[slug]/competition/register/status/page.tsx");
    const copy = status.slice(status.indexOf("const COPY"), status.indexOf("function money"));
    expect(copy.length).toBeGreaterThan(100);
    expect(copy).not.toMatch(/Stripe|webhook|PaymentIntent|checkout session/i);
  });
});
