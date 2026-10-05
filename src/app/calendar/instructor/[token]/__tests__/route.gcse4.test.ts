/* eslint-disable @typescript-eslint/no-explicit-any -- loose in-memory PostgREST/Google fakes */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};

function table(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const b: any = {
    select: () => b,
    update: () => b,
    eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return b; },
    gte: (c: string, v: any) => { filters.push((r) => r[c] >= v); return b; },
    lte: (c: string, v: any) => { filters.push((r) => r[c] <= v); return b; },
    in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return b; },
    not: (c: string, op: string, v: any) => { if (op === "eq") filters.push((r) => r[c] !== v); return b; },
    order: () => b,
    single: () => { const rows = (db[name] ?? []).filter((r) => filters.every((f) => f(r))); return Promise.resolve(rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "none" } }); },
    then: (resolve: any) => resolve({ data: (db[name] ?? []).filter((r) => filters.every((f) => f(r))), error: null }),
  };
  return b;
}
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (n: string) => table(n) }) }));

import { zonedDateTimeToUtcDate } from "@/lib/booking/selfServiceAvailability";
import { GET } from "../route";

const day = 86_400_000;
const at = (days: number, hour = 22) => new Date(Math.floor((Date.now() + days * day) / day) * day + hour * 3_600_000).toISOString();
const appt = (id: string, over: Row = {}): Row => ({ id, studio_id: "s1", instructor_id: "i1", title: "Salsa Level 1", appointment_type: "group_class", status: "scheduled", starts_at: at(7), ends_at: at(7, 23), notes: null, client_id: null, room_id: "r1", ...over });

async function feed() {
  const res = await GET(new Request("http://x"), { params: Promise.resolve({ token: "tok.ics" }) });
  expect(res.status).toBe(200);
  return res.text();
}
const uids = (ics: string) => [...ics.matchAll(/^UID:(.+)$/gm)].map((m) => m[1]);

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
  db.instructor_calendar_feeds = [{ id: "f1", studio_id: "s1", instructor_id: "i1", token: "tok", active: true }];
  db.instructors = [{ id: "i1", studio_id: "s1", first_name: "Ana", last_name: "Diaz", email: null }];
  db.rooms = [{ id: "r1", studio_id: "s1", name: "Studio A" }, { id: "r2", studio_id: "s1", name: "Studio B" }];
  db.clients = [];
  db.appointments = [];
});

describe("S1E-4 instructor ICS: group classes", () => {
  it("active class appears with appointment UID, UTC start/end, title and room", async () => {
    db.appointments = [appt("a1")];
    const ics = await feed();
    expect(uids(ics)).toEqual(["a1@danceflow"]);
    const iso = (s: string) => s.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    expect(ics).toContain(`DTSTART:${iso(db.appointments[0].starts_at)}`);
    expect(ics).toContain(`DTEND:${iso(db.appointments[0].ends_at)}`);
    expect(ics).toContain("SUMMARY:Salsa Level 1");
    expect(ics).toContain("LOCATION:Studio A");
  });

  it("times are true instants: 18:00 New York local is emitted as 22:00Z (EDT) / 23:00Z (EST), never floating UTC wall-clock", async () => {
    // PostgREST returns timestamptz as UTC strings; derive them from studio-local 18:00 via the canonical conversion.
    const ny = (date: string) => zonedDateTimeToUtcDate(date, "18:00", "America/New_York").toISOString().replace(".000Z", "+00:00");
    db.appointments = [
      appt("pre", { starts_at: ny("2030-11-02"), ends_at: ny("2030-11-02") }),
      appt("post", { starts_at: ny("2030-11-09"), ends_at: ny("2030-11-09") }),
    ];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-10-25T00:00:00Z"));
    let ics: string;
    try { ics = await feed(); } finally { vi.useRealTimers(); }
    expect(ics).toContain("DTSTART:20301102T220000Z");
    expect(ics).toContain("DTSTART:20301109T230000Z");
    expect(ics).not.toMatch(/DTSTART:\d{8}T\d{6}\r?$/m); // no floating times
  });

  it("single edit is reflected under the same UID", async () => {
    db.appointments = [appt("a1")];
    const first = await feed();
    Object.assign(db.appointments[0], { starts_at: at(8), ends_at: at(8, 23), room_id: "r2", title: "Salsa Advanced" });
    const second = await feed();
    expect(uids(second)).toEqual(uids(first));
    expect(second).toContain("SUMMARY:Salsa Advanced");
    expect(second).toContain("LOCATION:Studio B");
    expect(second).not.toContain("LOCATION:Studio A");
  });

  it("non-DST ordinary date: 18:00 New York in July is 22:00Z", async () => {
    const t = zonedDateTimeToUtcDate("2030-07-10", "18:00", "America/New_York").toISOString();
    db.appointments = [appt("jul", { starts_at: t, ends_at: t })];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-07-01T00:00:00Z"));
    let ics: string;
    try { ics = await feed(); } finally { vi.useRealTimers(); }
    expect(ics).toContain("DTSTART:20300710T220000Z");
    expect(ics).not.toMatch(/TZID/);
  });

  it("instructor reassignment moves the UID out of this feed; location_name wins over room, room is the fallback, blank is omitted", async () => {
    db.appointments = [appt("a1", { location_name: " Rented Ballroom " }), appt("a2", { location_name: null }), appt("a3", { location_name: "  ", room_id: null })];
    const ics = await feed();
    expect(ics).toContain("LOCATION:Rented Ballroom");
    expect(ics).toContain("LOCATION:Studio A");
    expect(ics.match(/^LOCATION:/gm)).toHaveLength(2);
    db.appointments[0].instructor_id = "i2";
    expect(uids(await feed())).toEqual(["a2@danceflow", "a3@danceflow"]);
  });

  it("S1C-5 split keeps every appointment UID (series_id changes are invisible to the feed)", async () => {
    db.appointments = [0, 1, 2].map((n) => appt(`a${n}`, { starts_at: at(7 * (n + 1)), ends_at: at(7 * (n + 1), 23), group_class_series_id: "S" }));
    const before = uids(await feed());
    for (const a of db.appointments.slice(1)) Object.assign(a, { group_class_series_id: "V2", title: "Salsa Level 2" });
    const after = uids(await feed());
    expect(after).toEqual(before);
    expect(new Set(after).size).toBe(3);
  });

  it("cancelled occurrence (single or series) is omitted; past cancelled and other instructors are not listed", async () => {
    db.appointments = [appt("keep"), appt("gone", { status: "cancelled" }), appt("gone2", { status: "cancelled", starts_at: at(14), ends_at: at(14, 23) }), appt("other", { instructor_id: "i2" })];
    expect(uids(await feed())).toEqual(["keep@danceflow"]);
  });

  it("repeated generation is deterministic (apart from DTSTAMP)", async () => {
    db.appointments = [appt("a1"), appt("a2", { starts_at: at(14), ends_at: at(14, 23) })];
    const strip = (s: string) => s.replace(/^DTSTAMP:.*$/gm, "");
    expect(strip(await feed())).toBe(strip(await feed()));
  });
});
