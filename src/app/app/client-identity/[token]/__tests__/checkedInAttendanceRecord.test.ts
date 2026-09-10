import { describe, expect, it } from "vitest";
import { resolveCheckedIn } from "@/app/app/client-identity/[token]/page";

/**
 * GC-1.3A: the scanned client's checked-in state on this staff QR screen
 * must come from their own attendance_records row only -- it must never
 * fall back to the row-level appointments.status, which reflects
 * lesson/class lifecycle (or another attendee's marked status), not
 * necessarily THIS specific client's own attendance.
 */
describe("resolveCheckedIn", () => {
  it("is true when this client's own attendance_records status is checked_in", () => {
    expect(resolveCheckedIn("checked_in")).toBe(true);
  });

  it("is true when this client's own attendance_records status is attended", () => {
    expect(resolveCheckedIn("attended")).toBe(true);
  });

  it("is false when there is no attendance_records row for this client (null status)", () => {
    expect(resolveCheckedIn(null)).toBe(false);
  });

  it("is false for registered/no_show -- no fallback to appointment-level status", () => {
    expect(resolveCheckedIn("registered")).toBe(false);
    expect(resolveCheckedIn("no_show")).toBe(false);
  });
});
