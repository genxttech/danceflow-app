// The Wallet loads cancelled registrations for the Past events list only: every other screen keeps reading `registrations` (never cancelled),
// tickets are never built for a cancelled registration, the event's end date/time/zone ride along through the events embed, and the lookup is
// no longer cut off at 20 rows.
const mockCalls: Array<{ table: string; method: string; args: unknown[] }> = [];

const row = (id: string, status: string, paymentStatus = "paid") => ({
  id,
  event_id: `e-${id}`,
  studio_id: "s1",
  status,
  payment_status: paymentStatus,
  quantity: 1,
  total_price: 25,
  events: { name: `Event ${id}`, slug: id, start_date: "2026-09-01", start_time: "19:00", end_date: "2026-09-02", end_time: "01:00", timezone: "America/Chicago", venue_name: "QA Ballroom", city: "Austin", state: "TX" },
  event_ticket_types: null,
});

jest.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    const proxy: unknown = new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown) => {
            if (table === "my_event_registrations") return resolve({ data: [row("active-1", "confirmed"), row("cancelled-1", "cancelled", "refunded"), row("cancelled-2", "cancelled")], error: null });
            if (table === "my_event_registration_attendees") {
              return resolve({
                data: [
                  { id: "a-active", registration_id: "active-1", event_id: "e-active-1", first_name: "Dana", last_name: "Dancer", email: null, sort_order: 1, checked_in_at: null, waiver_signed_at: null, ticket_code: "QA-DANA-0001", ticket_issued_at: "2026-08-01" },
                  { id: "a-cancelled", registration_id: "cancelled-1", event_id: "e-cancelled-1", first_name: "Dana", last_name: "Dancer", email: null, sort_order: 1, checked_in_at: null, waiver_signed_at: null, ticket_code: "QA-CANCELLED-0001", ticket_issued_at: "2026-08-01" },
                ],
                error: null,
              });
            }
            return resolve({ data: [], error: null });
          };
        }
        return (...args: unknown[]) => {
          mockCalls.push({ table, method: prop, args });
          return proxy;
        };
      },
    });
    return proxy;
  };
  return {
    supabase: {
      from: (table: string) => chain(table),
      auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }), getSession: async () => ({ data: { session: { user: { id: "user-1" } } } }) },
    },
  };
});
jest.mock("@/lib/studentDigitalContent", () => ({ loadStudentDigitalLibrary: async () => [] }));

import { loadStudentWallet } from "@/lib/studentWallet";

beforeEach(() => {
  mockCalls.length = 0;
});

describe("cancelled registrations in the wallet", () => {
  it("registrations (what every screen reads) never contains a cancelled one; closedRegistrations holds them with their status and payment status", async () => {
    const wallet = await loadStudentWallet([], "dana@example.test", { force: true });
    expect(wallet.registrations.map((r) => r.id)).toEqual(["active-1"]);
    expect((wallet.closedRegistrations ?? []).map((r) => [r.id, r.status, r.paymentStatus])).toEqual([
      ["cancelled-1", "cancelled", "refunded"],
      ["cancelled-2", "cancelled", "paid"],
    ]);
  });

  it("no ticket is built for a cancelled registration (the ticket screen must not show it)", async () => {
    const wallet = await loadStudentWallet([], "dana@example.test", { force: true });
    expect(wallet.tickets.map((t) => t.ticketCode)).toEqual(["QA-DANA-0001"]);
    const attendeeQuery = mockCalls.find((c) => c.table === "my_event_registration_attendees" && c.method === "in");
    expect(attendeeQuery?.args).toEqual(["registration_id", ["active-1"]]);
  });

  it("the event's own end date, end time and time zone come through the events embed (no new view column needed)", async () => {
    const wallet = await loadStudentWallet([], "dana@example.test", { force: true });
    const r = wallet.registrations[0];
    expect([r.eventEndDate, r.eventEndTime, r.eventTimeZone]).toEqual(["2026-09-02", "01:00", "America/Chicago"]);
    const select = mockCalls.find((c) => c.table === "my_event_registrations" && c.method === "select")?.args[0] as string;
    expect(select).toMatch(/end_date/);
    expect(select).toMatch(/end_time/);
    expect(select).toMatch(/timezone/);
    // Only the dancer views are read, never the base tables.
    expect(mockCalls.some((c) => c.table === "event_registrations" || c.table === "event_registration_attendees")).toBe(false);
  });

  it("the lookups are not cut off at 20 rows any more", async () => {
    await loadStudentWallet([], "dana@example.test", { force: true });
    const limits = mockCalls.filter((c) => c.table === "my_event_registrations" && c.method === "limit").map((c) => c.args[0]);
    expect(limits.length).toBeGreaterThan(0);
    expect(limits.every((n) => n === 100)).toBe(true);
  });
});
