import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * FC-1B5A: createClientAction, updateClientAction, and archiveClientAction
 * previously acquired their Supabase context via a local, unguarded
 * getCurrentUserStudioContext() helper with no permission check at all --
 * relying entirely on RLS as the only authorization boundary. RLS already
 * blocked independent_instructor/organizer roles from the actual INSERT/
 * UPDATE, but the missing app-level guard meant unauthorized roles could
 * still reach and execute the duplicate-email existence-check query (a
 * bounded oracle), and any authorized-role RLS change would have been the
 * only remaining protection.
 *
 * The fix wires all three actions through the existing, already-used-
 * elsewhere requireClientEditAccess() (src/lib/auth/serverRoleGuard.ts,
 * built on canEditClients). This suite mocks that guard entry point
 * directly -- exactly mirroring the established convention in
 * independentInstructorFloorRental.test.ts -- rather than re-deriving
 * canEditClients' own role semantics, which are already covered by
 * permissions.independentInstructor.test.ts and
 * serverRoleGuard.independentInstructor.test.ts.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest =
      `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

const requireClientEditAccessMock = vi.fn();

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireClientEditAccess: (...args: unknown[]) =>
    requireClientEditAccessMock(...args),
}));

const {
  createClientAction,
  updateClientAction,
  archiveClientAction,
} = await import("../actions");

const DENIAL_MESSAGE = "You do not have permission to manage clients.";

function digestUrl(error: unknown) {
  const digest = (error as { digest?: string })?.digest ?? "";
  const match = digest.match(/^NEXT_REDIRECT;replace;([^;]*);/);
  return match?.[1] ?? "";
}

async function runRedirectingAction(promise: Promise<unknown>) {
  return promise.catch((e) => e);
}

function minimalClientFormData() {
  const formData = new FormData();
  formData.set("firstName", "Jane");
  formData.set("lastName", "Doe");
  return formData;
}

/** Fake Supabase client whose only expected call is a single successful
 * clients.insert(); any other table access fails the test loudly. */
function makeSuccessfulCreateSupabase() {
  const fromCalls: string[] = [];
  return {
    fromCalls,
    from(table: string) {
      fromCalls.push(table);
      if (table === "clients") {
        return {
          insert: async () => ({ error: null }),
        };
      }
      throw new Error(`UNEXPECTED_TABLE_ACCESS:${table}`);
    },
  };
}

function makeSuccessfulUpdateSupabase() {
  const fromCalls: string[] = [];
  return {
    fromCalls,
    from(table: string) {
      fromCalls.push(table);
      if (table === "clients") {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      single: async () => ({
                        data: { id: "client-1" },
                        error: null,
                      }),
                    };
                  },
                };
              },
            };
          },
          update() {
            return {
              eq() {
                return {
                  eq: async () => ({ error: null }),
                };
              },
            };
          },
        };
      }
      throw new Error(`UNEXPECTED_TABLE_ACCESS:${table}`);
    },
  };
}

function makeSuccessfulArchiveSupabase() {
  const fromCalls: string[] = [];
  return {
    fromCalls,
    from(table: string) {
      fromCalls.push(table);
      if (table === "clients") {
        return {
          update() {
            return {
              eq() {
                return {
                  eq: async () => ({ error: null }),
                };
              },
            };
          },
        };
      }
      throw new Error(`UNEXPECTED_TABLE_ACCESS:${table}`);
    },
  };
}

const DENIED_ROLES = [
  "instructor",
  "independent_instructor",
  "organizer_owner",
  "organizer_admin",
  "organizer_staff",
];

beforeEach(() => {
  requireClientEditAccessMock.mockReset();
});

describe("createClientAction authorization (FC-1B5A)", () => {
  it.each(["studio_owner", "studio_admin", "front_desk"])(
    "%s reaches the authorized create path",
    async (role) => {
      const fakeSupabase = makeSuccessfulCreateSupabase();
      requireClientEditAccessMock.mockResolvedValue({
        supabase: fakeSupabase,
        studioId: "studio-1",
        user: { id: "user-1" },
        studioRole: role,
        isPlatformAdmin: false,
      });

      const result = await runRedirectingAction(
        createClientAction({ error: "" }, minimalClientFormData()),
      );

      expect(fakeSupabase.fromCalls).toEqual(["clients"]);
      expect(digestUrl(result)).toMatch(/^\/app\/clients\//);
    },
  );

  it.each(DENIED_ROLES)(
    "%s is denied before any client-table query",
    async () => {
      requireClientEditAccessMock.mockImplementation(() => {
        throw new Error(DENIAL_MESSAGE);
      });

      const result = await createClientAction(
        { error: "" },
        minimalClientFormData(),
      );

      expect(result).toEqual({ error: DENIAL_MESSAGE });
      expect(requireClientEditAccessMock).toHaveBeenCalledTimes(1);
    },
  );

  it("platform admin override behavior is preserved", async () => {
    const fakeSupabase = makeSuccessfulCreateSupabase();
    requireClientEditAccessMock.mockResolvedValue({
      supabase: fakeSupabase,
      studioId: "studio-1",
      user: { id: "platform-admin-1" },
      studioRole: "independent_instructor",
      isPlatformAdmin: true,
    });

    const result = await runRedirectingAction(
      createClientAction({ error: "" }, minimalClientFormData()),
    );

    expect(fakeSupabase.fromCalls).toEqual(["clients"]);
    expect(digestUrl(result)).toMatch(/^\/app\/clients\//);
  });

  it("unauthenticated caller is denied with no client-table query (session-expired boundary)", async () => {
    requireClientEditAccessMock.mockImplementation(() => {
      throw new Error("You must be logged in.");
    });

    const result = await createClientAction(
      { error: "" },
      minimalClientFormData(),
    );

    expect(result).toEqual({ error: "You must be logged in." });
  });

  it("direct invocation (no page/UI involved) still enforces the guard", async () => {
    requireClientEditAccessMock.mockImplementation(() => {
      throw new Error(DENIAL_MESSAGE);
    });

    const formData = minimalClientFormData();
    formData.set("email", "attacker-controlled@example.test");

    const result = await createClientAction({ error: "" }, formData);

    expect(result).toEqual({ error: DENIAL_MESSAGE });
  });
});

describe("updateClientAction authorization (FC-1B5A)", () => {
  function updateFormData() {
    const formData = minimalClientFormData();
    formData.set("clientId", "11111111-1111-4111-8111-111111111111");
    return formData;
  }

  it.each(["studio_owner", "studio_admin", "front_desk"])(
    "%s reaches the authorized update path",
    async (role) => {
      const fakeSupabase = makeSuccessfulUpdateSupabase();
      requireClientEditAccessMock.mockResolvedValue({
        supabase: fakeSupabase,
        studioId: "studio-1",
        user: { id: "user-1" },
        studioRole: role,
        isPlatformAdmin: false,
      });

      const result = await runRedirectingAction(
        updateClientAction({ error: "" }, updateFormData()),
      );

      expect(fakeSupabase.fromCalls[0]).toBe("clients");
      expect(digestUrl(result)).toMatch(/^\/app\/clients\//);
    },
  );

  it.each(DENIED_ROLES)(
    "%s is denied before any client-table query",
    async () => {
      requireClientEditAccessMock.mockImplementation(() => {
        throw new Error(DENIAL_MESSAGE);
      });

      const result = await updateClientAction(
        { error: "" },
        updateFormData(),
      );

      expect(result).toEqual({ error: DENIAL_MESSAGE });
      expect(requireClientEditAccessMock).toHaveBeenCalledTimes(1);
    },
  );
});

describe("archiveClientAction authorization (FC-1B5A)", () => {
  function archiveFormData() {
    const formData = new FormData();
    formData.set("clientId", "11111111-1111-4111-8111-111111111111");
    formData.set("returnTo", "/app/clients");
    return formData;
  }

  it("studio_owner reaches the authorized archive path", async () => {
    const fakeSupabase = makeSuccessfulArchiveSupabase();
    requireClientEditAccessMock.mockResolvedValue({
      supabase: fakeSupabase,
      studioId: "studio-1",
      user: { id: "user-1" },
      studioRole: "studio_owner",
      isPlatformAdmin: false,
    });

    const result = await runRedirectingAction(
      archiveClientAction(archiveFormData()),
    );

    expect(fakeSupabase.fromCalls).toEqual(["clients"]);
    expect(digestUrl(result)).toBe("/app/clients?success=client_archived");
  });

  it.each(DENIED_ROLES)(
    "%s is redirected with an unauthorized error before any client-table query",
    async () => {
      requireClientEditAccessMock.mockImplementation(() => {
        throw new Error(DENIAL_MESSAGE);
      });

      const result = await runRedirectingAction(
        archiveClientAction(archiveFormData()),
      );

      expect(digestUrl(result)).toBe("/app/clients?error=unauthorized");
      expect(requireClientEditAccessMock).toHaveBeenCalledTimes(1);
    },
  );
});
