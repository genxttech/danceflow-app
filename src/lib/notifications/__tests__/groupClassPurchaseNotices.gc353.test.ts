import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GC-3.5-3: notification additions for public paid registration. Same in-memory harness as the GC-S1F studio-notice test:
 * proves the dancer confirmation shows "paid online" only when asked (after verified settlement), the studio notice
 * identifies a NEW client from a public paid registration with a staff-only reconciliation note, the paid wording is
 * refused unless the attendee row itself is a paid pay-as-you-go enrollment, the refund-issue alert is deduped per hold,
 * and every email is branded HTML + text.
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
vi.mock("@/lib/notifications/studioStaffRecipients", () => ({ getStudioRegistrationNotificationEmails: (...a: unknown[]) => h.recipients(...a) }));

class Builder implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Array<(r: Row) => boolean> = [];
  constructor(private table: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, vals: unknown[]) { this.filters.push((r) => vals.includes(r[c])); return this; }
  order() { return this; }
  limit() { return this; }
  maybeSingle() { return this.then((r) => ({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error })); }
  then<T1, T2>(a?: ((v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null, b?: ((r: unknown) => T2 | PromiseLike<T2>) | null) {
    return Promise.resolve()
      .then(() => ({ data: (h.db[this.table] ?? []).filter((r) => this.filters.every((f) => f(r))).map((r) => ({ ...r })), error: null }))
      .then(a, b);
  }
}

const n = await import("../groupClassNotices");
const emails = await import("../scheduling-emails");

const S1 = "studio-1";

function seed(attendee: Row = {}) {
  h.db = {
    studios: [{ id: S1, name: "Studio One", public_name: "Studio One Dance", public_logo_url: null, slug: "one" }],
    studio_settings: [{ studio_id: S1, timezone: "America/New_York" }],
    appointments: [{ id: "c1", studio_id: S1, appointment_type: "group_class", title: "Salsa Level 1", starts_at: "2030-05-01T22:00:00.000Z", instructor_id: null, room_id: null, location_name: null }],
    appointment_attendees: [{ id: "att1", studio_id: S1, appointment_id: "c1", client_id: "cl1", status: "booked", billing_type: "pay_as_you_go", payment_status: "paid", ...attendee }],
    clients: [{ id: "cl1", studio_id: S1, first_name: "Ada", last_name: "Lovelace", email: "ada@example.test" }],
    instructors: [],
    rooms: [],
    client_account_links: [],
    dancer_profiles: [],
  };
}

beforeEach(() => {
  h.queue.mockReset();
  h.recipients.mockReset();
  h.queue.mockResolvedValue({ queued: true, skipped: false });
  h.recipients.mockResolvedValue(["owner@example.test"]);
  seed();
});

describe("dancer confirmation", () => {
  it("S: shows 'Payment: $25.00 paid online' only when the settled payment label is passed", () => {
    const studio = { name: "Studio One", public_name: "Studio One Dance", public_logo_url: null, slug: "one" } as never;
    const base = { studio, firstName: "Ada", classTitle: "Salsa Level 1", firstClass: "Thu, May 1", classCount: 1, instructorName: null, locationName: null, selfEnrolled: true };
    const paid = emails.buildGroupClassEnrollmentEmail({ ...base, paymentLabel: "$25.00 paid online" });
    expect(paid.bodyText).toContain("Payment: $25.00 paid online");
    expect(paid.bodyHtml).toContain("$25.00 paid online");
    expect(paid.bodyHtml).toMatch(/<html|<table/i);
    const unpaid = emails.buildGroupClassEnrollmentEmail(base);
    expect(unpaid.bodyText).not.toContain("Payment:");
  });

  it("S: the notifier forwards the payment label and keys the dedupe on the attendee id", async () => {
    await n.notifyGroupClassEnrolled({ studioId: S1, clientId: "cl1", appointmentIds: ["c1"], eventId: "att1", series: false, selfEnrolled: true, paymentLabel: "$25.00 paid online" });
    expect(h.queue).toHaveBeenCalledTimes(1);
    const call = h.queue.mock.calls[0][0];
    expect(call.bodyText).toContain("Payment: $25.00 paid online");
    expect(call.dedupeKey).toBe("group_class_enrolled:att1:ada@example.test");
    expect(call.bodyHtml).toBeTruthy();
  });
});

describe("studio notice", () => {
  it("T: identifies a new client from a public paid registration, with a staff-only reconciliation note", async () => {
    await n.notifyStudioOfExternalGroupClassEnrollment({ studioId: S1, attendeeId: "att1", publicPaidRegistration: { amountLabel: "$25.00", newClient: true } });
    const call = h.queue.mock.calls[0][0];
    expect(call.subject).toContain("New client — public paid registration");
    expect(call.bodyText).toContain("Payment: Paid online — $25.00");
    expect(call.bodyText).toContain("If this person already has a record at your studio, you may want to reconcile the two records.");
    expect(call.bodyHtml).toContain("New client — public paid registration");
    expect(call.dedupeKey).toBe("group_class_external_enrollment_staff:att1:owner@example.test");
  });

  it("a purchase that reused the purchaser's existing self link is not called a new client (no reconcile note)", async () => {
    await n.notifyStudioOfExternalGroupClassEnrollment({ studioId: S1, attendeeId: "att1", publicPaidRegistration: { amountLabel: "$25.00", newClient: false } });
    const call = h.queue.mock.calls[0][0];
    expect(call.subject).toContain("Public paid registration");
    expect(call.subject).not.toContain("New client");
    expect(call.bodyText).not.toContain("reconcile");
    expect(call.bodyText).toContain("Paid online — $25.00");
  });

  it("never claims a payment unless the attendee row itself is a paid pay-as-you-go enrollment", async () => {
    seed({ billing_type: "package_credit", payment_status: "unpaid" });
    await n.notifyStudioOfExternalGroupClassEnrollment({ studioId: S1, attendeeId: "att1", publicPaidRegistration: { amountLabel: "$25.00", newClient: true } });
    const call = h.queue.mock.calls[0][0];
    expect(call.bodyText).not.toContain("Paid online");
    expect(call.bodyText).toContain("Funding: Package credit");
  });

  it("the existing portal self-enrollment notice is unchanged without the flag", async () => {
    seed({ billing_type: "membership", payment_status: "unpaid" });
    await n.notifyStudioOfExternalGroupClassEnrollment({ studioId: S1, attendeeId: "att1" });
    const call = h.queue.mock.calls[0][0];
    expect(call.subject).toContain("New class enrollment: Ada Lovelace joined Salsa Level 1");
    expect(call.subject).not.toContain("public paid registration");
    expect(call.bodyText).toContain("Funding: Membership");
    expect(call.bodyText).not.toContain("Paid online");
  });
});

describe("refund-issue staff alert (X)", () => {
  it("alerts studio staff once per hold with branded HTML and never claims a refund happened", async () => {
    await n.notifyStudioOfPublicPurchaseRefundIssue({ studioId: S1, holdId: "hold-1", appointmentId: "c1", dancerName: "Ada Lovelace", amountLabel: "$25.00" });
    expect(h.queue).toHaveBeenCalledTimes(1);
    const call = h.queue.mock.calls[0][0];
    expect(call).toMatchObject({ studioId: S1, channel: "email", templateKey: "group_class_public_purchase_refund_issue_staff", relatedTable: "group_class_enrollment_holds", relatedId: "hold-1" });
    expect(call.dedupeKey).toBe("group_class_public_purchase_refund_issue_staff:hold-1:owner@example.test");
    expect(call.bodyText).toContain("the automatic refund did not go through");
    expect(call.bodyText).toContain("Amount: $25.00");
    expect(call.bodyHtml).toContain("Refund did not go through");
    expect(call.bodyText).not.toMatch(/was refunded|refund (has been|was) (issued|completed)/i);
  });

  it("never throws", async () => {
    h.recipients.mockRejectedValue(new Error("boom"));
    await expect(
      n.notifyStudioOfPublicPurchaseRefundIssue({ studioId: S1, holdId: "hold-1", appointmentId: "c1", dancerName: "A", amountLabel: "$1.00" }),
    ).resolves.toEqual({ emailsQueued: 0, pushedAccounts: 0 });
  });
});
