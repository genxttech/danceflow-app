import { describe, expect, it, vi } from "vitest";

/**
 * FC-1: proves the actual guard entry points an appointment/attendance
 * server action calls -- not just the underlying pure permission
 * functions (see permissions.independentInstructor.test.ts for those) --
 * correctly reject independent_instructor for general appointment/
 * attendance access, and correctly admit both ordinary staff and
 * independent_instructor to the new, narrow floor-rental-only guard.
 *
 * getCurrentUserStudioContext's own dependencies (@/lib/supabase/server,
 * @/lib/auth/studio) are mocked here since this suite's job is the guard
 * wiring (does requireAttendanceAccess really end up gated by
 * canMarkAttendance for a real resolved role), not studio-context
 * resolution itself, which is exercised elsewhere in this codebase.
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

const {
  requireAppointmentCreateAccess,
  requireAppointmentEditAccess,
  requireAttendanceAccess,
  requireFloorRentalAppointmentAccess,
} = await import("@/lib/auth/serverRoleGuard");

function mockSession(studioRole: string) {
  getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
  getCurrentStudioContextMock.mockResolvedValue({
    studioId: "studio-1",
    studioRole,
    isPlatformAdmin: false,
  });
}

describe("requireAttendanceAccess / requireAppointmentCreateAccess / requireAppointmentEditAccess -- FC-1", () => {
  it("independent_instructor is rejected by requireAttendanceAccess (no legitimate attendance use case exists)", async () => {
    mockSession("independent_instructor");
    await expect(requireAttendanceAccess()).rejects.toThrow(
      "You do not have permission to mark attendance.",
    );
  });

  it("independent_instructor is rejected by requireAppointmentCreateAccess (general staff gate)", async () => {
    mockSession("independent_instructor");
    await expect(requireAppointmentCreateAccess()).rejects.toThrow(
      "You do not have permission to create appointments.",
    );
  });

  it("independent_instructor is rejected by requireAppointmentEditAccess (general staff gate)", async () => {
    mockSession("independent_instructor");
    await expect(requireAppointmentEditAccess()).rejects.toThrow(
      "You do not have permission to edit appointments.",
    );
  });

  it("studio_owner is unaffected -- still passes all three general guards", async () => {
    mockSession("studio_owner");
    await expect(requireAttendanceAccess()).resolves.toMatchObject({
      studioId: "studio-1",
    });
    mockSession("studio_owner");
    await expect(requireAppointmentCreateAccess()).resolves.toMatchObject({
      studioId: "studio-1",
    });
    mockSession("studio_owner");
    await expect(requireAppointmentEditAccess()).resolves.toMatchObject({
      studioId: "studio-1",
    });
  });
});

describe("requireFloorRentalAppointmentAccess -- FC-1 narrow replacement guard", () => {
  it("admits independent_instructor (role-level only -- the caller must still verify the specific target is their own)", async () => {
    mockSession("independent_instructor");
    await expect(requireFloorRentalAppointmentAccess()).resolves.toMatchObject({
      studioId: "studio-1",
      studioRole: "independent_instructor",
    });
  });

  it.each(["studio_owner", "studio_admin", "front_desk", "instructor"])(
    "admits staff role %s",
    async (role) => {
      mockSession(role);
      await expect(requireFloorRentalAppointmentAccess()).resolves.toMatchObject({
        studioId: "studio-1",
        studioRole: role,
      });
    },
  );

  it("rejects a role with no appointment authority at all", async () => {
    mockSession("organizer_staff");
    await expect(requireFloorRentalAppointmentAccess()).rejects.toThrow(
      "You do not have permission to manage this appointment.",
    );
  });
});
