import { describe, expect, it } from "vitest";
import {
  getPostAuthDestination,
  pickPreferredWorkspace,
  sortByCreatedAtAscending,
} from "../route";

/**
 * FC-1B5C: callback previously determined /app eligibility and workspace
 * selection via a local getActiveStudioRoles() query that only read
 * user_studio_roles -- a pure organizer_users relationship (no matching
 * user_studio_roles row) was invisible to it, the same class of bug
 * FC-1B5B fixed for password login.
 *
 * The fix replaces that query with the shared getAccessibleStudioRolesForUser
 * (src/lib/auth/studio.ts), which already merges active user_studio_roles
 * and active organizer_users. Since that helper doesn't return created_at
 * ordering the way callback's own query did, callback now re-sorts its own
 * copy by created_at ascending (sortByCreatedAtAscending) to preserve its
 * exact existing selection behavior. Organizer-intent selection now also
 * recognizes genuine organizer_users-sourced rows via isOrganizerRole,
 * while the legacy studio-name heuristic (isOrganizerWorkspaceName) is
 * preserved completely unchanged, not widened to studio.ts's broader
 * "festival"/"event" matching.
 *
 * This suite tests the routing/selection decision functions directly
 * (exported from route.ts purely for testability, mirroring the FC-1B5B
 * convention), rather than the GET handler itself -- the OAuth exchange
 * machinery is unrelated to what changed here.
 */

type RoleFixture = ReturnType<typeof buildRole>;

function buildRole(overrides: {
  studio_id?: string;
  role?: string;
  active?: boolean;
  created_at?: string;
  studioName?: string | null;
}) {
  const studioId = overrides.studio_id ?? "studio-1";
  return {
    studio_id: studioId,
    role: overrides.role ?? "studio_owner",
    active: overrides.active ?? true,
    created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
    studios:
      overrides.studioName === null
        ? null
        : {
            id: studioId,
            name: overrides.studioName ?? "Test Studio",
            slug: null,
            public_name: null,
          },
  };
}

function resolveDestination(params: {
  roles: RoleFixture[];
  requestedNextPath?: string | null;
  fallbackNextPath?: string | null;
  portalPath?: string | null;
}) {
  const {
    roles,
    requestedNextPath = null,
    fallbackNextPath = null,
    portalPath = null,
  } = params;

  const sorted = sortByCreatedAtAscending(roles);
  const selectedWorkspace = pickPreferredWorkspace({
    roles: sorted,
    requestedNextPath,
    fallbackNextPath,
  });

  return {
    destination: getPostAuthDestination({
      requestedNextPath,
      fallbackNextPath,
      selectedWorkspace,
      portalPath,
    }),
    selectedWorkspace,
  };
}

describe("callback workspace routing -- active roles reach /app (FC-1B5C)", () => {
  it.each([
    "studio_owner",
    "studio_admin",
    "front_desk",
    "instructor",
    "independent_instructor",
  ])("active %s (via user_studio_roles) routes to /app", (role) => {
    const { destination } = resolveDestination({
      roles: [buildRole({ role })],
    });

    expect(destination).toBe("/app");
  });

  it.each(["organizer_owner", "organizer_admin", "organizer_staff"])(
    "%s reachable only via a pure organizer_users relationship routes to /app",
    (role) => {
      // Simulates a row that getAccessibleStudioRolesForUser merged in from
      // organizer_users alone -- no matching user_studio_roles row exists,
      // and the role string already comes back correct with no heuristic
      // needed. This is the core FC-1B5C fix: previously invisible to
      // callback entirely.
      const { destination } = resolveDestination({
        roles: [buildRole({ role, studioName: "Acme Dance Company" })],
      });

      expect(destination).toBe("/app");
    },
  );
});

describe("callback workspace routing -- non-workspace fallbacks unchanged (FC-1B5C)", () => {
  it("inactive-only relationships (surfaced as zero roles) with no portal route to /account", () => {
    const { destination } = resolveDestination({ roles: [] });

    expect(destination).toBe("/account");
  });

  it("portal-only user (zero workspace roles, linked portal) routes to the portal", () => {
    const { destination } = resolveDestination({
      roles: [],
      portalPath: "/portal/dance-studio?client=client-1",
    });

    expect(destination).toBe("/portal/dance-studio?client=client-1");
  });

  it("ordinary dancer/account holder (zero roles, no portal) routes to /account", () => {
    const { destination } = resolveDestination({ roles: [] });

    expect(destination).toBe("/account");
  });

  it("clients.is_independent_instructor=true alone does not qualify (never consulted by these functions)", () => {
    // The client-side flag is never read by getAccessibleStudioRolesForUser,
    // pickPreferredWorkspace, or getPostAuthDestination -- a user whose only
    // signal is that flag surfaces identically to an ordinary dancer here:
    // zero roles.
    const { destination } = resolveDestination({ roles: [] });

    expect(destination).toBe("/account");
  });
});

describe("callback workspace selection -- created_at ordering preserved (FC-1B5C)", () => {
  it("multiple ordinary workspaces select the earliest-created_at row, regardless of input array order", () => {
    const earlier = buildRole({
      studio_id: "studio-earlier",
      created_at: "2025-01-01T00:00:00.000Z",
    });
    const later = buildRole({
      studio_id: "studio-later",
      created_at: "2026-01-01T00:00:00.000Z",
    });

    // Deliberately passed in reverse (later before earlier) -- input order
    // must not matter; only created_at ordering should.
    const { destination, selectedWorkspace } = resolveDestination({
      roles: [later, earlier],
    });

    expect(destination).toBe("/app");
    expect(selectedWorkspace?.studio_id).toBe("studio-earlier");
  });

  it("the selected workspace's studio_id is what the (unchanged) cookie-setting call in GET persists", () => {
    // GET sets APP_SELECTED_STUDIO_COOKIE to selectedWorkspace.studio_id
    // unconditionally and unchanged by this fix -- this asserts the value
    // that call site would receive is correct.
    const { selectedWorkspace } = resolveDestination({
      roles: [buildRole({ studio_id: "studio-xyz" })],
    });

    expect(selectedWorkspace?.studio_id).toBe("studio-xyz");
  });
});

describe("callback organizer-intent selection (FC-1B5C)", () => {
  it("prefers a genuine organizer_users-sourced role over an earlier-created ordinary workspace", () => {
    const ordinaryFirst = buildRole({
      studio_id: "studio-ordinary",
      role: "studio_owner",
      created_at: "2025-01-01T00:00:00.000Z",
      studioName: "Regular Studio",
    });
    const organizerLater = buildRole({
      studio_id: "studio-organizer",
      role: "organizer_owner",
      created_at: "2026-01-01T00:00:00.000Z",
      studioName: "Some Organizer Co",
    });

    const { selectedWorkspace } = resolveDestination({
      roles: [ordinaryFirst, organizerLater],
      requestedNextPath: "/get-started/complete?intent=organizer",
    });

    expect(selectedWorkspace?.studio_id).toBe("studio-organizer");
  });

  it("preserves the legacy studio-name heuristic exactly for non-organizer-role rows", () => {
    const ordinaryFirst = buildRole({
      studio_id: "studio-ordinary",
      created_at: "2025-01-01T00:00:00.000Z",
      studioName: "Regular Studio",
    });
    // Matches callback's existing isOrganizerWorkspaceName (" organizer"
    // suffix) even though its role is plain studio_owner, not organizer_*.
    const legacyOrganizerNamed = buildRole({
      studio_id: "studio-legacy-organizer",
      role: "studio_owner",
      created_at: "2026-01-01T00:00:00.000Z",
      studioName: "Acme Dance Organizer",
    });

    const { selectedWorkspace } = resolveDestination({
      roles: [ordinaryFirst, legacyOrganizerNamed],
      requestedNextPath: "/get-started/complete?intent=organizer",
    });

    expect(selectedWorkspace?.studio_id).toBe("studio-legacy-organizer");
  });

  it("does NOT newly prefer a studio-name match that only satisfies studio.ts's broader heuristic (festival/singular event)", () => {
    const ordinaryFirst = buildRole({
      studio_id: "studio-ordinary",
      created_at: "2025-01-01T00:00:00.000Z",
      studioName: "Regular Studio",
    });
    // "Spring Festival" matches studio.ts's workspaceLooksLikeOrganizer
    // (includes "festival") but NOT callback's own, deliberately-unwidened
    // isOrganizerWorkspaceName (only " organizer"/" organizer "/" events").
    // Its role is plain studio_owner, not organizer_*, so isOrganizerRole
    // doesn't match it either.
    const festivalNamed = buildRole({
      studio_id: "studio-festival",
      role: "studio_owner",
      created_at: "2026-01-01T00:00:00.000Z",
      studioName: "Spring Festival",
    });

    const { selectedWorkspace } = resolveDestination({
      roles: [ordinaryFirst, festivalNamed],
      requestedNextPath: "/get-started/complete?intent=organizer",
    });

    // Organizer-intent found no match, so it falls through to the default
    // created_at-ascending pick -- NOT the festival-named row.
    expect(selectedWorkspace?.studio_id).toBe("studio-ordinary");
  });
});

describe("callback and password login agree on workspace-existence semantics (FC-1B5C)", () => {
  it.each([
    ["zero roles", [] as RoleFixture[]],
    ["at least one active role", [buildRole({})]],
  ])(
    "roles.length > 0 (password login's existence check) matches pickPreferredWorkspace's non-null verdict -- %s",
    (_label, roles) => {
      const passwordLoginExistenceCheck = roles.length > 0;
      const callbackSelectedWorkspace = pickPreferredWorkspace({
        roles: sortByCreatedAtAscending(roles),
        requestedNextPath: null,
        fallbackNextPath: null,
      });

      expect(passwordLoginExistenceCheck).toBe(callbackSelectedWorkspace !== null);
    },
  );
});
