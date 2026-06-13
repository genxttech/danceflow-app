import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type Params = Promise<{
  token: string;
}>;

type CoachRow = {
  id: string;
  event_id: string;
  name: string;
  schedule_token_enabled: boolean | null;
  active: boolean;
};

type EventRow = {
  id: string;
  name: string;
  slug: string;
  venue_name: string | null;
  city: string | null;
  state: string | null;
  timezone: string | null;
};

type SlotRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  location_label: string | null;
  status: string;
  buyer_name: string | null;
  buyer_email: string | null;
  buyer_phone: string | null;
  buyer_notes: string | null;
  held_until: string | null;
  updated_at: string | null;
};

function escapeIcsText(value: string | null | undefined) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

const DEFAULT_EVENT_TIME_ZONE = "America/New_York";

function safeTimeZone(value: string | null | undefined) {
  const candidate = value || DEFAULT_EVENT_TIME_ZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return DEFAULT_EVENT_TIME_ZONE;
  }
}

function formatIcsUtcDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function formatIcsLocalDate(value: string, timeZone: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map = new Map(parts.map((part) => [part.type, part.value]));

  return `${map.get("year")}${map.get("month")}${map.get("day")}T${map.get("hour")}${map.get("minute")}${map.get("second")}`;
}

function isManualBlockedSlot(slot: SlotRow) {
  return slot.status === "held" && !slot.held_until;
}

function buildBookedDescription(slot: SlotRow, event: EventRow, coach: CoachRow) {
  const lines = [
    `Event: ${event.name}`,
    `Coach: ${coach.name}`,
    slot.buyer_name ? `Student: ${slot.buyer_name}` : "Student: Booked student",
    slot.buyer_email ? `Email: ${slot.buyer_email}` : "",
    slot.buyer_phone ? `Phone: ${slot.buyer_phone}` : "",
    slot.buyer_notes ? `Notes: ${slot.buyer_notes}` : "",
  ].filter(Boolean);

  return lines.join("\\n");
}

function buildBlockedDescription(slot: SlotRow, event: EventRow, coach: CoachRow) {
  const lines = [
    `Event: ${event.name}`,
    `Coach: ${coach.name}`,
    slot.buyer_notes ? `Reason: ${slot.buyer_notes}` : "Blocked time",
  ].filter(Boolean);

  return lines.join("\\n");
}

export async function GET(
  _request: Request,
  { params }: { params: Params },
) {
  const { token } = await params;

  if (!token || token.length < 24) {
    notFound();
  }

  const supabase = await createClient();

  const { data: coach, error: coachError } = await supabase
    .from("event_guest_coaches")
    .select("id, event_id, name, schedule_token_enabled, active")
    .eq("schedule_token", token)
    .eq("active", true)
    .eq("schedule_token_enabled", true)
    .single();

  if (coachError || !coach) {
    notFound();
  }

  const typedCoach = coach as CoachRow;
  const nowIso = new Date().toISOString();

  await supabase
    .from("event_private_lesson_slots")
    .update({
      status: "available",
      payment_status: "unpaid",
      buyer_name: null,
      buyer_email: null,
      buyer_phone: null,
      buyer_notes: null,
      client_id: null,
      stripe_checkout_session_id: null,
      stripe_payment_intent_id: null,
      booked_at: null,
      held_until: null,
      hold_token: null,
      updated_at: nowIso,
    })
    .eq("coach_id", typedCoach.id)
    .eq("status", "held")
    .lt("held_until", nowIso);

  const [{ data: event, error: eventError }, { data: slots, error: slotsError }] =
    await Promise.all([
      supabase
        .from("events")
        .select("id, name, slug, venue_name, city, state, timezone")
        .eq("id", typedCoach.event_id)
        .single(),
      supabase
        .from("event_private_lesson_slots")
        .select(
          "id, starts_at, ends_at, location_label, status, buyer_name, buyer_email, buyer_phone, buyer_notes, held_until, updated_at",
        )
        .eq("coach_id", typedCoach.id)
        .or("status.eq.booked,and(status.eq.held,held_until.is.null)")
        .order("starts_at", { ascending: true }),
    ]);

  if (eventError || !event || slotsError) {
    notFound();
  }

  const typedEvent = event as EventRow;
  const eventTimeZone = safeTimeZone(typedEvent.timezone);
  const typedSlots = (slots ?? []) as SlotRow[];
  const calendarName = `${typedCoach.name} - ${typedEvent.name} Private Lessons`;
  const generatedAt = formatIcsUtcDate(nowIso);
  const defaultLocation = [
    typedEvent.venue_name,
    typedEvent.city,
    typedEvent.state,
  ]
    .filter(Boolean)
    .join(", ");

  const eventLines = typedSlots
    .map((slot) => {
      const isBlocked = isManualBlockedSlot(slot);
      const studentName = slot.buyer_name || "Student";
      const title = isBlocked
        ? `Blocked - ${slot.buyer_notes || "Private lesson time"}`
        : `Private Lesson - ${studentName}`;
      const description = isBlocked
        ? buildBlockedDescription(slot, typedEvent, typedCoach)
        : buildBookedDescription(slot, typedEvent, typedCoach);
      const location = slot.location_label || defaultLocation;

      return [
        "BEGIN:VEVENT",
        `UID:guest-coach-slot-${slot.id}@idanceflow.com`,
        `DTSTAMP:${generatedAt}`,
        `DTSTART;TZID=${eventTimeZone}:${formatIcsLocalDate(slot.starts_at, eventTimeZone)}`,
        `DTEND;TZID=${eventTimeZone}:${formatIcsLocalDate(slot.ends_at, eventTimeZone)}`,
        `SUMMARY:${escapeIcsText(title)}`,
        location ? `LOCATION:${escapeIcsText(location)}` : "",
        `DESCRIPTION:${escapeIcsText(description)}`,
        `STATUS:${isBlocked ? "TENTATIVE" : "CONFIRMED"}`,
        `LAST-MODIFIED:${formatIcsUtcDate(slot.updated_at ?? nowIso)}`,
        "END:VEVENT",
      ]
        .filter(Boolean)
        .join("\r\n");
    })
    .join("\r\n");

  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//DanceFlow//Guest Coach Schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    `X-WR-TIMEZONE:${escapeIcsText(eventTimeZone)}`,
    eventLines,
    "END:VCALENDAR",
    "",
  ]
    .filter((line) => line !== "")
    .join("\r\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `inline; filename="${encodeURIComponent(
        calendarName,
      )}.ics"`,
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

