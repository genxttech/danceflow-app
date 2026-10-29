import { describe, expect, it } from "vitest";
import { activeNoShows, ballotNeedsCorrection, canMarkNoShow, friendlyNoShowError, type NoShowRow } from "../noShow";

const row = (over: Partial<NoShowRow>): NoShowRow => ({
  no_show_id: "n1", heat_id: "h1", heat_number: 1, heat_entry_id: "he1", entry_id: "e1", entry_number: "101", display_name: "A",
  reason: "r", marked_at: "2027-01-01T00:00:00Z", voided: false, void_reason: null, voided_at: null, ...over,
});

describe("NS1 canMarkNoShow", () => {
  it("is open only while the round is active and the heat active or complete", () => {
    expect(canMarkNoShow({ roundStatus: "active", heatStatus: "active", entryStatus: "scheduled" })).toBe(true);
    expect(canMarkNoShow({ roundStatus: "active", heatStatus: "complete", entryStatus: "checked_in" })).toBe(true);
    expect(canMarkNoShow({ roundStatus: "active", heatStatus: "staging", entryStatus: "scheduled" })).toBe(false);
    expect(canMarkNoShow({ roundStatus: "active", heatStatus: "scheduled", entryStatus: "scheduled" })).toBe(false);
  });
  it("closes once ballots are locked or the round is anything but active", () => {
    for (const roundStatus of ["draft", "scheduled", "ballots_locked", "calculated", "approved", "published", "complete", "cancelled", undefined]) {
      expect(canMarkNoShow({ roundStatus, heatStatus: "active", entryStatus: "scheduled" })).toBe(false);
    }
  });
  it("refuses scratched, danced and disqualified entries", () => {
    for (const entryStatus of ["scratched", "danced", "disqualified"]) {
      expect(canMarkNoShow({ roundStatus: "active", heatStatus: "active", entryStatus })).toBe(false);
    }
  });
});

describe("NS1 activeNoShows", () => {
  it("keeps only marks that were not voided", () => {
    const map = activeNoShows([row({ heat_entry_id: "a" }), row({ heat_entry_id: "b", voided: true })]);
    expect([...map.keys()]).toEqual(["a"]);
    expect(activeNoShows(null).size).toBe(0);
  });
});

describe("NS1 friendlyNoShowError", () => {
  it("returns the database sentence for NS1 refusals and a plain message otherwise", () => {
    expect(friendlyNoShowError({ message: "COMP_NO_SHOW_WINDOW: a no-show can be recorded only while the round is active.\nDETAIL" }))
      .toBe("a no-show can be recorded only while the round is active.");
    expect(friendlyNoShowError({ message: "COMP_FORBIDDEN: not allowed." })).toMatch(/manager or the chief judge/);
    expect(friendlyNoShowError({ message: "COMP_VERIFIED_EMAIL_REQUIRED: a verified email credential is required" })).toMatch(/Verify your email.*COMP_VERIFIED_EMAIL_REQUIRED/);
    expect(friendlyNoShowError({ message: "boom internal" })).toBe("That change could not be saved. Refresh and try again.");
    expect(friendlyNoShowError(null)).toBe("That change could not be saved. Refresh and try again.");
  });
});

describe("NS1 ballotNeedsCorrection", () => {
  it("is false when the marks cover exactly the heat entries", () => {
    expect(ballotNeedsCorrection(["a", "b"], ["b", "a"])).toBe(false);
  });
  it("is true after a no-show (a mark for an entry no longer required) or a void (a required entry has no mark)", () => {
    expect(ballotNeedsCorrection(["a", "b"], ["a", "b", "c"])).toBe(true);
    expect(ballotNeedsCorrection(["a", "b", "c"], ["a", "b"])).toBe(true);
    expect(ballotNeedsCorrection(["a", "b"], ["a", "c"])).toBe(true);
  });
});
