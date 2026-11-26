// Past events must not appear in the upcoming list, must not crowd it out of the row limit, and must still open by id.
// A small fake of the Supabase query builder applies eq / in / gte / lte / order / limit to seeded rows, so the test sees what the
// database would return for the exact query the app builds (including the prefilter and the limit).
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
const queries: { table: string; ops: [string, ...unknown[]][] }[] = [];

function mockBuilder(table: string) {
  const ops: [string, ...unknown[]][] = [];
  queries.push({ table, ops });
  const api: Record<string, unknown> = {};
  const record = (name: string) => (...args: unknown[]) => {
    ops.push([name, ...args]);
    return api;
  };
  for (const name of ["select", "eq", "in", "gte", "lte", "order", "limit", "maybeSingle"]) api[name] = record(name);
  api.then = (resolve: (value: unknown) => unknown) => {
    let rows = [...(tables[table] ?? [])];
    let single = false;
    for (const [name, a, b] of ops) {
      if (name === "eq") rows = rows.filter((row) => row[a as string] === b);
      if (name === "in") rows = rows.filter((row) => (b as unknown[]).includes(row[a as string]));
      if (name === "gte") rows = rows.filter((row) => String(row[a as string] ?? "") >= String(b));
      if (name === "lte") rows = rows.filter((row) => String(row[a as string] ?? "") <= String(b));
      if (name === "order") {
        const asc = (b as { ascending?: boolean } | undefined)?.ascending !== false;
        rows.sort((x, y) => (String(x[a as string] ?? "") < String(y[a as string] ?? "") ? -1 : 1) * (asc ? 1 : -1));
      }
      if (name === "limit") rows = rows.slice(0, a as number);
      if (name === "maybeSingle") single = true;
    }
    return Promise.resolve(resolve({ data: single ? (rows[0] ?? null) : rows, error: null }));
  };
  return api;
}

jest.mock("@/lib/supabase", () => ({ supabase: { from: (table: string) => mockBuilder(table), auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } } }));
jest.mock("@/lib/danceflowApi", () => ({ danceflowApiFetch: jest.fn(async () => ({ eventId: "x", tickets: [] })) }));

import { getPublicEventDetailForMobile, getPublicEventsForMobile, getPublicStudioDetailForMobile } from "@/lib/publicDiscovery";

const NOW = new Date("2026-11-20T14:14:00Z"); // 09:14 in New York
const STUDIO = { id: "studio-1", slug: "qa", public_name: "QA Studio", name: "QA Studio", public_directory_enabled: true, subscription_status: "active", city: "Austin", state: "TX", latitude: null, longitude: null, beginner_friendly: true, public_short_description: null };

function event(id: string, start: string, end: string, extra: Row = {}): Row {
  return {
    id, slug: `slug-${id}`, studio_id: "studio-1", organizer_id: null, name: `Event ${id}`, event_type: "social", start_date: start, end_date: end,
    start_time: "19:00", end_time: "22:00", timezone: "America/New_York", visibility: "public", status: "published", public_directory_enabled: true,
    registration_required: true, beginner_friendly: false, public_summary: null, public_description: null, ...extra,
  };
}

beforeEach(() => {
  queries.length = 0;
  for (const key of Object.keys(tables)) delete tables[key];
  tables.studios = [STUDIO];
  tables.organizers = [];
  tables.event_locations = [];
  tables.event_public_styles = [];
  tables.event_ticket_types = [];
  tables.event_document_requirements = [];
  tables.user_favorites = [];
});

describe("the Events list (upcoming)", () => {
  it("PROD today: every public event is past, so the list is empty (a normal empty list, no error)", async () => {
    tables.events = [
      event("a", "2026-06-14", "2026-06-14"), event("b", "2026-09-05", "2026-09-05"), event("c", "2026-11-09", "2026-11-09"), event("d", "2026-10-01", "2026-10-01"),
    ];
    await expect(getPublicEventsForMobile(null, { now: NOW })).resolves.toEqual([]);
  });

  it("past rows do not consume the row limit: 150 old events do not hide the 3 upcoming ones", async () => {
    const old = Array.from({ length: 150 }, (_, i) => event(`old-${String(i).padStart(3, "0")}`, "2026-01-01", "2026-01-01"));
    tables.events = [...old, event("soon-1", "2026-11-21", "2026-11-21"), event("soon-2", "2026-12-05", "2026-12-05"), event("soon-3", "2027-01-10", "2027-01-10")];
    const list = await getPublicEventsForMobile(null, { now: NOW });
    expect(list.map((e) => e.id)).toEqual(["soon-1", "soon-2", "soon-3"]);
    const eventsQuery = queries.find((q) => q.table === "events")!;
    expect(eventsQuery.ops).toContainEqual(["gte", "end_date", "2026-11-19"]); // the prefilter the web uses (UTC date minus one day)
    const limit = eventsQuery.ops.find((op) => op[0] === "limit")?.[1] as number;
    expect(limit).toBeGreaterThanOrEqual(100); // the page limit plus the past buffer
  });

  it("drops an event that ended earlier today even though the date prefilter lets it through, keeps one still running", async () => {
    tables.events = [
      event("ended-this-morning", "2026-11-20", "2026-11-20", { start_time: "07:00", end_time: "08:30" }), // 08:30 EST, now is 09:14 EST
      event("tonight", "2026-11-20", "2026-11-20"),
      event("multi-day-last-day", "2026-11-18", "2026-11-20", { end_time: "17:00" }),
      event("multi-day-no-end-time", "2026-11-18", "2026-11-20", { end_time: null }),
      event("yesterday", "2026-11-19", "2026-11-19"),
    ];
    const list = await getPublicEventsForMobile(null, { now: NOW });
    expect(list.map((e) => e.id).sort()).toEqual(["multi-day-last-day", "multi-day-no-end-time", "tonight"]);
    expect(list.every((e) => e.ended === false)).toBe(true);
  });

  it("an event ending exactly now is gone", async () => {
    tables.events = [event("edge", "2026-11-20", "2026-11-20", { end_time: "09:14" })];
    await expect(getPublicEventsForMobile(null, { now: NOW })).resolves.toEqual([]);
    await expect(getPublicEventsForMobile(null, { now: new Date("2026-11-20T14:13:59Z") })).resolves.toHaveLength(1);
  });

  it("an event with no usable end date stays listed (never hidden by a data gap)", async () => {
    tables.events = [event("gap", "2026-12-01", "2026-12-01", { end_date: "2026-12-01", timezone: "Not/AZone" })];
    expect(await getPublicEventsForMobile(null, { now: NOW })).toHaveLength(1);
  });

  it("the studio page's upcoming events exclude ended ones", async () => {
    tables.events = [event("past", "2026-10-01", "2026-10-01"), event("next", "2099-12-12", "2099-12-12")];
    tables.studio_public_styles = [];
    tables.studio_offerings = [];
    tables.studio_staff = [];
    const detail = await getPublicStudioDetailForMobile("studio-1", null);
    expect(detail?.upcomingEvents.map((e) => e.id)).toEqual(["next"]);
    const eventsQuery = queries.find((q) => q.table === "events")!;
    expect(eventsQuery.ops.some((op) => op[0] === "gte" && op[1] === "end_date")).toBe(true);
  });
});

describe("the Past events list", () => {
  it("returns only ended events, newest first, flagged as ended", async () => {
    tables.events = [event("old", "2026-06-14", "2026-06-14"), event("recent", "2026-11-09", "2026-11-09"), event("future", "2026-12-01", "2026-12-01"), event("today-morning", "2026-11-20", "2026-11-20", { end_time: "08:00" })];
    const list = await getPublicEventsForMobile(null, { scope: "past", now: NOW });
    expect(list.map((e) => e.id)).toEqual(["today-morning", "recent", "old"]);
    expect(list.every((e) => e.ended)).toBe(true);
    const eventsQuery = queries.find((q) => q.table === "events")!;
    expect(eventsQuery.ops).toContainEqual(["lte", "end_date", "2026-11-21"]);
  });
});

describe("history stays reachable: event detail by id and direct links", () => {
  it("a past event still loads by id, flagged ended, with its tickets (checkout is blocked by the screens, not by the loader)", async () => {
    tables.events = [event("old-1", "2026-06-14", "2026-06-14", { account_required_for_registration: false })];
    tables.event_ticket_types = [{ id: "t1", event_id: "old-1", name: "General", description: null, ticket_kind: "general", price: 20, currency: "USD", capacity: null, active: true, attendees_per_ticket: 1, sort_order: 1 }];
    const detail = await getPublicEventDetailForMobile("old-1", null);
    expect(detail).not.toBeNull();
    expect(detail!.ended).toBe(true);
    expect(detail!.ticketTypes).toHaveLength(1);
    expect(detail!.name).toBe("Event old-1");
  });

  it("detail loads that one event even when 200 other events exist (the limit cannot hide it)", async () => {
    tables.events = [event("target", "2026-01-01", "2026-01-01"), ...Array.from({ length: 200 }, (_, i) => event(`other-${i}`, "2026-02-01", "2026-02-01"))];
    const detail = await getPublicEventDetailForMobile("target", null);
    expect(detail?.id).toBe("target");
  });

  it("an upcoming event is not flagged ended", async () => {
    tables.events = [event("new", "2099-01-01", "2099-01-01")];
    expect((await getPublicEventDetailForMobile("new", null))?.ended).toBe(false);
  });

  it("an unknown id is null (not an error)", async () => {
    tables.events = [];
    expect(await getPublicEventDetailForMobile("missing", null)).toBeNull();
  });
});
