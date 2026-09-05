import { describe, expect, it } from "vitest";

import { canViewClients } from "@/lib/auth/permissions";

/**
 * FC-1B5D: client PII SELECT containment. instructor loses general CRM
 * client-roster visibility -- their access is now relationship-scoped via
 * get_teaching_clients_for_instructor / search_bookable_clients_for_instructor
 * (SECURITY DEFINER RPCs, not gated by this function at all). See
 * permissions.independentInstructor.test.ts for the full canViewClients
 * suite (updated alongside this change) and
 * userStudioRolesInsertGuard.test.ts for the P0 precedent this design
 * follows.
 */
describe("canViewClients -- FC-1B5D CRM tier", () => {
  const CRM_TIER_ROLES = ["platform_admin", "studio_owner", "studio_admin", "front_desk"];
  const NON_CRM_ROLES = ["instructor", "independent_instructor", "organizer_owner", "organizer_admin"];

  it.each(CRM_TIER_ROLES)("CRM-tier role %s retains full client-roster visibility", (role) => {
    expect(canViewClients(role)).toBe(true);
  });

  it.each(NON_CRM_ROLES)("non-CRM role %s has no general client-roster visibility", (role) => {
    expect(canViewClients(role)).toBe(false);
  });
});
