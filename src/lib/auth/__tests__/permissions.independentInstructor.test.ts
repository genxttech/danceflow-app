import { describe, expect, it } from "vitest";

import {
  canCreateAppointments,
  canEditAppointments,
  canManageOwnFloorRentalAppointment,
  canMarkAttendance,
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
