/* eslint-disable @typescript-eslint/no-explicit-any -- loose PostgREST fake */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};
const selects: string[] = [];

function table(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let isUpdate = false;
  const b: any = {
    select: (cols?: string) => { if (cols) selects.push(`${name}:${cols}`); return b; },
    update: () => { isUpdate = true; return b; },
    eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return b; },
    lt: () => b,
    or: () => b,
    order: () => b,
    single: async () => { const rows = (db[name] ?? []).filter((r) => filters.every((f) => f(r))); return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "none" } }; },
    then: (resolve: any) => resolve({ data: isUpdate ? null : (db[name] ?? []).filter((r) => filters.every((f) => f(r))), error: null }),
  };
  return b;
}
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: (n: string) => table(n) }) }));

import { GET } from "../route";

const TOKEN = "t".repeat(32);
beforeEach(() => {
  selects.length = 0;
  db.event_guest_coaches = [{ id: "c1", event_id: "e1", name: "Coach Kim", schedule_token: TOKEN, schedule_token_enabled: true, active: true }];
  db.events = [{ id: "e1", name: "Spring Fling", slug: "sf", venue_name: "Hall", city: "Austin", state: "TX", timezone: "America/Chicago" }];
  db.event_private_lesson_slots = [
    { id: "s1", coach_id: "c1", starts_at: "2030-05-01T15:00:00Z", ends_at: "2030-05-01T16:00:00Z", location_label: "Room 1", status: "booked", buyer_name: "Pat Student", buyer_email: "pat@private.test", buyer_phone: "+15125550123", buyer_notes: "has a knee injury", held_until: null, updated_at: null },
    { id: "s2", coach_id: "c1", starts_at: "2030-05-01T17:00:00Z", ends_at: "2030-05-01T18:00:00Z", location_label: null, status: "held", buyer_name: null, buyer_email: null, buyer_phone: null, buyer_notes: "Lunch", held_until: null, updated_at: null },
  ];
});

describe("coach schedule ICS privacy", () => {
  it("keeps the student name but never emits buyer email, phone or notes", async () => {
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ token: TOKEN }) });
    const ics = (await res.text()).replace(/\r\n /g, "");
    expect(ics).toContain("Private Lesson - Pat Student");
    expect(ics).toContain("Student: Pat Student");
    expect(ics).not.toContain("pat@private.test");
    expect(ics).not.toContain("5125550123");
    expect(ics).not.toContain("knee injury");
    expect(ics).not.toMatch(/Email:|Phone:|Notes:/);
  });

  it("does not even select buyer email or phone for the feed", async () => {
    await GET(new Request("http://x"), { params: Promise.resolve({ token: TOKEN }) });
    const slotSelect = selects.find((s) => s.startsWith("event_private_lesson_slots:")) ?? "";
    expect(slotSelect).not.toMatch(/buyer_email|buyer_phone/);
  });

  it("staff-entered block reasons still show on blocked time", async () => {
    const ics = (await (await GET(new Request("http://x"), { params: Promise.resolve({ token: TOKEN }) })).text()).replace(/\r\n /g, "");
    expect(ics).toContain("Blocked - Lunch");
  });
});
