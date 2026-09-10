import { describe, expect, it } from "vitest";
import { isClassLevelAttendanceEligible as isClassLevelAttendanceEligibleOnList } from "@/app/app/schedule/page";
import { isClassLevelAttendanceEligible as isClassLevelAttendanceEligibleOnDetail } from "@/app/app/schedule/[id]/page";

/**
 * GC-1.3A: a group_class row's appointments.status is class lifecycle
 * only, never one student's attendance -- the legacy single-row Mark
 * Attended/Mark No Show controls must never show for a class, on either
 * the schedule list page or the appointment detail page. Lesson behavior
 * (and the pre-existing floor-rental exclusion) must be unchanged.
 */
describe("schedule/page.tsx isClassLevelAttendanceEligible", () => {
  it("hides attendance actions for a group_class", () => {
    expect(
      isClassLevelAttendanceEligibleOnList({
        isFinalStatus: false,
        canMark: true,
        isFloorRental: false,
        isGroupClass: true,
      }),
    ).toBe(false);
  });

  it("shows attendance actions for an active lesson the caller may mark (unchanged)", () => {
    expect(
      isClassLevelAttendanceEligibleOnList({
        isFinalStatus: false,
        canMark: true,
        isFloorRental: false,
        isGroupClass: false,
      }),
    ).toBe(true);
  });

  it("still respects role/final-status/floor-rental exclusions (unchanged)", () => {
    expect(
      isClassLevelAttendanceEligibleOnList({
        isFinalStatus: false,
        canMark: false,
        isFloorRental: false,
        isGroupClass: false,
      }),
    ).toBe(false);
    expect(
      isClassLevelAttendanceEligibleOnList({
        isFinalStatus: true,
        canMark: true,
        isFloorRental: false,
        isGroupClass: false,
      }),
    ).toBe(false);
    expect(
      isClassLevelAttendanceEligibleOnList({
        isFinalStatus: false,
        canMark: true,
        isFloorRental: true,
        isGroupClass: false,
      }),
    ).toBe(false);
  });
});

describe("schedule/[id]/page.tsx isClassLevelAttendanceEligible", () => {
  it("hides attendance actions for a group_class", () => {
    expect(
      isClassLevelAttendanceEligibleOnDetail({
        canMark: true,
        isFloorRental: false,
        isGroupClass: true,
      }),
    ).toBe(false);
  });

  it("shows attendance actions for an active lesson the caller may mark (unchanged)", () => {
    expect(
      isClassLevelAttendanceEligibleOnDetail({
        canMark: true,
        isFloorRental: false,
        isGroupClass: false,
      }),
    ).toBe(true);
  });

  it("still hides attendance actions for a floor rental (unchanged)", () => {
    expect(
      isClassLevelAttendanceEligibleOnDetail({
        canMark: true,
        isFloorRental: true,
        isGroupClass: false,
      }),
    ).toBe(false);
  });
});
