import { describe, expect, it } from "vitest";

import {
  canCreateAppointments,
  canEditAppointments,
  canManageOwnFloorRentalAppointment,
  canMarkAttendance,
  canViewClients,
  canViewStudioSchedule,
} from "@/lib/auth/permissions";

/**
 * FC-1: SR-A found independent_instructor granted broad appointment
 * create/edit/attendance authority identical to real studio staff, with
 * the intended narrowing (their own floor-rental relationship only)
 * enforced in just one code path. This suite proves the central fix at
 * the permission-function level: independent_instructor no longer passes
 * the general staff gates, and the narrow replacement identifies only
 * that role (the actual "is this their own relationship" check is a
 * separate, data-layer concern -- see
 * independentInstructorFloorRental.test.ts for that).
 *
 * FC-1B1: extends the same pattern to canViewClients (narrowed -- this
 * role is not host-studio staff) and canViewStudioSchedule (new -- gates
 * the general staff schedule-viewing surface). See
 * independentInstructorScheduleLockdown.test.ts, independentInstructor
 * ClientsLockdown.test.ts, and independentInstructorExpensesLockdown.test.ts
 * for the page/action-level enforcement these functions now drive.
 */

const STAFF_ROLES = [
  "platform_admin",
  "studio_owner",
  "studio_admin",
  "front_desk",
  "instructor",
];

describe("canCreateAppointments / canEditAppointments / canMarkAttendance -- FC-1", () => {
  it.each(STAFF_ROLES)("staff role %s is unaffected by the FC-1 change", (role) => {
    expect(canCreateAppointments(role)).toBe(true);
    expect(canEditAppointments(role)).toBe(true);
    expect(canMarkAttendance(role)).toBe(true);
  });

  it("independent_instructor no longer has general appointment-create authority", () => {
    expect(canCreateAppointments("independent_instructor")).toBe(false);
  });

  it("independent_instructor no longer has general appointment-edit authority", () => {
    expect(canEditAppointments("independent_instructor")).toBe(false);
  });

  it("independent_instructor no longer has any attendance-marking authority (no legitimate use case exists for this role)", () => {
    expect(canMarkAttendance("independent_instructor")).toBe(false);
  });

  it("null/unknown roles remain denied", () => {
    expect(canCreateAppointments(null)).toBe(false);
    expect(canEditAppointments(undefined)).toBe(false);
    expect(canMarkAttendance("client")).toBe(false);
  });
});

describe("canManageOwnFloorRentalAppointment -- FC-1 narrow replacement", () => {
  it("identifies only independent_instructor", () => {
    expect(canManageOwnFloorRentalAppointment("independent_instructor")).toBe(true);
  });

  it.each([...STAFF_ROLES, "organizer_owner", "organizer_staff", "client", null, undefined])(
    "does not identify %s",
    (role) => {
      expect(canManageOwnFloorRentalAppointment(role)).toBe(false);
    },
  );
});

describe("canViewClients -- FC-1B1 / FC-1B5D", () => {
  it.each(["platform_admin", "studio_owner", "studio_admin", "front_desk"])(
    "CRM-tier role %s is unaffected",
    (role) => {
      expect(canViewClients(role)).toBe(true);
    },
  );

  // FC-1B5D: instructor is no longer a general CRM role -- superseded by
  // the relationship-scoped get_teaching_clients_for_instructor /
  // search_bookable_clients_for_instructor RPCs. See
  // permissions.fc1b5d.test.ts for the full FC-1B5D suite.
  it("instructor no longer has general client-roster visibility (FC-1B5D)", () => {
    expect(canViewClients("instructor")).toBe(false);
  });

  it("independent_instructor no longer has general client-roster visibility", () => {
    expect(canViewClients("independent_instructor")).toBe(false);
  });

  it("null/unknown roles remain denied", () => {
    expect(canViewClients(null)).toBe(false);
    expect(canViewClients(undefined)).toBe(false);
  });
});

describe("canViewStudioSchedule -- FC-1B1 new function", () => {
  it.each(STAFF_ROLES)("staff role %s can view the general studio schedule", (role) => {
    expect(canViewStudioSchedule(role)).toBe(true);
  });

  it("independent_instructor cannot view the general studio schedule", () => {
    expect(canViewStudioSchedule("independent_instructor")).toBe(false);
  });

  it("null/unknown roles remain denied", () => {
    expect(canViewStudioSchedule(null)).toBe(false);
    expect(canViewStudioSchedule("client")).toBe(false);
  });
});
