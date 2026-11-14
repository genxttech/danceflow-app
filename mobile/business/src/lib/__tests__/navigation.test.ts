import { initialTab, pickDefaultWorkspace, tabsForWorkspace } from "@/lib/navigation";
import type { StaffWorkspace } from "@/lib/staffApi";

// Capability values as GET /api/staff/me reports them per role (src/lib/auth/staffCapabilities.ts).
const INSTRUCTOR = { viewStudioSchedule: true, viewClients: false, viewReports: false, markAttendance: true };
const OWNER = { viewStudioSchedule: true, viewClients: true, viewReports: true, manageBilling: true };
const FRONT_DESK = { viewStudioSchedule: true, viewClients: true, viewReports: true };
const ORGANIZER = { viewStudioSchedule: false, viewClients: false, viewReports: true };

function workspace(overrides: Partial<StaffWorkspace>): StaffWorkspace {
  return {
    studioId: "studio-1",
    name: "Studio",
    publicName: null,
    slug: null,
    role: "instructor",
    accessAllowed: true,
    subscriptionStatus: "active",
    capabilities: INSTRUCTOR,
    ...overrides,
  };
}

describe("tabsForWorkspace", () => {
  it("gives an instructor Today, Clients and More", () => {
    expect(tabsForWorkspace(workspace({}))).toEqual(["today", "clients", "more"]);
  });

  it("gives an owner Pulse ahead of the instructor tabs", () => {
    expect(tabsForWorkspace(workspace({ role: "studio_owner", capabilities: OWNER }))).toEqual([
      "pulse",
      "today",
      "clients",
      "more",
    ]);
  });

  it("gives an admin the owner tabs", () => {
    expect(tabsForWorkspace(workspace({ role: "studio_admin", capabilities: OWNER }))).toEqual([
      "pulse",
      "today",
      "clients",
      "more",
    ]);
  });

  it("follows capabilities, not the role name", () => {
    expect(tabsForWorkspace(workspace({ role: "front_desk", capabilities: FRONT_DESK }))).toEqual([
      "pulse",
      "today",
      "clients",
      "more",
    ]);
    expect(tabsForWorkspace(workspace({ role: "studio_owner", capabilities: INSTRUCTOR }))).toEqual([
      "today",
      "clients",
      "more",
    ]);
  });

  it("treats a missing capability key as false", () => {
    expect(tabsForWorkspace(workspace({ capabilities: {} }))).toEqual(["more"]);
    expect(tabsForWorkspace(workspace({ capabilities: { viewStudioSchedule: undefined } }))).toEqual(["more"]);
  });

  it("only accepts a literal true", () => {
    const loose = { viewStudioSchedule: "yes" } as unknown as StaffWorkspace["capabilities"];
    expect(tabsForWorkspace(workspace({ capabilities: loose }))).toEqual(["more"]);
  });

  it("shows only More for a paused workspace", () => {
    expect(tabsForWorkspace(workspace({ accessAllowed: false, subscriptionStatus: "past_due" }))).toEqual(["more"]);
  });

  it("shows only More for roles the v1 API does not serve, even with capabilities", () => {
    expect(tabsForWorkspace(workspace({ role: "organizer_owner", capabilities: ORGANIZER }))).toEqual(["more"]);
    expect(tabsForWorkspace(workspace({ role: "independent_instructor", capabilities: INSTRUCTOR }))).toEqual(["more"]);
    expect(tabsForWorkspace(workspace({ role: "something_new", capabilities: OWNER }))).toEqual(["more"]);
  });

  it("shows only More without a workspace", () => {
    expect(tabsForWorkspace(null)).toEqual(["more"]);
  });
});

describe("initialTab", () => {
  it("opens on Today whenever Today is available", () => {
    expect(initialTab(workspace({}))).toBe("today");
    expect(initialTab(workspace({ role: "studio_owner", capabilities: OWNER }))).toBe("today");
  });

  it("opens on More otherwise", () => {
    expect(initialTab(workspace({ accessAllowed: false }))).toBe("more");
  });
});

describe("pickDefaultWorkspace", () => {
  const paused = workspace({ studioId: "paused", accessAllowed: false });
  const organizer = workspace({ studioId: "org", role: "organizer_owner", capabilities: ORGANIZER });
  const active = workspace({ studioId: "active" });
  const second = workspace({ studioId: "second" });

  it("prefers an open workspace the API serves", () => {
    expect(pickDefaultWorkspace([paused, organizer, active])?.studioId).toBe("active");
  });

  it("keeps the person's choice when it is usable", () => {
    expect(pickDefaultWorkspace([active, second], "second")?.studioId).toBe("second");
  });

  it("still opens a chosen paused workspace so More can explain it", () => {
    expect(pickDefaultWorkspace([paused, active], "paused")?.studioId).toBe("paused");
  });

  it("falls back when the chosen workspace is no longer listed", () => {
    expect(pickDefaultWorkspace([paused, active], "gone")?.studioId).toBe("active");
  });

  it("returns null when there are none", () => {
    expect(pickDefaultWorkspace([])).toBeNull();
  });
});
