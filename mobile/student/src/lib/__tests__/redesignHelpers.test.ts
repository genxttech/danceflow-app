jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
jest.mock("@/lib/supabase", () => ({ supabase: {} }));

import { styleInitials } from "@/lib/eventArt";
import { ticketAccessibilityLabel } from "@/lib/ticketPass";
import { momentLabel, weekStrip, weekStripLabel } from "@/lib/todayView";

describe("styleInitials", () => {
  it.each([
    [["Salsa & Bachata", null, "Friday"], "SB"],
    [[null, "workshop", "Bachata Musicality"], "W"],
    [[null, null, "Harvest Moon Social Dance"], "HM"],
    [["", undefined, "The Night of Waltz"], "W"],
    [[null, null, ""], "DF"]
  ])("%p -> %s", (labels, initials) => {
    expect(styleInitials(...(labels as Array<string | null | undefined>))).toBe(initials);
  });
});

describe("momentLabel", () => {
  const now = new Date("2026-11-10T15:00:00Z"); // 10:00 in New York

  it("says today, tomorrow, or the date, in the studio's time zone", () => {
    expect(momentLabel("2026-11-10T23:00:00Z", "America/New_York", now)).toBe("Today at 6:00 PM");
    expect(momentLabel("2026-11-11T23:00:00Z", "America/New_York", now)).toBe("Tomorrow at 6:00 PM");
    expect(momentLabel("2026-11-14T00:30:00Z", "America/New_York", now)).toBe("Fri, Nov 13 at 7:30 PM");
  });

  it("uses the studio's day, not UTC's, near midnight", () => {
    // 03:00 UTC on the 11th is still the evening of the 10th in New York.
    expect(momentLabel("2026-11-11T03:00:00Z", "America/New_York", now)).toBe("Today at 10:00 PM");
  });

  it("does not invent a time for a bad date", () => {
    expect(momentLabel("not a date", "America/New_York", now)).toBe("Time to be confirmed");
  });
});

describe("weekStrip", () => {
  const now = new Date("2026-11-10T15:00:00Z");
  const items = [
    { startsAt: "2026-11-10T23:00:00Z", timeZone: "America/New_York" },
    { startsAt: "2026-11-12T23:00:00Z", timeZone: "America/New_York" },
    { startsAt: "2026-11-12T20:00:00Z", timeZone: "America/New_York" },
    { startsAt: "2026-11-30T20:00:00Z", timeZone: "America/New_York" }
  ];

  it("covers seven days from today and counts items per day", () => {
    const days = weekStrip(items, now, "America/New_York");
    expect(days).toHaveLength(7);
    expect(days[0]).toMatchObject({ key: "2026-11-10", isToday: true, count: 1, weekday: "Tue", dayOfMonth: "10" });
    expect(days[2]).toMatchObject({ key: "2026-11-12", count: 2 });
    expect(days.reduce((sum, day) => sum + day.count, 0)).toBe(3);
  });

  it("gives screen readers the total and the busy days", () => {
    const days = weekStrip(items, now, "America/New_York");
    expect(weekStripLabel(days)).toBe("3 scheduled in the next seven days, on Tue, Thu. Opens your full schedule.");
    expect(weekStripLabel(weekStrip([], now, "America/New_York"))).toMatch(/^Nothing scheduled/);
  });
});

describe("ticketAccessibilityLabel", () => {
  it("spells out the code and says the check-in state in words", () => {
    const label = ticketAccessibilityLabel({
      id: "t1",
      registrationId: "r1",
      eventId: "e1",
      studioId: "s1",
      studioName: "Studio",
      hostName: "Host",
      eventName: "Friday Night Social",
      eventSlug: null,
      ticketName: "General admission",
      ticketCode: "FNS-2041",
      qrImageUrl: null,
      checkedInAt: null,
      waiverSignedAt: null,
      eventDate: null,
      eventTime: null,
      venue: null,
      city: null,
      state: null
    });
    expect(label).toContain("Code F N S - 2 0 4 1");
    expect(label).toContain("Not checked in yet");
  });
});
