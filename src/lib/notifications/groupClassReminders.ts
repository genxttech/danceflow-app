/**
 * GC-R1: reminders for the enrolled attendees of canonical (appointment-based) group classes.
 *
 * A canonical group_class appointment has no client_id (enrollment lives in appointment_attendees), so the lesson reminder
 * generator, which keys on appointment.client_id, never reminded class attendees. This module is the pure part of the
 * fix: who is eligible, what the delivery row looks like and how it is deduplicated. The route keeps every I/O concern.
 *
 * Reused as-is: the 24h and 2h windows, the `student_lesson_reminder_24h` / `_2h` delivery types (the table's CHECK
 * constraint only allows those and the staff types), the notification_deliveries table, the send route and its branded
 * HTML path, Reply-To and sender-name rules. These are operational reminders: they never touch the campaign email allowance.
 *
 * Eligibility follows the roster's own definition (src/lib/schedule/groupClassRoster.ts): an attendee is enrolled when
 * appointment_attendees.status = 'booked'. A class that has attendee rows is reminded ONLY through them; a class with no
 * attendee rows keeps the legacy client_id behavior untouched.
 */

type Relation<T> = T | T[] | null | undefined;

export type ClassReminderAppointment = {
  id: string;
  studio_id: string;
  starts_at: string;
  title: string | null;
  appointment_type: string | null;
  status: string | null;
  location_name?: string | null;
  instructors?: Relation<{ first_name: string | null; last_name: string | null }>;
  rooms?: Relation<{ name: string | null }>;
};

export type ClassReminderAttendeeRow = {
  appointment_id: string;
  studio_id: string;
  client_id: string;
  status: string;
  clients: Relation<{
    id: string;
    studio_id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  }>;
};

export type ClassReminderKind = "24h" | "2h";

export type ClassReminderDelivery = {
  studio_id: string;
  client_id: string;
  delivery_type: "student_lesson_reminder_24h" | "student_lesson_reminder_2h";
  channel: "email";
  status: "pending";
  related_appointment_id: string;
  related_date: string;
  subject: string;
  body: string;
  metadata: Record<string, unknown>;
  scheduled_for: string;
  dedupe_key: string;
};

function first<T>(value: Relation<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function clean(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function isDeliverableEmail(value: string | null | undefined) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(value));
}

/**
 * Idempotency key for one attendee, one class occurrence and one reminder window. The (channel, delivery_type, user_id,
 * client_id, related_appointment_id, related_date) unique constraint cannot dedupe these rows because user_id is NULL
 * (NULLs are distinct in a unique index), so the table's partial unique index on dedupe_key is used instead.
 */
export function groupClassReminderDedupeKey(kind: ClassReminderKind, appointmentId: string, clientId: string) {
  return `gcr1:${kind}:${appointmentId}:${clientId}`;
}

export function isCanonicalGroupClass(appointment: { appointment_type: string | null }) {
  return appointment.appointment_type === "group_class";
}

/**
 * Splits canonical group classes into those reminded through their attendee rows and the rest, and returns the eligible
 * recipients: booked, same studio as the class and the client's own studio, with a deliverable email. Anything else is
 * skipped silently (a missing address never fails the run and is never invented).
 */
export function selectGroupClassRecipients(
  appointments: ClassReminderAppointment[],
  attendeeRows: ClassReminderAttendeeRow[],
) {
  const byId = new Map(appointments.filter(isCanonicalGroupClass).map((a) => [a.id, a]));
  const classesWithAttendeeRows = new Set<string>();
  const seen = new Set<string>();
  const recipients: Array<{ appointment: ClassReminderAppointment; clientId: string; email: string; name: string }> = [];

  for (const row of attendeeRows) {
    const appointment = byId.get(row.appointment_id);
    if (!appointment) continue;
    classesWithAttendeeRows.add(appointment.id);

    if (row.status !== "booked") continue; // cancelled / not enrolled
    if (row.studio_id !== appointment.studio_id) continue; // tenant boundary: the roster row must belong to the class's studio
    const client = first(row.clients);
    if (!client || client.id !== row.client_id || client.studio_id !== appointment.studio_id) continue; // and so must the client
    if (!isDeliverableEmail(client.email)) continue;

    const key = `${appointment.id}:${client.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    recipients.push({
      appointment,
      clientId: client.id,
      email: clean(client.email),
      name: [clean(client.first_name), clean(client.last_name)].filter(Boolean).join(" "),
    });
  }

  return { classesWithAttendeeRows, recipients };
}

export type ClassReminderFormatters = {
  dateKey: (date: Date, timeZone: string) => string;
  dateLong: (date: string, timeZone: string) => string;
  time: (date: string, timeZone: string) => string;
};

/** The one delivery row for one eligible attendee and one reminder window. Class-specific, truthful copy only. */
export function buildGroupClassReminderDelivery(params: {
  kind: ClassReminderKind;
  appointment: ClassReminderAppointment;
  clientId: string;
  email: string;
  name: string;
  timeZone: string;
  now: Date;
  format: ClassReminderFormatters;
}): ClassReminderDelivery {
  const { kind, appointment, clientId, timeZone, format } = params;
  const title = clean(appointment.title) || "Group Class";
  const instructor = first(appointment.instructors);
  const instructorName = instructor ? [clean(instructor.first_name), clean(instructor.last_name)].filter(Boolean).join(" ") : "";
  const locationName = clean(appointment.location_name) || clean(first(appointment.rooms)?.name);
  const dateLong = format.dateLong(appointment.starts_at, timeZone);
  const time = format.time(appointment.starts_at, timeZone);

  const detailLines = [
    instructorName ? `Instructor: ${instructorName}` : null,
    locationName ? `Location: ${locationName}` : null,
  ].filter((line): line is string => Boolean(line));

  const lead =
    kind === "24h"
      ? `You are enrolled in ${title} on ${dateLong} at ${time}.`
      : `${title} starts at ${time} today.`;

  return {
    studio_id: appointment.studio_id,
    client_id: clientId,
    delivery_type: kind === "24h" ? "student_lesson_reminder_24h" : "student_lesson_reminder_2h",
    channel: "email",
    status: "pending",
    related_appointment_id: appointment.id,
    related_date: format.dateKey(new Date(appointment.starts_at), timeZone),
    subject: kind === "24h" ? `Reminder: ${title} on ${dateLong}` : `Reminder: your class starts soon`,
    body: [lead, ...detailLines].join("\n"),
    metadata: {
      appointmentTitle: title,
      appointmentType: "group_class",
      startsAt: appointment.starts_at,
      clientName: params.name,
      clientEmail: params.email,
      studioTimezone: timeZone,
      ...(instructorName ? { instructorName } : {}),
      ...(locationName ? { locationName } : {}),
    },
    scheduled_for: params.now.toISOString(),
    dedupe_key: groupClassReminderDedupeKey(kind, appointment.id, clientId),
  };
}
