import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GC-S1C-3 (D11): send-time revalidation in the notification send route. A queued client reminder for a canonical group class
 * must not be delivered once the class is cancelled, whether or not the queued row was invalidated at cancel time; a reminder
 * for anything else is unaffected; an unreadable class leaves the row pending for the next run. The route runs against an
 * in-memory database and a stubbed email transport.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  db: null as unknown as { tables: Record<string, Row[]>; failAppointments: boolean },
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
    private db: { tables: Record<string, Row[]>; failAppointments: boolean },
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

function seed(deliveries: Row[], appointments: Row[]) {
  h.db = {
    failAppointments: false,
    tables: {
      notification_deliveries: deliveries,
      appointments,
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
