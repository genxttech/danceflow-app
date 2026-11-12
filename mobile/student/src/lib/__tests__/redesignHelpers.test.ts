jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
jest.mock("@/lib/supabase", () => ({ supabase: {} }));

import { styleInitials } from "@/lib/eventArt";
import { publicEventLocation } from "@/lib/publicDiscovery";
import type { StudentTicket } from "@/lib/studentWallet";
import { admitCount, attendeeDisplayName, ticketPaymentLabel, ticketPaymentState } from "@/lib/ticketFacts";
import { admitLine, ticketAccessibilityLabel, ticketHolder, ticketWhen } from "@/lib/ticketPass";
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

const baseTicket: StudentTicket = {
  id: "t1",
  registrationId: "r1",
  eventId: "e1",
  studioId: "s1",
  studioName: "Studio",
  hostName: "Host",
  eventName: "Friday Night Social",
  eventSlug: null,
  ticketName: "Ticket 1",
  attendeeName: null,
  paymentState: null,
  admitPosition: 1,
  admitTotal: 1,
  ticketCode: "FNS-2041",
  qrImageUrl: null,
  checkedInAt: null,
  waiverSignedAt: null,
  eventDate: null,
  eventTime: null,
  venue: null,
  city: null,
  state: null
};

describe("ticketAccessibilityLabel", () => {
  it("spells out the code and says the check-in state in words", () => {
    const label = ticketAccessibilityLabel(baseTicket);
    expect(label).toContain("Code F N S - 2 0 4 1");
    expect(label).toContain("Not checked in yet");
  });

  it("names the holder, the admission and the payment state", () => {
    const label = ticketAccessibilityLabel({ ...baseTicket, attendeeName: "Ana Diaz", admitPosition: 2, admitTotal: 4, paymentState: "pending" });
    expect(label).toContain("Ana Diaz");
    expect(label).toContain("Admission 2 of 4");
    expect(label).toContain("Payment pending");
  });

  it("says nothing about payment or party size it does not know", () => {
    const label = ticketAccessibilityLabel(baseTicket);
    expect(label).not.toMatch(/Paid|pending|Free|Admission/);
    expect(label).toContain("Ticket 1");
  });
});

describe("ticket pass facts", () => {
  it.each([
    ["paid", 25, "paid"],
    ["PAID", 25, "paid"],
    ["pending", 25, "pending"],
    ["unpaid", 25, "pending"],
    ["partial", 25, "pending"],
    ["waived", 25, "free"],
    ["no_payment_required", null, "free"],
    ["pending", 0, "free"],
    [null, 0, "free"],
    ["paid", 0, "free"],
    ["refunded", 25, null],
    ["failed", 25, null],
    [null, null, null]
  ] as const)("payment_status %s with total %s is %s", (status, total, expected) => {
    expect(ticketPaymentState(status, total)).toBe(expected);
  });

  it("labels each payment state", () => {
    expect(ticketPaymentLabel("paid")).toBe("Paid");
    expect(ticketPaymentLabel("pending")).toBe("Payment pending");
    expect(ticketPaymentLabel("free")).toBe("Free");
    expect(ticketPaymentLabel(null)).toBeNull();
  });

  it.each([
    [1, 1, 1],
    [2, 1, 2],
    [2, 3, 6],
    [3, null, 3],
    [null, 2, 2],
    [0, 2, 2],
    [2, 0, 2],
    [-1, -4, 1],
    [2.7, 2, 4]
  ] as const)("quantity %s × attendees_per_ticket %s admits %s", (quantity, perTicket, expected) => {
    expect(admitCount(quantity, perTicket)).toBe(expected);
  });

  it.each([
    ["Ana", "Diaz", "Ana Diaz"],
    ["Ana", null, "Ana"],
    [null, "Diaz", "Diaz"],
    ["  Ana ", " Diaz  ", "Ana Diaz"],
    ["", "  ", null],
    [null, null, null]
  ] as const)("first %s and last %s name the attendee %s", (first, last, expected) => {
    expect(attendeeDisplayName(first, last)).toBe(expected);
  });

  it("falls back to the ticket's place when the attendee has no name", () => {
    expect(ticketHolder(baseTicket)).toBe("Ticket 1");
    expect(ticketHolder({ ...baseTicket, attendeeName: "Ana Diaz" })).toBe("Ana Diaz");
  });

  it("shows a place in the party only when the registration admits more than one", () => {
    expect(admitLine(baseTicket)).toBeNull();
    expect(admitLine({ ...baseTicket, admitPosition: 3, admitTotal: 4 })).toBe("3 of 4");
  });

  it("shows the start date and time, with no doors time", () => {
    const when = ticketWhen({ ...baseTicket, eventDate: "2026-11-20", eventTime: "8:00 PM" });
    expect(when).toContain("8:00 PM");
    expect(when).not.toMatch(/door/i);
  });
});

describe("publicEventLocation", () => {
  const studio = { city: "Austin", state: "TX" };
  it("uses the event's own venue, city and state first", () => {
    expect(publicEventLocation({ venue_name: "Ballroom One", city: "Dallas", state: "TX" }, { venue_name: "Other" }, studio)).toBe(
      "Ballroom One · Dallas, TX"
    );
    expect(publicEventLocation({ city: "Dallas", state: "TX" }, null, studio)).toBe("Dallas, TX");
  });

  it("falls back to the first event location, then the studio", () => {
    expect(publicEventLocation({ venue_name: " " }, { venue_name: "Hall B", city: "Plano", state: "TX" }, studio)).toBe("Hall B · Plano, TX");
    expect(publicEventLocation({}, null, studio)).toBe("Austin, TX");
    expect(publicEventLocation({}, null, null)).toBe("Location coming soon");
  });
});
