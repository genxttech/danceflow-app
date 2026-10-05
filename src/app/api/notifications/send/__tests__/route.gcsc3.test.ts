import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GC-S1C-3 (D11): send-time revalidation in the notification send route. A queued client reminder for a canonical group class
 * must not be delivered once the class is cancelled, whether or not the queued row was invalidated at cancel time; a reminder
 * for anything else is unaffected; an unreadable class leaves the row pending for the next run. The route runs against an
 * in-memory database and a stubbed email transport.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  db: null as unknown as { tables: Record<string, Row[]>; failAppointments: boolean; failAttendees?: boolean },
  fetchMock: vi.fn(),
  updates: [] as Array<{ table: string; eqCols: string[]; patch: Record<string, unknown> }>,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => new Builder(h.db, t) }),
}));
vi.mock("@/lib/security/cron", () => ({ getCronAuthFailure: () => null }));
vi.mock("@/lib/notifications/dispatch", () => ({
  dispatchQueuedOutboundDeliveries: async () => ({ processed: 0 }),
}));

class Builder implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Array<(r: Row) => boolean> = [];
  private mode: "select" | "update" = "select";
  private patch: Row = {};
  private max = Infinity;
  private eqCols: string[] = [];
  constructor(
    private db: { tables: Record<string, Row[]>; failAppointments: boolean; failAttendees?: boolean },
    private table: string,
  ) {}
  select() { return this; }
  update(patch: Row) { this.mode = "update"; this.patch = patch; return this; }
  eq(c: string, v: unknown) { this.eqCols.push(c); this.filters.push((r) => r[c] === v); return this; }
  lte(c: string, v: unknown) { this.filters.push((r) => String(r[c]) <= String(v)); return this; }
  order() { return this; }
  limit(n: number) { this.max = n; return this; }
  maybeSingle() { return this.then((r) => ({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error })); }
  single() { return this.maybeSingle(); }
  private run() {
    if (this.table === "appointments" && this.db.failAppointments) {
      return { data: null, error: { message: "boom" } };
    }
    if (this.table === "appointment_attendees" && this.db.failAttendees) {
      return { data: null, error: { message: "boom" } };
    }
    const rows = (this.db.tables[this.table] ??= []);
    const matching = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.mode === "update") {
      h.updates.push({ table: this.table, eqCols: [...this.eqCols], patch: { ...this.patch } });
      for (const r of matching) Object.assign(r, this.patch);
      return { data: null, error: null };
    }
    return { data: matching.slice(0, this.max).map((r) => ({ ...r })), error: null };
  }
  then<T1, T2>(a?: ((v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null, b?: ((r: unknown) => T2 | PromiseLike<T2>) | null) {
    return Promise.resolve().then(() => this.run()).then(a, b);
  }
}

const { POST } = await import("../route");

const STUDIO = "studio-a";
const delivery = (over: Row): Row => ({
  id: `d-${Math.random()}`,
  studio_id: STUDIO,
  user_id: null,
  client_id: "c1",
  delivery_type: "student_lesson_reminder_24h",
  channel: "email",
  status: "pending",
  subject: "Reminder",
  body: "See you soon",
  metadata: { clientEmail: "client@example.test", appointmentType: "group_class" },
  scheduled_for: "2000-01-01T00:00:00Z",
  related_appointment_id: "cls1",
  ...over,
});

function seed(deliveries: Row[], appointments: Row[], attendees: Row[] = []) {
  h.db = {
    failAppointments: false,
    tables: {
      notification_deliveries: deliveries,
      appointments,
      appointment_attendees: attendees,
      studios: [{ id: STUDIO, name: "Studio A", public_name: null, public_logo_url: null, slug: "a", email: "hello@studio-a.test" }],
    },
  };
}

const call = async () => {
  const res = await POST(new Request("https://app.test/api/notifications/send", { method: "POST" }) as never);
  return (await res.json()) as { notifications: { processed: number; sent: number; failed: number; suppressed: number; deferred: number } };
};

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "test-key");
  h.fetchMock.mockReset();
  h.updates.length = 0;
  h.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "email-1" }), text: async () => "" });
  vi.stubGlobal("fetch", h.fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GC-S1C-3 reminder send-time suppression", () => {
  it("does not send a queued reminder for a cancelled group class and marks it cancelled", async () => {
    seed([delivery({ id: "d1" })], [{ id: "cls1", appointment_type: "group_class", status: "cancelled" }]);
    const out = await call();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(out.notifications).toMatchObject({ sent: 0, suppressed: 1, failed: 0, deferred: 0 });
    expect(h.db.tables.notification_deliveries[0]).toMatchObject({ status: "cancelled", failure_reason: "class_cancelled" });
  });

  it("applies to both client reminder windows", async () => {
    seed(
      [delivery({ id: "d1" }), delivery({ id: "d2", delivery_type: "student_lesson_reminder_2h", client_id: "c2" })],
      [{ id: "cls1", appointment_type: "group_class", status: "cancelled" }],
    );
    const out = await call();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(out.notifications.suppressed).toBe(2);
  });

  it("still sends a reminder for a scheduled group class", async () => {
    seed([delivery({ id: "d1" })], [{ id: "cls1", appointment_type: "group_class", status: "scheduled" }]);
    const out = await call();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(out.notifications).toMatchObject({ sent: 1, suppressed: 0 });
    expect(h.db.tables.notification_deliveries[0]).toMatchObject({ status: "sent" });
  });

  it("leaves private-lesson reminders exactly as before (even for a cancelled lesson: out of this slice)", async () => {
    seed([delivery({ id: "d1", related_appointment_id: "les1" })], [{ id: "les1", appointment_type: "private_lesson", status: "cancelled" }]);
    const out = await call();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(out.notifications).toMatchObject({ sent: 1, suppressed: 0 });
  });

  it("does not check non-reminder deliveries even if they reference a cancelled class", async () => {
    seed([delivery({ id: "d1", delivery_type: "owner_daily_digest", metadata: { clientEmail: "owner@example.test" } })], [
      { id: "cls1", appointment_type: "group_class", status: "cancelled" },
    ]);
    const out = await call();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(out.notifications.suppressed).toBe(0);
  });

  it("defers (does not send, does not fail) when the class cannot be read, and leaves the row pending", async () => {
    seed([delivery({ id: "d1" })], [{ id: "cls1", appointment_type: "group_class", status: "scheduled" }]);
    h.db.failAppointments = true;
    const out = await call();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(out.notifications).toMatchObject({ sent: 0, failed: 0, suppressed: 0, deferred: 1 });
    expect(h.db.tables.notification_deliveries[0]).toMatchObject({ status: "pending" });
  });

  it("suppresses with a compare-and-set on status so a delivery another run already finished is never overwritten", async () => {
    seed([delivery({ id: "d1" })], [{ id: "cls1", appointment_type: "group_class", status: "cancelled" }]);
    await call();
    const update = h.updates.find((u) => u.table === "notification_deliveries");
    expect(update?.eqCols).toEqual(expect.arrayContaining(["id", "status"]));
    expect(update?.patch).toEqual({ status: "cancelled", failure_reason: "class_cancelled" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// GC-S1E-1: send-time revalidation of the start time and the attendee
// ---------------------------------------------------------------------------------------------------------------------
describe("GC-S1E-1 reminder send-time revalidation (start time and attendee)", () => {
  const START = "2030-05-01T15:00:00.000Z";
  const MOVED = "2030-05-01T17:00:00.000Z";
  const gcr = (over: Row = {}) =>
    delivery({
      id: "g1",
      dedupe_key: "gcr1:24h:cls1:c1:1",
      metadata: { clientEmail: "client@example.test", appointmentType: "group_class", startsAt: START },
      ...over,
    });
  const cls = (over: Row = {}) => ({ id: "cls1", studio_id: STUDIO, appointment_type: "group_class", status: "scheduled", starts_at: START, ...over });
  const booked = (over: Row = {}) => ({ id: "at1", studio_id: STUDIO, appointment_id: "cls1", client_id: "c1", status: "booked", ...over });

  it("F: an unchanged class with a still-booked dancer sends exactly once", async () => {
    seed([gcr()], [cls()], [booked()]);
    const out = await call();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(out.notifications).toMatchObject({ sent: 1, suppressed: 0 });
    await call();
    expect(h.fetchMock).toHaveBeenCalledTimes(1); // the row is no longer pending
  });

  it("C: a queued reminder for the old time is suppressed (the stale time is never emailed) once the class has moved", async () => {
    seed([gcr()], [cls({ starts_at: MOVED })], [booked()]);
    const out = await call();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(out.notifications).toMatchObject({ sent: 0, suppressed: 1, failed: 0 });
    expect(h.db.tables.notification_deliveries[0]).toMatchObject({ status: "cancelled", failure_reason: "class_rescheduled" });
    // the new time has its own identity, so nothing needs releasing here
    expect(h.db.tables.notification_deliveries[0].dedupe_key).toBe("gcr1:24h:cls1:c1:1");
  });

  it("C: the same instant written with a different offset is not a reschedule", async () => {
    seed([gcr({ metadata: { clientEmail: "client@example.test", startsAt: "2030-05-01T15:00:00+00:00" } })], [cls()], [booked()]);
    const out = await call();
    expect(out.notifications).toMatchObject({ sent: 1, suppressed: 0 });
  });

  it("E: a removed dancer queued reminder is suppressed and the key is released for a later re-enrollment", async () => {
    seed([gcr()], [cls()], [booked({ status: "cancelled" })]);
    const out = await call();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(out.notifications).toMatchObject({ sent: 0, suppressed: 1 });
    expect(h.db.tables.notification_deliveries[0]).toMatchObject({ status: "cancelled", failure_reason: "attendee_removed" });
    expect(String(h.db.tables.notification_deliveries[0].dedupe_key)).toBe("gcr1:24h:cls1:c1:1:released:g1");
  });

  it("E: a dancer with no attendee row at all is treated as not enrolled", async () => {
    seed([gcr()], [cls()], []);
    const out = await call();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(out.notifications.suppressed).toBe(1);
  });

  it("E: series removal leaves the same cancelled attendee state as single removal and is covered identically", async () => {
    // remove_group_class_series_from cancels ordinary appointment_attendees rows (status cancelled), exactly what single removal does
    seed(
      [gcr(), gcr({ id: "g2", client_id: "c2", dedupe_key: "gcr1:24h:cls1:c2:1" })],
      [cls()],
      [booked({ status: "cancelled" }), booked({ id: "at2", client_id: "c2" })],
    );
    const out = await call();
    expect(out.notifications).toMatchObject({ sent: 1, suppressed: 1 });
    expect(h.db.tables.notification_deliveries.find((d) => d.id === "g1")).toMatchObject({ status: "cancelled", failure_reason: "attendee_removed" });
    expect(h.db.tables.notification_deliveries.find((d) => d.id === "g2")).toMatchObject({ status: "sent" });
  });

  it("G: a cancelled class is still suppressed as class_cancelled (S1C-3 behavior preserved)", async () => {
    seed([gcr()], [cls({ status: "cancelled" })], [booked()]);
    const out = await call();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.db.tables.notification_deliveries[0]).toMatchObject({ status: "cancelled", failure_reason: "class_cancelled" });
    expect(out.notifications.suppressed).toBe(1);
  });

  it("I: a reminder row whose class belongs to another studio is never sent", async () => {
    seed([gcr()], [cls({ studio_id: "studio-b" })], [booked()]);
    const out = await call();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.db.tables.notification_deliveries[0]).toMatchObject({ status: "cancelled", failure_reason: "class_mismatch" });
    expect(out.notifications.suppressed).toBe(1);
  });

  it("I: an attendee row from another studio does not count as the dancer being booked", async () => {
    seed([gcr()], [cls()], [booked({ studio_id: "studio-b" })]);
    const out = await call();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(out.notifications.suppressed).toBe(1);
  });

  it("defers (leaves the row pending) when the attendee state cannot be read", async () => {
    seed([gcr()], [cls()], [booked()]);
    h.db.failAttendees = true;
    const out = await call();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(out.notifications).toMatchObject({ sent: 0, failed: 0, suppressed: 0, deferred: 1 });
    expect(h.db.tables.notification_deliveries[0]).toMatchObject({ status: "pending" });
  });

  it("older class reminders without the attendee identity (client_id path) are not subject to the new checks", async () => {
    seed([delivery({ id: "old", dedupe_key: null })], [cls({ starts_at: MOVED })], []);
    const out = await call();
    expect(out.notifications).toMatchObject({ sent: 1, suppressed: 0 });
  });

  it("suppression is a compare-and-set on pending status, so a delivery another run finished is never overwritten", async () => {
    seed([gcr()], [cls({ starts_at: MOVED })], [booked()]);
    await call();
    const update = h.updates.find((u) => u.table === "notification_deliveries");
    expect(update?.eqCols).toEqual(expect.arrayContaining(["id", "status"]));
    expect(update?.patch).toEqual({ status: "cancelled", failure_reason: "class_rescheduled" });
  });

  it("a moved class has a different reminder identity, so the old suppressed row never blocks the new time", async () => {
    const { groupClassReminderDedupeKey } = await import("@/lib/notifications/groupClassReminders");
    expect(groupClassReminderDedupeKey("24h", "cls1", "c1", START)).not.toBe(groupClassReminderDedupeKey("24h", "cls1", "c1", MOVED));
  });
});
