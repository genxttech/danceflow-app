import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type Params = Promise<{
  organizerSlug: string;
}>;

type OrganizerRow = {
  id: string;
  name: string;
  slug: string | null;
};

type StudioAccessRow = {
  billing_plan: string | null;
  subscription_status: string | null;
};

type EventRow = {
  id: string;
  name: string;
  slug: string | null;
  event_type: string | null;
  short_description: string | null;
  description: string | null;
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
  studios: StudioAccessRow | StudioAccessRow[] | null;
};

const siteUrl = "https://www.idanceflow.com";

function hasActivePublicAccess(studio: {
  billing_plan?: string | null;
  subscription_status?: string | null;
} | null | undefined) {
  if (!studio) return false;

  const status = (studio.subscription_status ?? "").trim().toLowerCase();

  return status === "active" || status === "trialing";
}

function getStudio(value: EventRow["studios"]) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function escapeIcsText(value: string | null | undefined) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "")
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

function addOneDay(date: string) {
  const current = new Date(`${date}T00:00:00`);
  current.setDate(current.getDate() + 1);

  return current.toISOString().slice(0, 10);
}

function nowUtcStamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
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

function eventDescription(event: EventRow, organizerName: string) {
  const eventUrl = event.slug ? `${siteUrl}/events/${event.slug}` : siteUrl;

  return [
    event.short_description || event.description || "",
    "",
    `Event type: ${eventTypeLabel(event.event_type)}`,
    `Hosted by: ${organizerName}`,
    "",
    `View details or register: ${eventUrl}`,
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");
}

function buildEventIcs(event: EventRow, organizerName: string) {
  if (!event.start_date) return "";

  const uid = `event-${event.id}@idanceflow.com`;
  const stamp = nowUtcStamp();
  const location = locationText(event);
  const description = eventDescription(event, organizerName);
  const eventUrl = event.slug ? `${siteUrl}/events/${event.slug}` : siteUrl;

  const lines = [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `LAST-MODIFIED:${stamp}`,
    `SUMMARY:${escapeIcsText(event.name)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    `LOCATION:${escapeIcsText(location)}`,
    `URL:${eventUrl}`,
  ];

  if (event.start_time) {
    lines.push(`DTSTART:${formatDateTime(event.start_date, event.start_time)}`);

    if (event.end_date || event.end_time) {
      lines.push(
        `DTEND:${formatDateTime(
          event.end_date || event.start_date,
          event.end_time || event.start_time
        )}`
      );
    }
  } else {
    lines.push(`DTSTART;VALUE=DATE:${formatDateOnly(event.start_date)}`);
    lines.push(
      `DTEND;VALUE=DATE:${formatDateOnly(
        addOneDay(event.end_date || event.start_date)
      )}`
    );
  }

  lines.push("END:VEVENT");

  return lines.join("\r\n");
}

export async function GET(
  _request: Request,
  context: {
    params: Params;
  }
) {
  const { organizerSlug } = await context.params;
  const supabase = await createClient();

  const { data: organizer, error: organizerError } = await supabase
    .from("organizers")
    .select("id, name, slug")
    .eq("slug", organizerSlug)
    .maybeSingle<OrganizerRow>();

  if (organizerError) {
    return new NextResponse("Could not load organizer calendar.", {
      status: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  if (!organizer) {
    return new NextResponse("Organizer calendar not found.", {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  const { data: events, error: eventsError } = await supabase
    .from("events")
    .select(
      `
        id,
        name,
        slug,
        event_type,
        short_description,
        description,
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
        updated_at,
        studios (
          billing_plan,
          subscription_status
        )
      `
    )
    .eq("organizer_id", organizer.id)
    .eq("status", "published")
    .eq("visibility", "public")
    .eq("public_directory_enabled", true)
    .not("start_date", "is", null)
    .order("start_date", { ascending: true });

  if (eventsError) {
    return new NextResponse("Could not load organizer events.", {
      status: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  const organizerName = organizer.name || "DanceFlow Organizer";
  const publicEvents = ((events ?? []) as EventRow[]).filter((event) =>
    hasActivePublicAccess(getStudio(event.studios)),
  );

  const calendarLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//DanceFlow//Public Organizer Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(`${organizerName} Events`)}`,
    `X-WR-CALDESC:${escapeIcsText(
      `Public DanceFlow events for ${organizerName}`
    )}`,
    "X-WR-TIMEZONE:America/New_York",
    ...publicEvents.map((event) => buildEventIcs(event, organizerName)),
    "END:VCALENDAR",
  ].filter(Boolean);

  return new NextResponse(calendarLines.join("\r\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
}