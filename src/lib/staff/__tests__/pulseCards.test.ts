import { describe, expect, it, vi } from "vitest";
import {
  PULSE_LIST_LIMIT,
  countLowPackages,
  isPulseLead,
  leadSourceLabel,
  loadPulseCards,
  pulseCardAccess,
  summarizeHealth,
  summarizeLeads,
  summarizeRequests,
} from "../pulseCards";

/*
  The Pulse command-center cards: the role matrix, the pure projections, and the loaders against a small in-memory fake (filters on studio_id, status sets, instructor
  scope, per-card failure). The fake records every table read so tenancy and "no read for a hidden card" can be asserted.
*/

const STUDIO = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
const INSTRUCTOR = "11111111-0000-4000-8000-000000000001";
const OTHER_INSTRUCTOR = "11111111-0000-4000-8000-000000000002";
const USER = "99999999-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-22T15:00:00.000Z");

type Row = Record<string, unknown>;

class Fake {
  private filters: ((row: Row) => boolean)[] = [];
  private max = Infinity;
  private sorting: { column: string; ascending: boolean } | null = null;
  constructor(
    private rows: Row[],
    private table: string,
    private log: { table: string; studio: unknown; instructor: unknown }[],
    private fail: boolean,
    private head = false,
    private wantCount = false,
  ) {}
  select(_cols?: string, options?: { count?: string; head?: boolean }) {
    this.head = options?.head === true;
    this.wantCount = options?.count === "exact";
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  is(column: string, value: null) {
    this.filters.push((row) => (row[column] ?? null) === value);
    return this;
  }
  not(column: string, _op: string, value: null) {
    this.filters.push((row) => (row[column] ?? null) !== value);
    return this;
  }
  or(expression: string) {
    // "col.is.null,col.neq.value" and "col.is.null,col.not.ilike.pattern*pattern": enough of PostgREST's grammar for the loader
    const parts = expression.split(",").map((part) => part.split("."));
    this.filters.push((row) =>
      parts.some(([column, op, ...rest]) => {
        const value = row[column] ?? null;
        if (op === "is") return rest[0] === "null" && value === null;
        if (op === "neq") return value !== rest.join(".");
        if (op === "not" && rest[0] === "ilike") {
          const pattern = new RegExp("^" + rest.slice(1).join(".").split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
          return value !== null && !pattern.test(String(value));
        }
        return false;
      }),
    );
    return this;
  }
  gte(column: string, value: string) {
    this.filters.push((row) => String(row[column]) >= value);
    return this;
  }
  lte(column: string, value: string) {
    this.filters.push((row) => String(row[column]) <= value);
    return this;
  }
  order(column: string, { ascending }: { ascending: boolean }) {
    this.sorting = { column, ascending };
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  maybeSingle() {
    return Promise.resolve({ data: this.rows.filter((row) => this.filters.every((f) => f(row)))[0] ?? null, error: null });
  }
  then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
    const out = (() => {
      let rows = this.rows.filter((row) => this.filters.every((f) => f(row)));
      if (this.sorting) {
        const { column, ascending } = this.sorting;
        rows = [...rows].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
      }
      this.log.push({ table: this.table, studio: this.rows[0]?.studio_id, instructor: undefined });
      if (this.fail) return { data: null, error: { message: "row text that must never be logged" }, count: null };
      return { data: this.head ? null : rows.slice(0, this.max), error: null, count: this.wantCount ? rows.length : null };
    })();
    return Promise.resolve(out).then(resolve, reject);
  }
}

function world(tables: Record<string, Row[]>, options: { failTables?: string[]; instructorOf?: string | null } = {}) {
  const log: { table: string; studio: unknown; instructor: unknown }[] = [];
  const supabase = {
    from(table: string) {
      if (table === "instructors") {
        // resolveViewerInstructorId reads this
        return new Fake(options.instructorOf ? [{ id: options.instructorOf, user_id: USER, studio_id: STUDIO, active: true }] : [], table, log, false);
      }
      return new Fake(tables[table] ?? [], table, log, options.failTables?.includes(table) ?? false);
    },
  };
  return { supabase: supabase as never, log };
}

const today = { total: 6, upcoming: 2, cancelled: 1, truncated: false };

const data = {
  booking_requests: [
    { id: "br1", studio_id: STUDIO, client_id: "c1", instructor_id: INSTRUCTOR, status: "pending", created_at: "2026-11-20T10:00:00Z", requested_starts_at: "2026-11-25T15:00:00Z" },
    { id: "br2", studio_id: STUDIO, client_id: "c2", instructor_id: OTHER_INSTRUCTOR, status: "pending", created_at: "2026-11-21T10:00:00Z", requested_starts_at: null },
    { id: "br3", studio_id: STUDIO, client_id: "c1", instructor_id: INSTRUCTOR, status: "approved", created_at: "2026-11-19T10:00:00Z", requested_starts_at: null },
    { id: "brB", studio_id: OTHER, client_id: "cB", instructor_id: null, status: "pending", created_at: "2026-11-18T10:00:00Z", requested_starts_at: null },
  ],
  student_booking_action_requests: [
    { id: "sr1", studio_id: STUDIO, client_id: "c2", instructor_id: INSTRUCTOR, action_type: "reschedule", status: "pending", created_at: "2026-11-22T09:00:00Z", requested_starts_at: "2026-11-26T15:00:00Z" },
    { id: "sr2", studio_id: STUDIO, client_id: "c1", instructor_id: null, action_type: "cancel", status: "executed", created_at: "2026-11-17T09:00:00Z", requested_starts_at: null },
  ],
  clients: [
    { id: "c1", studio_id: STUDIO, first_name: "Maya", last_name: "Chen", status: "active", created_at: "2026-10-01T00:00:00Z", referral_source: null, is_independent_instructor: false },
    { id: "c2", studio_id: STUDIO, first_name: "Evan", last_name: "Hale", status: "active", created_at: "2026-10-01T00:00:00Z", referral_source: null, is_independent_instructor: false },
    { id: "L1", studio_id: STUDIO, first_name: "Lena", last_name: "Lead", status: "lead", created_at: "2026-11-21T10:00:00Z", referral_source: "public_intro_booking", is_independent_instructor: false },
    { id: "L2", studio_id: STUDIO, first_name: "Old", last_name: "Lead", status: "lead", created_at: "2026-09-01T10:00:00Z", referral_source: "website", is_independent_instructor: false },
    { id: "L3", studio_id: STUDIO, first_name: "Event", last_name: "Registrant", status: "lead", created_at: "2026-11-21T11:00:00Z", referral_source: "event_registration", is_independent_instructor: false },
    { id: "L4", studio_id: STUDIO, first_name: "Indie", last_name: "Teacher", status: "lead", created_at: "2026-11-21T12:00:00Z", referral_source: null, is_independent_instructor: true },
    { id: "LB", studio_id: OTHER, first_name: "Other", last_name: "Studio", status: "lead", created_at: "2026-11-21T12:00:00Z", referral_source: null, is_independent_instructor: false },
  ],
  lead_activities: [
    { id: "a1", studio_id: STUDIO, client_id: "L2", follow_up_due_at: "2026-11-20T00:00:00Z", completed_at: null },
    { id: "a2", studio_id: STUDIO, client_id: "L1", follow_up_due_at: "2026-11-29T00:00:00Z", completed_at: null },
  ],
  automation_actions: [
    { id: "x1", studio_id: STUDIO, rule_key: "lapsed_client", title: "Reach out to Sam", status: "suggested", priority: "high", created_at: "2026-11-21T00:00:00Z" },
    { id: "x2", studio_id: STUDIO, rule_key: "birthday", title: "Draft ready", status: "drafted", priority: "low", created_at: "2026-11-20T00:00:00Z" },
    { id: "x3", studio_id: STUDIO, rule_key: "birthday", title: "Done", status: "completed", priority: "low", created_at: "2026-11-19T00:00:00Z" },
    { id: "xB", studio_id: OTHER, rule_key: "birthday", title: "Other studio", status: "suggested", priority: "low", created_at: "2026-11-19T00:00:00Z" },
  ],
  client_packages: [
    { id: "p1", studio_id: STUDIO, active: true, client_package_items: [{ quantity_remaining: 1, is_unlimited: false }] },
    { id: "p2", studio_id: STUDIO, active: true, client_package_items: [{ quantity_remaining: 8, is_unlimited: false }] },
    { id: "p3", studio_id: STUDIO, active: true, client_package_items: [{ quantity_remaining: 0, is_unlimited: true }] },
    { id: "p4", studio_id: STUDIO, active: false, client_package_items: [{ quantity_remaining: 0, is_unlimited: false }] },
    { id: "pB", studio_id: OTHER, active: true, client_package_items: [{ quantity_remaining: 0, is_unlimited: false }] },
  ],
} as Record<string, Row[]>;

const call = (role: string, options: Parameters<typeof world>[1] = {}, tables = data) => {
  const w = world(tables, options);
  return { w, run: () => loadPulseCards({ supabase: w.supabase, studioId: STUDIO, userId: USER, studioRole: role, now: NOW, today }) };
};

describe("role matrix", () => {
  it("gives each role exactly its cards", () => {
    expect(pulseCardAccess("studio_owner")).toEqual({ requests: "all", leads: true, aria: true, exceptions: "all", health: "studio" });
    expect(pulseCardAccess("studio_admin")).toEqual({ requests: "all", leads: true, aria: true, exceptions: "all", health: "studio" });
    expect(pulseCardAccess("front_desk")).toEqual({ requests: "all", leads: true, aria: false, exceptions: "all", health: "studio" });
    expect(pulseCardAccess("instructor")).toEqual({ requests: "own", leads: false, aria: false, exceptions: "own", health: "own" });
  });
  it.each(["platform_admin", "independent_instructor", "organizer_owner", "student", "", null, undefined, "future_role"])("denies %s everything", (role) => {
    expect(pulseCardAccess(role as string)).toEqual({ requests: null, leads: false, aria: false, exceptions: null, health: null });
  });
});

describe("pure projections", () => {
  it("merges both request queues, oldest first for waiting and newest first for the list, capped", () => {
    const booking = Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, client_id: null, created_at: `2026-11-1${i}T00:00:00Z`, requested_starts_at: null }));
    const summary = summarizeRequests(booking, [{ id: "s1", client_id: null, action_type: "cancel", created_at: "2026-11-09T00:00:00Z", requested_starts_at: null }]);
    expect(summary.oldestCreatedAt).toBe("2026-11-09T00:00:00Z");
    expect(summary.recent).toHaveLength(PULSE_LIST_LIMIT);
    expect(summary.recent[0].id).toBe("b7");
    expect(summarizeRequests([], []).oldestCreatedAt).toBeNull();
  });
  it("maps unknown self-service kinds to null, not a guess", () => {
    expect(summarizeRequests([], [{ id: "s", client_id: null, action_type: "weird", created_at: "2026-11-09T00:00:00Z", requested_starts_at: null }]).recent[0].kind).toBeNull();
  });
  it("excludes event registrants and independent instructors from leads", () => {
    expect(isPulseLead({ referral_source: "event_registration", is_independent_instructor: false })).toBe(false);
    expect(isPulseLead({ referral_source: null, is_independent_instructor: true })).toBe(false);
    expect(isPulseLead({ referral_source: "public_intro_booking", is_independent_instructor: false })).toBe(true);
  });
  it("labels sources without echoing unknown free text", () => {
    expect(leadSourceLabel("public_intro_booking")).toBe("Intro booking");
    expect(leadSourceLabel(null)).toBe("Studio");
    expect(leadSourceLabel("<script>")).toBe("Other");
  });
  it("counts a low package once and ignores unlimited items", () => {
    expect(countLowPackages([{ id: "a", client_package_items: [{ quantity_remaining: 1, is_unlimited: false }, { quantity_remaining: 1, is_unlimited: false }] }])).toBe(1);
    expect(countLowPackages([{ id: "a", client_package_items: [{ quantity_remaining: 0, is_unlimited: true }] }])).toBe(0);
    expect(countLowPackages([{ id: "a", client_package_items: [{ quantity_remaining: "1", is_unlimited: false }] }])).toBe(1);
    expect(countLowPackages([{ id: "a", client_package_items: null }])).toBe(0);
  });
  it("derives done sessions from the same day summary the app already shows", () => {
    expect(summarizeHealth({ total: 6, upcoming: 2, cancelled: 1 })).toEqual({ sessionsToday: 6, sessionsAhead: 2, sessionsDone: 4 });
    expect(summarizeHealth({ total: 1, upcoming: 3, cancelled: 0 }).sessionsDone).toBe(0);
  });
  it("summarizeLeads counts new, uncontacted and overdue follow-ups", () => {
    const rows = data.clients.filter((row) => row.status === "lead" && row.studio_id === STUDIO) as never[];
    const s = summarizeLeads(rows, new Set(["L2", "L1"]), [{ client_id: "L2", follow_up_due_at: "2026-11-20T00:00:00Z", completed_at: null }], NOW);
    expect(s.newLast7Days).toBe(1);
    expect(s.uncontacted).toBe(0);
    expect(s.followUpsOverdue).toBe(1);
    expect(s.recent.map((r) => r.id)).toEqual(["L1", "L2"].sort((a, b) => (rows as { id: string }[]).findIndex((r) => r.id === a) - (rows as { id: string }[]).findIndex((r) => r.id === b)));
  });
});

describe("loadPulseCards: owner and admin", () => {
  it.each(["studio_owner", "studio_admin"])("%s gets every card", async (role) => {
    const { run } = call(role);
    const cards = await run();
    expect(cards.requests).toMatchObject({ state: "ok", bookingRequests: 2, selfService: 1, total: 3, oldestCreatedAt: "2026-11-20T10:00:00Z" });
    expect(cards.leads).toMatchObject({ state: "ok", newLast7Days: 1, uncontacted: 0, followUpsOverdue: 1 });
    expect(cards.aria).toMatchObject({ state: "ok", open: 2 });
    expect(cards.exceptions).toMatchObject({ state: "ok", cancelledToday: 1, lowPackages: 1 });
    expect(cards.health).toMatchObject({ state: "ok", scope: "studio", sessionsToday: 6, sessionsAhead: 2, sessionsDone: 4 });
  });
  it("names clients on requests for broad roles only", async () => {
    const cards = await call("studio_owner").run();
    const recent = (cards.requests as { recent: { clientName: string | null }[] }).recent;
    expect(recent.map((r) => r.clientName).sort()).toEqual(["Evan Hale", "Evan Hale", "Maya Chen"]);
  });
  it("never returns another studio's rows", async () => {
    const cards = await call("studio_owner").run();
    expect(JSON.stringify(cards)).not.toMatch(/Other Studio|Other studio|brB|"LB"|"xB"|"pB"/);
  });
  it("leads exclude event registrants and independent instructors", async () => {
    const cards = await call("studio_owner").run();
    const ids = (cards.leads as { recent: { id: string }[] }).recent.map((l) => l.id);
    expect(ids).toEqual(["L1", "L2"]);
  });
});

describe("loadPulseCards: front desk", () => {
  it("has no ARIA card and does not read the table at all", async () => {
    const { run, w } = call("front_desk");
    const cards = await run();
    expect(cards.aria).toBeNull();
    expect(w.log.some((entry) => entry.table === "automation_actions")).toBe(false);
    expect(cards.leads).not.toBeNull();
    expect(cards.requests).not.toBeNull();
  });
});

describe("loadPulseCards: instructor", () => {
  it("sees only requests assigned to them, no names, no leads, ARIA or packages", async () => {
    const { run, w } = call("instructor", { instructorOf: INSTRUCTOR });
    const cards = await run();
    expect(cards.requests).toMatchObject({ state: "ok", bookingRequests: 1, selfService: 1, total: 2 });
    expect((cards.requests as { recent: { clientName: string | null }[] }).recent.every((r) => r.clientName === null)).toBe(true);
    expect(cards.leads).toBeNull();
    expect(cards.aria).toBeNull();
    expect(cards.exceptions).toMatchObject({ state: "ok", cancelledToday: 1, lowPackages: null });
    expect(cards.health).toMatchObject({ scope: "own" });
    const read = new Set(w.log.map((entry) => entry.table));
    expect(read.has("lead_activities")).toBe(false);
    expect(read.has("automation_actions")).toBe(false);
    expect(read.has("client_packages")).toBe(false);
    expect(read.has("clients")).toBe(false);
  });
  it("without a linked instructor sees no requests, never everyone's", async () => {
    const cards = await call("instructor", { instructorOf: null }).run();
    expect(cards.requests).toMatchObject({ state: "ok", total: 0, recent: [] });
  });
});

describe("loadPulseCards: refused roles and isolated failure", () => {
  it.each(["independent_instructor", "platform_admin", "organizer_owner"])("%s gets only nulls and reads nothing", async (role) => {
    const { run, w } = call(role);
    expect(await run()).toEqual({ requests: null, leads: null, aria: null, exceptions: null, health: null });
    expect(w.log).toHaveLength(0);
  });
  it("one failing card becomes unavailable and the others still answer; the error body is not logged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cards = await call("studio_owner", { failTables: ["automation_actions"] }).run();
    expect(cards.aria).toEqual({ state: "unavailable" });
    expect(cards.requests).toMatchObject({ state: "ok" });
    expect(cards.leads).toMatchObject({ state: "ok" });
    expect(cards.health).toMatchObject({ state: "ok" });
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).toContain("aria");
    expect(logged).not.toContain("row text that must never be logged");
    spy.mockRestore();
  });
  it("a queue longer than the old scan cap still gets the exact total and the NEWEST requests, not the oldest", async () => {
    const many = Array.from({ length: 205 }, (_, i) => ({ id: "m" + i, studio_id: STUDIO, client_id: null, instructor_id: null, status: "pending", created_at: new Date(Date.UTC(2026, 10, 1) + i * 3600_000).toISOString(), requested_starts_at: null }));
    const cards = await call("studio_owner", {}, { ...data, booking_requests: many }).run();
    const requests = cards.requests as { bookingRequests: number; selfService: number; total: number; oldestCreatedAt: string; recent: { id: string }[] };
    expect(requests.bookingRequests).toBe(205);
    expect(requests.total).toBe(205 + requests.selfService);
    expect(requests.oldestCreatedAt).toBe("2026-11-01T00:00:00.000Z");
    expect(requests.recent[0].id).toBe("sr1"); // the newest of all (a self-service request from the base data)
    expect(requests.recent.map((r) => r.id)).toContain("m204");
    expect(requests.recent.map((r) => r.id)).not.toContain("m0");
  });
});

describe("classification guard: a lead is not a lesson request, a booking, an event registrant or an intake", () => {
  const person = (id: string, over: Row): Row => ({ id, studio_id: STUDIO, first_name: id, last_name: "Test", status: "lead", created_at: "2026-11-21T10:00:00Z", referral_source: null, source_system: null, is_independent_instructor: false, ...over });

  it.each([
    ["the event checkout's own spelling", { referral_source: "Event Registration", source_system: "event_registration" }],
    ["the key spelling", { referral_source: "event_registration" }],
    ["a dashed spelling", { referral_source: "event-registration" }],
    ["only the source system says event", { referral_source: null, source_system: "event_registration" }],
    ["an independent instructor", { is_independent_instructor: true }],
  ])("%s is never a lead", (_name, over) => {
    expect(isPulseLead({ referral_source: null, source_system: null, is_independent_instructor: false, ...(over as object) })).toBe(false);
  });

  it("an event ticket purchaser (status lead, the event checkout's spelling) is in no lead count and no lead row", async () => {
    const tables = { ...data, clients: [...data.clients, person("EV1", { referral_source: "Event Registration", source_system: "event_registration", created_at: "2026-11-22T10:00:00Z" })] };
    const cards = await call("studio_owner", {}, tables).run();
    const leads = cards.leads as { newLast7Days: number; uncontacted: number; recent: { id: string }[] };
    expect(leads.recent.map((l) => l.id)).not.toContain("EV1");
    expect(leads.newLast7Days).toBe(1); // unchanged from the base data: only L1
    expect(leads.uncontacted).toBe(0);
  });

  it("a client who is not a lead (a booked, active student) is not a lead, and a lead's pending request is counted once as a request and once as a lead, never merged", async () => {
    const tables = {
      ...data,
      clients: [...data.clients, person("N1", { status: "active" }), person("N2", { status: "lead", first_name: "Nia" })],
      booking_requests: [...data.booking_requests, { id: "brN", studio_id: STUDIO, client_id: "N2", instructor_id: null, status: "pending", created_at: "2026-11-22T08:00:00Z", requested_starts_at: null }],
    };
    const cards = await call("studio_owner", {}, tables).run();
    const leads = cards.leads as { recent: { id: string }[]; uncontacted: number };
    const requests = cards.requests as { total: number; recent: { id: string }[] };
    expect(leads.recent.map((l) => l.id)).not.toContain("N1");
    expect(leads.recent.map((l) => l.id)).toContain("N2");
    expect(requests.total).toBe(4); // 3 from the base data + brN
    expect(requests.recent.map((r) => r.id)).toContain("brN");
  });

  it("a confirmed booking or an approved request is never an open request", async () => {
    const cards = await call("studio_owner").run();
    const ids = (cards.requests as { recent: { id: string }[] }).recent.map((r) => r.id);
    expect(ids).not.toContain("br3"); // approved
    expect(ids).not.toContain("sr2"); // executed
  });

  it("every ok card has a stable id and type and an empty action list (read only; ARIA attaches actions in a later phase)", async () => {
    const cards = await call("studio_owner").run();
    expect(cards.requests).toMatchObject({ cardId: "lesson_requests", cardType: "lesson_requests", actions: [] });
    expect(cards.leads).toMatchObject({ cardId: "new_leads", cardType: "new_leads", actions: [] });
    expect(cards.aria).toMatchObject({ cardId: "aria_suggestions", cardType: "aria_suggestions", actions: [] });
    expect(cards.exceptions).toMatchObject({ cardId: "operational_exceptions", cardType: "operational_exceptions", actions: [] });
    expect(cards.health).toMatchObject({ cardId: "studio_health", cardType: "studio_health", actions: [] });
  });

  it("ARIA suggestions are listed only as open suggestions: nothing approved, queued or completed, and no write is ever issued", async () => {
    const { run, w } = call("studio_owner");
    const cards = await run();
    expect((cards.aria as { recent: { status: string }[] }).recent.every((r) => r.status === "suggested" || r.status === "drafted")).toBe(true);
    expect(w.log.every((entry) => !("write" in entry))).toBe(true);
  });

  it("source labels are one origin whatever the spelling", () => {
    expect(leadSourceLabel("Website")).toBe("Website");
    expect(leadSourceLabel("Instagram")).toBe("Instagram");
    expect(leadSourceLabel("Friend or family")).toBe("Friend or family");
    expect(leadSourceLabel("  Event Registration ")).toBe("Other");
  });
});

describe("review fixes", () => {
  const person = (id: string, over: Row): Row => ({ id, studio_id: STUDIO, first_name: id, last_name: "Test", status: "lead", created_at: "2026-11-21T10:00:00Z", referral_source: null, source_system: null, is_independent_instructor: false, ...over });

  it("a big event's registrants cannot fill the lead scan and push real leads out", async () => {
    const registrants = Array.from({ length: 260 }, (_, i) => person("EV" + i, { referral_source: "Event Registration", source_system: "event_registration", created_at: "2026-11-22T10:00:00Z" }));
    const tables = { ...data, clients: [...data.clients, ...registrants] };
    const cards = await call("studio_owner", {}, tables).run();
    const leads = cards.leads as { truncated: boolean; recent: { id: string }[]; newLast7Days: number };
    expect(leads.truncated).toBe(false);
    expect(leads.recent.map((l) => l.id)).toEqual(["L1", "L2"]);
    expect(leads.newLast7Days).toBe(1);
  });

  it("a failing package lookup leaves the cancelled count alone (lowPackages is null, the card is still ok)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cards = await call("studio_owner", { failTables: ["client_packages"] }).run();
    expect(cards.exceptions).toMatchObject({ state: "ok", cancelledToday: 1, lowPackages: null });
    expect(spy.mock.calls.flat().join(" ")).not.toContain("row text that must never be logged");
    spy.mockRestore();
  });

  it("a public booking request has no client id: broad roles see the typed name, an instructor never does", async () => {
    const tables = {
      ...data,
      booking_requests: [{ id: "brP", studio_id: STUDIO, client_id: null, instructor_id: INSTRUCTOR, status: "pending", created_at: "2026-11-22T11:00:00Z", requested_starts_at: null, customer_first_name: "Pat", customer_last_name: "Walker" }],
      student_booking_action_requests: [],
    };
    const owner = await call("studio_owner", {}, tables).run();
    expect((owner.requests as { recent: { clientName: string | null }[] }).recent[0].clientName).toBe("Pat Walker");
    const instructor = await call("instructor", { instructorOf: INSTRUCTOR }, tables).run();
    expect((instructor.requests as { recent: { clientName: string | null }[] }).recent[0].clientName).toBeNull();
  });

  it("a self-service request linked to a booking request is not counted twice", async () => {
    const tables = {
      ...data,
      booking_requests: [{ id: "brL", studio_id: STUDIO, client_id: "c1", instructor_id: null, status: "pending", created_at: "2026-11-22T11:00:00Z", requested_starts_at: null }],
      student_booking_action_requests: [{ id: "srL", studio_id: STUDIO, client_id: "c1", instructor_id: null, action_type: "book", status: "pending", booking_request_id: "brL", created_at: "2026-11-22T11:00:01Z", requested_starts_at: null }],
    };
    const cards = await call("studio_owner", {}, tables).run();
    expect(cards.requests).toMatchObject({ total: 1, bookingRequests: 1, selfService: 0 });
  });

  it("an old 'new' or 'in_review' status is not an open request (the schema never allows them)", async () => {
    const tables = { ...data, booking_requests: [{ id: "x", studio_id: STUDIO, client_id: null, instructor_id: null, status: "new", created_at: "2026-11-22T11:00:00Z", requested_starts_at: null }], student_booking_action_requests: [] };
    expect((await call("studio_owner", {}, tables).run()).requests).toMatchObject({ total: 0 });
  });
});
