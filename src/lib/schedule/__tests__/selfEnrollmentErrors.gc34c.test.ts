import { describe, expect, it } from "vitest";
import {
  classifySelfEnrollmentError,
  isSelfEnrollmentErrorKind,
  selfEnrollmentErrorMessage,
} from "../selfEnrollmentErrors";

/** GC-3.4C: one classification for portal and public self-enrollment. */

describe("classifySelfEnrollmentError", () => {
  it.each([
    ["You are already enrolled in this class.", "already_enrolled"],
    ["GC34C_CLASS_STARTED: This class has already started.", "started"],
    ["This class is not open for self-enrollment.", "unavailable"],
    ["No eligible package or membership found for this class.", "no_funding"],
    ["A single funding source choice is required.", "choose_funding"],
    ["Selected package is not an eligible funding source for this class.", "funding_changed"],
    ["Selected membership is not an eligible funding source for this class.", "funding_changed"],
    ["This class has no available seats remaining.", "full"],
    ["GCSC3_CLASS_CANCELLED: This class has been cancelled and can't take new students.", "cancelled"],
    ["Not authorized to enroll this client into this class.", "not_authorized"],
    ["Group class not found.", "not_found"],
    ['duplicate key value violates unique constraint "x"', "failed"],
    ["", "failed"],
  ])("%j -> %s", (message, kind) => {
    expect(classifySelfEnrollmentError(message)).toBe(kind);
  });

  it("keeps the portal's existing messages and never returns raw database text", () => {
    expect(selfEnrollmentErrorMessage("already_enrolled")).toBe("You are already enrolled in this class.");
    expect(selfEnrollmentErrorMessage("unavailable")).toBe("Online enrollment isn't available for this class.");
    expect(selfEnrollmentErrorMessage("full")).toBe("This class is full.");
    expect(selfEnrollmentErrorMessage("cancelled")).toBe("This class has been cancelled.");
    expect(selfEnrollmentErrorMessage("failed")).toBe("Could not join this class. Try again.");
    expect(selfEnrollmentErrorMessage("started")).toBe("This class has already started and can no longer be joined online.");
    for (const kind of ["already_enrolled", "started", "unavailable", "no_funding", "choose_funding", "funding_changed", "full", "cancelled", "not_authorized", "not_found", "failed"] as const) {
      expect(selfEnrollmentErrorMessage(kind)).not.toMatch(/GC34C_|GCSC3_|constraint|violat/);
    }
  });

  it("only known kinds are accepted from a URL", () => {
    expect(isSelfEnrollmentErrorKind("started")).toBe(true);
    expect(isSelfEnrollmentErrorKind("toString")).toBe(false);
    expect(isSelfEnrollmentErrorKind("GC34C_CLASS_STARTED")).toBe(false);
    expect(isSelfEnrollmentErrorKind(undefined)).toBe(false);
  });
});
