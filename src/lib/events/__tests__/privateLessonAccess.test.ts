/* eslint-disable @typescript-eslint/no-explicit-any -- loose in-memory PostgREST fake */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = Record<string, any>;
type Query = { client: "admin" | "session"; table: string; columns: string; filters: Array<[string, unknown]> };
let queries: Query[] = [];
let data: Record<"admin" | "session", Record<string, Row[]>>;
let errors: Record<string, string> = {};

function fake(client: "admin" | "session") {
  return {
    from(table: string) {
      const query: Query = { client, table, columns: "", filters: [] };
      queries.push(query);
      const rows = () => (data[client][table] ?? []).filter((row) => query.filters.every(([c, v]) => row[c] === v));
      const result = () => (errors[table] ? { data: null, error: { message: errors[table] } } : { data: rows(), error: null });
      const builder: any = {
        select: (columns: string) => { query.columns = columns; return builder; },
        eq: (c: string, v: unknown) => { query.filters.push([c, v]); return builder; },
        order: () => builder,
        maybeSingle: async () => { const r = result(); return { data: r.data?.[0] ?? null, error: r.error }; },
        then: (resolve: any) => resolve(result()),
      };
      return builder;
    },
  };
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake("admin") }));

import { GUEST_COACH_COLUMNS, VISITOR_SLOT_COLUMNS, isEventPubliclyListed, loadVisitorPrivateLessonSlots, resolveGuestCoachAccess } from "../privateLessonAccess";

const session = () => fake("session") as any;
const admin = () => fake("admin") as any;
const EVENT = { id: "e1", status: "published", visibility: "public", public_directory_enabled: false, studio_id: "s1" };
const coachRow = { id: "c1", event_id: "e1", schedule_token: "tok", active: true, schedule_token_enabled: true };
const slot = (over: Row = {}) => ({ id: "l1", event_id: "e1", status: "available", payment_status: "unpaid", event_guest_coaches: { id: "c1", name: "N", bio: null, photo_url: null, active: true }, ...over });

function seed(event: Row = {}, studio: Row = {}) {
  const base = { events: [{ ...EVENT, ...event }], studios: [{ id: "s1", subscription_status: "active", ...studio }], event_private_lesson_slots: [slot()], event_guest_coaches: [coachRow] };
  data = { admin: structuredClone(base), session: { event_private_lesson_slots: [], event_guest_coaches: [] } };
}

beforeEach(() => { queries = []; errors = {}; seed(); });

describe("visitor private-lesson columns", () => {
  it("never include buyer, client, payment reference, hold or link columns", () => {
    expect(VISITOR_SLOT_COLUMNS).not.toMatch(/buyer|client|stripe|hold|token|order_id|\*/);
    expect(GUEST_COACH_COLUMNS).not.toMatch(/\bschedule_token\b|\*/);
  });
});

describe("isEventPubliclyListed", () => {
  it.each([
    ["published and public", {}, {}, true],
    ["unlisted but in the public directory", { visibility: "unlisted", public_directory_enabled: true }, {}, true],
    ["trialing studio", {}, { subscription_status: "trialing" }, true],
    ["draft", { status: "draft" }, {}, false],
    ["unlisted", { visibility: "unlisted" }, {}, false],
    ["no studio", { studio_id: null }, {}, false],
    ["canceled studio", {}, { subscription_status: "canceled" }, false],
  ])("%s", async (_name, event, studio, expected) => {
    seed(event, studio);
    await expect(isEventPubliclyListed(admin(), "e1")).resolves.toBe(expected);
  });

  it("fails closed on read errors and unknown events", async () => {
    await expect(isEventPubliclyListed(admin(), "nope")).resolves.toBe(false);
    errors.events = "boom";
    await expect(isEventPubliclyListed(admin(), "e1")).rejects.toThrow("boom");
  });
});

describe("loadVisitorPrivateLessonSlots", () => {
  const slotQuery = () => queries.find((q) => q.table === "event_private_lesson_slots")!;

  it("reads a listed event server-side, scoped to the event and to open slots, and strips the coach's active flag", async () => {
    const { data: rows } = await loadVisitorPrivateLessonSlots("e1", session());
    expect(slotQuery().client).toBe("admin");
    expect(slotQuery().columns).toBe(VISITOR_SLOT_COLUMNS);
    expect(slotQuery().filters).toEqual([["event_id", "e1"], ["status", "available"], ["payment_status", "unpaid"]]);
    expect(rows![0].event_guest_coaches).toEqual({ id: "c1", name: "N", bio: null, photo_url: null });
  });

  it("hides an inactive coach", async () => {
    data.admin.event_private_lesson_slots = [slot({ event_guest_coaches: { id: "c1", name: "N", bio: null, photo_url: null, active: false } })];
    const { data: rows } = await loadVisitorPrivateLessonSlots("e1", session());
    expect(rows![0].event_guest_coaches).toBeNull();
  });

  it("uses the caller's session, never the service role, for an event that is not listed", async () => {
    seed({ status: "draft" });
    const { data: rows } = await loadVisitorPrivateLessonSlots("e1", session());
    expect(slotQuery().client).toBe("session");
    expect(rows).toEqual([]);
  });

  it("returns the query error", async () => {
    errors.event_private_lesson_slots = "boom";
    const { data: rows, error } = await loadVisitorPrivateLessonSlots("e1", session());
    expect(rows).toBeNull();
    expect(error?.message).toBe("boom");
  });
});

describe("resolveGuestCoachAccess", () => {
  it("resolves a live link on a listed event to the server client", async () => {
    const access = await resolveGuestCoachAccess("tok", session());
    expect(access?.coach.id).toBe("c1");
    const probe = queries.length;
    await access!.db.from("event_private_lesson_slots").select("id");
    expect(queries[probe].client).toBe("admin");
    expect(queries[0].filters).toEqual([["schedule_token", "tok"], ["active", true], ["schedule_token_enabled", true]]);
  });

  it.each([
    ["wrong link", () => {}, "other"],
    ["inactive coach", () => { data.admin.event_guest_coaches = [{ ...coachRow, active: false }]; }, "tok"],
    ["disabled link", () => { data.admin.event_guest_coaches = [{ ...coachRow, schedule_token_enabled: false }]; }, "tok"],
    ["unlisted event and no staff session", () => { seed({ status: "draft" }); }, "tok"],
  ])("returns nothing for a %s", async (_name, arrange, token) => {
    arrange();
    await expect(resolveGuestCoachAccess(token, session())).resolves.toBeNull();
  });

  it("lets the event's own staff preview an unlisted event through their session only", async () => {
    seed({ status: "draft" });
    data.session.event_guest_coaches = [coachRow];
    const access = await resolveGuestCoachAccess("tok", session());
    const probe = queries.length;
    await access!.db.from("event_private_lesson_slots").select("id");
    expect(queries[probe].client).toBe("session");
  });
});
