import { createAdminClient } from "@/lib/supabase/admin";
import { queueOutboundDelivery } from "@/lib/notifications/outbound";
import {
  buildEventConfirmedEmailTemplate,
  buildEventConfirmedSmsTemplate,
} from "@/lib/notifications/templates";

type EventReminderCandidate = {
  id: string;
  studio_id: string;
  attendee_first_name: string;
  attendee_last_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  quantity: number;
  total_price: number | null;
  currency: string | null;
  events:
    | {
        slug: string;
        name: string;
        start_date: string;
        start_time: string | null;
      }
    | {
        slug: string;
        name: string;
        start_date: string;
        start_time: string | null;
      }[]
    | null;
  event_ticket_types:
    | {
        name: string;
      }
    | {
        name: string;
      }[]
    | null;
};

function getAppUrl() {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "http://localhost:3000"
  );
}

function getEventValue(
  value:
    | {
        slug: string;
        name: string;
        start_date: string;
        start_time: string | null;
      }
    | {
        slug: string;
        name: string;
        start_date: string;
        start_time: string | null;
      }[]
    | null
) {
  return Array.isArray(value) ? value[0] : value;
}

function getTicketTypeValue(
  value:
    | { name: string }
    | { name: string }[]
    | null
) {
  return Array.isArray(value) ? value[0] : value;
}

function buildEventStartDateTime(startDate: string, startTime: string | null) {
  const time = startTime && startTime.trim() ? startTime.trim() : "00:00:00";
  return new Date(`${startDate}T${time}`);
}

function hoursUntil(date: Date) {
  return (date.getTime() - Date.now()) / (1000 * 60 * 60);
}

export async function queueUpcomingEventReminders() {
  const supabase = createAdminClient();

  const today = new Date();
  const inTwoDays = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000);

  const startDateMin = today.toISOString().slice(0, 10);
  const startDateMax = inTwoDays.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("event_registrations")
    .select(`
      id,
      studio_id,
      attendee_first_name,
      attendee_last_name,
      attendee_email,
      attendee_phone,
      quantity,
      total_price,
      currency,
      events (
        slug,
        name,
        start_date,
        start_time
      ),
      event_ticket_types (
        name
      )
    `)
    .eq("status", "confirmed")
    .gte("events.start_date", startDateMin)
    .lte("events.start_date", startDateMax);

  if (error) {
    throw new Error(`Failed to load event reminder candidates: ${error.message}`);
  }

  const rows = (data ?? []) as EventReminderCandidate[];

  let queued = 0;
  let skipped = 0;

  for (const row of rows) {
    const eventValue = getEventValue(row.events);
    if (!eventValue?.slug || !eventValue?.name || !eventValue?.start_date) {
      skipped += 1;
      continue;
    }

    const startAt = buildEventStartDateTime(
      eventValue.start_date,
      eventValue.start_time
    );
    const diffHours = hoursUntil(startAt);

    // Send roughly in the 24-hour reminder window.
    if (diffHours < 0 || diffHours > 26) {
      skipped += 1;
      continue;
    }

    const eventUrl = `${getAppUrl()}/events/${encodeURIComponent(eventValue.slug)}`;
    const ticketTypeValue = getTicketTypeValue(row.event_ticket_types);

    const emailTemplate = buildEventConfirmedEmailTemplate({
      eventName: `${eventValue.name} — Reminder`,
      attendeeFirstName: row.attendee_first_name,
      attendeeLastName: row.attendee_last_name,
      ticketTypeName: ticketTypeValue?.name ?? "Event ticket",
      quantity: row.quantity ?? 1,
      totalPrice: Number(row.total_price ?? 0),
      currency: row.currency || "USD",
      eventUrl,
    });

    const smsBody = buildEventConfirmedSmsTemplate({
      eventName: `${eventValue.name} — Reminder`,
      attendeeFirstName: row.attendee_first_name,
      attendeeLastName: row.attendee_last_name,
      ticketTypeName: ticketTypeValue?.name ?? "Event ticket",
      quantity: row.quantity ?? 1,
      totalPrice: Number(row.total_price ?? 0),
      currency: row.currency || "USD",
      eventUrl,
    });

    const reminderKey = `${eventValue.start_date}:${eventValue.start_time ?? "00:00:00"}`;

    const results = await Promise.allSettled([
      queueOutboundDelivery({
        studioId: row.studio_id,
        channel: "email",
        templateKey: "event_registration_reminder_24h",
        recipientEmail: row.attendee_email,
        subject: emailTemplate.subject,
        bodyText: emailTemplate.bodyText,
        relatedTable: "event_registrations",
        relatedId: row.id,
        dedupeKey: `event_registration_reminder_24h:email:${row.id}:${reminderKey}`,
      }),
      queueOutboundDelivery({
        studioId: row.studio_id,
        channel: "sms",
        templateKey: "event_registration_reminder_24h",
        recipientPhone: row.attendee_phone,
        bodyText: smsBody,
        relatedTable: "event_registrations",
        relatedId: row.id,
        dedupeKey: `event_registration_reminder_24h:sms:${row.id}:${reminderKey}`,
      }),
    ]);

    const anyQueued = results.some(
      (result) => result.status === "fulfilled" && result.value?.queued
    );

    if (anyQueued) {
      queued += 1;
    } else {
      skipped += 1;
    }
  }

  return {
    scanned: rows.length,
    queued,
    skipped,
  };
}