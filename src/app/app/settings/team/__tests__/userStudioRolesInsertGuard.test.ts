import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * FC-1B5 P0: user_studio_roles had an authenticated INSERT policy with
 * WITH CHECK (true) -- any authenticated user could insert an arbitrary
 * role for themselves or anyone else, at any studio. The only application
 * path that depended on that policy was upsertTeamMemberRoleAction's
 * direct `.from("user_studio_roles").upsert(...)` via the RLS-enforced
 * client. The fix drops the policy entirely (see migration
 * 20260904150000_user_studio_roles_insert_guard.sql) and this action now
 * performs that write through the service-role client instead, after the
 * exact same authorization chain it already had (actorIsOwner ->
 * parseRole/ASSIGNABLE_ROLES -> roleFitsWorkspaceType ->
 * canAssignTargetRole -> assertPlanAllowsRole).
 *
 * This suite proves two things: (1) the write now goes through
 * createAdminClient(), never the RLS-scoped client, and (2) every existing
 * denial branch still fires BEFORE that write is ever attempted -- the
 * admin client's upsert must not be called when any check fails.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest =
      `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const getCurrentStudioContextMock = vi.fn();
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: (...args: unknown[]) =>
    getCurrentStudioContextMock(...args),
}));

const getCurrentWorkspaceCapabilitiesForUserMock = vi.fn();
const canAssignRoleUnderPlanMock = vi.fn();
vi.mock("@/lib/billing/access", () => ({
  getCurrentWorkspaceCapabilitiesForUser: (...args: unknown[]) =>
    getCurrentWorkspaceCapabilitiesForUserMock(...args),
  canAssignRoleUnderPlan: (...args: unknown[]) =>
    canAssignRoleUnderPlanMock(...args),
}));

const regularUpsertMock = vi.fn();
const adminUpsertMock = vi.fn();

function makeRegularSupabase() {
  return {
    auth: {
      getUser: async () => ({
        data: { user: { id: "actor-1", email: "actor@example.test" } },
      }),
    },
    from(table: string) {
      if (table !== "user_studio_roles") {
        throw new Error(`UNEXPECTED_TABLE_ACCESS:${table}`);
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: async () => ({ data: [], error: null }), // countAssignedRole
              maybeSingle: async () => ({ data: null, error: null }), // getExistingMembership
            }),
          }),
        }),
        upsert: (...args: unknown[]) => {
          regularUpsertMock(...args);
          return { error: null };
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => makeRegularSupabase(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      if (table !== "user_studio_roles") {
        throw new Error(`UNEXPECTED_ADMIN_TABLE_ACCESS:${table}`);
      }
      return {
        upsert: (...args: unknown[]) => {
          adminUpsertMock(...args);
          return Promise.resolve({ error: null });
        },
      };
    },
  }),
}));

const { upsertTeamMemberRoleAction } = await import("../actions");

function digestUrl(error: unknown) {
  const digest = (error as { digest?: string })?.digest ?? "";
  const match = digest.match(/^NEXT_REDIRECT;replace;([^;]*);/);
  return match?.[1] ?? "";
}

async function run(formData: FormData) {
  return upsertTeamMemberRoleAction(formData).catch((e) => e);
}

function mockActor(role: string | null) {
  getCurrentStudioContextMock.mockResolvedValue({
    studioId: "studio-1",
    studioRole: role,
    isPlatformAdmin: false,
    userId: "actor-1",
    email: "actor@example.test",
  });
  getCurrentWorkspaceCapabilitiesForUserMock.mockResolvedValue({
    studioId: "studio-1",
    planCode: "pro",
  });
}

function teamFormData(targetRole: string, targetUserId = "target-user-1") {
  const formData = new FormData();
  formData.set("targetUserId", targetUserId);
  formData.set("targetRole", targetRole);
  return formData;
}

beforeEach(() => {
  regularUpsertMock.mockReset();
  adminUpsertMock.mockReset();
  getCurrentStudioContextMock.mockReset();
  getCurrentWorkspaceCapabilitiesForUserMock.mockReset();
  canAssignRoleUnderPlanMock.mockReset();
  canAssignRoleUnderPlanMock.mockReturnValue(true);
});

describe("upsertTeamMemberRoleAction (FC-1B5 P0)", () => {
  it("studio_owner assigning instructor to another user succeeds via the admin client, never the RLS-scoped one", async () => {
    mockActor("studio_owner");

    const result = await run(teamFormData("instructor"));

    expect(adminUpsertMock).toHaveBeenCalledTimes(1);
    expect(adminUpsertMock).toHaveBeenCalledWith(
      {
        studio_id: "studio-1",
        user_id: "target-user-1",
        role: "instructor",
        active: true,
      },
      { onConflict: "studio_id,user_id" },
    );
    expect(regularUpsertMock).not.toHaveBeenCalled();
    expect(digestUrl(result)).toContain("success=");
  });

  it("studio_owner assigning front_desk to another user succeeds via the admin client", async () => {
    mockActor("studio_owner");

    await run(teamFormData("front_desk"));

    expect(adminUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: "front_desk", user_id: "target-user-1" }),
      expect.anything(),
    );
    expect(regularUpsertMock).not.toHaveBeenCalled();
  });

  it("non-owner actor (front_desk) is denied before any write is attempted", async () => {
    mockActor("front_desk");

    const result = await run(teamFormData("instructor"));

    expect(digestUrl(result)).toContain("error=");
    expect(adminUpsertMock).not.toHaveBeenCalled();
    expect(regularUpsertMock).not.toHaveBeenCalled();
  });

  it("studio_owner cannot grant platform_admin -- rejected by parseRole before any write", async () => {
    mockActor("studio_owner");

    const result = await run(teamFormData("platform_admin"));

    expect(digestUrl(result)).toContain("error=");
    expect(adminUpsertMock).not.toHaveBeenCalled();
    expect(regularUpsertMock).not.toHaveBeenCalled();
  });

  it("studio_owner cannot grant studio_owner -- rejected by parseRole before any write", async () => {
    mockActor("studio_owner");

    const result = await run(teamFormData("studio_owner"));

    expect(digestUrl(result)).toContain("error=");
    expect(adminUpsertMock).not.toHaveBeenCalled();
  });

  it("studio_owner cannot grant independent_instructor via this action -- rejected before any write", async () => {
    mockActor("studio_owner");

    const result = await run(teamFormData("independent_instructor"));

    expect(digestUrl(result)).toContain("error=");
    expect(adminUpsertMock).not.toHaveBeenCalled();
  });

  it("organizer_owner cannot assign a studio-only role (instructor) -- workspace-type mismatch denied before any write", async () => {
    mockActor("organizer_owner");

    const result = await run(teamFormData("instructor"));

    expect(digestUrl(result)).toContain("error=");
    expect(adminUpsertMock).not.toHaveBeenCalled();
  });

  it("platform_admin can assign organizer_admin via the admin client", async () => {
    mockActor("platform_admin");

    await run(teamFormData("organizer_admin"));

    expect(adminUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: "organizer_admin" }),
      expect.anything(),
    );
    expect(regularUpsertMock).not.toHaveBeenCalled();
  });
});
