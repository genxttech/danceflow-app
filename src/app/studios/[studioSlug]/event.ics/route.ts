import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

type Params = Promise<{
  studioSlug: string;
}>;

type StudioRow = {
  id: string;
  name: string;
  public_name: string | null;
  slug: string | null;
  public_directory_enabled: boolean | null;
  billing_plan: string | null;
  subscription_status: string | null;
};

type EventRow = {
  id: string;
  name: string;
  slug: string | null;
  event_type: string | null;
  public_summary: string | null;
  public_description: string | null;
  venue_name: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  timezone: string | null;
  start_date: string | null;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  updated_at: string | null;
};

const DEFAULT_TIME_ZONE = "America/New_York";
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

function hasActivePublicAccess(studio: {
  billing_plan?: string | null;
  subscription_status?: string | null;
}) {
  const status = (studio.subscription_status ?? "").trim().toLowerCase();

  return status === "active" || status === "trialing";
}

function escapeIcsText(value: string | null | undefined) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function formatDateOnly(value: string) {
  return value.replaceAll("-", "");
}

function formatDateTime(date: string, time: string | null | undefined) {
  const safeTime = time || "00:00:00";
  const normalizedTime = safeTime.length === 5 ? `${safeTime}:00` : safeTime;

  return `${date.replaceAll("-", "")}T${normalizedTime.replaceAll(":", "")}`;
}

function safeIcsTimeZone(value: string | null | undefined) {
  const candidate = value?.trim() || DEFAULT_TIME_ZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function addOneDay(date: string) {
  const current = new Date(`${date}T00:00:00`);
  current.setDate(current.getDate() + 1);

  return current.toISOString().slice(0, 10);
}

function utcStamp(value?: string | null) {
  const parsed = value ? new Date(value) : new Date();
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function eventTypeLabel(value: string | null) {
  switch (value) {
    case "group_class":
      return "Group Class";
    case "practice_party":
      return "Practice Party";
    case "workshop":
      return "Workshop";
    case "social_dance":
      return "Social Dance";
    case "competition":
      return "Competition";
    case "showcase":
      return "Showcase";
    case "festival":
      return "Festival";
    case "special_event":
      return "Special Event";
    default:
      return "Event";
  }
}

function locationText(event: EventRow) {
  return [
    event.venue_name,
    event.address_line_1,
    event.address_line_2,
    [event.city, event.state, event.postal_code].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");
}

function eventUrl(origin: string, event: EventRow) {
  return event.slug ? `${origin}/events/${encodeURIComponent(event.slug)}` : origin;
}

function eventDescription(origin: string, event: EventRow, studioName: string) {
  return [
    event.public_summary || event.public_description || "",
    "",
    `Event type: ${eventTypeLabel(event.event_type)}`,
    `Hosted by: ${studioName}`,
    "",
    `View details or register: ${eventUrl(origin, event)}`,
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");
}

function buildEventIcs(origin: string, event: EventRow, studioName: string) {
  if (!event.start_date) return "";

  const uid = `event-${event.id}@idanceflow.com`;
  const stamp = utcStamp(event.updated_at);
  const eventTimeZone = safeIcsTimeZone(event.timezone);
  const location = locationText(event);
  const description = eventDescription(origin, event, studioName);
  const url = eventUrl(origin, event);

  const lines = [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `LAST-MODIFIED:${stamp}`,
    `SUMMARY:${escapeIcsText(event.name)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    `LOCATION:${escapeIcsText(location)}`,
    `URL:${url}`,
  ];

  if (event.start_time) {
    lines.push(`DTSTART;TZID=${eventTimeZone}:${formatDateTime(event.start_date, event.start_time)}`);

    if (event.end_date || event.end_time) {
      lines.push(
        `DTEND;TZID=${eventTimeZone}:${formatDateTime(
          event.end_date || event.start_date,
          event.end_time || event.start_time,
        )}`,
      );
    }
  } else {
    lines.push(`DTSTART;VALUE=DATE:${formatDateOnly(event.start_date)}`);
    lines.push(
      `DTEND;VALUE=DATE:${formatDateOnly(
        addOneDay(event.end_date || event.start_date),
      )}`,
    );
  }

  lines.push("END:VEVENT");

  return lines.join("\r\n");
}

function textResponse(message: string, status: number) {
  return new NextResponse(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(
  request: NextRequest,
  context: {
    params: Params;
  },
) {
  const { studioSlug } = await context.params;
  const normalizedSlug = studioSlug.trim();

  if (!SLUG_PATTERN.test(normalizedSlug)) {
    return textResponse("Studio calendar not found.", 404);
  }

  const supabase = await createClient();

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, name, public_name, slug, public_directory_enabled, billing_plan, subscription_status")
    .eq("slug", normalizedSlug)
    .eq("public_directory_enabled", true)
    .maybeSingle<StudioRow>();

  if (studioError) {
    return textResponse("Could not load studio calendar.", 500);
  }

  if (!studio || !hasActivePublicAccess(studio)) {
    return textResponse("Studio calendar not found.", 404);
  }

  const { data: events, error: eventsError } = await supabase
    .from("events")
    .select(
      `
        id,
        name,
        slug,
        event_type,
        public_summary,
        public_description,
        venue_name,
        address_line_1,
        address_line_2,
        city,
        state,
        postal_code,
        timezone,
        start_date,
        end_date,
        start_time,
        end_time,
        updated_at
      `,
    )
    .eq("studio_id", studio.id)
    .in("status", ["published", "open"])
    .eq("visibility", "public")
    .eq("public_directory_enabled", true)
    .not("start_date", "is", null)
    .order("start_date", { ascending: true });

  if (eventsError) {
    return textResponse("Could not load studio events.", 500);
  }

  const studioName = studio.public_name || studio.name || "DanceFlow Studio";
  const origin = request.nextUrl.origin;

  const calendarLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//DanceFlow//Public Studio Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(`${studioName} Events`)}`,
    `X-WR-CALDESC:${escapeIcsText(`Public DanceFlow events for ${studioName}`)}`,
    `X-WR-TIMEZONE:${DEFAULT_TIME_ZONE}`,
    ...((events ?? []) as EventRow[]).map((event) =>
      buildEventIcs(origin, event, studioName),
    ),
    "END:VCALENDAR",
  ].filter(Boolean);

  return new NextResponse(calendarLines.join("\r\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename="${normalizedSlug}-events.ics"`,
    },
  });
}
