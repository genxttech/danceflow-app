import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GC-S1E-2: automatic group-class notices (change / enrollment / removal, single class and consolidated series operations).
 * The orchestrators run against an in-memory database and stub the outbound queue and the push sender, so these tests prove
 * who is told, how many times, with what content and under which idempotency key; and that a failure never throws.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  queue: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (t: string) => new Builder(t) }) }));
vi.mock("@/lib/notifications/outbound", () => ({ queueOutboundDelivery: (...a: unknown[]) => h.queue(...a) }));
vi.mock("@/lib/notifications/schedulePush", () => ({ sendGroupClassNoticePush: (...a: unknown[]) => h.push(...a) }));

class Builder implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Array<(r: Row) => boolean> = [];
  constructor(private table: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  in(c: string, vals: unknown[]) { this.filters.push((r) => vals.includes(r[c])); return this; }
  gte(c: string, v: unknown) { this.filters.push((r) => Number(r[c]) >= Number(v)); return this; }
  maybeSingle() { return this.then((r) => ({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error })); }
  then<T1, T2>(a?: ((v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null, b?: ((r: unknown) => T2 | PromiseLike<T2>) | null) {
    return Promise.resolve()
      .then(() => ({ data: (h.db[this.table] ?? []).filter((r) => this.filters.every((f) => f(r))).map((r) => ({ ...r })), error: null }))
      .then(a, b);
  }
}

const n = await import("../groupClassNotices");
const editNotice = await import("@/lib/schedule/groupClassEditNotice");

const S1 = "studio-1";
const S2 = "studio-2";
const NOW_TZ = "America/New_York";

const START_A = "2030-05-01T22:00:00.000Z"; // 6:00 PM EDT
const END_A = "2030-05-01T23:00:00.000Z";
const START_B = "2030-05-02T23:00:00.000Z"; // next day 7:00 PM EDT
const END_B = "2030-05-03T00:00:00.000Z";

const snap = (over: Partial<import("../groupClassNotices").ClassMaterialSnapshot> = {}) => ({
  startsAt: START_A,
  endsAt: END_A,
  instructorId: "i1",
  roomId: "r1",
  locationName: null as string | null,
  ...over,
});

const client = (id: string, over: Row = {}) => ({ id, studio_id: S1, first_name: id.toUpperCase(), email: `${id}@example.test`, ...over });
const attendee = (cls: string, clientId: string, over: Row = {}) => ({ studio_id: S1, appointment_id: cls, client_id: clientId, status: "booked", ...over });

function seed(over: Record<string, Row[]> = {}) {
  h.db = {
    studios: [{ id: S1, name: "Studio One", public_name: "Studio One", public_logo_url: null, slug: "one" }],
    studio_settings: [{ studio_id: S1, timezone: NOW_TZ }],
    appointments: [{ id: "c1", studio_id: S1, title: "Salsa", status: "scheduled" }],
    appointment_attendees: [],
    clients: [],
    instructors: [{ id: "i1", studio_id: S1, first_name: "Maria", last_name: "Lopez" }, { id: "i2", studio_id: S1, first_name: "Juan", last_name: "Perez" }],
    rooms: [{ id: "r1", studio_id: S1, name: "Studio A" }, { id: "r2", studio_id: S1, name: "Studio B" }],
    ...over,
  };
}

beforeEach(() => {
  h.queue.mockReset();
  h.push.mockReset();
  h.queue.mockResolvedValue({ queued: true, skipped: false });
  h.push.mockResolvedValue(1);
});

const emails = () => h.queue.mock.calls.map((c) => c[0] as Record<string, unknown>);

// ---------------------------------------------------------------------------------------------------------------------
describe("S1E-2 pure rules", () => {
  it("only date/time, instructor, room and location are material; the same instant spelled differently is not a change", () => {
    expect(n.diffClassMaterial(snap(), snap()).any).toBe(false);
    expect(n.diffClassMaterial(snap(), snap({ startsAt: "2030-05-01T22:00:00+00:00" })).any).toBe(false);
    expect(n.diffClassMaterial(snap(), snap({ startsAt: START_B, endsAt: END_B }))).toMatchObject({ time: true, instructor: false, room: false, location: false, any: true });
    expect(n.diffClassMaterial(snap(), snap({ endsAt: "2030-05-01T23:30:00.000Z" })).time).toBe(true);
    expect(n.diffClassMaterial(snap(), snap({ instructorId: "i2" }))).toMatchObject({ instructor: true, any: true });
    expect(n.diffClassMaterial(snap(), snap({ roomId: "r2" }))).toMatchObject({ room: true, any: true });
    expect(n.diffClassMaterial(snap(), snap({ locationName: "Back lot" }))).toMatchObject({ location: true, any: true });
    expect(n.diffClassMaterial(snap({ locationName: null }), snap({ locationName: "  " })).any).toBe(false);
  });

  it("the change lines describe only what changed, with before and after", () => {
    const names = { instructor: (id: string | null) => (id === "i1" ? "Maria Lopez" : id === "i2" ? "Juan Perez" : null), room: (id: string | null) => (id === "r1" ? "Studio A" : null) };
    const after = snap({ startsAt: START_B, endsAt: END_B, instructorId: "i2" });
    const lines = n.buildChangeLines({ diff: n.diffClassMaterial(snap(), after), before: snap(), after, timeZone: NOW_TZ, names });
    expect(lines.map((l) => l.label)).toEqual(["Date and time", "Instructor"]);
    expect(lines[0]).toEqual({ label: "Date and time", from: "Wed, May 1, 6:00 PM - 7:00 PM", to: "Thu, May 2, 7:00 PM - 8:00 PM" });
    expect(lines[1]).toEqual({ label: "Instructor", from: "Maria Lopez", to: "Juan Perez" });
  });

  it("dedupe keys are deterministic per event and address, and differ across events", () => {
    expect(n.groupClassNoticeDedupeKey("k:a", "e1", "Ann@Example.test")).toBe("k:a:e1:ann@example.test");
    expect(n.groupClassNoticeDedupeKey("k:a", "e1", "ann@example.test")).not.toBe(n.groupClassNoticeDedupeKey("k:a", "e2", "ann@example.test"));
  });

  it("series changes are material only for date/time, instructor, room or location, never title or capacity", () => {
    expect(n.seriesChangesAreMaterial({ title: "x", roster_capacity: 5 })).toBe(false);
    expect(n.seriesChangesAreMaterial({ local_start_time: "19:00" })).toBe(true);
    expect(n.seriesChangesAreMaterial({ duration_minutes: 75 })).toBe(true);
    expect(n.seriesChangesAreMaterial({ instructor_id: null })).toBe(true);
    expect(n.seriesChangesAreMaterial({ room_id: "r" })).toBe(true);
    expect(n.seriesChangesAreMaterial({ location_name: "x" })).toBe(true);
    expect(n.seriesChangesAreMaterial({})).toBe(false);
  });

  it("the notified-dancers wording counts unique dancers and promises no channel", () => {
    expect(editNotice.dancersNotifiedLine(0)).toBeNull();
    expect(editNotice.dancersNotifiedLine(1)).toBe("1 enrolled dancer will be notified about these changes.");
    expect(editNotice.dancersNotifiedLine(7)).toBe("7 enrolled dancers will be notified about these changes.");
    expect(editNotice.dancersNotifiedLine(7)).not.toMatch(/email|push|text|sms/i);
  });

  it("the single-edit message: hint before a material change, count after, nothing without enrolled dancers", () => {
    expect(editNotice.singleEditNoticeText(0, true)).toBeNull();
    expect(editNotice.singleEditNoticeText(3, false)).toContain("Enrolled dancers (3) are notified automatically");
    expect(editNotice.singleEditNoticeText(3, true)).toBe("3 enrolled dancers will be notified about these changes.");
  });

  it("the form detector ignores notes and capacity (they are not part of the compared values)", () => {
    const initial = { startsAt: "2030-05-01T18:00", endsAt: "2030-05-01T19:00", instructorId: "i1", roomId: "r1", locationName: "" };
    expect(editNotice.classFormMaterialChanged(initial, { ...initial })).toBe(false);
    expect(editNotice.classFormMaterialChanged(initial, { ...initial, startsAt: "2030-05-02T18:00" })).toBe(true);
    expect(editNotice.classFormMaterialChanged(initial, { ...initial, instructorId: "" })).toBe(true);
    expect(editNotice.classFormMaterialChanged(initial, { ...initial, roomId: "r2" })).toBe(true);
    expect(editNotice.classFormMaterialChanged(initial, { ...initial, locationName: "Back lot" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("S1E-2 single class change", () => {
  const run = (over: Partial<Parameters<typeof n.notifyGroupClassChanged>[0]> = {}) =>
    n.notifyGroupClassChanged({
      studioId: S1,
      appointmentId: "c1",
      before: snap(),
      after: snap({ startsAt: START_B, endsAt: END_B }),
      eventId: "2030-04-01T00:00:00.000Z",
      ...over,
    });

  it("a date/time change sends one branded email and one push to each booked dancer", async () => {
    seed({ clients: [client("ann"), client("bo")], appointment_attendees: [attendee("c1", "ann"), attendee("c1", "bo")] });
    const out = await run();
    expect(out.emailsQueued).toBe(2);
    expect(emails().map((e) => e.recipientEmail).sort()).toEqual(["ann@example.test", "bo@example.test"]);
    const first = emails()[0];
    expect(first.channel).toBe("email");
    expect(first.templateKey).toBe("group_class_changed");
    expect(String(first.bodyHtml)).toContain("Studio One");
    expect(String(first.bodyHtml)).toContain("Date and time");
    expect(String(first.bodyText)).toContain("Wed, May 1, 6:00 PM - 7:00 PM -> Thu, May 2, 7:00 PM - 8:00 PM");
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push.mock.calls[0][0]).toMatchObject({ studioId: S1, kind: "changed", clientIds: ["ann", "bo"], title: "Your class changed" });
  });

  it("instructor-only and room-only changes notify, naming the people and places", async () => {
    seed({ clients: [client("ann")], appointment_attendees: [attendee("c1", "ann")] });
    await run({ after: snap({ instructorId: "i2" }) });
    expect(String(emails()[0].bodyText)).toContain("Instructor: Maria Lopez -> Juan Perez");
    expect(String(emails()[0].bodyText)).not.toContain("Date and time");
    h.queue.mockClear();
    await run({ after: snap({ roomId: "r2" }), eventId: "e2" });
    expect(String(emails()[0].bodyText)).toContain("Room: Studio A -> Studio B");
    h.queue.mockClear();
    await run({ after: snap({ locationName: "Back lot" }), eventId: "e3" });
    expect(String(emails()[0].bodyText)).toContain("Location: not set -> Back lot");
  });

  it("several material fields at once produce ONE consolidated message per dancer", async () => {
    seed({ clients: [client("ann")], appointment_attendees: [attendee("c1", "ann")] });
    await run({ after: snap({ startsAt: START_B, endsAt: END_B, instructorId: "i2", roomId: "r2", locationName: "Back lot" }) });
    expect(h.queue).toHaveBeenCalledTimes(1);
    const text = String(emails()[0].bodyText);
    for (const label of ["Date and time", "Instructor", "Room", "Location"]) expect(text).toContain(label);
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it("nothing material changed (notes or capacity only, or an identical save) sends nothing and reads nothing", async () => {
    seed({ clients: [client("ann")], appointment_attendees: [attendee("c1", "ann")] });
    const out = await run({ after: snap() });
    expect(out).toEqual({ emailsQueued: 0, pushedAccounts: 0 });
    expect(h.queue).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });

  it("no booked attendees, or only cancelled ones, means no notice", async () => {
    seed({ clients: [client("ann")], appointment_attendees: [attendee("c1", "ann", { status: "cancelled" })] });
    expect(await run()).toEqual({ emailsQueued: 0, pushedAccounts: 0 });
    seed();
    expect(await run()).toEqual({ emailsQueued: 0, pushedAccounts: 0 });
    expect(h.queue).not.toHaveBeenCalled();
  });

  it("a cancelled class is not announced as changed (cancellation has its own notice)", async () => {
    seed({ appointments: [{ id: "c1", studio_id: S1, title: "Salsa", status: "cancelled" }], clients: [client("ann")], appointment_attendees: [attendee("c1", "ann")] });
    expect(await run()).toEqual({ emailsQueued: 0, pushedAccounts: 0 });
  });

  it("channels: email only, push only, both, neither -- and never SMS", async () => {
    seed({ clients: [client("ann")], appointment_attendees: [attendee("c1", "ann")] });
    h.push.mockResolvedValue(0); // email only: no portal account
    let out = await run();
    expect(out).toEqual({ emailsQueued: 1, pushedAccounts: 0 });

    h.queue.mockClear();
    seed({ clients: [client("ann", { email: null })], appointment_attendees: [attendee("c1", "ann")] }); // push only
    h.push.mockResolvedValue(2);
    out = await run({ eventId: "e2" });
    expect(out).toEqual({ emailsQueued: 0, pushedAccounts: 2 });
    expect(h.queue).not.toHaveBeenCalled();

    seed({ clients: [client("ann")], appointment_attendees: [attendee("c1", "ann")] }); // both
    h.push.mockResolvedValue(1);
    out = await run({ eventId: "e3" });
    expect(out).toEqual({ emailsQueued: 1, pushedAccounts: 1 });

    h.queue.mockClear();
    h.push.mockClear();
    seed({ clients: [client("ann", { email: "" })], appointment_attendees: [attendee("c1", "ann")] }); // neither
    h.push.mockResolvedValue(0);
    out = await run({ eventId: "e4" });
    expect(out).toEqual({ emailsQueued: 0, pushedAccounts: 0 });

    for (const e of emails()) {
      expect(e.channel).toBe("email");
      expect(e.recipientPhone).toBeUndefined();
    }
    expect(JSON.stringify(h.queue.mock.calls)).not.toMatch(/"sms"/);
  });

  it("tenancy: a dancer whose client row belongs to another studio is never emailed, and queries stay studio-scoped", async () => {
    seed({
      clients: [client("ann"), client("bo", { studio_id: S2 })],
      appointment_attendees: [attendee("c1", "ann"), attendee("c1", "bo")],
    });
    await run();
    expect(emails().map((e) => e.recipientEmail)).toEqual(["ann@example.test"]);
    expect(emails().every((e) => e.studioId === S1)).toBe(true);
    expect(h.push.mock.calls[0][0].clientIds).toEqual(["ann"]);
    seed({ appointments: [{ id: "c1", studio_id: S2, title: "Other", status: "scheduled" }], clients: [client("ann")], appointment_attendees: [attendee("c1", "ann")] });
    h.queue.mockClear();
    expect(await run()).toEqual({ emailsQueued: 0, pushedAccounts: 0 }); // the class is not in this studio
    expect(h.queue).not.toHaveBeenCalled();
  });

  it("idempotency: the key follows the edit event, so a retry is deduped and a later separate edit still notifies", async () => {
    seed({ clients: [client("ann")], appointment_attendees: [attendee("c1", "ann")] });
    await run({ eventId: "edit-1" });
    await run({ eventId: "edit-1" });
    await run({ eventId: "edit-2" });
    const keys = emails().map((e) => e.dedupeKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("two dancers behind one address get one email (merged), different addresses one each", async () => {
    seed({ clients: [client("ann", { email: "family@example.test" }), client("bo", { email: "family@example.test" }), client("cy")], appointment_attendees: [attendee("c1", "ann"), attendee("c1", "bo"), attendee("c1", "cy")] });
    const out = await run();
    expect(out.emailsQueued).toBe(2);
    expect(emails().map((e) => e.recipientEmail).sort()).toEqual(["cy@example.test", "family@example.test"]);
  });

  it("failure never throws: a queue error or a push error leaves the mutation untouched", async () => {
    seed({ clients: [client("ann")], appointment_attendees: [attendee("c1", "ann")] });
    h.queue.mockRejectedValue(new Error("db down"));
    h.push.mockRejectedValue(new Error("expo down"));
    await expect(run()).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("S1E-2 This-and-following change (consolidated)", () => {
  const classRow = (id: string) => ({ id, studio_id: S1, title: "Salsa", status: "scheduled" });
  const before = new Map([
    ["c1", snap()],
    ["c2", snap({ startsAt: "2030-05-08T22:00:00.000Z", endsAt: "2030-05-08T23:00:00.000Z" })],
    ["c3", snap({ startsAt: "2030-05-15T22:00:00.000Z", endsAt: "2030-05-15T23:00:00.000Z" })],
  ]);
  const shifted = new Map([
    ["c1", snap({ startsAt: "2030-05-01T23:00:00.000Z", endsAt: "2030-05-02T00:00:00.000Z" })],
    ["c2", snap({ startsAt: "2030-05-08T23:00:00.000Z", endsAt: "2030-05-09T00:00:00.000Z" })],
    ["c3", snap({ startsAt: "2030-05-15T22:00:00.000Z", endsAt: "2030-05-15T23:00:00.000Z" })], // unchanged
  ]);
  const run = (over: Partial<Parameters<typeof n.notifyGroupClassSeriesChanged>[0]> = {}) =>
    n.notifyGroupClassSeriesChanged({ studioId: S1, eventId: "req-1", seriesId: "ser1", before, after: shifted, ...over });

  it("a dancer enrolled in several changed classes gets ONE email summarizing them; different dancers each get one", async () => {
    seed({
      appointments: [classRow("c1"), classRow("c2"), classRow("c3")],
      clients: [client("ann"), client("bo")],
      appointment_attendees: [attendee("c1", "ann"), attendee("c2", "ann"), attendee("c2", "bo"), attendee("c3", "bo")],
    });
    const out = await run();
    expect(out.emailsQueued).toBe(2);
    const byTo = new Map(emails().map((e) => [e.recipientEmail, e]));
    expect(String(byTo.get("ann@example.test")?.bodyText)).toContain("updated 2 upcoming sessions of Salsa");
    expect(String(byTo.get("bo@example.test")?.bodyText)).toContain("updated Salsa (Wed, May 8, 7:00 PM)"); // bo has exactly one changed class (c2)
    expect(emails().every((e) => e.templateKey === "group_class_series_changed")).toBe(true);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push.mock.calls[0][0].clientIds.sort()).toEqual(["ann", "bo"]);
  });

  it("only classes that really changed count: a dancer only in the unchanged class is not told", async () => {
    seed({
      appointments: [classRow("c1"), classRow("c2"), classRow("c3")],
      clients: [client("ann"), client("zed")],
      appointment_attendees: [attendee("c1", "ann"), attendee("c3", "zed")],
    });
    await run();
    expect(emails().map((e) => e.recipientEmail)).toEqual(["ann@example.test"]);
  });

  it("only currently booked attendees are included; cancelled attendance and cancelled classes are not", async () => {
    seed({
      appointments: [classRow("c1"), { ...classRow("c2"), status: "cancelled" }, classRow("c3")],
      clients: [client("ann"), client("bo"), client("cy")],
      appointment_attendees: [attendee("c1", "ann"), attendee("c1", "bo", { status: "cancelled" }), attendee("c2", "cy")],
    });
    await run();
    expect(emails().map((e) => e.recipientEmail)).toEqual(["ann@example.test"]);
  });

  it("the email describes the time change once, from the dancer first changed class", async () => {
    seed({ appointments: [classRow("c1"), classRow("c2")], clients: [client("ann")], appointment_attendees: [attendee("c1", "ann"), attendee("c2", "ann")] });
    await run();
    const text = String(emails()[0].bodyText);
    expect(text.match(/Date and time:/g)).toHaveLength(1);
    expect(text).toContain("starting Wed, May 1, 7:00 PM");
    expect(String(emails()[0].bodyHtml)).toContain("Studio One");
  });

  it("nothing changed (or only unreadable snapshots) sends nothing", async () => {
    seed({ appointments: [classRow("c1")], clients: [client("ann")], appointment_attendees: [attendee("c1", "ann")] });
    expect(await run({ after: before })).toEqual({ emailsQueued: 0, pushedAccounts: 0 });
    expect(await run({ before: new Map() })).toEqual({ emailsQueued: 0, pushedAccounts: 0 });
    expect(h.queue).not.toHaveBeenCalled();
  });

  it("idempotency: the edit request id is the event, so a retried notification is deduped per address", async () => {
    seed({ appointments: [classRow("c1")], clients: [client("ann")], appointment_attendees: [attendee("c1", "ann")] });
    await run({ eventId: "req-1" });
    await run({ eventId: "req-1" });
    await run({ eventId: "req-2" });
    const keys = emails().map((e) => e.dedupeKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(String(keys[0])).toContain("group_class_series_changed:ser1:req-1:");
  });

  it("tenancy: another studio's client behind a booked row is never emailed or pushed", async () => {
    seed({ appointments: [classRow("c1")], clients: [client("bo", { studio_id: S2 })], appointment_attendees: [attendee("c1", "bo")] });
    h.push.mockClear();
    await run();
    expect(h.queue).not.toHaveBeenCalled();
    const pushed = h.push.mock.calls.flatMap((c) => (c[0] as { clientIds: string[] }).clientIds);
    expect(pushed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("S1E-2 enrollment and removal", () => {
  const cls = (id: string, startsAt: string, over: Row = {}) => ({ id, studio_id: S1, title: "Salsa", starts_at: startsAt, instructor_id: "i1", room_id: "r1", location_name: null, ...over });

  it("single enrollment: one branded confirmation with class, time, instructor and location, plus a push", async () => {
    seed({ appointments: [cls("c1", START_A)], clients: [client("ann")] });
    const out = await n.notifyGroupClassEnrolled({ studioId: S1, clientId: "ann", appointmentIds: ["c1"], eventId: "att-1", series: false });
    expect(out.emailsQueued).toBe(1);
    const e = emails()[0];
    expect(e.templateKey).toBe("group_class_enrolled");
    expect(e.dedupeKey).toBe("group_class_enrolled:att-1:ann@example.test");
    const text = String(e.bodyText);
    expect(text).toContain("enrolled you in Salsa on Wed, May 1, 6:00 PM");
    expect(text).toContain("Instructor: Maria Lopez");
    expect(text).toContain("Location: Studio A");
    expect(String(e.bodyHtml)).toContain("Studio One");
    expect(h.push.mock.calls[0][0]).toMatchObject({ kind: "enrolled", clientIds: ["ann"], title: "You are enrolled" });
  });

  it("series enrollment: ONE consolidated notice with the class count and the first class, not one per class", async () => {
    seed({ appointments: [cls("c1", START_A), cls("c2", "2030-05-08T22:00:00.000Z"), cls("c3", "2030-05-15T22:00:00.000Z")], clients: [client("ann")] });
    const out = await n.notifyGroupClassEnrolled({ studioId: S1, clientId: "ann", appointmentIds: ["c3", "c1", "c2"], eventId: "evt", series: true });
    expect(out.emailsQueued).toBe(1);
    expect(h.queue).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledTimes(1);
    const e = emails()[0];
    expect(e.templateKey).toBe("group_class_series_enrolled");
    expect(String(e.bodyText)).toContain("enrolled you in 3 sessions of Salsa, starting Wed, May 1, 6:00 PM");
    expect(String(e.bodyText)).toContain("Sessions: 3");
  });

  it("enrollment copy exposes no payment or funding internals", async () => {
    seed({ appointments: [cls("c1", START_A)], clients: [client("ann")] });
    await n.notifyGroupClassEnrolled({ studioId: S1, clientId: "ann", appointmentIds: ["c1"], eventId: "a", series: false });
    expect(String(emails()[0].bodyText) + String(emails()[0].bodyHtml)).not.toMatch(/package|membership|credit|paid|price|billing/i);
  });

  it("an empty operation (a refused or no-op enrollment names no classes) sends nothing", async () => {
    seed({ appointments: [cls("c1", START_A)], clients: [client("ann")] });
    expect(await n.notifyGroupClassEnrolled({ studioId: S1, clientId: "ann", appointmentIds: [], eventId: "a", series: true })).toEqual({ emailsQueued: 0, pushedAccounts: 0 });
    expect(h.queue).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });

  it("a repeated orchestration dedupes the email; push idempotency rides the same stable per-event notice key (the push helper enforces it)", async () => {
    seed({ appointments: [cls("c1", START_A)], clients: [client("ann")] });
    await n.notifyGroupClassEnrolled({ studioId: S1, clientId: "ann", appointmentIds: ["c1"], eventId: "att-1", series: false });
    h.queue.mockResolvedValue({ queued: false, skipped: true, reason: "duplicate" });
    const second = await n.notifyGroupClassEnrolled({ studioId: S1, clientId: "ann", appointmentIds: ["c1"], eventId: "att-1", series: false });
    expect(second.emailsQueued).toBe(0);
    expect(h.push).toHaveBeenCalledTimes(2);
    expect(h.push.mock.calls[1][0].noticeKey).toBe(h.push.mock.calls[0][0].noticeKey);
    expect(h.push.mock.calls[0][0].noticeKey).toContain(S1);
  });

  it("push notice keys are stable per event, differ per event and kind, and carry the studio", () => {
    const k = n.groupClassPushNoticeKey;
    expect(k("group_class_changed", "s1", "a1", "t1")).toBe(k("group_class_changed", "s1", "a1", "t1"));
    expect(k("group_class_changed", "s1", "a1", "t1")).not.toBe(k("group_class_changed", "s1", "a1", "t2"));
    expect(k("group_class_changed", "s1", "a1", "t1")).not.toBe(k("group_class_changed", "s2", "a1", "t1"));
    expect(k("group_class_enrolled", "s1", "a1", "t1")).not.toBe(k("group_class_removed", "s1", "a1", "t1"));
  });

  it("tenancy: a client of another studio, or classes of another studio, are never notified", async () => {
    seed({ appointments: [cls("c1", START_A)], clients: [client("ann", { studio_id: S2 })] });
    expect(await n.notifyGroupClassEnrolled({ studioId: S1, clientId: "ann", appointmentIds: ["c1"], eventId: "a", series: false })).toEqual({ emailsQueued: 0, pushedAccounts: 0 });
    seed({ appointments: [cls("c1", START_A, { studio_id: S2 })], clients: [client("ann")] });
    expect(await n.notifyGroupClassEnrolled({ studioId: S1, clientId: "ann", appointmentIds: ["c1"], eventId: "a", series: false })).toEqual({ emailsQueued: 0, pushedAccounts: 0 });
    expect(h.queue).not.toHaveBeenCalled();
  });

  it("single removal: one notice, no credit or refund language", async () => {
    seed({ appointments: [cls("c1", START_A)], clients: [client("ann")] });
    const out = await n.notifyGroupClassRemoved({ studioId: S1, clientId: "ann", appointmentIds: ["c1"], keptCount: 0, eventId: "att-1", series: false });
    expect(out.emailsQueued).toBe(1);
    const e = emails()[0];
    expect(e.templateKey).toBe("group_class_removed");
    expect(String(e.bodyText)).toContain("removed you from Salsa on Wed, May 1, 6:00 PM");
    expect(String(e.bodyText) + String(e.bodyHtml)).not.toMatch(/credit|refund|restor|money|reimburs/i);
    expect(h.push.mock.calls[0][0]).toMatchObject({ kind: "removed", title: "Your enrollment was removed" });
  });

  it("series removal: ONE consolidated notice that counts only removed classes and truthfully mentions classes kept for recorded attendance", async () => {
    seed({ appointments: [cls("c2", "2030-05-08T22:00:00.000Z"), cls("c3", "2030-05-15T22:00:00.000Z")], clients: [client("ann")] });
    const out = await n.notifyGroupClassRemoved({ studioId: S1, clientId: "ann", appointmentIds: ["c2", "c3"], keptCount: 1, eventId: "evt", series: true });
    expect(out.emailsQueued).toBe(1);
    expect(h.queue).toHaveBeenCalledTimes(1);
    const text = String(emails()[0].bodyText);
    expect(text).toContain("removed you from 2 upcoming sessions of Salsa");
    expect(text).toContain("One class where attendance was already recorded was not changed.");
    const none = await n.notifyGroupClassRemoved({ studioId: S1, clientId: "ann", appointmentIds: ["c2"], keptCount: 0, eventId: "e2", series: true });
    expect(none.emailsQueued).toBe(1);
    expect(String(emails()[1].bodyText)).not.toContain("attendance was already recorded");
  });

  it("removal by attendee id derives the dancer from the cancelled row itself and ignores anything else", async () => {
    seed({
      appointments: [cls("c1", START_A)],
      clients: [client("ann")],
      appointment_attendees: [{ id: "att-1", studio_id: S1, appointment_id: "c1", client_id: "ann", status: "cancelled" }, { id: "att-2", studio_id: S1, appointment_id: "c1", client_id: "ann", status: "booked" }],
    });
    expect((await n.notifyGroupClassRemovedByAttendee({ studioId: S1, attendeeId: "att-1" })).emailsQueued).toBe(1);
    expect(emails()[0].dedupeKey).toBe("group_class_removed:att-1:ann@example.test");
    h.queue.mockClear();
    expect(await n.notifyGroupClassRemovedByAttendee({ studioId: S1, attendeeId: "att-2" })).toEqual({ emailsQueued: 0, pushedAccounts: 0 }); // still booked: not a removal
    expect(await n.notifyGroupClassRemovedByAttendee({ studioId: S2, attendeeId: "att-1" })).toEqual({ emailsQueued: 0, pushedAccounts: 0 }); // another studio
    expect(await n.notifyGroupClassRemovedByAttendee({ studioId: S1, attendeeId: "missing" })).toEqual({ emailsQueued: 0, pushedAccounts: 0 });
    expect(h.queue).not.toHaveBeenCalled();
  });

  it("failures never throw", async () => {
    seed({ appointments: [cls("c1", START_A)], clients: [client("ann")] });
    h.queue.mockRejectedValue(new Error("down"));
    h.push.mockRejectedValue(new Error("down"));
    await expect(n.notifyGroupClassEnrolled({ studioId: S1, clientId: "ann", appointmentIds: ["c1"], eventId: "a", series: false })).resolves.toBeDefined();
    await expect(n.notifyGroupClassRemoved({ studioId: S1, clientId: "ann", appointmentIds: ["c1"], keptCount: 0, eventId: "a", series: false })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("S1E-2 series snapshots and counts", () => {
  it("snapshotSeriesFollowing walks the successor lineage from the anchor and never includes earlier or cancelled classes", async () => {
    h.db = {
      group_class_series: [
        { id: "s1", studio_id: S1, split_from_series_id: null },
        { id: "s2", studio_id: S1, split_from_series_id: "s1" },
        { id: "other", studio_id: S1, split_from_series_id: null },
      ],
      appointments: [
        { id: "a1", studio_id: S1, appointment_type: "group_class", group_class_series_id: "s1", series_occurrence_index: 1, status: "scheduled", starts_at: START_A, ends_at: END_A, instructor_id: "i1", room_id: null, location_name: null },
        { id: "a2", studio_id: S1, appointment_type: "group_class", group_class_series_id: "s1", series_occurrence_index: 2, status: "scheduled", starts_at: START_A, ends_at: END_A, instructor_id: "i1", room_id: null, location_name: null },
        { id: "a3", studio_id: S1, appointment_type: "group_class", group_class_series_id: "s2", series_occurrence_index: 3, status: "scheduled", starts_at: START_A, ends_at: END_A, instructor_id: "i1", room_id: null, location_name: null },
        { id: "a4", studio_id: S1, appointment_type: "group_class", group_class_series_id: "s2", series_occurrence_index: 4, status: "cancelled", starts_at: START_A, ends_at: END_A, instructor_id: "i1", room_id: null, location_name: null },
        { id: "x1", studio_id: S1, appointment_type: "group_class", group_class_series_id: "other", series_occurrence_index: 2, status: "scheduled", starts_at: START_A, ends_at: END_A, instructor_id: "i1", room_id: null, location_name: null },
      ],
    };
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const snapshot = await n.snapshotSeriesFollowing(createAdminClient() as never, S1, "a2");
    expect(snapshot?.seriesId).toBe("s1");
    expect(Array.from(snapshot?.classes.keys() ?? []).sort()).toEqual(["a2", "a3"]);
  });

  it("the review count is unique dancers across the classes, not occurrences", async () => {
    h.db = {
      appointment_attendees: [
        attendee("a2", "ann"),
        attendee("a3", "ann"),
        attendee("a3", "bo"),
        attendee("a3", "cy", { status: "cancelled" }),
        attendee("a9", "zed", { studio_id: S2 }),
      ],
    };
    const { createAdminClient } = await import("@/lib/supabase/admin");
    expect(await n.countEnrolledDancers(createAdminClient() as never, S1, ["a2", "a3"])).toBe(2);
    expect(await n.countEnrolledDancers(createAdminClient() as never, S1, [])).toBe(0);
  });

  it("the series review line appears only for material changes with enrolled dancers", async () => {
    h.db = {
      appointments: [{ id: "a1", studio_id: S1, appointment_type: "group_class", group_class_series_id: "s1", series_occurrence_index: 1, status: "scheduled", starts_at: START_A, ends_at: END_A, instructor_id: "i1", room_id: null, location_name: null }],
      group_class_series: [{ id: "s1", studio_id: S1, split_from_series_id: null }],
      appointment_attendees: [attendee("a1", "ann"), attendee("a1", "bo")],
    };
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const db = createAdminClient() as never;
    expect(await n.seriesEditNoticeLine(db, S1, "a1", { title: "x", roster_capacity: 4 })).toBeNull();
    expect(await n.seriesEditNoticeLine(db, S1, "a1", { local_start_time: "19:00" })).toBe("2 enrolled dancers will be notified about these changes.");
    h.db.appointment_attendees = [];
    expect(await n.seriesEditNoticeLine(db, S1, "a1", { local_start_time: "19:00" })).toBeNull();
  });
});
