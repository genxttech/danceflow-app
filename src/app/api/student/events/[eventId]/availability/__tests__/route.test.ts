import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const EVENT = "11111111-1111-4111-8111-111111111111";
const EVENT_PRIVATE = "22222222-2222-4222-8222-222222222222";
const EVENT_DRAFT = "33333333-3333-4333-8333-333333333333";
const EVENT_OTHER_STUDIO = "44444444-4444-4444-8444-444444444444";
const T_LIMITED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const T_PAIR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const T_FREE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const T_INACTIVE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const T_PRIVATE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

const db: Record<string, Row[]> = {};
let pageCalls = 0;

// A small chainable fake covering exactly the query shapes the loader uses: select / eq / in / order / range / maybeSingle.
function table(name: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let range: [number, number] | null = null;
  let orderCol: string | null = null;
  const run = () => {
    let rows = (db[name] ?? []).filter((r) => filters.every((f) => f(r)));
    if (orderCol) rows = [...rows].sort((a, b) => String(a[orderCol as string]).localeCompare(String(b[orderCol as string])));
    if (range) { pageCalls += 1; rows = rows.slice(range[0], range[1] + 1); }
    return rows;
  };
  const q: Record<string, unknown> = {
    select: () => q,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
    in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
    order: (c: string) => ((orderCol = c), q),
    range: (a: number, b: number) => ((range = [a, b]), q),
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: run(), error: null }),
  };
  return q;
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (n: string) => table(n) }) }));
let authed = true;
vi.mock("@/lib/auth/studentApiAuth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/studentApiAuth")>("@/lib/auth/studentApiAuth");
  return {
    ...actual,
    requireStudentApiUser: async () =>
      authed ? { ok: true as const, user: { id: "user-1", email: "student@example.test" } } : { ok: false as const, response: new Response(JSON.stringify({ error: "Authentication required." }), { status: 401 }) },
  };
});

import { GET } from "../route";

const call = (eventId: string) => GET(new Request(`http://localhost/api/student/events/${eventId}/availability`) as never, { params: Promise.resolve({ eventId }) });
const future = new Date(Date.now() + 3600_000).toISOString();
const past = new Date(Date.now() - 3600_000).toISOString();

function seed() {
  for (const k of Object.keys(db)) delete db[k];
  pageCalls = 0;
  db.events = [
    { id: EVENT, status: "published", visibility: "public" },
    { id: EVENT_PRIVATE, status: "published", visibility: "private" },
    { id: EVENT_DRAFT, status: "draft", visibility: "public" },
    { id: EVENT_OTHER_STUDIO, status: "published", visibility: "unlisted" },
  ];
  db.event_ticket_types = [
    { id: T_LIMITED, event_id: EVENT, capacity: 10, attendees_per_ticket: 1, active: true },
    { id: T_PAIR, event_id: EVENT, capacity: 10, attendees_per_ticket: 2, active: true },
    { id: T_FREE, event_id: EVENT, capacity: null, attendees_per_ticket: 1, active: true },
    { id: T_INACTIVE, event_id: EVENT, capacity: 5, attendees_per_ticket: 1, active: false },
    { id: T_PRIVATE, event_id: EVENT_PRIVATE, capacity: 3, attendees_per_ticket: 1, active: true },
  ];
  db.event_orders = [
    { id: "o-live", status: "pending", payment_status: "pending", expires_at: future },
    { id: "o-expired", status: "pending", payment_status: "pending", expires_at: past },
    { id: "o-cancelled", status: "cancelled", payment_status: "failed", expires_at: future },
  ];
  db.event_registrations = [
    { id: "r01", ticket_type_id: T_LIMITED, quantity: 2, status: "confirmed", payment_status: "paid", order_id: null, attendee_email: "secret@example.test" },
    { id: "r02", ticket_type_id: T_LIMITED, quantity: 1, status: "pending", payment_status: "pending", order_id: "o-live" },
    { id: "r03", ticket_type_id: T_LIMITED, quantity: 4, status: "pending", payment_status: "pending", order_id: "o-expired" },
    { id: "r04", ticket_type_id: T_LIMITED, quantity: 3, status: "cancelled", payment_status: "refunded", order_id: null },
    { id: "r05", ticket_type_id: T_LIMITED, quantity: 1, status: "checked_in", payment_status: "paid", order_id: null },
    { id: "r06", ticket_type_id: T_LIMITED, quantity: 1, status: "pending", payment_status: "pending", order_id: "o-cancelled" },
    { id: "r07", ticket_type_id: T_PAIR, quantity: 2, status: "confirmed", payment_status: "paid", order_id: null },
    { id: "r08", ticket_type_id: T_PRIVATE, quantity: 3, status: "confirmed", payment_status: "paid", order_id: null },
    // orderless pending rows: a live terminal (card reader) hold reserves capacity like the trigger says, an expired one does not
    { id: "r10", ticket_type_id: T_LIMITED, quantity: 1, status: "pending", payment_status: "pending", order_id: null, terminal_hold_until: future },
    { id: "r11", ticket_type_id: T_LIMITED, quantity: 2, status: "pending", payment_status: "pending", order_id: null, terminal_hold_until: past },
    { id: "r12", ticket_type_id: T_LIMITED, quantity: 2, status: "pending", payment_status: "pending", order_id: null, terminal_hold_until: null },
  ];
}

describe("GET /api/student/events/[eventId]/availability", () => {
  beforeEach(() => { authed = true; seed(); });

  it("requires a signed-in student session", async () => {
    authed = false;
    expect((await call(EVENT)).status).toBe(401);
  });

  it("counts admissions the way the capacity trigger does: paid or confirmed/checked_in/attended plus live holds, times attendees per ticket", async () => {
    const res = await call(EVENT);
    expect(res.status).toBe(200);
    const body = await res.json();
    // T_LIMITED: r01 2 + r02 live hold 1 + r05 1 + r10 live terminal hold 1 = 5 used (expired holds, cancelled, cancelled-order hold, orderless row without a hold are free) -> 5 left of 10
    // T_PAIR: 2 tickets x 2 admissions = 4 used -> 6 left of 10; T_FREE unlimited; inactive ticket omitted
    expect(body).toEqual({
      eventId: EVENT,
      tickets: [
        { ticketTypeId: T_LIMITED, capacity: 10, remaining: 5, soldOut: false },
        { ticketTypeId: T_PAIR, capacity: 10, remaining: 6, soldOut: false },
        { ticketTypeId: T_FREE, capacity: null, remaining: null, soldOut: false },
      ],
    });
  });

  it("reports sold out at zero and never negative", async () => {
    (db.event_registrations as Row[]).push({ id: "r09", ticket_type_id: T_LIMITED, quantity: 20, status: "confirmed", payment_status: "paid", order_id: null });
    const body = await (await call(EVENT)).json();
    expect(body.tickets[0]).toEqual({ ticketTypeId: T_LIMITED, capacity: 10, remaining: 0, soldOut: true });
  });

  it("byte-stable shape: exact keys, sorted by ticket type id, no registration, email, order or timestamp data", async () => {
    const text = JSON.stringify(await (await call(EVENT)).json());
    expect(text).toBe(
      `{"eventId":"${EVENT}","tickets":[` +
        `{"ticketTypeId":"${T_LIMITED}","capacity":10,"remaining":5,"soldOut":false},` +
        `{"ticketTypeId":"${T_PAIR}","capacity":10,"remaining":6,"soldOut":false},` +
        `{"ticketTypeId":"${T_FREE}","capacity":null,"remaining":null,"soldOut":false}]}`,
    );
    expect(text).not.toMatch(/secret@example\.test|email|order|registration|expires|created/i);
  });

  it("does not leak counts for private, draft or unknown events: identical 404 body", async () => {
    const unknown = "99999999-9999-4999-8999-999999999999";
    const bodies = [];
    for (const id of [EVENT_PRIVATE, EVENT_DRAFT, unknown, "not-a-uuid"]) {
      const res = await call(id);
      expect(res.status, id).toBe(404);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toMatch(/capacity|remaining|ticket/i);
  });

  it("an unlisted event is allowed (same rule as the public event page) and one event's counts never include another event's registrations", async () => {
    const res = await call(EVENT_OTHER_STUDIO);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eventId: EVENT_OTHER_STUDIO, tickets: [] });
  });

  it("is cacheable per user for a few seconds and private", async () => {
    expect((await call(EVENT)).headers.get("Cache-Control")).toBe("private, max-age=5");
  });

  it("pages through more than 1000 registrations", async () => {
    const many = Array.from({ length: 2300 }, (_, i) => ({ id: `m${String(i).padStart(5, "0")}`, ticket_type_id: T_PAIR, quantity: 1, status: "confirmed", payment_status: "paid", order_id: null }));
    db.event_registrations = [...(db.event_registrations as Row[]).filter((r) => r.ticket_type_id !== T_PAIR), ...many];
    db.event_ticket_types = (db.event_ticket_types as Row[]).map((t) => (t.id === T_PAIR ? { ...t, capacity: 5000 } : t));
    const body = await (await call(EVENT)).json();
    expect(body.tickets.find((t: { ticketTypeId: string }) => t.ticketTypeId === T_PAIR)).toEqual({ ticketTypeId: T_PAIR, capacity: 5000, remaining: 5000 - 2300 * 2, soldOut: false });
    expect(pageCalls).toBeGreaterThanOrEqual(3);
  });
});
