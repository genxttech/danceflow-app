import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Landmark 1A Slice 8: upsertTeamMemberRoleAction writes through the
 * service-role client and previously did not guard owner targets, so an owner
 * (or the owner acting on themselves) could overwrite an owner row with
 * admin/front_desk/instructor. There is no supported ownership-transfer flow,
 * and demoting an owner who is also a capable instructor turns a free seat
 * into a counted one. The DB seat gate enforces the seat rule regardless;
 * this proves the action now refuses owner targets before any write.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const getCurrentStudioContextMock = vi.fn();
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: (...args: unknown[]) => getCurrentStudioContextMock(...args),
}));
vi.mock("@/lib/billing/access", () => ({
  getCurrentWorkspaceCapabilitiesForUser: async () => ({ studioId: "studio-1", planCode: "pro" }),
  canAssignRoleUnderPlan: () => true,
}));

let existingMembership: { user_id: string; role: string; active: boolean } | null = null;
const adminUpsertMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "actor-1", email: "actor@example.test" } } }) },
    from(table: string) {
      if (table !== "user_studio_roles") throw new Error(`UNEXPECTED_TABLE_ACCESS:${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: async () => ({ data: [], error: null }),
              maybeSingle: async () => ({ data: existingMembership, error: null }),
            }),
          }),
        }),
      };
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      if (table !== "user_studio_roles") throw new Error(`UNEXPECTED_ADMIN_TABLE_ACCESS:${table}`);
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

function redirectUrl(error: unknown) {
  const digest = (error as { digest?: string })?.digest ?? "";
  return decodeURIComponent((digest.match(/^NEXT_REDIRECT;replace;([^;]*);/)?.[1] ?? "").replace(/\+/g, " "));
}

function form(targetRole: string, targetUserId = "target-user-1") {
  const fd = new FormData();
  fd.set("targetUserId", targetUserId);
  fd.set("targetRole", targetRole);
  return fd;
}

beforeEach(() => {
  adminUpsertMock.mockReset();
  existingMembership = null;
  getCurrentStudioContextMock.mockResolvedValue({
    studioId: "studio-1",
    studioRole: "studio_owner",
    isPlatformAdmin: false,
    userId: "actor-1",
    email: "actor@example.test",
  });
});

describe("upsertTeamMemberRoleAction -- owner targets (Slice 8)", () => {
  for (const targetRole of ["studio_admin", "front_desk", "instructor"]) {
    it(`refuses to demote an existing studio owner to ${targetRole} and never writes`, async () => {
      existingMembership = { user_id: "owner-2", role: "studio_owner", active: true };

      const error = await upsertTeamMemberRoleAction(form(targetRole, "owner-2")).catch((e) => e);

      expect(redirectUrl(error)).toContain("Owner access can't be changed here.");
      expect(adminUpsertMock).not.toHaveBeenCalled();
    });
  }

  it("refuses when the owner targets themselves", async () => {
    existingMembership = { user_id: "actor-1", role: "studio_owner", active: true };

    const error = await upsertTeamMemberRoleAction(form("studio_admin", "actor-1")).catch((e) => e);

    expect(redirectUrl(error)).toContain("Owner access can't be changed here.");
    expect(adminUpsertMock).not.toHaveBeenCalled();
  });

  it("still assigns a role to a non-owner member", async () => {
    existingMembership = { user_id: "member-1", role: "front_desk", active: true };

    const error = await upsertTeamMemberRoleAction(form("instructor", "member-1")).catch((e) => e);

    expect(redirectUrl(error)).toContain("success");
    expect(adminUpsertMock).toHaveBeenCalledTimes(1);
    expect(adminUpsertMock.mock.calls[0][0]).toMatchObject({
      studio_id: "studio-1",
      user_id: "member-1",
      role: "instructor",
    });
  });

  it("still assigns a role to a brand-new member (no existing membership)", async () => {
    existingMembership = null;

    const error = await upsertTeamMemberRoleAction(form("front_desk", "new-user")).catch((e) => e);

    expect(redirectUrl(error)).toContain("success");
    expect(adminUpsertMock).toHaveBeenCalledTimes(1);
  });
});
