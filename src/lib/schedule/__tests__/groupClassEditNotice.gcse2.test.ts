import { describe, expect, it } from "vitest";
import { classFormMaterialChanged, dancersNotifiedLine, singleEditNoticeText } from "../groupClassEditNotice";

const base = { startsAt: "2030-11-02T18:00", endsAt: "2030-11-02T19:00", instructorId: "i1", roomId: "r1", locationName: "Front" };

describe("S1E-2 edit notice wording", () => {
  it("material change = date/time, instructor, room or location only", () => {
    expect(classFormMaterialChanged(base, { ...base })).toBe(false);
    expect(classFormMaterialChanged(base, { ...base, locationName: " Front " })).toBe(false);
    for (const patch of [{ startsAt: "2030-11-02T18:30" }, { endsAt: "2030-11-02T19:30" }, { instructorId: "i2" }, { roomId: "" }, { locationName: "Back" }]) {
      expect(classFormMaterialChanged(base, { ...base, ...patch })).toBe(true);
    }
  });
  it("count line is pluralised, makes no channel promise, and is absent with nobody enrolled", () => {
    expect(dancersNotifiedLine(0)).toBeNull();
    expect(dancersNotifiedLine(1)).toBe("1 enrolled dancer will be notified about these changes.");
    expect(dancersNotifiedLine(4)).toBe("4 enrolled dancers will be notified about these changes.");
    expect(dancersNotifiedLine(4)).not.toMatch(/email|push|text|sms/i);
  });
  it("single-edit text: standing hint before a change, consequence after, none without attendees", () => {
    expect(singleEditNoticeText(0, true)).toBeNull();
    expect(singleEditNoticeText(3, false)).toMatch(/notified automatically/);
    expect(singleEditNoticeText(3, true)).toBe("3 enrolled dancers will be notified about these changes.");
  });
});
