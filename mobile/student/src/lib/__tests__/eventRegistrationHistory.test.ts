import { eventItemsFromWallet, PAST_PAGE_SIZE } from "@/lib/eventRegistrationHistory";
import type { StudentEventRegistration, StudentWallet } from "@/lib/studentWallet";

const NOW = new Date("2026-11-20T15:00:00Z"); // 10:00 in New York

function registration(id: string, extra: Partial<StudentEventRegistration> = {}): StudentEventRegistration {
  return {
    id, eventId: `event-${id}`, studioId: "s1", studioName: "QA Studio", hostName: "QA Studio", eventName: `Event ${id}`, eventSlug: `slug-${id}`,
    status: "confirmed", paymentStatus: "paid", paymentState: null, quantity: 1, admits: 1, totalAmount: 25,
    eventDate: "2026-12-01", eventTime: "19:00", eventEndDate: "2026-12-01", eventEndTime: "22:00", eventTimeZone: "America/New_York",
    venue: "QA Ballroom", city: "Austin", state: "TX", ...extra,
  };
}

function wallet(registrations: StudentEventRegistration[], extra: Partial<StudentWallet> = {}): StudentWallet {
  return {
    digitalEntitlements: [], memberships: [], packages: [], paymentRequests: [], registrations, rewards: [], rewardProgress: [], tickets: [], ...extra,
  } as StudentWallet;
}

const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("Tickets & registrations: upcoming versus past", () => {
  it("nothing without a wallet", () => {
    expect(eventItemsFromWallet(null, NOW)).toEqual({ upcoming: [], past: [] });
  });

  it("splits by the event's own end, not the device date", () => {
    const w = wallet([
      registration("future"),
      registration("ended-last-week", { eventDate: "2026-11-13", eventEndDate: "2026-11-13" }),
      registration("tonight", { eventDate: "2026-11-20", eventEndDate: "2026-11-20", eventEndTime: "22:00" }),
      registration("this-morning", { eventDate: "2026-11-20", eventEndDate: "2026-11-20", eventTime: "07:00", eventEndTime: "09:30" }),
    ]);
    const { upcoming, past } = eventItemsFromWallet(w, NOW);
    expect(ids(upcoming)).toEqual(["tonight", "future"]);
    expect(ids(past)).toEqual(["this-morning", "ended-last-week"]);
  });

  it("time zone boundary: 23:00 Pacific on the 20th is still the 20th for the event (07:00Z on the 21st is when it ends)", () => {
    const la = registration("la", { eventDate: "2026-11-20", eventEndDate: "2026-11-20", eventTime: "20:00", eventEndTime: "23:00", eventTimeZone: "America/Los_Angeles" });
    expect(ids(eventItemsFromWallet(wallet([la]), new Date("2026-11-21T06:59:59Z")).upcoming)).toEqual(["la"]);
    expect(ids(eventItemsFromWallet(wallet([la]), new Date("2026-11-21T07:00:00Z")).past)).toEqual(["la"]);
  });

  it("an event ending exactly now is past", () => {
    const e = registration("edge", { eventDate: "2026-11-20", eventEndDate: "2026-11-20", eventTime: "08:00", eventEndTime: "10:00" }); // ends 10:00 EST = 15:00Z
    expect(ids(eventItemsFromWallet(wallet([e]), NOW).past)).toEqual(["edge"]);
    expect(ids(eventItemsFromWallet(wallet([e]), new Date("2026-11-20T14:59:59Z")).upcoming)).toEqual(["edge"]);
  });

  it("no end time: through the end of the end date in the event's zone; multi-day stays current through its last day", () => {
    const multi = registration("multi", { eventDate: "2026-11-18", eventEndDate: "2026-11-20", eventTime: "09:00", eventEndTime: null });
    expect(ids(eventItemsFromWallet(wallet([multi]), NOW).upcoming)).toEqual(["multi"]);
    expect(ids(eventItemsFromWallet(wallet([multi]), new Date("2026-11-21T05:00:00Z")).past)).toEqual(["multi"]);
  });

  it("an event with no usable date is never moved to history", () => {
    const nodate = registration("nodate", { eventDate: null, eventEndDate: null, eventEndTime: null, eventTime: null });
    expect(ids(eventItemsFromWallet(wallet([nodate]), NOW).upcoming)).toEqual(["nodate"]);
  });

  it("history is newest-ended first; upcoming is soonest first", () => {
    const mk = (id: string, d: string) => registration(id, { eventDate: d, eventEndDate: d });
    const w = wallet([mk("a-old", "2026-01-05"), mk("b-recent", "2026-11-19"), mk("c-mid", "2026-08-01"), mk("u2", "2027-02-01"), mk("u1", "2026-12-24")]);
    const { upcoming, past } = eventItemsFromWallet(w, NOW);
    expect(ids(past)).toEqual(["b-recent", "c-mid", "a-old"]);
    expect(ids(upcoming)).toEqual(["u1", "u2"]);
  });

  it("an ended registration WITHOUT a ticket is in history (ticket count 0), one with tickets keeps its count", () => {
    const noTicket = registration("no-ticket", { eventDate: "2026-10-01", eventEndDate: "2026-10-01" });
    const withTicket = registration("with-ticket", { eventDate: "2026-10-02", eventEndDate: "2026-10-02" });
    const w = wallet([noTicket, withTicket], {
      tickets: [{ id: "t1", registrationId: "with-ticket", checkedInAt: null } as unknown as StudentWallet["tickets"][number]],
    });
    const { past } = eventItemsFromWallet(w, NOW);
    expect(past.map((p) => [p.id, p.ticketCount])).toEqual([["with-ticket", 1], ["no-ticket", 0]]);
  });

  it("a ticket whose registration is not in the wallet still produces an item (history or upcoming by its start date)", () => {
    const w = wallet([], {
      tickets: [
        { id: "t9", registrationId: "orphan-old", eventId: "e9", eventName: "Orphan", eventSlug: null, studioName: "S", hostName: "S", checkedInAt: "2026-06-01T00:00:00Z", eventDate: "2026-06-01", eventTime: "19:00", venue: null, city: null, state: null } as unknown as StudentWallet["tickets"][number],
      ],
    });
    const { past } = eventItemsFromWallet(w, NOW);
    expect(past.map((p) => [p.id, p.status])).toEqual([["orphan-old", "checked_in"]]);
  });

  it("cancelled and refunded registrations of ENDED events are in history with their own status; a cancelled one for a future event is in neither list", () => {
    const w = wallet([registration("confirmed-old", { eventDate: "2026-09-01", eventEndDate: "2026-09-01" })], {
      closedRegistrations: [
        registration("cancelled-old", { status: "cancelled", paymentStatus: "paid", eventDate: "2026-09-03", eventEndDate: "2026-09-03" }),
        registration("refunded-old", { status: "cancelled", paymentStatus: "refunded", eventDate: "2026-09-02", eventEndDate: "2026-09-02" }),
        registration("cancelled-future", { status: "cancelled", paymentStatus: "refunded" }),
      ],
    });
    const { upcoming, past } = eventItemsFromWallet(w, NOW);
    expect(ids(upcoming)).toEqual([]);
    expect(past.map((p) => [p.id, p.status, p.paymentStatus])).toEqual([
      ["cancelled-old", "cancelled", "paid"],
      ["refunded-old", "cancelled", "refunded"],
      ["confirmed-old", "confirmed", "paid"],
    ]);
  });

  it("the page size is 12", () => {
    expect(PAST_PAGE_SIZE).toBe(12);
  });
});
