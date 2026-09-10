import { describe, expect, it } from "vitest";
import { canShowClassAttendanceActions } from "../ScheduleEventDrawer";

/**
 * GC-1.3A: a group_class row's appointments.status is class lifecycle
 * only, never one student's attendance -- the legacy single-row Mark
 * Attended/Mark No Show controls must never show for a class. Lesson
 * behavior (and the pre-existing floor-rental exclusion) must be unchanged.
 */
describe("canShowClassAttendanceActions", () => {
  it("hides attendance actions for a group_class", () => {
    expect(
      canShowClassAttendanceActions({
        isFinalStatus: false,
        isFloorRental: false,
        isGroupClass: true,
      }),
    ).toBe(false);
  });

  it("shows attendance actions for an active lesson (unchanged)", () => {
    expect(
      canShowClassAttendanceActions({
        isFinalStatus: false,
        isFloorRental: false,
        isGroupClass: false,
      }),
    ).toBe(true);
  });

  it("still hides attendance actions for a floor rental (unchanged)", () => {
    expect(
      canShowClassAttendanceActions({
        isFinalStatus: false,
        isFloorRental: true,
        isGroupClass: false,
      }),
    ).toBe(false);
  });

  it("still hides attendance actions once in a final status (unchanged)", () => {
    expect(
      canShowClassAttendanceActions({
        isFinalStatus: true,
        isFloorRental: false,
        isGroupClass: false,
      }),
    ).toBe(false);
  });
});
