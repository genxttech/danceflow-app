/**
 * Plain display formatting for an event's dates, times and venue, from their stored values (YYYY-MM-DD dates and
 * HH:MM[:SS] times are event-local; they are formatted as written, never shifted through the viewer's or the
 * server's time zone). Shared by the competition setup page and its live event-page preview.
 */

export function formatEventDates(start: string | null | undefined, end: string | null | undefined): string | null {
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
  const format = (date: string) =>
    new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return end && end !== start && /^\d{4}-\d{2}-\d{2}$/.test(end) ? `${format(start)} – ${format(end)}` : format(start);
}

export function formatEventTimes(start: string | null | undefined, end: string | null | undefined): string | null {
  const format = (time: string) => {
    const [hour, minute] = time.split(":").map(Number);
    return new Date(Date.UTC(2000, 0, 1, hour, minute)).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  };
  const valid = (time: string | null | undefined): time is string => Boolean(time && /^\d{2}:\d{2}/.test(time));
  if (!valid(start)) return null;
  return valid(end) ? `${format(start)} – ${format(end)}` : format(start);
}

export function formatEventVenue(venue: string | null | undefined, city: string | null | undefined, state: string | null | undefined): string | null {
  return [venue?.trim(), [city?.trim(), state?.trim()].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || null;
}
