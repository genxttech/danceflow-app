import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { botBlockedJson, requestLooksAutomated } from "@/lib/security/bot-protection";

type Params = Promise<{
  slug: string;
}>;

type OrganizerRow = {
  id: string;
  name: string;
  slug: string | null;
  active: boolean | null;
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
  public_summary: string | null;
  public_description: string | null;
  public_cover_image_url: string | null;
  venue_name: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  timezone: string | null;
  start_date: string | null;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  registration_required: boolean | null;
  beginner_friendly: boolean | null;
  studios: StudioAccessRow | StudioAccessRow[] | null;
};

const SITE_URL = "https://www.idanceflow.com";
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

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

function normalizeLimit(value: string | null) {
  const parsed = Number(value ?? "6");
  if (!Number.isFinite(parsed)) return 6;
  return Math.min(Math.max(Math.trunc(parsed), 1), 24);
}

function eventTypeLabel(value: string | null) {
  if (value === "group_class") return "Group Class";
  if (value === "practice_party") return "Practice Party";
  if (value === "workshop") return "Workshop";
  if (value === "social_dance") return "Social Dance";
  if (value === "competition") return "Competition";
  if (value === "showcase") return "Showcase";
  if (value === "festival") return "Festival";
  if (value === "special_event") return "Special Event";
  return "Event";
}

function formatDateRange(startDate: string | null, endDate: string | null) {
  if (!startDate) return "Date coming soon";
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate ?? startDate}T00:00:00`);

  if (Number.isNaN(start.getTime())) return "Date coming soon";

  const startText = start.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  if (!endDate || startDate === endDate || Number.isNaN(end.getTime())) {
    return startText;
  }

  return `${startText} - ${end.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
}

function formatTime(value: string | null) {
  if (!value) return "";
  const date = new Date(`2000-01-01T${value}`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTimeRange(startTime: string | null, endTime: string | null) {
  const start = formatTime(startTime);
  const end = formatTime(endTime);
  if (start && end) return `${start} - ${end}`;
  return start || end || null;
}

function locationLabel(event: EventRow) {
  return [event.venue_name, event.city, event.state].filter(Boolean).join(", ");
}

function mapEvent(event: EventRow, hostName: string) {
  const eventUrl = event.slug ? `${SITE_URL}/events/${event.slug}` : SITE_URL;

  return {
    id: event.id,
    name: event.name,
    slug: event.slug,
    eventType: event.event_type,
    eventTypeLabel: eventTypeLabel(event.event_type),
    summary:
      event.public_summary ||
      event.public_description ||
      "Public event details coming soon.",
    imageUrl: event.public_cover_image_url || null,
    url: eventUrl,
    dateLabel: formatDateRange(event.start_date, event.end_date),
    timeLabel: formatTimeRange(event.start_time, event.end_time),
    timezone: event.timezone || "America/New_York",
    locationLabel: locationLabel(event),
    registrationRequired: Boolean(event.registration_required),
    beginnerFriendly: Boolean(event.beginner_friendly),
    hostName,
  };
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function GET(
  request: Request,
  context: {
    params: Params;
  },
) {
  if (requestLooksAutomated(request)) {
    return botBlockedJson(corsHeaders());
  }

  const { slug } = await context.params;
  const normalizedSlug = slug.trim().toLowerCase();

  if (!SLUG_PATTERN.test(normalizedSlug)) {
    return NextResponse.json(
      { error: "Organizer event embed not found." },
      { status: 404, headers: corsHeaders() },
    );
  }

  const url = new URL(request.url);
  const limit = normalizeLimit(url.searchParams.get("limit"));
  const supabase = await createClient();

  const { data: organizer, error: organizerError } = await supabase
    .from("organizers")
    .select("id, name, slug, active")
    .eq("slug", normalizedSlug)
    .eq("active", true)
    .maybeSingle<OrganizerRow>();

  if (organizerError) {
    return NextResponse.json(
      { error: "Could not load organizer events." },
      { status: 500, headers: corsHeaders() },
    );
  }

  if (!organizer) {
    return NextResponse.json(
      { error: "Organizer event embed not found." },
      { status: 404, headers: corsHeaders() },
    );
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
        public_cover_image_url,
        venue_name,
        city,
        state,
        postal_code,
        timezone,
        start_date,
        end_date,
        start_time,
        end_time,
        registration_required,
        beginner_friendly,
        studios (
          billing_plan,
          subscription_status
        )
      `,
    )
    .eq("organizer_id", organizer.id)
    .eq("visibility", "public")
    .eq("public_directory_enabled", true)
    .in("status", ["published", "open"])
    .not("start_date", "is", null)
    .order("start_date", { ascending: true })
    .limit(limit);

  if (eventsError) {
    return NextResponse.json(
      { error: "Could not load organizer events." },
      { status: 500, headers: corsHeaders() },
    );
  }

  const hostName = organizer.name || "DanceFlow Organizer";
  const publicEvents = ((events ?? []) as EventRow[]).filter((event) =>
    hasActivePublicAccess(getStudio(event.studios)),
  );

  return NextResponse.json(
    {
      source: "organizer",
      slug: normalizedSlug,
      hostName,
      publicUrl: `${SITE_URL}/organizers/${normalizedSlug}`,
      events: publicEvents.map((event) => mapEvent(event, hostName)),
    },
    {
      status: 200,
      headers: {
        ...corsHeaders(),
        "Cache-Control": "public, max-age=300, s-maxage=900",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
