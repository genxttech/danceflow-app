import { getEventEndUtc, isEventPast } from "@/lib/eventTiming";
import type { StudentWallet } from "@/lib/studentWallet";

/*
  Tickets & registrations: which event registrations are upcoming and which are history.
  "Ended" is the shared end-of-event rule (src/lib/eventTiming.ts: end date + end time in the EVENT's own time zone), the same one the Events list uses,
  not the device's date. History keeps registrations without an issued ticket and cancelled/refunded ones; a cancelled registration of an event that has
  not ended stays out of both lists (as before). Nothing here reads or changes access: it only sorts what the dancer's own wallet already holds.
*/

export const PAST_PAGE_SIZE = 12;

export type EventScheduleItem = {
  id: string;
  eventId: string;
  eventName: string;
  eventSlug: string | null;
  studioName: string;
  hostName: string;
  status: string;
  paymentStatus: string | null;
  ticketCount: number;
  eventDate: string | null;
  eventTime: string | null;
  eventEndDate: string | null;
  eventEndTime: string | null;
  eventTimeZone: string | null;
  venue: string | null;
  city: string | null;
  state: string | null;
};

function timingOf(item: EventScheduleItem) {
  return { start_date: item.eventDate, start_time: item.eventTime, end_date: item.eventEndDate, end_time: item.eventEndTime, timezone: item.eventTimeZone };
}

/** A timing failure (an unusable zone, say) never hides a registration: it counts as not ended. */
function endedSafe(item: EventScheduleItem, now: Date) {
  try {
    return isEventPast(timingOf(item), now);
  } catch {
    return false;
  }
}

function dateKey(item: Pick<EventScheduleItem, "eventDate">) {
  return item.eventDate?.slice(0, 10) ?? null;
}

/** When the event ended (ms), falling back to the start date, for sorting history newest first. */
function endedAtMs(item: EventScheduleItem) {
  try {
    const end = getEventEndUtc(timingOf(item));
    if (end) return end.getTime();
  } catch {
    // fall through
  }
  const key = dateKey(item);
  return key ? Date.parse(`${key}T00:00:00Z`) || 0 : 0;
}

export function eventItemsFromWallet(wallet: StudentWallet | null, now: Date = new Date()): { upcoming: EventScheduleItem[]; past: EventScheduleItem[] } {
  if (!wallet) return { upcoming: [], past: [] };

  const ticketCountByRegistrationId = new Map<string, number>();
  wallet.tickets.forEach((ticket) => {
    ticketCountByRegistrationId.set(ticket.registrationId, (ticketCountByRegistrationId.get(ticket.registrationId) ?? 0) + 1);
  });

  const toItem = (registration: StudentWallet["registrations"][number]): EventScheduleItem => ({
    id: registration.id,
    eventId: registration.eventId,
    eventName: registration.eventName,
    eventSlug: registration.eventSlug,
    studioName: registration.studioName,
    hostName: registration.hostName,
    status: registration.status,
    paymentStatus: registration.paymentStatus,
    ticketCount: ticketCountByRegistrationId.get(registration.id) ?? 0,
    eventDate: registration.eventDate,
    eventTime: registration.eventTime,
    eventEndDate: registration.eventEndDate ?? null,
    eventEndTime: registration.eventEndTime ?? null,
    eventTimeZone: registration.eventTimeZone ?? null,
    venue: registration.venue,
    city: registration.city,
    state: registration.state,
  });

  const registrationItems = wallet.registrations.map(toItem);
  const registrationIds = new Set(registrationItems.map((item) => item.id));

  const ticketOnlyItems: EventScheduleItem[] = wallet.tickets
    .filter((ticket) => !registrationIds.has(ticket.registrationId))
    .map((ticket) => ({
      id: ticket.registrationId,
      eventId: ticket.eventId,
      eventName: ticket.eventName,
      eventSlug: ticket.eventSlug,
      studioName: ticket.studioName,
      hostName: ticket.hostName,
      status: ticket.checkedInAt ? "checked_in" : "confirmed",
      paymentStatus: null,
      ticketCount: 1,
      eventDate: ticket.eventDate,
      eventTime: ticket.eventTime,
      eventEndDate: null,
      eventEndTime: null,
      eventTimeZone: null,
      venue: ticket.venue,
      city: ticket.city,
      state: ticket.state,
    }));

  const active = [...registrationItems, ...ticketOnlyItems];
  const closed = (wallet.closedRegistrations ?? []).map(toItem);

  const upcoming = active
    .filter((item) => !endedSafe(item, now))
    .sort((a, b) => (dateKey(a) ?? "9999-12-31").localeCompare(dateKey(b) ?? "9999-12-31"));

  // History: ended registrations (with or without a ticket) and ended cancelled/refunded ones, most recently ended first.
  const past = [...active, ...closed]
    .filter((item) => endedSafe(item, now))
    .sort((a, b) => endedAtMs(b) - endedAtMs(a) || a.eventName.localeCompare(b.eventName));

  return { upcoming, past };
}
