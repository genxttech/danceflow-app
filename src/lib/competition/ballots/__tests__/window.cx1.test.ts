import { describe, expect, it } from "vitest";
import { canMarkNoShow } from "../../noShow";
import { CORRECTION_BANNER, ballotsAccepting, inCorrectionWindow, normalWindowOpen } from "../window";

describe("CX1 ballot window", () => {
  it("accepts ballots while the round is active", () => {
    expect(ballotsAccepting({ status: "active" })).toBe(true);
    expect(ballotsAccepting({ status: "active", correction_open: false })).toBe(true);
    expect(inCorrectionWindow({ status: "active" })).toBe(false);
  });

  it("keeps a plain lock closed", () => {
    expect(ballotsAccepting({ status: "ballots_locked" })).toBe(false);
    expect(ballotsAccepting({ status: "ballots_locked", correction_open: false })).toBe(false);
    expect(ballotsAccepting({ status: "ballots_locked", correction_open: null })).toBe(false);
    expect(inCorrectionWindow({ status: "ballots_locked" })).toBe(false);
  });

  it("opens a locked round only when a correction is open", () => {
    expect(ballotsAccepting({ status: "ballots_locked", correction_open: true })).toBe(true);
    expect(inCorrectionWindow({ status: "ballots_locked", correction_open: true })).toBe(true);
  });

  it("stays closed in every other status, even with a stale correction flag", () => {
    for (const status of ["draft", "scheduled", "calculated", "approved", "published", "cancelled", "complete"]) {
      expect(ballotsAccepting({ status, correction_open: true })).toBe(false);
      expect(ballotsAccepting({ status, correction_open: false })).toBe(false);
      expect(inCorrectionWindow({ status, correction_open: true })).toBe(false);
    }
  });

  it("an older reader without the flag fails closed", () => {
    expect(ballotsAccepting({ status: "ballots_locked", correction_open: undefined })).toBe(false);
  });

  it("attendance, drafts and no-shows follow the plain active window, never the correction", () => {
    expect(normalWindowOpen({ status: "active" })).toBe(true);
    expect(normalWindowOpen({ status: "ballots_locked", correction_open: true })).toBe(false);
    expect(canMarkNoShow({ roundStatus: "ballots_locked", heatStatus: "complete", entryStatus: "checked_in" })).toBe(false);
  });

  it("an absent judge is handled by the page (scheme/absent), not by the window", () => {
    // The page opens forms only when ballotsAccepting && scheme_available && !absent; model that composition.
    const open = (sheet: { status: string; correction_open?: boolean; scheme: boolean; absent: boolean }) =>
      ballotsAccepting(sheet) && sheet.scheme && !sheet.absent;
    expect(open({ status: "ballots_locked", correction_open: true, scheme: true, absent: true })).toBe(false);
    expect(open({ status: "ballots_locked", correction_open: true, scheme: true, absent: false })).toBe(true);
    expect(open({ status: "ballots_locked", correction_open: true, scheme: false, absent: false })).toBe(false);
  });

  it("states the recalculation consequence in the banner", () => {
    expect(CORRECTION_BANNER).toContain("Correction open");
    expect(CORRECTION_BANNER).toContain("recalculated and re-approved");
  });
});
