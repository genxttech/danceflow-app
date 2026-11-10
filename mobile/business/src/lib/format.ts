import type { PersonName } from "@/lib/staffApi";

/** Times always render in the studio's zone, never the device's (contract). */
export function formatTime(iso: string, timeZone: string | undefined) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  }
}

export function formatTimeRange(startsAt: string, endsAt: string, timeZone: string | undefined) {
  return `${formatTime(startsAt, timeZone)} – ${formatTime(endsAt, timeZone)}`;
}

export function durationMinutes(startsAt: string, endsAt: string) {
  return Math.max(0, Math.round((new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 60000));
}

/** "2026-11-09" → "Monday, November 9". Calendar dates have no zone, so UTC keeps the day fixed. */
export function formatDayHeading(date: string) {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

export function shiftDate(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function personName(person: PersonName | null | undefined) {
  if (!person) return null;
  const name = [person.firstName, person.lastName].filter(Boolean).join(" ").trim();
  return name || null;
}

const TYPE_LABELS: Record<string, string> = {
  private_lesson: "Private lesson",
  group_class: "Group class",
  intro_lesson: "Intro lesson",
  coaching: "Coaching",
  practice_party: "Practice party",
  floor_space_rental: "Floor rental",
  event: "Event",
};

export function appointmentTypeLabel(type: string) {
  return TYPE_LABELS[type] ?? humanize(type);
}

const STATUS_LABELS: Record<string, string> = {
  scheduled: "Scheduled",
  confirmed: "Confirmed",
  rescheduled: "Rescheduled",
  attended: "Attended",
  cancelled: "Cancelled",
  no_show: "No-show",
};

export function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? humanize(status);
}

function humanize(value: string) {
  const text = value.replace(/_/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "Appointment";
}

export type StatusTone = "neutral" | "success" | "warning" | "error";

export function statusTone(status: string): StatusTone {
  if (status === "attended") return "success";
  if (status === "cancelled" || status === "no_show") return "error";
  if (status === "rescheduled") return "warning";
  return "neutral";
}
