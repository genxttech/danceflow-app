/* eslint-disable @typescript-eslint/no-explicit-any -- loose in-memory PostgREST/Google fakes */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---- in-memory Google calendar (stand-in for the REST client) -------------------------
type GEvent = { id: string; payload: any };
const calendar = new Map<string, GEvent>();
let nextGoogleId = 1;
let failDelete = false;
let failLookup = false;
const googleCalls = { create: 0, patch: 0, delete: 0 };

vi.mock("@/lib/integrations/google-calendar/client", () => ({
  getValidGoogleCalendarAccessToken: async () => "token",
  upsertGoogleCalendarEvent: async ({ eventId, payload }: any) => {
    if (eventId && calendar.has(eventId)) {
      googleCalls.patch += 1;
      calendar.set(eventId, { id: eventId, payload });
      return { id: eventId };
    }
    googleCalls.create += 1; // no id, or id missing in Google (404/410 path) -> create
    const id = `g${nextGoogleId++}`;
    calendar.set(id, { id, payload });
    return { id };
  },
  deleteGoogleCalendarEvent: async ({ eventId }: any) => {
    if (failDelete) throw new Error("boom");
    googleCalls.delete += 1;
    calendar.delete(eventId); // missing is tolerated (404/410 -> deleted)
    return { deleted: true };
  },
}));

// ---- in-memory DB behind a chainable PostgREST-style fake ------------------------------
type Row = Record<string, any>;
const db: Record<string, Row[]> = {};
let nextRowId = 1;

function table(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let mode: "select" | "update" | "insert" = "select";
  let patch: Row = {};
  let isIdLookup = false;
  const builder: any = {
    select: () => builder,
    update: (p: Row) => { mode = "update"; patch = p; return builder; },
    insert: (p: Row) => { db[name] = db[name] ?? []; db[name].push({ id: `row${nextRowId++}`, ...p }); mode = "insert"; return builder; },
    eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return builder; },
    gte: (c: string, v: any) => { filters.push((r) => r[c] >= v); return builder; },
    lte: (c: string, v: any) => { filters.push((r) => r[c] <= v); return builder; },
    in: (c: string, v: any[]) => { isIdLookup = true; filters.push((r) => v.includes(r[c])); return builder; },
    not: () => builder,
    order: () => builder,
    then: (resolve: any) => {
      const rows = (db[name] ?? []).filter((r) => filters.every((f) => f(r)));
      if (failLookup && isIdLookup && name === "appointments") return resolve({ data: null, error: { message: "lookup down" } });
      if (mode === "update") rows.forEach((r) => Object.assign(r, patch));
      resolve({ data: mode === "select" ? rows.map((r) => ({ ...r })) : null, error: null });
    },
  };
  return builder;
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (n: string) => table(n) }) }));

import { zonedDateTimeToUtcDate } from "@/lib/booking/selfServiceAvailability";
import { syncGoogleCalendarConnection, type GoogleCalendarConnectionRow } from "../sync";

const studioConn: GoogleCalendarConnectionRow = { id: "c1", studio_id: "s1", connection_scope: "studio", instructor_id: null, calendar_id: "cal", sync_lessons: false, sync_classes: true, sync_events: false };
const instrConn: GoogleCalendarConnectionRow = { ...studioConn, id: "c2", connection_scope: "instructor", instructor_id: "i1" };

const day = 86_400_000;
const at = (days: number, hour = 18) => new Date(Math.floor((Date.now() + days * day) / day) * day + hour * 3_600_000).toISOString();
function appt(id: string, over: Row = {}): Row {
  return {
    id, studio_id: "s1", title: "Salsa Level 1", appointment_type: "group_class", status: "scheduled",
    starts_at: at(7), ends_at: at(7, 19), location_name: null, instructor_id: "i1",
    clients: null, instructors: { first_name: "Ana", last_name: "Diaz" }, rooms: { name: "Studio A" }, ...over,
  };
}
const find = (id: string) => (db.studio_google_calendar_sync_items ?? []).find((i) => i.source_id === id);
const liveEvents = () => [...calendar.values()];
const eventFor = (id: string) => liveEvents().filter((e) => e.payload.extendedProperties.private.danceflowSourceId === id);

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.appointments = []; db.events = []; db.studio_google_calendar_sync_items = []; db.studio_google_calendar_connections = [{ id: "c1" }, { id: "c2" }];
  calendar.clear(); nextGoogleId = 1; failDelete = false; failLookup = false; googleCalls.create = googleCalls.patch = googleCalls.delete = 0;
});

describe("S1E-4 Google reconciliation: group classes", () => {
  it("create converges to exactly one event per appointment and reruns are idempotent", async () => {
    db.appointments = [appt("a1"), appt("a2", { starts_at: at(14), ends_at: at(14, 19) }), appt("a3", { starts_at: at(21), ends_at: at(21, 19) })];
    expect((await syncGoogleCalendarConnection(studioConn)).synced).toBe(3);
    expect(liveEvents()).toHaveLength(3);
    await syncGoogleCalendarConnection(studioConn);
    await syncGoogleCalendarConnection(studioConn);
    expect(liveEvents()).toHaveLength(3);
    expect(googleCalls.create).toBe(3);
    expect(db.studio_google_calendar_sync_items).toHaveLength(3);
  });

  it("identity is the appointment id: a single edit patches the same event, never duplicates", async () => {
    db.appointments = [appt("a1")];
    await syncGoogleCalendarConnection(studioConn);
    const gid = find("a1")!.google_event_id;
    Object.assign(db.appointments[0], { starts_at: at(8), ends_at: at(8, 19), rooms: { name: "Studio B" }, title: "Salsa Advanced", instructors: { first_name: "Bo", last_name: "Lee" } });
    await syncGoogleCalendarConnection(studioConn);
    expect(find("a1")!.google_event_id).toBe(gid);
    expect(liveEvents()).toHaveLength(1);
    const p = calendar.get(gid)!.payload;
    expect(p.start.dateTime).toBe(at(8));
    expect(p.location).toBe("Studio B");
    expect(p.summary).toBe("Salsa Advanced");
    expect(p.description).toContain("Instructor: Bo Lee");
    expect(googleCalls.create).toBe(1);
    expect(db.studio_google_calendar_sync_items).toHaveLength(1);
  });

  it("a non-calendar change (notes/capacity) re-patches the same event and creates nothing new", async () => {
    db.appointments = [appt("a1", { notes: "x" })];
    await syncGoogleCalendarConnection(studioConn);
    const before = JSON.stringify(calendar.get(find("a1")!.google_event_id)!.payload);
    db.appointments[0].notes = "changed";
    await syncGoogleCalendarConnection(studioConn);
    expect(JSON.stringify(calendar.get(find("a1")!.google_event_id)!.payload)).toBe(before);
    expect(googleCalls.create).toBe(1);
  });

  it("S1C-5 split keeps appointment ids: series_id/ordinal changes never create, orphan or duplicate events", async () => {
    db.appointments = [0, 1, 2, 3].map((n) => appt(`a${n}`, { starts_at: at(7 * (n + 1)), ends_at: at(7 * (n + 1), 19), group_class_series_id: "S", series_occurrence_index: n }));
    await syncGoogleCalendarConnection(studioConn);
    const ids = Object.fromEntries(db.appointments.map((a) => [a.id, find(a.id)!.google_event_id]));
    // This-and-following from index 2: rows 2,3 move to successor series V2 and change time/room/title.
    for (const a of db.appointments.slice(2)) Object.assign(a, { group_class_series_id: "V2", series_occurrence_index: a.series_occurrence_index - 2, title: "Salsa Level 2", rooms: { name: "Studio C" }, starts_at: new Date(Date.parse(a.starts_at) + 3_600_000).toISOString() });
    await syncGoogleCalendarConnection(studioConn);
    expect(googleCalls.create).toBe(4); // initial only
    expect(liveEvents()).toHaveLength(4);
    for (const a of db.appointments) expect(find(a.id)!.google_event_id).toBe(ids[a.id]);
    expect(calendar.get(ids.a3)!.payload.summary).toBe("Salsa Level 2");
    expect(calendar.get(ids.a3)!.payload.location).toBe("Studio C");
    expect(calendar.get(ids.a0)!.payload.summary).toBe("Salsa Level 1"); // predecessor unchanged
    expect(calendar.get(ids.a0)!.payload.location).toBe("Studio A");
    expect(db.studio_google_calendar_sync_items).toHaveLength(4);
  });

  it("split with an occurrence cancelled in the same edit deletes only that one", async () => {
    db.appointments = ["a0", "a1", "a2"].map((id, n) => appt(id, { starts_at: at(7 * (n + 1)), ends_at: at(7 * (n + 1), 19) }));
    await syncGoogleCalendarConnection(studioConn);
    db.appointments[2].status = "cancelled";
    const r = await syncGoogleCalendarConnection(studioConn);
    expect(r.deleted).toBe(1);
    expect(eventFor("a2")).toHaveLength(0);
    expect(eventFor("a0")).toHaveLength(1);
    expect(eventFor("a1")).toHaveLength(1);
  });

  it("single cancellation deletes the event, is idempotent, and does not recreate it", async () => {
    db.appointments = [appt("a1")];
    await syncGoogleCalendarConnection(studioConn);
    db.appointments[0].status = "cancelled";
    await syncGoogleCalendarConnection(studioConn);
    await syncGoogleCalendarConnection(studioConn);
    expect(liveEvents()).toHaveLength(0);
    expect(googleCalls.create).toBe(1);
    expect(googleCalls.delete).toBe(1);
    expect(find("a1")).toMatchObject({ google_event_id: null, last_sync_status: "deleted" });
  });

  it("series cancellation removes cancelled future occurrences only; completed/other rows are untouched", async () => {
    db.appointments = [appt("f1"), appt("f2", { starts_at: at(14), ends_at: at(14, 19) }), appt("done", { status: "completed", starts_at: at(3), ends_at: at(3, 19) })];
    await syncGoogleCalendarConnection(studioConn);
    const doneEvent = find("done")!.google_event_id;
    db.appointments[0].status = "cancelled";
    db.appointments[1].status = "cancelled";
    await syncGoogleCalendarConnection(studioConn);
    expect(liveEvents().map((e) => e.id)).toEqual([doneEvent]);
  });

  it("an event already missing in Google still converges on delete, and a failed delete retries next run", async () => {
    db.appointments = [appt("a1")];
    await syncGoogleCalendarConnection(studioConn);
    calendar.clear(); // deleted externally
    db.appointments[0].status = "cancelled";
    failDelete = true;
    expect((await syncGoogleCalendarConnection(studioConn)).failed).toBe(1);
    expect(find("a1")!.google_event_id).not.toBeNull(); // kept so it is retried
    failDelete = false;
    const r = await syncGoogleCalendarConnection(studioConn);
    expect(r).toMatchObject({ deleted: 1, failed: 0 });
    expect(find("a1")!.google_event_id).toBeNull();
  });

  it("an externally-deleted live event is recreated once (not duplicated) on the next run", async () => {
    db.appointments = [appt("a1")];
    await syncGoogleCalendarConnection(studioConn);
    calendar.clear();
    await syncGoogleCalendarConnection(studioConn);
    await syncGoogleCalendarConnection(studioConn);
    expect(eventFor("a1")).toHaveLength(1);
    expect(db.studio_google_calendar_sync_items).toHaveLength(1);
  });

  it("class-sync disabled: no group-class events; lesson sync is independent of class sync", async () => {
    db.appointments = [appt("c1"), appt("l1", { appointment_type: "private_lesson", title: "Lesson" })];
    await syncGoogleCalendarConnection({ ...studioConn, sync_classes: false, sync_lessons: false });
    expect(liveEvents()).toHaveLength(0);
    await syncGoogleCalendarConnection({ ...studioConn, sync_classes: false, sync_lessons: true });
    expect(liveEvents().map((e) => e.payload.extendedProperties.private.danceflowSourceId)).toEqual(["l1"]);
    await syncGoogleCalendarConnection({ ...studioConn, sync_classes: true, sync_lessons: false });
    expect(eventFor("c1")).toHaveLength(1);
    expect(eventFor("l1")).toHaveLength(0); // lesson event removed once lesson sync is off
  });

  it("turning class sync off removes previously synced class events (current product rule)", async () => {
    db.appointments = [appt("c1")];
    await syncGoogleCalendarConnection(studioConn);
    await syncGoogleCalendarConnection({ ...studioConn, sync_classes: false });
    expect(liveEvents()).toHaveLength(0);
  });

  it("instructor-scoped connection follows instructor changes: reassign moves the event out and in", async () => {
    db.appointments = [appt("a1")];
    await syncGoogleCalendarConnection(instrConn);
    expect(liveEvents()).toHaveLength(1);
    db.appointments[0].instructor_id = "i2";
    await syncGoogleCalendarConnection(instrConn);
    expect(liveEvents()).toHaveLength(0);
  });

  it("cron and the manual Sync-now action both call the same reconciler (no separate class rule)", () => {
    const read = (f: string) => readFileSync(path.resolve(import.meta.dirname, f), "utf8");
    const cron = read("../../../../app/api/cron/google-calendar-sync/route.ts");
    const manual = read("../../../../app/app/settings/integrations/google-calendar/actions.ts");
    for (const src of [cron, manual]) {
      expect(src).toContain("syncGoogleCalendarConnection(connection)");
      expect(src).not.toMatch(/group_class|appointment_type/);
    }
  });

  it("event instants are true RFC3339 instants (DST-safe): 18:00 local across the Nov DST end stays 18:00 local", async () => {
    // Instants come from the canonical studio-local -> UTC conversion (what the schedule writers store).
    const ny = (date: string) => zonedDateTimeToUtcDate(date, "18:00", "America/New_York").toISOString();
    expect(ny("2030-11-02")).toBe("2030-11-02T22:00:00.000Z"); // EDT
    expect(ny("2030-11-09")).toBe("2030-11-09T23:00:00.000Z"); // EST
    expect(ny("2030-07-10")).toBe("2030-07-10T22:00:00.000Z"); // ordinary non-DST-boundary date
    db.appointments = [
      appt("pre", { starts_at: ny("2030-11-02"), ends_at: ny("2030-11-02") }),
      appt("post", { starts_at: ny("2030-11-09"), ends_at: ny("2030-11-09") }),
    ];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-10-25T00:00:00Z"));
    try { await syncGoogleCalendarConnection(studioConn); } finally { vi.useRealTimers(); }
    const fmt = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
    expect(fmt(calendar.get(find("pre")!.google_event_id)!.payload.start.dateTime)).toBe("18:00");
    expect(fmt(calendar.get(find("post")!.google_event_id)!.payload.start.dateTime)).toBe("18:00");
  });
});

describe("S1E-4 moving fetch window never deletes by itself", () => {
  const past = (days: number) => ({ starts_at: at(-days), ends_at: at(-days, 19) });
  const mapped = (id: string) => ({ ...find(id)! });

  it("a synced class that has become historical keeps its Google event and mapping (aged out of the window)", async () => {
    db.appointments = [appt("h1", past(0))]; // starts in the window...
    db.appointments[0].starts_at = at(2); db.appointments[0].ends_at = at(2, 19);
    await syncGoogleCalendarConnection(studioConn);
    const before = mapped("h1");
    Object.assign(db.appointments[0], past(5), { status: "completed" });
    for (let n = 0; n < 3; n += 1) expect(await syncGoogleCalendarConnection(studioConn)).toMatchObject({ deleted: 0, failed: 0 });
    expect(find("h1")).toMatchObject({ google_event_id: before.google_event_id, last_sync_status: "success" });
    expect(calendar.has(before.google_event_id)).toBe(true);
    expect(googleCalls.delete).toBe(0);
    expect(db.studio_google_calendar_sync_items).toHaveLength(1);
  });

  it("a mapped class now beyond the +90-day boundary keeps its event and mapping", async () => {
    db.appointments = [appt("far")];
    await syncGoogleCalendarConnection(studioConn);
    const gid = find("far")!.google_event_id;
    Object.assign(db.appointments[0], { starts_at: at(200), ends_at: at(200, 19) });
    expect(await syncGoogleCalendarConnection(studioConn)).toMatchObject({ deleted: 0, failed: 0 });
    expect(find("far")!.google_event_id).toBe(gid);
    expect(calendar.has(gid)).toBe(true);
  });

  it("an explicitly cancelled PAST mapping IS deleted (explicit ineligibility, not aging)", async () => {
    db.appointments = [appt("p1")];
    await syncGoogleCalendarConnection(studioConn);
    Object.assign(db.appointments[0], past(3), { status: "cancelled" });
    expect(await syncGoogleCalendarConnection(studioConn)).toMatchObject({ deleted: 1 });
    expect(find("p1")).toMatchObject({ google_event_id: null, last_sync_status: "deleted" });
    expect(liveEvents()).toHaveLength(0);
  });

  it("no_show outside the window is explicit ineligibility too", async () => {
    db.appointments = [appt("n1")];
    await syncGoogleCalendarConnection(studioConn);
    Object.assign(db.appointments[0], past(3), { status: "no_show" });
    await syncGoogleCalendarConnection(studioConn);
    expect(liveEvents()).toHaveLength(0);
  });

  it("sync_classes=false deletes class mappings even when they are outside the window, but leaves them alone while on", async () => {
    db.appointments = [appt("o1")];
    await syncGoogleCalendarConnection(studioConn);
    Object.assign(db.appointments[0], past(10), { status: "completed" });
    await syncGoogleCalendarConnection(studioConn);
    expect(liveEvents()).toHaveLength(1); // aged out: kept
    await syncGoogleCalendarConnection({ ...studioConn, sync_classes: false });
    expect(liveEvents()).toHaveLength(0); // setting off: removed
    expect(find("o1")).toMatchObject({ google_event_id: null, last_sync_status: "deleted" });
  });

  it("an appointment that no longer exists loses its event; instructor reassignment of a historical class removes it from the old instructor feed only", async () => {
    db.appointments = [appt("x1"), appt("x2")];
    await syncGoogleCalendarConnection(instrConn);
    db.appointments = db.appointments.filter((a) => a.id !== "x1");
    Object.assign(db.appointments[0], past(4), { instructor_id: "i2" });
    await syncGoogleCalendarConnection(instrConn);
    expect(liveEvents()).toHaveLength(0);
  });

  it("series cancellation with history: cancelled future occurrences deleted; completed past occurrence event + mapping untouched", async () => {
    db.appointments = [appt("hist", { starts_at: at(2), ends_at: at(2, 19) }), appt("f1", { starts_at: at(7), ends_at: at(7, 19) }), appt("f2", { starts_at: at(14), ends_at: at(14, 19) })];
    await syncGoogleCalendarConnection(studioConn);
    const histBefore = mapped("hist");
    Object.assign(db.appointments[0], past(1), { status: "completed" }); // class has now happened
    db.appointments[1].status = "cancelled"; db.appointments[2].status = "cancelled"; // series cancelled (released S1C semantics: future only)
    const r = await syncGoogleCalendarConnection(studioConn);
    expect(r).toMatchObject({ deleted: 2, failed: 0 });
    expect(find("hist")).toMatchObject({ google_event_id: histBefore.google_event_id, last_sync_status: "success" });
    expect(liveEvents().map((e) => e.id)).toEqual([histBefore.google_event_id]);
    expect(find("f1")!.google_event_id).toBeNull();
    expect(find("f2")!.google_event_id).toBeNull();
  });

  it("if the appointment lookup fails the mapping is retained (never deleted blind) and the run reports failure", async () => {
    db.appointments = [appt("l1")];
    await syncGoogleCalendarConnection(studioConn);
    Object.assign(db.appointments[0], past(5));
    failLookup = true;
    const r = await syncGoogleCalendarConnection(studioConn);
    expect(r.failed).toBeGreaterThan(0);
    expect(r.deleted).toBe(0);
    expect(calendar.size).toBe(1);
    failLookup = false;
    expect(await syncGoogleCalendarConnection(studioConn)).toMatchObject({ deleted: 0, failed: 0 });
    expect(calendar.size).toBe(1);
  });
});
