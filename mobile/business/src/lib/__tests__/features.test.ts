import { WRITE_FEATURES, isStaffFeatureEnabled, parseStaffFeatures } from "@/lib/features";

describe("staff feature words", () => {
  it("defaults to clients and attendance only: every Phase 1A write word is OFF", () => {
    const enabled = parseStaffFeatures(undefined);
    expect([...enabled].sort()).toEqual(["attendance", "clients"]);
    for (const word of WRITE_FEATURES) expect(enabled.has(word)).toBe(false);
    for (const word of WRITE_FEATURES) expect(isStaffFeatureEnabled(word)).toBe(false);
  });

  it("each write word is turned on only by naming it, independently of the others", () => {
    for (const word of WRITE_FEATURES) {
      const enabled = parseStaffFeatures(word);
      expect(enabled.has(word)).toBe(true);
      for (const other of WRITE_FEATURES) if (other !== word) expect(enabled.has(other)).toBe(false);
    }
    const several = parseStaffFeatures("clientNotes, classRoster");
    expect(several.has("clientNotes") && several.has("classRoster")).toBe(true);
    expect(several.has("clientCreate")).toBe(false);
  });

  it("none turns everything off, including write words named before it; - removes one; unknown words change nothing", () => {
    expect([...parseStaffFeatures("clientNotes,none")]).toEqual([]);
    expect(parseStaffFeatures("clientNotes,-clientNotes").has("clientNotes")).toBe(false);
    expect([...parseStaffFeatures("wat,clientNotess,Clientnotes")].sort()).toEqual(["attendance", "clients"]);
  });

  it("the write words are the same four the server gate knows", () => {
    expect([...WRITE_FEATURES]).toEqual(["appointmentAttendance", "clientNotes", "clientCreate", "classRoster"]);
  });
});
