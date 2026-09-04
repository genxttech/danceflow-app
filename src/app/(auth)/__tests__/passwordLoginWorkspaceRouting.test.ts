import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * FC-1B5B: password login previously determined /app eligibility via a
 * hand-rolled query checking only role === 'studio_owner' in
 * user_studio_roles -- silently sending every other valid active role
 * (studio_admin, front_desk, instructor, independent_instructor, every
 * organizer role) to /account (or a portal, if linked) instead of /app.
 *
 * The fix reuses getAccessibleStudioRolesForUser (src/lib/auth/studio.ts),
 * the same shared source of truth /app's own layout already uses -- it
 * merges active user_studio_roles and active organizer_users. This suite
 * mocks that helper directly (mirroring the established convention from
 * FC-1B5A/independentInstructorFloorRental.test.ts of mocking the shared
 * entry point rather than re-deriving its own SQL), and mocks the portal
 * fallback (listLinkedPortalDestinations/decidePortalDestination) the same
 * way, to test the routing DECISION in isolation from
 * signInWithPassword/rate-limiting/profile-sync, none of which affect the
 * /app vs portal vs /account outcome.
 */

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieStore[name] !== undefined ? { value: cookieStore[name] } : undefined,
  }),
  headers: async () => new Map(),
}));

const getAccessibleStudioRolesForUserMock = vi.fn();

vi.mock("@/lib/auth/studio", () => ({
  getAccessibleStudioRolesForUser: (...args: unknown[]) =>
    getAccessibleStudioRolesForUserMock(...args),
}));

const listLinkedPortalDestinationsMock = vi.fn();
const decidePortalDestinationMock = vi.fn();

vi.mock("@/lib/auth/portal-linking", () => ({
  listLinkedPortalDestinations: (...args: unknown[]) =>
    listLinkedPortalDestinationsMock(...args),
  decidePortalDestination: (...args: unknown[]) =>
    decidePortalDestinationMock(...args),
  ensurePortalProfileAndClientLinks: vi.fn(),
  claimGroupLessonRecapsForUser: vi.fn(),
  getGroupLessonRecapTokenFromPath: vi.fn(),
  PORTAL_SELECTED_STUDIO_COOKIE: "portal_selected_studio_id",
}));

let cookieStore: Record<string, string> = {};

const { getPostLoginRedirectPath, hasActiveWorkspaceRole } = await import(
  "../actions"
);

function activeRole(role: string, studioId = "studio-1") {
  return { studio_id: studioId, role, active: true, studios: null };
}

function mockRoles(roles: ReturnType<typeof activeRole>[]) {
  getAccessibleStudioRolesForUserMock.mockResolvedValue(roles);
}

function mockPortal(
  decision:
    | { type: "none" }
    | { type: "single"; path: string }
    | { type: "multiple" },
) {
  listLinkedPortalDestinationsMock.mockResolvedValue([]);
  decidePortalDestinationMock.mockReturnValue(decision);
}

beforeEach(() => {
  cookieStore = {};
  getAccessibleStudioRolesForUserMock.mockReset();
  listLinkedPortalDestinationsMock.mockReset();
  decidePortalDestinationMock.mockReset();
});

describe("hasActiveWorkspaceRole (FC-1B5B)", () => {
  it("delegates to getAccessibleStudioRolesForUser rather than a hand-rolled role filter", async () => {
    mockRoles([activeRole("front_desk")]);

    const result = await hasActiveWorkspaceRole("user-1");

    expect(result).toBe(true);
    expect(getAccessibleStudioRolesForUserMock).toHaveBeenCalledWith("user-1");
  });

  it("returns true for a non-studio_owner active role (regression guard for the fixed bug)", async () => {
    mockRoles([activeRole("instructor")]);

    expect(await hasActiveWorkspaceRole("user-1")).toBe(true);
  });

  it("returns false when no active roles exist", async () => {
    mockRoles([]);

    expect(await hasActiveWorkspaceRole("user-1")).toBe(false);
  });
});

describe("getPostLoginRedirectPath routing matrix (FC-1B5B)", () => {
  it.each([
    ["studio_owner", "studio_owner"],
    ["studio_admin", "studio_admin"],
    ["front_desk", "front_desk"],
    ["instructor", "instructor"],
    ["independent_instructor (active host role)", "independent_instructor"],
    ["organizer_owner", "organizer_owner"],
    ["organizer_admin", "organizer_admin"],
    ["organizer_staff", "organizer_staff"],
  ])("active %s routes to /app", async (_label, role) => {
    mockRoles([activeRole(role)]);
    mockPortal({ type: "none" });

    const result = await getPostLoginRedirectPath("user-1");

    expect(result).toBe("/app");
    expect(decidePortalDestinationMock).not.toHaveBeenCalled();
  });

  it("inactive-only role (no active roles surfaced) with no linked portal routes to /account", async () => {
    mockRoles([]);
    mockPortal({ type: "none" });

    expect(await getPostLoginRedirectPath("user-1")).toBe("/account");
  });

  it("inactive/revoked independent_instructor with a still-valid linked portal routes to the portal", async () => {
    mockRoles([]);
    mockPortal({ type: "single", path: "/portal/host-studio?client=client-1" });

    const result = await getPostLoginRedirectPath("user-1");

    expect(result).toBe("/portal/host-studio?client=client-1");
  });

  it("inactive/revoked independent_instructor with no portal link routes to /account", async () => {
    mockRoles([]);
    mockPortal({ type: "none" });

    expect(await getPostLoginRedirectPath("user-1")).toBe("/account");
  });

  it("clients.is_independent_instructor=true alone (no active workspace, no portal) routes to /account", async () => {
    // The client-side flag is never consulted by getAccessibleStudioRolesForUser
    // or the portal decision -- both are mocked here to reflect a user with
    // no qualifying rows of either kind, proving the flag alone is inert.
    mockRoles([]);
    mockPortal({ type: "none" });

    expect(await getPostLoginRedirectPath("user-1")).toBe("/account");
  });

  it("portal-only user (linked client, no workspace role) routes to the portal", async () => {
    mockRoles([]);
    mockPortal({ type: "single", path: "/portal/dance-studio?client=client-2" });

    expect(await getPostLoginRedirectPath("user-1")).toBe(
      "/portal/dance-studio?client=client-2",
    );
  });

  it("ordinary dancer/account holder with no workspace and no portal link routes to /account", async () => {
    mockRoles([]);
    mockPortal({ type: "none" });

    expect(await getPostLoginRedirectPath("user-1")).toBe("/account");
  });

  it("multiple active workspaces route to /app (destination only -- which studio is out of scope)", async () => {
    mockRoles([activeRole("studio_owner", "studio-1"), activeRole("instructor", "studio-2")]);
    mockPortal({ type: "none" });

    const result = await getPostLoginRedirectPath("user-1");

    expect(result).toBe("/app");
  });

  it("platform-admin-only user with no operational workspace routes to /account (current, unchanged behavior)", async () => {
    // hasActiveWorkspaceRole has no platform_admin special-case today, and
    // this fix does not add one -- a platform-admin user with zero
    // user_studio_roles/organizer_users rows surfaces as zero roles here,
    // same as before this fix. Documented explicitly so a future change to
    // this behavior is a deliberate decision, not an accidental regression.
    mockRoles([]);
    mockPortal({ type: "none" });

    expect(await getPostLoginRedirectPath("user-1")).toBe("/account");
  });

  it("an active workspace role takes priority over an also-linked portal (priority order preserved)", async () => {
    mockRoles([activeRole("studio_owner")]);
    mockPortal({ type: "single", path: "/portal/dance-studio?client=client-3" });

    const result = await getPostLoginRedirectPath("user-1");

    expect(result).toBe("/app");
    expect(decidePortalDestinationMock).not.toHaveBeenCalled();
  });

  it("multiple linked portal studios with no active workspace routes to the portal chooser", async () => {
    mockRoles([]);
    mockPortal({ type: "multiple" });

    expect(await getPostLoginRedirectPath("user-1")).toBe("/portal/choose");
  });
});
