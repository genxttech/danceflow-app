import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GC-S1F: studio-side operational notice for a dancer who enrolled themselves through the client portal. Runs against an
 * in-memory database with the outbound queue and recipient lookup stubbed: proves who is told, once, with what content, and that
 * a failure never throws.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  queue: vi.fn(),
  recipients: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (t: string) => new Builder(t) }) }));
vi.mock("@/lib/notifications/outbound", () => ({ queueOutboundDelivery: (...a: unknown[]) => h.queue(...a) }));
vi.mock("@/lib/notifications/schedulePush", () => ({ sendGroupClassNoticePush: vi.fn() }));
vi.mock("@/lib/notifications/studioStaffRecipients", () => ({ getStudioStaffNotificationEmails: (...a: unknown[]) => h.recipients(...a) }));

class Builder implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Array<(r: Row) => boolean> = [];
  constructor(private table: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, vals: unknown[]) { this.filters.push((r) => vals.includes(r[c])); return this; }
  maybeSingle() { return this.then((r) => ({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error })); }
  then<T1, T2>(a?: ((v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null, b?: ((r: unknown) => T2 | PromiseLike<T2>) | null) {
    return Promise.resolve()
      .then(() => ({ data: (h.db[this.table] ?? []).filter((r) => this.filters.every((f) => f(r))).map((r) => ({ ...r })), error: null }))
      .then(a, b);
  }
}

const n = await import("../groupClassNotices");

const S1 = "studio-1";
const S2 = "studio-2";

function seed(attendee: Row = {}, cls: Row = {}) {
  h.db = {
    studios: [
      { id: S1, name: "Studio One", public_name: "Studio One Dance", public_logo_url: null, slug: "one" },
      { id: S2, name: "Studio Two", public_name: "Studio Two", public_logo_url: null, slug: "two" },
    ],
    studio_settings: [{ studio_id: S1, timezone: "America/New_York" }],
    appointments: [{ id: "c1", studio_id: S1, appointment_type: "group_class", title: "Salsa Level 1", starts_at: "2030-05-01T22:00:00.000Z", instructor_id: "i1", room_id: "r1", location_name: null, ...cls }],
    appointment_attendees: [{ id: "att1", studio_id: S1, appointment_id: "c1", client_id: "cl1", status: "booked", billing_type: "package_credit", ...attendee }],
    clients: [{ id: "cl1", studio_id: S1, first_name: "Dana", last_name: "Reyes", email: "dana@example.test" }],
    instructors: [{ id: "i1", studio_id: S1, first_name: "Maria", last_name: "Lopez" }],
    rooms: [{ id: "r1", studio_id: S1, name: "Studio A" }],
  };
}

beforeEach(() => {
  h.queue.mockReset();
  h.recipients.mockReset();
  h.queue.mockResolvedValue({ queued: true, skipped: false });
  h.recipients.mockResolvedValue(["owner@example.test", "admin@example.test"]);
  seed();
});

describe("S1F studio notice for a portal self-enrollment", () => {
  it("sends one branded operational email per studio recipient, keyed on the new attendee id", async () => {
    const out = await n.notifyStudioOfExternalGroupClassEnrollment({ studioId: S1, attendeeId: "att1" });
    expect(out.emailsQueued).toBe(2);
    expect(out.pushedAccounts).toBe(0); // no push, no SMS
    expect(h.recipients).toHaveBeenCalledTimes(1);
    expect(h.recipients.mock.calls[0][1]).toBe(S1); // recipients are looked up for this studio only
    const calls = h.queue.mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.recipientEmail).sort()).toEqual(["admin@example.test", "owner@example.test"]);
    for (const c of calls) {
      expect(c).toMatchObject({ studioId: S1, channel: "email", templateKey: "group_class_external_enrollment_staff", relatedTable: "appointment_attendees", relatedId: "att1" });
      expect(c.dedupeKey).toBe(`group_class_external_enrollment_staff:att1:${c.recipientEmail}`);
      expect(c.bodyHtml).toContain("Studio One Dance");
      expect(c.bodyText).toContain("Dancer: Dana Reyes");
      expect(c.bodyText).toContain("Class: Salsa Level 1");
      expect(c.bodyText).toContain("Status: Enrolled");
      expect(c.bodyText).toContain("Instructor: Maria Lopez");
      expect(c.bodyText).toContain("Location: Studio A");
      expect(c.bodyText).toContain("/app/schedule/c1");
      expect(c.subject).toContain("Dana Reyes");
    }
  });

  it("package-funded: says package credit and never claims a purchase or payment", async () => {
    await n.notifyStudioOfExternalGroupClassEnrollment({ studioId: S1, attendeeId: "att1" });
    const c = h.queue.mock.calls[0][0];
    expect(c.bodyText).toContain("Funding: Package credit");
    for (const text of [c.bodyText, c.bodyHtml, c.subject]) expect(text).not.toMatch(/\bpaid\b|payment|purchas|\$\d|cash|charged/i);
  });

  it("membership-funded: says membership and never claims a purchase or payment", async () => {
    seed({ billing_type: "membership" });
    await n.notifyStudioOfExternalGroupClassEnrollment({ studioId: S1, attendeeId: "att1" });
    const c = h.queue.mock.calls[0][0];
    expect(c.bodyText).toContain("Funding: Membership");
    expect(c.bodyText).not.toMatch(/Package/);
    for (const text of [c.bodyText, c.bodyHtml]) expect(text).not.toMatch(/\bpaid\b|payment|purchas|\$\d|cash/i);
  });

  it("a replay of the same attendee is deduplicated by the outbound key and reports no new email", async () => {
    h.queue.mockResolvedValue({ queued: false, skipped: true, reason: "duplicate" });
    const out = await n.notifyStudioOfExternalGroupClassEnrollment({ studioId: S1, attendeeId: "att1" });
    expect(out.emailsQueued).toBe(0);
    const keys = h.queue.mock.calls.map((c) => c[0].dedupeKey);
    await n.notifyStudioOfExternalGroupClassEnrollment({ studioId: S1, attendeeId: "att1" });
    expect(h.queue.mock.calls.slice(-2).map((c) => c[0].dedupeKey)).toEqual(keys); // identical keys every time
  });

  it("sends nothing for anything that is not a committed booked enrollment", async () => {
    for (const status of ["cancelled", "registered", "attended"]) {
      seed({ status });
      expect((await n.notifyStudioOfExternalGroupClassEnrollment({ studioId: S1, attendeeId: "att1" })).emailsQueued).toBe(0);
    }
    seed();
    expect((await n.notifyStudioOfExternalGroupClassEnrollment({ studioId: S1, attendeeId: "missing" })).emailsQueued).toBe(0);
    expect(h.queue).not.toHaveBeenCalled();
  });

  it("cannot be used across studios: an attendee of another studio sends nothing and no recipient lookup occurs", async () => {
    const out = await n.notifyStudioOfExternalGroupClassEnrollment({ studioId: S2, attendeeId: "att1" });
    expect(out.emailsQueued).toBe(0);
    expect(h.queue).not.toHaveBeenCalled();
    expect(h.recipients).not.toHaveBeenCalled();
  });

  it("sends nothing for a non-group-class appointment or when no recipient exists", async () => {
    seed({}, { appointment_type: "private_lesson" });
    expect((await n.notifyStudioOfExternalGroupClassEnrollment({ studioId: S1, attendeeId: "att1" })).emailsQueued).toBe(0);
    seed();
    h.recipients.mockResolvedValue([]);
    expect((await n.notifyStudioOfExternalGroupClassEnrollment({ studioId: S1, attendeeId: "att1" })).emailsQueued).toBe(0);
    expect(h.queue).not.toHaveBeenCalled();
  });

  it("never throws: queue failure or recipient lookup failure leaves the enrollment standing", async () => {
    h.queue.mockRejectedValue(new Error("smtp down"));
    await expect(n.notifyStudioOfExternalGroupClassEnrollment({ studioId: S1, attendeeId: "att1" })).resolves.toMatchObject({ emailsQueued: 0 });
    h.recipients.mockRejectedValue(new Error("studio_staff_recipient_lookup_failed"));
    await expect(n.notifyStudioOfExternalGroupClassEnrollment({ studioId: S1, attendeeId: "att1" })).resolves.toMatchObject({ emailsQueued: 0 });
  });

  it("funding label maps only real self-enrollment funding and never invents a payment", () => {
    expect(n.externalEnrollmentFundingLabel("package_credit")).toBe("Package credit");
    expect(n.externalEnrollmentFundingLabel("membership")).toBe("Membership");
    expect(n.externalEnrollmentFundingLabel("direct_payment")).not.toMatch(/paid|cash|purchase/i);
  });
});

describe("S1F dancer confirmation wording and isolation", () => {
  it("self-enrollment speaks to the dancer; staff-driven enrollment keeps the studio wording", async () => {
    await n.notifyGroupClassEnrolled({ studioId: S1, clientId: "cl1", appointmentIds: ["c1"], eventId: "att1", series: false, selfEnrolled: true });
    const self = h.queue.mock.calls[0][0];
    expect(self.templateKey).toBe("group_class_enrolled");
    expect(self.bodyText).toMatch(/You.re enrolled in Salsa Level 1 on /);
    expect(self.bodyText).not.toMatch(/enrolled you in/);
    h.queue.mockClear();
    await n.notifyGroupClassEnrolled({ studioId: S1, clientId: "cl1", appointmentIds: ["c1"], eventId: "att1", series: false });
    const staff = h.queue.mock.calls[0][0];
    expect(staff.bodyText).toContain("Studio One Dance enrolled you in Salsa Level 1 on ");
    expect(staff.dedupeKey).toBe(self.dedupeKey); // same event identity either way, so never two confirmations
  });

  it("a failing dancer notice neither throws nor blocks the studio notice", async () => {
    h.queue.mockImplementation(async (p: { templateKey: string }) => {
      if (p.templateKey === "group_class_enrolled") throw new Error("smtp down");
      return { queued: true, skipped: false };
    });
    await expect(n.notifyGroupClassEnrolled({ studioId: S1, clientId: "cl1", appointmentIds: ["c1"], eventId: "att1", series: false, selfEnrolled: true })).resolves.toBeDefined();
    const studio = await n.notifyStudioOfExternalGroupClassEnrollment({ studioId: S1, attendeeId: "att1" });
    expect(studio.emailsQueued).toBe(2);
  });

  it("dancer-supplied text is HTML-escaped in the studio email", async () => {
    (h.db.clients[0] as Row).first_name = "<img src=x onerror=alert(1)>";
    await n.notifyStudioOfExternalGroupClassEnrollment({ studioId: S1, attendeeId: "att1" });
    const html = h.queue.mock.calls[0][0].bodyHtml as string;
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("S1F portal self-enrollment wiring", () => {
  const src = readFileSync(path.resolve(import.meta.dirname, "../../../app/portal/[studioSlug]/schedule/actions.ts"), "utf8");
  const body = src.slice(src.indexOf("export async function selfEnrollGroupClassAction"));

  it("notifies the dancer and the studio only after the RPC succeeded, keyed on the returned attendee id", () => {
    const rpc = body.indexOf('rpc("self_enroll_class_attendee"');
    const errorRedirect = body.indexOf("classifySelfEnrollError(error.message");
    const dancer = body.indexOf("notifyGroupClassEnrolled(");
    const studio = body.indexOf("notifyStudioOfExternalGroupClassEnrollment(");
    expect(rpc).toBeGreaterThan(-1);
    expect(errorRedirect).toBeGreaterThan(rpc);
    expect(dancer).toBeGreaterThan(errorRedirect);
    expect(studio).toBeGreaterThan(dancer);
    expect(body).toMatch(/data: enrolledAttendeeId, error } = await authClient\.rpc\("self_enroll_class_attendee"/);
    expect(body).toMatch(/eventId: enrolledAttendeeId/);
    expect(body).toMatch(/selfEnrolled: true/);
    expect(body).toMatch(/attendeeId: enrolledAttendeeId/);
  });
});
