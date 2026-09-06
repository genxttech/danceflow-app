import { describe, expect, it } from "vitest";

import { canDeleteAppointments } from "@/lib/auth/permissions";

/**
 * FC-1B5D2 D2A (blocking-review correction): the independent review found
 * the Danger Zone delete affordance on src/app/app/schedule/[id]/page.tsx
 * was still gated by canEditAppointments (which includes "instructor"),
 * even after deleteAppointmentAction itself was narrowed to
 * canDeleteAppointments -- so an ordinary instructor saw a Delete button
 * the server would always deny. The page's
 * `canDeleteAppointmentMistake = canDeleteAppointments(role) && !isFinalStatus`
 * gate now delegates directly to this function, so proving its exact
 * allow/deny role set here is equivalent to proving who does and doesn't
 * see the Danger Zone affordance -- this codebase's established
 * convention for testing permission-driven UI visibility (see
 * permissions.independentInstructor.test.ts for the same pattern applied
 * to other role-gated surfaces).
 */

describe("canDeleteAppointments -- Danger Zone delete affordance gate (FC-1B5D2 D2A)", () => {
  it.each(["instructor", "independent_instructor"])(
    "%s does not receive the delete affordance",
    (role) => {
      expect(canDeleteAppointments(role)).toBe(false);
    },
  );

  it.each(["platform_admin", "studio_owner", "studio_admin", "front_desk"])(
    "%s receives the delete affordance",
    (role) => {
      expect(canDeleteAppointments(role)).toBe(true);
    },
  );

  it("an unrecognized role does not receive the delete affordance (default deny)", () => {
    expect(canDeleteAppointments("some_future_role_nobody_reviewed")).toBe(false);
    expect(canDeleteAppointments(null)).toBe(false);
    expect(canDeleteAppointments(undefined)).toBe(false);
  });
});
