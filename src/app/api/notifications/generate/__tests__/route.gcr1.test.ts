import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GC-R1: reminders for the enrolled attendees of canonical (appointment-based) group classes, through the real
 * notification generator route with an in-memory database. Covers recipient eligibility, one reminder per attendee,
 * idempotency across generator runs, tenant scoping, class-specific copy, the branded HTML path, and that the legacy
 * lesson reminders, the campaign allowance and SMS are untouched.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  db: null as unknown as { tables: Record<string, Row[]>; from: (t: string) => unknown },
  confirmation: vi.fn(),
  allowance: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (t: string) => h.db.from(t) }) }));
vi.mock("@/lib/security/cron", () => ({ getCronAuthFailure: () => null }));
vi.mock("@/lib/schedule/appointmentConfirmation", () => ({
  createAppointmentConfirmationToken: (...args: unknown[]) => h.confirmation(...args),
}));
vi.mock("@/lib/usage/campaignAllowance", () => ({
  reserveCampaignSendAllowance: (...a: unknown[]) => h.allowance(...a),
  settleCampaignBatch: (...a: unknown[]) => h.allowance(...a),
  getCampaignAllowanceState: (...a: unknown[]) => h.allowance(...a),
}));

class Builder implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Array<(r: Row) => boolean> = [];
  private mode: "select" | "insert" = "select";
  private payload: Row | Row[] | null = null;
  constructor(
    private db: { tables: Record<string, Row[]> },
    private table: string,
  ) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  gte(c: string, v: unknown) { this.filters.push((r) => String(r[c]) >= String(v)); return this; }
  lte(c: string, v: unknown) { this.filters.push((r) => String(r[c]) <= String(v)); return this; }
  in(c: string, vals: unknown[]) { this.filters.push((r) => vals.includes(r[c])); return this; }
  insert(row: Row) { this.mode = "insert"; this.payload = row; return this; }
  upsert(rows: Row[]) {
    // the legacy table-level unique constraint never fires when user_id is NULL (NULLs are distinct), so rows always insert
    this.mode = "insert";
    this.payload = rows;
    return this;
  }
  private run() {
    const rows = (this.db.tables[this.table] ??= []);
    if (this.mode === "insert") {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      for (const row of incoming) {
        // partial unique index on dedupe_key (WHERE dedupe_key IS NOT NULL)
        if (this.table === "notification_deliveries" && row.dedupe_key && rows.some((r) => r.dedupe_key === row.dedupe_key)) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        rows.push({ id: `d${rows.length + 1}`, ...row });
      }
      return { data: null, error: null };
    }
    return { data: rows.filter((r) => this.filters.every((f) => f(r))).map((r) => ({ ...r })), error: null };
  }
  then<T1, T2>(a?: ((v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null, b?: ((r: unknown) => T2 | PromiseLike<T2>) | null) {
    return Promise.resolve().then(() => this.run()).then(a, b);
  }
}

const { POST } = await import("../route");

const NOW = new Date("2026-03-10T15:00:00.000Z");
const S1 = "studio-1";
const S2 = "studio-2";

const client = (id: string, studio: string, over: Row = {}) => ({ id, studio_id: studio, first_name: id.toUpperCase(), last_name: "Dancer", email: `${id}@example.test`, ...over });
const attendee = (appt: string, c: Row, studio = S1, status = "booked") => ({ appointment_id: appt, studio_id: studio, client_id: c.id, status, clients: c });
const startsIn = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

function appointment(over: Row = {}): Row {
  return {
    id: "class-1", studio_id: S1, starts_at: startsIn(24), ends_at: startsIn(25), title: "Salsa Basics", appointment_type: "group_class",
    status: "scheduled", client_id: null, instructor_id: "i1", location_name: null, rooms: { name: "Studio A" },
    clients: null, instructors: { id: "i1", profile_user_id: null, first_name: "Maria", last_name: "Lopez", email: "maria@example.test" },
    ...over,
  };
}

function seed(tables: Record<string, Row[]>) {
  h.db = {
    tables: { user_notification_preferences: [], studios: [{ id: S1, timezone: "America/New_York" }, { id: S2, timezone: "America/Los_Angeles" }], appointments: [], appointment_attendees: [], notification_deliveries: [], ...tables },
    from(t: string) { return new Builder(h.db, t); },
  };
}
const run = async () => (await POST(new Request("http://localhost/api/notifications/generate") as never)).json();
const deliveries = () => h.db.tables.notification_deliveries;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.confirmation.mockReset();
  h.confirmation.mockResolvedValue({ confirmUrl: "https://example.test/appointments/confirm/tok", expiresAt: startsIn(25) });
  h.allowance.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("GC-R1 canonical group-class attendee reminders", () => {
  it("generates one reminder per enrolled attendee of a client_id = null canonical class", async () => {
    const [a, b, c] = [client("ann", S1), client("bob", S1), client("cy", S1)];
    seed({ appointments: [appointment()], appointment_attendees: [attendee("class-1", a), attendee("class-1", b), attendee("class-1", c)] });
    const result = await run();
    expect(result.generated).toBe(3);
    expect(deliveries().map((d) => d.client_id).sort()).toEqual(["ann", "bob", "cy"]);
    expect(deliveries().every((d) => d.delivery_type === "student_lesson_reminder_24h" && d.channel === "email" && d.studio_id === S1 && d.related_appointment_id === "class-1")).toBe(true);
  });

  it("excludes removed/cancelled attendees and keeps only booked ones", async () => {
    const [a, b] = [client("ann", S1), client("bob", S1)];
    seed({ appointments: [appointment()], appointment_attendees: [attendee("class-1", a), attendee("class-1", b, S1, "cancelled")] });
    await run();
    expect(deliveries().map((d) => d.client_id)).toEqual(["ann"]);
  });

  it("does not remind a cancelled class", async () => {
    seed({ appointments: [appointment({ status: "cancelled" })], appointment_attendees: [attendee("class-1", client("ann", S1))] });
    await run();
    expect(deliveries()).toHaveLength(0);
  });

  it("an attendee without a deliverable email is skipped without failing the run or fabricating an address", async () => {
    const [a, b, c] = [client("ann", S1), client("bob", S1, { email: null }), client("cy", S1, { email: "not-an-email" })];
    seed({ appointments: [appointment()], appointment_attendees: [attendee("class-1", a), attendee("class-1", b), attendee("class-1", c)] });
    const result = await run();
    expect(result.ok).toBe(true);
    expect(deliveries().map((d) => d.client_id)).toEqual(["ann"]);
    expect(JSON.stringify(deliveries())).not.toContain("not-an-email");
  });

  it("is idempotent: repeated generator runs never duplicate a reminder", async () => {
    seed({ appointments: [appointment()], appointment_attendees: [attendee("class-1", client("ann", S1)), attendee("class-1", client("bob", S1))] });
    expect((await run()).generated).toBe(2);
    expect((await run()).generated).toBe(0);
    expect((await run()).generated).toBe(0);
    expect(deliveries()).toHaveLength(2);
    expect(new Set(deliveries().map((d) => d.dedupe_key)).size).toBe(2);
  });

  it("a concurrent run that already queued a row (duplicate key) does not fail the others", async () => {
    seed({ appointments: [appointment()], appointment_attendees: [attendee("class-1", client("ann", S1)), attendee("class-1", client("bob", S1))] });
    // another run inserted ann's reminder between our existence check and our insert
    const realFrom = h.db.from.bind(h.db);
    let raced = false;
    h.db.from = (t: string) => {
      const b = realFrom(t) as Builder;
      if (t === "notification_deliveries" && !raced) {
        const realIn = b.in.bind(b);
        b.in = (c: string, v: unknown[]) => { raced = true; const out = realIn(c, v); h.db.tables.notification_deliveries.push({ id: "other", dedupe_key: "gcr1:24h:class-1:ann", client_id: "ann", delivery_type: "student_lesson_reminder_24h" }); return out; };
      }
      return b;
    };
    const result = await run();
    expect(result.ok).toBe(true);
    expect(deliveries().filter((d) => d.dedupe_key === "gcr1:24h:class-1:ann")).toHaveLength(1);
    expect(deliveries().some((d) => d.client_id === "bob")).toBe(true);
  });

  it("each reminder window is its own occurrence: the 2h reminder is generated separately from the 24h one", async () => {
    seed({ appointments: [appointment({ starts_at: startsIn(2) })], appointment_attendees: [attendee("class-1", client("ann", S1))] });
    await run();
    expect(deliveries().map((d) => d.delivery_type)).toEqual(["student_lesson_reminder_2h"]);
    expect(deliveries()[0].dedupe_key).toBe("gcr1:2h:class-1:ann");
  });

  it("does not remind classes outside both windows", async () => {
    seed({ appointments: [appointment({ starts_at: startsIn(10) })], appointment_attendees: [attendee("class-1", client("ann", S1))] });
    await run();
    expect(deliveries()).toHaveLength(0);
  });

  it("tenant scoping: a roster row or client from another studio is never a recipient", async () => {
    const foreignClient = client("eve", S2);
    seed({
      appointments: [appointment()],
      appointment_attendees: [
        attendee("class-1", client("ann", S1)),
        attendee("class-1", foreignClient, S1), // roster row claims studio 1 but the client belongs to studio 2
        attendee("class-1", client("zed", S1), S2), // roster row belongs to another studio
        { ...attendee("class-1", client("mal", S1)), clients: { ...client("mal", S1), id: "someone-else" } }, // client relation does not match the row
      ],
    });
    await run();
    expect(deliveries().map((d) => d.client_id)).toEqual(["ann"]);
    expect(deliveries().every((d) => d.studio_id === S1)).toBe(true);
  });

  it("each studio's class uses its own timezone for the date and time", async () => {
    seed({
      appointments: [
        appointment({ id: "ny", starts_at: "2026-03-11T15:00:00.000Z" }),
        appointment({ id: "la", studio_id: S2, starts_at: "2026-03-11T15:00:00.000Z" }),
      ],
      appointment_attendees: [attendee("ny", client("ann", S1)), attendee("la", client("lee", S2), S2)],
    });
    await run();
    const ny = deliveries().find((d) => d.client_id === "ann")!;
    const la = deliveries().find((d) => d.client_id === "lee")!;
    expect(ny.body).toContain("Wednesday, March 11 at 11:00 AM");
    expect(la.body).toContain("Wednesday, March 11 at 8:00 AM");
    expect((ny.metadata as Row).studioTimezone).toBe("America/New_York");
    expect(ny.related_date).toBe("2026-03-11");
  });

  it("uses class-specific copy with only truthful data (title, date, time, instructor, location), and no lesson, credit or payment wording", async () => {
    seed({ appointments: [appointment()], appointment_attendees: [attendee("class-1", client("ann", S1))] });
    await run();
    const d = deliveries()[0];
    expect(d.subject).toBe("Reminder: Salsa Basics on Wednesday, March 11");
    expect(d.body).toBe("You are enrolled in Salsa Basics on Wednesday, March 11 at 11:00 AM.\nInstructor: Maria Lopez\nLocation: Studio A");
    expect(`${d.subject} ${d.body}`).not.toMatch(/lesson|credit|package|membership|payment|\$|paid/i);
    expect(d.metadata).toMatchObject({ appointmentType: "group_class", appointmentTitle: "Salsa Basics", instructorName: "Maria Lopez", locationName: "Studio A", clientEmail: "ann@example.test" });
  });

  it("omits instructor and location when the class does not have them; prefers an explicit location name over the room", async () => {
    seed({
      appointments: [appointment({ id: "bare", instructors: null, rooms: null, title: null }), appointment({ id: "loc", location_name: "Main Hall", rooms: { name: "Room 2" } })],
      appointment_attendees: [attendee("bare", client("ann", S1)), attendee("loc", client("bob", S1))],
    });
    await run();
    const bare = deliveries().find((d) => d.client_id === "ann")!;
    expect(bare.body).toBe("You are enrolled in Group Class on Wednesday, March 11 at 11:00 AM.");
    expect(deliveries().find((d) => d.client_id === "bob")!.body).toContain("Location: Main Hall");
  });

  it("never creates a confirmation link for a shared class (the single-appointment confirmation flow does not apply)", async () => {
    seed({ appointments: [appointment()], appointment_attendees: [attendee("class-1", client("ann", S1))] });
    await run();
    expect(h.confirmation).not.toHaveBeenCalled();
    expect(JSON.stringify(deliveries())).not.toMatch(/confirmationUrl|appointments\/confirm/);
  });

  it("private lessons keep their exact behavior: client_id reminder with a confirmation link, no dedupe_key change", async () => {
    seed({
      appointments: [{ ...appointment({ id: "lesson-1", appointment_type: "private_lesson", client_id: "ann", title: "Private", rooms: null }), clients: client("ann", S1) }],
    });
    const result = await run();
    expect(result.generated).toBe(1);
    expect(deliveries()[0]).toMatchObject({ delivery_type: "student_lesson_reminder_24h", client_id: "ann", related_appointment_id: "lesson-1" });
    expect(deliveries()[0].dedupe_key).toBeUndefined();
    expect(String(deliveries()[0].body)).toContain("You have an upcoming lesson scheduled for");
    expect(h.confirmation).toHaveBeenCalledTimes(1);
  });

  it("a legacy group_class row with a client_id and NO attendee rows is still reminded the legacy way, exactly once", async () => {
    seed({ appointments: [{ ...appointment({ id: "legacy", client_id: "ann" }), clients: client("ann", S1) }] });
    await run();
    expect(deliveries()).toHaveLength(1);
    expect(deliveries()[0].dedupe_key).toBeUndefined();
    expect(deliveries()[0].client_id).toBe("ann");
  });

  it("a class that HAS attendee rows is reminded only through them: a legacy client_id on the same row never double-reminds", async () => {
    const ann = client("ann", S1);
    seed({ appointments: [{ ...appointment({ client_id: "ann" }), clients: ann }], appointment_attendees: [attendee("class-1", ann)] });
    await run();
    expect(deliveries()).toHaveLength(1);
    expect(deliveries()[0].dedupe_key).toBe("gcr1:24h:class-1:ann");
  });

  it("is an operational path: it never touches the campaign allowance and creates no SMS or non-email delivery", async () => {
    seed({ appointments: [appointment()], appointment_attendees: [attendee("class-1", client("ann", S1))] });
    await run();
    expect(h.allowance).not.toHaveBeenCalled();
    expect(deliveries().every((d) => d.channel === "email")).toBe(true);
  });

  it("leaves the legacy Events reminder system alone: no event tables are read or written", async () => {
    seed({ appointments: [appointment()], appointment_attendees: [attendee("class-1", client("ann", S1))] });
    const touched: string[] = [];
    const realFrom = h.db.from.bind(h.db);
    h.db.from = (t: string) => { touched.push(t); return realFrom(t); };
    await run();
    expect(touched.filter((t) => /event/.test(t))).toEqual([]);
  });

  it("a lookup failure surfaces as a 500 and queues nothing", async () => {
    seed({ appointments: [appointment()], appointment_attendees: [attendee("class-1", client("ann", S1))] });
    const realFrom = h.db.from.bind(h.db);
    h.db.from = (t: string) => {
      if (t === "appointment_attendees") return { select: () => ({ in: () => Promise.resolve({ data: null, error: { message: "boom" } }) }) };
      return realFrom(t);
    };
    const response = await POST(new Request("http://localhost/api/notifications/generate") as never);
    expect(response.status).toBe(500);
    expect(deliveries()).toHaveLength(0);
  });

  it("looks classes up in chunks so the request URL never overflows", async () => {
    const classes = Array.from({ length: 230 }, (_, i) => appointment({ id: `c${i}` }));
    seed({ appointments: classes, appointment_attendees: [] });
    const sizes: number[] = [];
    const realFrom = h.db.from.bind(h.db);
    h.db.from = (t: string) => {
      const b = realFrom(t) as Builder;
      if (t === "appointment_attendees") { const realIn = b.in.bind(b); b.in = (c: string, v: unknown[]) => { sizes.push(v.length); return realIn(c, v); }; }
      return b;
    };
    await run();
    expect(sizes).toEqual([100, 100, 30]);
  });
});
