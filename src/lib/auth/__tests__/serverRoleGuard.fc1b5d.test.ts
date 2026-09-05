import { describe, expect, it, vi } from "vitest";

/**
 * FC-1B5D: proves the new requireClientViewAccess() guard entry point --
 * mirrors serverRoleGuard.independentInstructor.test.ts's mocking approach.
 */

const getUserMock = vi.fn();
const getCurrentStudioContextMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: (...args: unknown[]) => getUserMock(...args),
    },
  }),
}));

vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: (...args: unknown[]) =>
    getCurrentStudioContextMock(...args),
}));

const { requireClientViewAccess } = await import("@/lib/auth/serverRoleGuard");

function mockSession(studioRole: string, isPlatformAdmin = false) {
  getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
  getCurrentStudioContextMock.mockResolvedValue({
    studioId: "studio-1",
    studioRole,
    isPlatformAdmin,
  });
}

describe("requireClientViewAccess -- FC-1B5D", () => {
  it.each(["studio_owner", "studio_admin", "front_desk"])(
    "CRM-tier role %s is admitted",
    async (role) => {
      mockSession(role);
      await expect(requireClientViewAccess()).resolves.toMatchObject({
        studioRole: role,
      });
    },
  );

  it("platform_admin bypasses the role check entirely", async () => {
    mockSession("organizer_owner", true);
    await expect(requireClientViewAccess()).resolves.toBeDefined();
  });

  it("instructor is rejected (superseded by the relationship-scoped RPCs, not this guard)", async () => {
    mockSession("instructor");
    await expect(requireClientViewAccess()).rejects.toThrow(
      "You do not have permission to view clients.",
    );
  });

  it("independent_instructor is rejected", async () => {
    mockSession("independent_instructor");
    await expect(requireClientViewAccess()).rejects.toThrow(
      "You do not have permission to view clients.",
    );
  });
});
