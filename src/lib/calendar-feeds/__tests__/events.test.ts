/* eslint-disable @typescript-eslint/no-explicit-any -- loose fixture rows */
import { describe, expect, it } from "vitest";
import { loadFeedEvents, type FeedSubject } from "../events";
import { FakeAdmin } from "./fakeAdmin";

const NOW = new Date("2026-12-01T12:00:00Z");
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const U_DANCER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U_STAFF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C_ADULT = "c0000000-0000-4000-8000-000000000001";
const C_MINOR = "c0000000-0000-4000-8000-000000000002";
const C_OTHER = "c0000000-0000-4000-8000-000000000003";
const I1 = "d0000000-0000-4000-8000-000000000001";

const iso = (days: number, hour = 18) => new Date(NOW.getTime() + days * 86400000 + (hour - 12) * 3600000).toISOString();

function appt(over: Record<string, unknown>) {
  const startsAt = (over.starts_at as string) ?? iso(2);
  return {
    id: `a-${Math.random().toString(16).slice(2, 10)}`,
    studio_id: S1,
    title: null,
    notes: "SECRET INTERNAL NOTE phone 555-0100",
    appointment_type: "private_lesson",
    status: "scheduled",
    starts_at: startsAt,
    ends_at: new Date(Date.parse(startsAt) + 3600000).toISOString(),
    location_name: null,
    client_id: C_ADULT,
    partner_client_id: null,
    instructor_id: I1,
    room_id: null,
    updated_at: "2026-11-25T10:00:00Z",
    cancelled_at: null,
    ...over,
  };
}

function world(extra: Record<string, any[]> = {}) {
  return new FakeAdmin({
    studios: [
      { id: S1, name: "Studio One", public_name: "Studio One Dance" },
      { id: S2, name: "Studio Two", public_name: null },
    ],
    instructors: [{ id: I1, studio_id: S1, user_id: U_STAFF, active: true, first_name: "Sam" }],
    clients: [
      { id: C_ADULT, studio_id: S1, first_name: "Alex", last_name: "Rivera", date_of_birth: "1990-05-05" },
      { id: C_MINOR, studio_id: S1, first_name: "Mia", last_name: "Kent", date_of_birth: "2015-03-03" },
      { id: C_OTHER, studio_id: S1, first_name: "Other", last_name: "Person", date_of_birth: "1980-01-01" },
    ],
    rooms: [{ id: "r1", studio_id: S1, name: "Studio A" }],
    client_account_links: [
      { studio_id: S1, user_id: U_DANCER, client_id: C_ADULT, status: "linked", can_view_schedule: true },
      { studio_id: S1, user_id: U_DANCER, client_id: C_MINOR, status: "linked", can_view_schedule: true },
      { studio_id: S1, user_id: U_DANCER, client_id: C_OTHER, status: "linked", can_view_schedule: false },
    ],
    appointment_attendees: [],
    appointments: [],
    ...extra,
  });
}

const staff = (detail: "minimal" | "standard" = "minimal"): FeedSubject => ({ studioId: S1, subjectKind: "staff", subjectUserId: U_STAFF, detailLevel: detail, includeClientIds: null });
const dancer = (detail: "minimal" | "standard" = "minimal", include: string[] | null = null): FeedSubject => ({ studioId: S1, subjectKind: "dancer_account", subjectUserId: U_DANCER, detailLevel: detail, includeClientIds: include });

describe("loadFeedEvents: privacy", () => {
  it("never emits notes, client names (minimal), contact data or free-text private-lesson titles", async () => {
    const admin = world({ appointments: [appt({ id: "p1", title: "Lesson with Alex Rivera 555-0100" })] });
    const { events } = await loadFeedEvents(admin, staff("minimal"), NOW);
    expect(events).toHaveLength(1);
    const blob = JSON.stringify(events);
    expect(blob).not.toMatch(/SECRET|555|Alex|Rivera/);
    expect(events[0].summary).toBe("Private lesson");
    expect(events[0].description).toBe("Open DanceFlow for details.");
  });

  it("staff standard: first name + last initial for adults, first name only for minors and unknown ages", async () => {
    const unknown = "c0000000-0000-4000-8000-000000000009";
    const admin = world({
      clients: [
        { id: C_ADULT, studio_id: S1, first_name: "Alex", last_name: "Rivera", date_of_birth: "1990-05-05" },
        { id: C_MINOR, studio_id: S1, first_name: "Mia", last_name: "Kent", date_of_birth: "2015-03-03" },
        { id: unknown, studio_id: S1, first_name: "Noa", last_name: "Lane", date_of_birth: null },
      ],
      appointments: [appt({ id: "p1", client_id: C_ADULT }), appt({ id: "p2", client_id: C_MINOR, starts_at: iso(3) }), appt({ id: "p3", client_id: unknown, starts_at: iso(4) })],
    });
    const { events } = await loadFeedEvents(admin, staff("standard"), NOW);
    const byUid = Object.fromEntries(events.map((e) => [e.uid, e.summary]));
    expect(byUid["p1@danceflow"]).toBe("Private lesson: Alex R.");
    expect(byUid["p2@danceflow"]).toBe("Private lesson: Mia");
    expect(byUid["p3@danceflow"]).toBe("Private lesson: Noa");
    expect(JSON.stringify(events)).not.toMatch(/Kent|Lane|Rivera/);
  });

  it("dancer standard adds only the instructor first name; no other participants", async () => {
    const admin = world({ appointments: [appt({ id: "p1" })] });
    const { events } = await loadFeedEvents(admin, dancer("standard"), NOW);
    expect(events[0].summary).toBe("Private lesson with Sam");
    expect(JSON.stringify(events)).not.toMatch(/Rivera|SECRET/);
  });

  it("applies the event-type allowlist: no events, unavailable blocks; floor rental only for staff", async () => {
    const rows = [
      appt({ id: "ok", appointment_type: "group_class", title: "Salsa Level 1", client_id: null }),
      appt({ id: "ev", appointment_type: "event" }),
      appt({ id: "ru", appointment_type: "room_unavailable" }),
      appt({ id: "fr", appointment_type: "floor_space_rental" }),
    ];
    const staffFeed = await loadFeedEvents(world({ appointments: rows }), staff(), NOW);
    expect(staffFeed.events.map((e) => e.uid).sort()).toEqual(["fr@danceflow", "ok@danceflow"]);
    const dancerWorld = world({
      appointments: rows.map((r) => ({ ...r, client_id: C_ADULT })),
    });
    const dancerFeed = await loadFeedEvents(dancerWorld, dancer(), NOW);
    expect(dancerFeed.events.map((e) => e.uid)).toEqual(["ok@danceflow"]);
    expect(dancerFeed.events[0].summary).toBe("Salsa Level 1");
  });

  it("no_show is never emitted", async () => {
    const admin = world({ appointments: [appt({ id: "n1", status: "no_show", starts_at: iso(-1) })] });
    expect((await loadFeedEvents(admin, staff(), NOW)).events).toHaveLength(0);
  });
});

describe("loadFeedEvents: visibility and isolation", () => {
  it("dancer sees only linked profiles with can_view_schedule; never another client's lessons", async () => {
    const admin = world({
      appointments: [appt({ id: "mine", client_id: C_ADULT }), appt({ id: "kid", client_id: C_MINOR, starts_at: iso(3) }), appt({ id: "hidden", client_id: C_OTHER, starts_at: iso(4) }), appt({ id: "stranger", client_id: "c0000000-0000-4000-8000-0000000000ff", starts_at: iso(5) })],
    });
    const { events } = await loadFeedEvents(admin, dancer(), NOW);
    expect(events.map((e) => e.uid).sort()).toEqual(["kid@danceflow", "mine@danceflow"]);
  });

  it("guardian can limit the feed to chosen dependents", async () => {
    const admin = world({ appointments: [appt({ id: "mine", client_id: C_ADULT }), appt({ id: "kid", client_id: C_MINOR, starts_at: iso(3) })] });
    const { events } = await loadFeedEvents(admin, dancer("minimal", [C_MINOR]), NOW);
    expect(events.map((e) => e.uid)).toEqual(["kid@danceflow"]);
  });

  it("a link that is no longer linked removes the profile immediately (re-evaluated per request)", async () => {
    const admin = world({ appointments: [appt({ id: "kid", client_id: C_MINOR })] });
    expect((await loadFeedEvents(admin, dancer(), NOW)).events).toHaveLength(1);
    admin.tables.client_account_links = admin.tables.client_account_links.map((l) => (l.client_id === C_MINOR ? { ...l, status: "disconnected" } : l));
    expect((await loadFeedEvents(admin, dancer(), NOW)).events).toHaveLength(0);
  });

  it("never returns another studio's rows even when ids collide with the subject", async () => {
    const admin = world({ appointments: [appt({ id: "s2row", studio_id: S2 }), appt({ id: "s1row" })] });
    const staffFeed = await loadFeedEvents(admin, staff(), NOW);
    expect(staffFeed.events.map((e) => e.uid)).toEqual(["s1row@danceflow"]);
    const dancerFeed = await loadFeedEvents(admin, dancer(), NOW);
    expect(dancerFeed.events.map((e) => e.uid)).toEqual(["s1row@danceflow"]);
  });

  it("every query is filtered by the token's studio (isolation guard)", async () => {
    const admin = world({ appointments: [appt({ id: "p1" })], appointment_attendees: [{ studio_id: S1, appointment_id: "p1", client_id: C_ADULT, status: "booked", updated_at: "2026-11-25T10:00:00Z" }] });
    await loadFeedEvents(admin, dancer("standard"), NOW);
    await loadFeedEvents(admin, staff("standard"), NOW);
    expect(admin.queries.length).toBeGreaterThan(5);
    for (const q of admin.queries) {
      const col = q.table === "studios" ? "id" : "studio_id";
      expect(q.filters.some((f) => f.op === "eq" && f.col === col && f.val === S1), `query on ${q.table} lacks studio filter`).toBe(true);
    }
  });

  it("staff without an active instructor row get an empty feed", async () => {
    const admin = world({ appointments: [appt({ id: "p1" })] });
    admin.tables.instructors = [{ id: I1, studio_id: S1, user_id: U_STAFF, active: false, first_name: "Sam" }];
    expect((await loadFeedEvents(admin, staff(), NOW)).events).toHaveLength(0);
  });
});

describe("loadFeedEvents: lifecycle", () => {
  it("emits CANCELLED with SEQUENCE+1 and the same UID for 30 days, then drops it", async () => {
    const live = appt({ id: "x1", starts_at: iso(2) });
    const cancelledRecent = appt({ id: "x2", status: "cancelled", starts_at: iso(-10), updated_at: "2026-11-28T10:00:00Z" });
    const cancelledOld = appt({ id: "x3", status: "cancelled", starts_at: iso(-45) });
    const admin = world({ appointments: [live, cancelledRecent, cancelledOld] });
    const { events } = await loadFeedEvents(admin, staff(), NOW);
    const byUid = Object.fromEntries(events.map((e) => [e.uid, e]));
    expect(byUid["x1@danceflow"].status).toBe("CONFIRMED");
    expect(byUid["x2@danceflow"].status).toBe("CANCELLED");
    expect(byUid["x2@danceflow"].sequence).toBeGreaterThan(0);
    expect(byUid["x3@danceflow"]).toBeUndefined();
  });

  it("a reschedule keeps the UID and raises SEQUENCE", async () => {
    const before = appt({ id: "r1", updated_at: "2026-11-25T10:00:00Z" });
    const after = { ...before, starts_at: iso(3), ends_at: new Date(Date.parse(iso(3)) + 3600000).toISOString(), updated_at: "2026-11-26T10:00:00Z" };
    const a = (await loadFeedEvents(world({ appointments: [before] }), staff(), NOW)).events[0];
    const b = (await loadFeedEvents(world({ appointments: [after] }), staff(), NOW)).events[0];
    expect(b.uid).toBe(a.uid);
    expect(b.sequence).toBeGreaterThan(a.sequence);
    expect(b.startsAt).not.toBe(a.startsAt);
  });

  it("a dancer cancelling their own spot cancels it only in their feed", async () => {
    const klass = appt({ id: "g1", appointment_type: "group_class", title: "Waltz", client_id: null, instructor_id: I1 });
    const admin = world({
      appointments: [klass],
      appointment_attendees: [
        { studio_id: S1, appointment_id: "g1", client_id: C_ADULT, status: "cancelled", cancelled_at: "2026-11-29T09:00:00Z", updated_at: "2026-11-29T09:00:00Z" },
        { studio_id: S1, appointment_id: "g1", client_id: C_OTHER, status: "booked", updated_at: "2026-11-20T09:00:00Z" },
      ],
    });
    const mine = (await loadFeedEvents(admin, dancer("minimal", [C_ADULT]), NOW)).events;
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe("CANCELLED");
    const staffView = (await loadFeedEvents(admin, staff(), NOW)).events;
    expect(staffView[0].status).toBe("CONFIRMED");
  });

  it("group-class bookings via attendees appear for the dancer", async () => {
    const klass = appt({ id: "g2", appointment_type: "group_class", title: "Tango", client_id: null });
    const admin = world({ appointments: [klass], appointment_attendees: [{ studio_id: S1, appointment_id: "g2", client_id: C_ADULT, status: "booked", updated_at: "2026-11-20T09:00:00Z" }] });
    const { events } = await loadFeedEvents(admin, dancer(), NOW);
    expect(events.map((e) => e.summary)).toEqual(["Tango"]);
  });

  it("caps the window: nothing beyond 120 days, nothing older than 7 days (live)", async () => {
    const admin = world({ appointments: [appt({ id: "far", starts_at: iso(130) }), appt({ id: "old", starts_at: iso(-10) }), appt({ id: "ok", starts_at: iso(100) })] });
    const { events } = await loadFeedEvents(admin, staff(), NOW);
    expect(events.map((e) => e.uid)).toEqual(["ok@danceflow"]);
  });
});
