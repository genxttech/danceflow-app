import { describe, expect, it } from "vitest";
import {
  buildGroupClassReminderDelivery,
  groupClassReminderDedupeKey,
  groupClassReminderLegacyDedupeKey,
  isCanonicalGroupClass,
  isGroupClassAttendeeReminderKey,
  legacyReminderCoversOccurrence,
  normalizedStartKey,
  revalidateQueuedClassReminder,
  selectGroupClassRecipients,
  type ClassReminderAppointment,
  type ClassReminderAttendeeRow,
} from "@/lib/notifications/groupClassReminders";
import { renderNotificationHtml, type NotificationDeliveryRow } from "@/lib/notifications/notification-html";

const appt: ClassReminderAppointment = {
  id: "a1", studio_id: "s1", starts_at: "2026-03-11T15:00:00.000Z", title: "Salsa", appointment_type: "group_class", status: "scheduled",
};
const row = (over: Partial<ClassReminderAttendeeRow> = {}): ClassReminderAttendeeRow => ({
  appointment_id: "a1", studio_id: "s1", client_id: "c1", status: "booked",
  clients: { id: "c1", studio_id: "s1", first_name: "Ann", last_name: "Lee", email: "ann@example.test" }, ...over,
});
const format = { dateKey: () => "2026-03-11", dateLong: () => "Wednesday, March 11", time: () => "11:00 AM" };

describe("GC-R1 pure logic", () => {
  it("dedupe key is per kind, class, attendee and start time", () => {
    const at = "2026-03-11T15:00:00.000Z";
    const ms = String(new Date(at).getTime());
    expect(groupClassReminderDedupeKey("24h", "a1", "c1", at)).toBe(`gcr1:24h:a1:c1:${ms}`);
    expect(groupClassReminderDedupeKey("2h", "a1", "c1", at)).not.toBe(groupClassReminderDedupeKey("24h", "a1", "c1", at));
    expect(groupClassReminderDedupeKey("24h", "a1", "c2", at)).not.toBe(groupClassReminderDedupeKey("24h", "a1", "c1", at));
  });

  it("only group_class appointments are canonical classes", () => {
    expect(isCanonicalGroupClass({ appointment_type: "group_class" })).toBe(true);
    expect(isCanonicalGroupClass({ appointment_type: "private_lesson" })).toBe(false);
  });

  it("selects booked attendees only, dedupes repeated rows, and ignores non-class appointments", () => {
    const result = selectGroupClassRecipients(
      [appt, { ...appt, id: "p1", appointment_type: "private_lesson" }],
      [row(), row(), row({ client_id: "c2", status: "cancelled" }), row({ appointment_id: "p1" })],
    );
    expect(result.recipients.map((r) => r.clientId)).toEqual(["c1"]);
    expect([...result.classesWithAttendeeRows]).toEqual(["a1"]);
  });

  it("a class whose attendees are all cancelled still counts as roster-handled (no legacy fallback) with no recipients", () => {
    const result = selectGroupClassRecipients([appt], [row({ status: "cancelled" })]);
    expect(result.recipients).toEqual([]);
    expect(result.classesWithAttendeeRows.has("a1")).toBe(true);
  });

  it("rejects cross-studio rows and clients, and bad or missing emails", () => {
    const bad = [
      row({ studio_id: "s2" }),
      row({ clients: { id: "c1", studio_id: "s2", first_name: "", last_name: "", email: "x@example.test" } }),
      row({ clients: { id: "other", studio_id: "s1", first_name: "", last_name: "", email: "x@example.test" } }),
      row({ clients: { id: "c1", studio_id: "s1", first_name: "", last_name: "", email: null } }),
      row({ clients: { id: "c1", studio_id: "s1", first_name: "", last_name: "", email: "nope" } }),
      row({ clients: null }),
    ];
    expect(selectGroupClassRecipients([appt], bad).recipients).toEqual([]);
  });

  it("builds a 2h delivery with no payment language and no internal ids in the copy", () => {
    const d = buildGroupClassReminderDelivery({ kind: "2h", appointment: appt, clientId: "c1", email: "ann@example.test", name: "Ann Lee", timeZone: "America/New_York", now: new Date("2026-03-11T13:00:00Z"), format });
    expect(d.delivery_type).toBe("student_lesson_reminder_2h");
    expect(d.channel).toBe("email");
    expect(d.body).toBe("Salsa starts at 11:00 AM today.");
    expect(`${d.subject} ${d.body}`).not.toMatch(/a1|c1|credit|payment/);
  });
});

describe("GC-R1 branded HTML class variant", () => {
  const delivery = (over: Partial<NotificationDeliveryRow>): NotificationDeliveryRow => ({
    id: "d1", studio_id: "s1", user_id: null, client_id: "c1", delivery_type: "student_lesson_reminder_24h", channel: "email", status: "pending",
    subject: "Reminder: Salsa", body: "You are enrolled in Salsa on Wednesday, March 11 at 11:00 AM.\nInstructor: Maria Lopez\nLocation: Studio A",
    metadata: { appointmentType: "group_class", appointmentTitle: "Salsa", startsAt: "2026-03-11T15:00:00.000Z", studioTimezone: "America/New_York", clientName: "Ann Lee", instructorName: "Maria Lopez", locationName: "Studio A", confirmationUrl: "https://example.test/appointments/confirm/x" },
    scheduled_for: new Date().toISOString(), ...over,
  });

  it("renders class copy, detail rows and studio identity with no confirmation link", () => {
    const html = renderNotificationHtml({ delivery: delivery({}), studioName: "Acme Dance", portalUrl: "https://www.idanceflow.com/portal/acme-dance" });
    expect(html).toContain("Class Reminder");
    expect(html).toContain("Your class is coming up");
    expect(html).toContain("Maria Lopez");
    expect(html).toContain("Studio A");
    expect(html).toContain("Acme Dance");
    expect(html).not.toContain("appointments/confirm");
    expect(html).not.toMatch(/Lesson Reminder|Your lesson/);
  });

  it("2h class variant says the class starts soon", () => {
    const html = renderNotificationHtml({ delivery: delivery({ delivery_type: "student_lesson_reminder_2h", body: "Salsa starts at 11:00 AM today." }), studioName: "Acme Dance" });
    expect(html).toContain("Your class starts soon");
  });

  it("the private-lesson variant is unchanged", () => {
    const html = renderNotificationHtml({
      delivery: delivery({ body: null, metadata: { appointmentType: "private_lesson", appointmentTitle: "Private", startsAt: "2026-03-11T15:00:00.000Z", confirmationUrl: "https://example.test/appointments/confirm/x" } }),
      studioName: "Acme Dance",
    });
    expect(html).toContain("Lesson Reminder");
    expect(html).toContain("Your lesson is coming up");
    expect(html).not.toContain("Class Reminder");
  });
});

describe("GC-S1E-1 reminder identity and revalidation (pure)", () => {
  it("the start key is the canonical instant: offset spellings are equal, display strings and garbage are not accepted", () => {
    expect(normalizedStartKey("2026-03-11T15:00:00.000Z")).toBe(normalizedStartKey("2026-03-11T15:00:00+00:00"));
    expect(normalizedStartKey("2026-03-11T10:00:00-05:00")).toBe(normalizedStartKey("2026-03-11T15:00:00Z"));
    expect(normalizedStartKey("2026-03-11T15:00:00Z")).not.toBe(normalizedStartKey("2026-03-11T15:01:00Z"));
    expect(normalizedStartKey("Wednesday at 3 PM")).toBeNull();
    expect(normalizedStartKey("")).toBeNull();
    expect(normalizedStartKey(null)).toBeNull();
  });

  it("the legacy key is the old format and never equals a new key", () => {
    const at = "2026-03-11T15:00:00.000Z";
    expect(groupClassReminderLegacyDedupeKey("24h", "a1", "c1")).toBe("gcr1:24h:a1:c1");
    expect(groupClassReminderDedupeKey("24h", "a1", "c1", at)).not.toBe(groupClassReminderLegacyDedupeKey("24h", "a1", "c1"));
    expect(groupClassReminderDedupeKey("24h", "a1", "c1", at).startsWith(groupClassReminderLegacyDedupeKey("24h", "a1", "c1") + ":")).toBe(true);
  });

  it("a legacy row covers its own occurrence time and nothing else; an undatable row keeps the old rule", () => {
    const now = "2026-03-11T15:00:00.000Z";
    expect(legacyReminderCoversOccurrence({ startsAt: now }, now)).toBe(true);
    expect(legacyReminderCoversOccurrence({ startsAt: "2026-03-11T15:00:00+00:00" }, now)).toBe(true);
    expect(legacyReminderCoversOccurrence({ startsAt: "2026-03-11T16:00:00.000Z" }, now)).toBe(false);
    expect(legacyReminderCoversOccurrence({}, now)).toBe(true);
    expect(legacyReminderCoversOccurrence(null, now)).toBe(true);
    expect(legacyReminderCoversOccurrence({ startsAt: "garbage" }, now)).toBe(true);
  });

  it("only attendee-path keys are subject to the revalidation", () => {
    expect(isGroupClassAttendeeReminderKey("gcr1:24h:a1:c1:123")).toBe(true);
    expect(isGroupClassAttendeeReminderKey("gcr1:24h:a1:c1")).toBe(true);
    expect(isGroupClassAttendeeReminderKey(null)).toBe(false);
    expect(isGroupClassAttendeeReminderKey("something-else")).toBe(false);
  });

  const classRow = { studio_id: "s1", appointment_type: "group_class", status: "scheduled", starts_at: "2026-03-11T15:00:00.000Z" };
  const decide = (over: Partial<Parameters<typeof revalidateQueuedClassReminder>[0]> = {}) =>
    revalidateQueuedClassReminder({
      deliveryStudioId: "s1",
      queuedStartsAt: "2026-03-11T15:00:00.000Z",
      appointment: classRow,
      attendeeBooked: true,
      ...over,
    });

  it("revalidation: sends only for the current time of a live class and a still-booked dancer", () => {
    expect(decide()).toBe("ok");
    expect(decide({ queuedStartsAt: "2026-03-11T10:00:00-05:00" })).toBe("ok");
    expect(decide({ appointment: { ...classRow, starts_at: "2026-03-11T17:00:00.000Z" } })).toBe("rescheduled");
    expect(decide({ attendeeBooked: false })).toBe("removed");
    expect(decide({ appointment: { ...classRow, status: "cancelled" } })).toBe("cancelled");
    expect(decide({ appointment: { ...classRow, studio_id: "s2" } })).toBe("invalid");
  });

  it("revalidation: cancellation wins over everything, a missing recorded time falls through to the attendee check, other appointment types are untouched", () => {
    expect(decide({ appointment: { ...classRow, status: "cancelled" }, attendeeBooked: false, queuedStartsAt: "2000-01-01T00:00:00Z" })).toBe("cancelled");
    expect(decide({ queuedStartsAt: undefined })).toBe("ok");
    expect(decide({ queuedStartsAt: undefined, attendeeBooked: false })).toBe("removed");
    expect(decide({ appointment: { ...classRow, appointment_type: "private_lesson", starts_at: "2030-01-01T00:00:00Z" }, attendeeBooked: false })).toBe("ok");
  });
});
