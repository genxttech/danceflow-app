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
            if (table === "my_event_registrations") return resolve({ data: byUser ? [registrationRow("r-claimed")] : [], error: null });
            if (table === "my_event_registration_attendees") {
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
    const userQuery = mockCalls.filter((c) => c.table === "my_event_registrations" && c.method === "eq" && c.args[0] === "user_id");
    expect(userQuery.map((c) => c.args[1])).toEqual(["user-1"]);
  });

  it("asks for the signed-in account's own user_id and only the shown statuses", async () => {
    await loadStudentWallet([], "dana.dancer@example.test", { force: true });
    const ins = mockCalls.filter((c) => c.table === "my_event_registrations" && c.method === "in").map((c) => c.args);
    expect(ins).toContainEqual(["status", ["confirmed", "checked_in", "pending", "waitlisted"]]);
  });

  it("signed out (no session user): no by-user lookup and nothing invented", async () => {
    mockSessionUser = null;
    const wallet = await loadStudentWallet([], "dana.dancer@example.test", { force: true });
    expect(wallet.registrations).toEqual([]);
    expect(mockCalls.some((c) => c.table === "my_event_registrations" && c.method === "eq" && c.args[0] === "user_id")).toBe(false);
  });
});

// Column-restricted dancer read (PR 647): the Wallet reads event registrations and tickets only through the views
// my_event_registrations / my_event_registration_attendees, with column lists the views expose. Never the base tables.
describe("wallet reads the dancer views, not the base tables", () => {
  // Columns of the views (20270222092000_dancer_event_registration_views.sql). An embed is allowed through the views.
  const REG_VIEW = ["id", "event_id", "ticket_type_id", "studio_id", "user_id", "status", "payment_status", "attendee_first_name", "attendee_last_name", "attendee_email", "attendee_phone", "quantity", "unit_price", "total_price", "total_amount", "currency", "checked_in_at", "cancelled_at", "created_at", "updated_at"];
  const ATT_VIEW = ["id", "registration_id", "event_id", "ticket_type_id", "first_name", "last_name", "email", "phone", "attendee_role", "sort_order", "waiver_signed_at", "checked_in_at", "ticket_code", "ticket_issued_at", "created_at"];
  const topLevelColumns = (select: string) => select.replace(/\w+\s*\([^()]*\)/g, "").split(",").map((c) => c.trim()).filter(Boolean);

  it("never touches the base tables", async () => {
    await loadStudentWallet([{ studioId: "s1", clientId: "c1", studioName: "S", studioPublicName: null } as never], "dana.dancer@example.test", { force: true });
    expect(mockCalls.filter((c) => c.table === "event_registrations" || c.table === "event_registration_attendees")).toEqual([]);
  });

  it("selects only columns the views expose (no client_id, notes, stripe ids, source, ticket_token, checked_in_by), keeps the embeds, and filters on exposed columns only", async () => {
    await loadStudentWallet([{ studioId: "s1", clientId: "c1", studioName: "S", studioPublicName: null } as never], "dana.dancer@example.test", { force: true });
    const regSelects = mockCalls.filter((c) => c.table === "my_event_registrations" && c.method === "select").map((c) => String(c.args[0]));
    const attSelects = mockCalls.filter((c) => c.table === "my_event_registration_attendees" && c.method === "select").map((c) => String(c.args[0]));
    expect(regSelects.length).toBeGreaterThan(0);
    expect(attSelects.length).toBeGreaterThan(0);
    for (const select of regSelects) {
      expect(topLevelColumns(select).filter((c) => !REG_VIEW.includes(c))).toEqual([]);
      expect(select).toMatch(/events\s*\(/);
      expect(select).toMatch(/event_ticket_types\s*\(/);
    }
    for (const select of attSelects) expect(topLevelColumns(select).filter((c) => !ATT_VIEW.includes(c))).toEqual([]);
    const filters = mockCalls
      .filter((c) => (c.table === "my_event_registrations" || c.table === "my_event_registration_attendees") && ["eq", "in", "neq", "gt", "lt", "or"].includes(c.method))
      .map((c) => String(c.args[0]).split(/[.,]/)[0]);
    const allowed = new Set([...REG_VIEW, ...ATT_VIEW]);
    expect(filters.filter((f) => !allowed.has(f))).toEqual([]);
  });
});
