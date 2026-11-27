import { createHash } from "node:crypto";

export type FeedEvent = {
  /** Stable for the life of the booking: `<appointment id>@danceflow`. */
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  /** ISO instants (UTC). */
  startsAt: string;
  endsAt: string;
  status: "CONFIRMED" | "CANCELLED";
  /** Monotonic revision (see sequenceFromUpdatedAt); a cancellation uses base + 1. */
  sequence: number;
  /** ISO instant of the last change that matters to subscribers. */
  lastModified: string;
};

const SEQUENCE_EPOCH_MS = Date.UTC(2026, 0, 1);
const FALLBACK_STAMP = "20260101T000000Z";

/** Whole seconds since 2026-01-01 UTC of the row's updated_at: monotonic and fits a signed 32-bit integer for decades. */
export function sequenceFromUpdatedAt(updatedAt: string | null | undefined): number {
  const ms = Date.parse(String(updatedAt ?? ""));
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((ms - SEQUENCE_EPOCH_MS) / 1000));
}

export function formatIcsUtc(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return FALLBACK_STAMP;
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** TEXT value escaping per RFC 5545 plus control-character and CR/LF-injection stripping. */
export function escapeIcsText(value: string): string {
  const stripControls = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u2028\\u2029]", "g");
  return value
    .split(/\r\n|\r|\n/) // real line breaks become the TEXT escape \n (never a raw CR/LF in the output)
    .map((line) => line.replace(stripControls, "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,"))
    .join("\\n");
}

/** RFC 5545 line folding at 75 OCTETS (not UTF-16 units), never splitting a code point. */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (currentBytes + size > limit) {
      parts.push(current);
      current = "";
      currentBytes = 0;
      limit = 74; // continuation lines start with one space
    }
    current += ch;
    currentBytes += size;
  }
  if (current) parts.push(current);
  return parts.map((part, index) => (index === 0 ? part : ` ${part}`)).join("\r\n");
}

export function renderCalendar(options: { calendarName: string; events: FeedEvent[] }): string {
  const events = [...options.events].sort((a, b) =>
    a.startsAt === b.startsAt ? (a.uid < b.uid ? -1 : 1) : a.startsAt < b.startsAt ? -1 : 1,
  );
  // Deterministic DTSTAMP (latest change) so identical content yields an identical body and a stable ETag.
  const stamp = events.reduce((latest, event) => {
    const formatted = formatIcsUtc(event.lastModified);
    return formatted > latest ? formatted : latest;
  }, FALLBACK_STAMP);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//DanceFlow//Calendar Feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(options.calendarName)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];

  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid.replace(/[^A-Za-z0-9@._-]/g, "")}`,
      `DTSTAMP:${stamp}`,
      `LAST-MODIFIED:${formatIcsUtc(event.lastModified)}`,
      `SEQUENCE:${Math.max(0, Math.trunc(event.sequence))}`,
      `DTSTART:${formatIcsUtc(event.startsAt)}`,
      `DTEND:${formatIcsUtc(event.endsAt)}`,
      `STATUS:${event.status}`,
      `SUMMARY:${escapeIcsText(event.summary)}`,
    );
    if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

export function etagFor(body: string): string {
  return `"${createHash("sha256").update(body, "utf8").digest("hex").slice(0, 32)}"`;
}
