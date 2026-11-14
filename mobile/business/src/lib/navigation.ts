import type { StaffWorkspace } from "@/lib/staffApi";

/*
  Which tabs a workspace shows, from GET /api/staff/me capabilities only.

  Capabilities are role-level hints that shape navigation; the server still enforces every
  route. A missing key is false, and a role this app does not serve gets no feature tabs.
*/

export type TabKey = "pulse" | "today" | "clients" | "more";

/** Roles whose schedule routes the v1 API serves. Independent instructors and organizer roles get role_not_permitted. */
const SERVED_ROLES = new Set(["studio_owner", "studio_admin", "front_desk", "instructor"]);

const TAB_ORDER: TabKey[] = ["pulse", "today", "clients", "more"];

export function isServedRole(role: string | null | undefined) {
  return SERVED_ROLES.has(role ?? "");
}

function can(workspace: StaffWorkspace, key: string) {
  return workspace.capabilities?.[key] === true;
}

export function tabsForWorkspace(workspace: StaffWorkspace | null | undefined): TabKey[] {
  if (!workspace || !workspace.accessAllowed || !isServedRole(workspace.role)) return ["more"];

  const tabs = new Set<TabKey>(["more"]);
  const schedule = can(workspace, "viewStudioSchedule");

  if (schedule) tabs.add("today");
  // Owners, admins and front desk see the studio's clients; instructors see the people they teach.
  if (can(workspace, "viewClients") || schedule) tabs.add("clients");
  if (can(workspace, "viewReports")) tabs.add("pulse");

  return TAB_ORDER.filter((tab) => tabs.has(tab));
}

/** The tab a workspace opens on. */
export function initialTab(workspace: StaffWorkspace | null | undefined): TabKey {
  const tabs = tabsForWorkspace(workspace);
  return tabs.includes("today") ? "today" : tabs[0];
}

/**
 * The person's choice if it is still listed (even paused, so More can explain it); otherwise the
 * first workspace that can be opened now (not paused, a role the API serves); otherwise the first.
 */
export function pickDefaultWorkspace(workspaces: StaffWorkspace[], preferredId?: string | null) {
  return (
    workspaces.find((w) => w.studioId === preferredId) ??
    workspaces.find((w) => w.accessAllowed && isServedRole(w.role)) ??
    workspaces[0] ??
    null
  );
}

export function roleLabel(role: string) {
  switch (role) {
    case "studio_owner":
      return "Owner";
    case "studio_admin":
      return "Admin";
    case "front_desk":
      return "Front desk";
    case "instructor":
      return "Instructor";
    case "independent_instructor":
      return "Independent instructor";
    case "organizer_owner":
    case "organizer_admin":
    case "organizer_staff":
      return "Organizer";
    default:
      return "Staff";
  }
}
