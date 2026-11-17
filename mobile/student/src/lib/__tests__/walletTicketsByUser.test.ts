// A registration the database linked to this account (user_id, e.g. by claim_my_event_registrations) must show in the Wallet even when
// the email lookup cannot find it: stored with capitals or stray spaces, or bought under another email. Found on device 2026-11-17: two
// of five seeded tickets were missing because the app only looked up registrations by exact lower-case email and client link.
const mockCalls: Array<{ table: string; method: string; args: unknown[] }> = [];
let mockSessionUser: { id: string } | null = { id: "user-1" };

const registrationRow = (id: string) => ({
  id,
  event_id: "e1",
  studio_id: "s1",
  status: "confirmed",
  payment_status: "paid",
  quantity: 1,
  total_price: 25,
  events: { name: "QA Social Dance Night", slug: "qa", start_date: "2026-12-01", start_time: "19:00", venue_name: "QA Ballroom", city: "Austin", state: "TX" },
  event_ticket_types: null,
});

jest.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    const eqs: unknown[][] = [];
    const proxy: unknown = new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown) => {
            const byUser = eqs.some((a) => a[0] === "user_id");
            if (table === "event_registrations") return resolve({ data: byUser ? [registrationRow("r-claimed")] : [], error: null });
            if (table === "event_registration_attendees") {
              return resolve({ data: [{ id: "a1", registration_id: "r-claimed", event_id: "e1", first_name: "Dana", last_name: "Dancer", email: "dana@example.test", sort_order: 1, checked_in_at: null, waiver_signed_at: null, ticket_code: "QA-CLAIM-0001", ticket_issued_at: "2026-11-01" }], error: null });
            }
            return resolve({ data: [], error: null });
          };
        }
        return (...args: unknown[]) => {
          mockCalls.push({ table, method: prop, args });
          if (prop === "eq") eqs.push(args);
          return proxy;
        };
      },
    });
    return proxy;
  };
  return {
    supabase: {
      from: (table: string) => chain(table),
      auth: {
        getUser: async () => ({ data: { user: { id: "user-1" } } }),
        getSession: async () => ({ data: { session: mockSessionUser ? { user: mockSessionUser } : null } }),
      },
    },
  };
});
jest.mock("@/lib/studentDigitalContent", () => ({ loadStudentDigitalLibrary: async () => [] }));

import { loadStudentWallet } from "@/lib/studentWallet";

beforeEach(() => {
  mockCalls.length = 0;
  mockSessionUser = { id: "user-1" };
});

describe("wallet tickets linked by user_id", () => {
  it("includes a registration owned by the account even though the email lookup finds nothing", async () => {
    const wallet = await loadStudentWallet([], "dana.dancer@example.test", { force: true });
    expect(wallet.registrations.map((r) => r.id)).toEqual(["r-claimed"]);
    expect(wallet.tickets.map((t) => t.ticketCode)).toEqual(["QA-CLAIM-0001"]);
    const userQuery = mockCalls.filter((c) => c.table === "event_registrations" && c.method === "eq" && c.args[0] === "user_id");
    expect(userQuery.map((c) => c.args[1])).toEqual(["user-1"]);
  });

  it("asks for the signed-in account's own user_id and only the shown statuses", async () => {
    await loadStudentWallet([], "dana.dancer@example.test", { force: true });
    const ins = mockCalls.filter((c) => c.table === "event_registrations" && c.method === "in").map((c) => c.args);
    expect(ins).toContainEqual(["status", ["confirmed", "checked_in", "pending", "waitlisted"]]);
  });

  it("signed out (no session user): no by-user lookup and nothing invented", async () => {
    mockSessionUser = null;
    const wallet = await loadStudentWallet([], "dana.dancer@example.test", { force: true });
    expect(wallet.registrations).toEqual([]);
    expect(mockCalls.some((c) => c.table === "event_registrations" && c.method === "eq" && c.args[0] === "user_id")).toBe(false);
  });
});
