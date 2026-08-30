import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import FavoriteButton from "@/components/public/FavoriteButton";
import ShareButton from "@/components/public/ShareButton";
import CurrentLocationButton from "@/components/public/CurrentLocationButton";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import { getResumeBanner } from "./resumeBanner";

type SearchParams = Promise<{
  q?: string;
  city?: string;
  state?: string;
  zip?: string;
  style?: string;
  beginner?: string;
  radius?: string;
  latitude?: string;
  longitude?: string;
  locationMode?: string;
  error?: string;
  success?: string;
}>;

type EventRow = {
  id: string;
  slug: string;
  studio_id: string | null;
  organizer_id: string | null;
  name: string;
  event_type: string | null;
  start_date: string | null;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  visibility: string | null;
  status: string | null;
  public_summary: string | null;
  public_description: string | null;
  public_cover_image_url: string | null;
  beginner_friendly: boolean;
  public_directory_enabled: boolean;
  capacity: number | null;
  waitlist_enabled: boolean;
  registration_required: boolean;
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
  created_at: string | null;
};

type StudioRow = {
  id: string;
  slug: string | null;
  public_name: string | null;
  name: string;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
  public_directory_enabled: boolean;
  billing_plan: string | null;
  subscription_status: string | null;
};

type OrganizerRow = {
  id: string;
  name: string;
  slug: string;
  studio_id: string;
  active: boolean;
};

type EventStyleRow = {
  event_id: string;
  style_key: string;
  display_name: string;
};

type RegistrationSummaryRow = {
  event_id: string;
  status: string;
};

type EventLocationSessionRow = {
  event_location_id: string | null;
  session_date: string | null;
  start_time: string | null;
  end_time: string | null;
  sort_order: number | null;
};

type EventLocationRow = {
  id: string;
  event_id: string;
  location_name: string | null;
  venue_name: string | null;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  sort_order: number | null;
  event_location_sessions: EventLocationSessionRow[] | null;
};

const STYLE_OPTIONS = [
  { key: "country", label: "Country" },
  { key: "ballroom", label: "Ballroom" },
  { key: "latin", label: "Latin" },
  { key: "salsa", label: "Salsa" },
  { key: "bachata", label: "Bachata" },
  { key: "swing", label: "Swing" },
  { key: "west_coast_swing", label: "West Coast Swing" },
  { key: "hip_hop", label: "Hip Hop" },
  { key: "contemporary", label: "Contemporary" },
  { key: "ballet", label: "Ballet" },
] as const;

const RADIUS_OPTIONS = [10, 25, 50, 100];


const SEARCH_TEXT_MAX_LENGTH = 80;
const STATE_PATTERN = /^[a-z]{0,2}$/;
const ZIP_PATTERN = /^[a-z0-9 -]{0,12}$/;

function cleanSearchParam(value: string | undefined, maxLength = SEARCH_TEXT_MAX_LENGTH) {
  return (value ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function normalizeOptionParam<T extends string>(
  value: string | undefined,
  allowedValues: readonly T[],
) {
  const normalized = cleanSearchParam(value).toLowerCase() as T;
  return allowedValues.includes(normalized) ? normalized : "";
}

function normalizeLocationMode(value: string | undefined) {
  return value === "current" ? "current" : "manual";
}

function normalizeRadiusParam(value: string | undefined) {
  const parsed = Number(value ?? "25");
  return RADIUS_OPTIONS.includes(parsed) ? parsed : 25;
}

function normalizeCoordinate(value: string | undefined, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return Math.round(parsed * 1_000_000) / 1_000_000;
}



function hostStudioName(studio: StudioRow | undefined) {
  if (!studio) return "Studio";
  return studio.public_name?.trim() || studio.name;
}

function hasActivePublicAccess(studio: {
  billing_plan?: string | null;
  subscription_status?: string | null;
}) {
  const status = (studio.subscription_status ?? "").trim().toLowerCase();

  return status === "active" || status === "trialing";
}

function formatDate(value: string | null) {
  if (!value) return "Date coming soon";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}

function formatDateRange(startDate: string | null, endDate: string | null) {
  if (!startDate) return "Date coming soon";
  if (!endDate || endDate === startDate) return formatDate(startDate);
  return `${formatDate(startDate)} – ${formatDate(endDate)}`;
}

function formatTime(value: string | null) {
  if (!value) return "";

  const date = new Date(`2000-01-01T${value}`);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTimeRange(startTime: string | null, endTime: string | null) {
  const start = formatTime(startTime);
  const end = formatTime(endTime);

  if (start && end) return `${start} – ${end}`;
  return start || end;
}

function weekdayPlural(startDate: string | null) {
  if (!startDate) return null;

  const date = new Date(`${startDate}T00:00:00`);

  if (Number.isNaN(date.getTime())) return null;

  return `${date.toLocaleDateString([], { weekday: "long" })}s`;
}

function seriesWeekCount(startDate: string | null, endDate: string | null) {
  if (!startDate || !endDate) return null;

  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end < start
  ) {
    return null;
  }

  const days = Math.round(
    (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
  );

  return Math.floor(days / 7) + 1;
}

function formatEventSchedule(event: EventRow) {
  if (event.event_type !== "group_class") {
    return formatDateRange(event.start_date, event.end_date);
  }

  const weekday = weekdayPlural(event.start_date);
  const timeRange = formatTimeRange(event.start_time, event.end_time);
  const weeks = seriesWeekCount(event.start_date, event.end_date);

  if (event.end_date) {
    return [
      weekday,
      formatDateRange(event.start_date, event.end_date),
      timeRange,
      weeks ? `${weeks}-week series` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  return [
    weekday,
    event.start_date ? `Starts ${formatDate(event.start_date)}` : null,
    timeRange,
    "Ongoing weekly class",
  ]
    .filter(Boolean)
    .join(" · ");
}

function weekdayPluralFromDate(value: string | null) {
  if (!value) return null;

  const date = new Date(`${value}T00:00:00`);

  if (Number.isNaN(date.getTime())) return null;

  return `${date.toLocaleDateString([], { weekday: "long" })}s`;
}

function joinHumanList(values: string[]) {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} & ${values[1]}`;

  return `${values.slice(0, -1).join(", ")} & ${values[values.length - 1]}`;
}

function formatEventScheduleFromLocations(
  event: EventRow,
  locations: EventLocationRow[],
) {
  const sessions = locations.flatMap((location) =>
    (location.event_location_sessions ?? []).map((session) => ({
      ...session,
      locationId: location.id,
    })),
  );

  if (sessions.length === 0) {
    return formatEventSchedule(event);
  }

  const datedSessions = sessions
    .filter((session) => session.session_date)
    .sort((a, b) => {
      const dateA = `${a.session_date ?? ""} ${a.start_time ?? ""}`;
      const dateB = `${b.session_date ?? ""} ${b.start_time ?? ""}`;

      return dateA.localeCompare(dateB);
    });

  if (datedSessions.length === 0) {
    return formatEventSchedule(event);
  }

  const firstSession = datedSessions[0];
  const lastSession = datedSessions[datedSessions.length - 1];

  const weekdayOrder = [
    "Sundays",
    "Mondays",
    "Tuesdays",
    "Wednesdays",
    "Thursdays",
    "Fridays",
    "Saturdays",
  ];

  const weekdaySet = new Set<string>();
  for (const session of datedSessions) {
    const weekday = weekdayPluralFromDate(session.session_date);
    if (weekday) weekdaySet.add(weekday);
  }

  const weekdays = weekdayOrder.filter((day) => weekdaySet.has(day));
  const weekdayLabel = joinHumanList(weekdays);
  const dateRange = formatDateRange(
    firstSession.session_date,
    lastSession.session_date,
  );

  const uniqueLocationCount = new Set(
    datedSessions.map((session) => session.locationId),
  ).size;

  const firstTimeRange = formatTimeRange(
    firstSession.start_time,
    firstSession.end_time,
  );
  const allSameTime = datedSessions.every(
    (session) =>
      session.start_time === firstSession.start_time &&
      session.end_time === firstSession.end_time,
  );

  const sessionCountByLocation = new Map<string, number>();
  for (const session of datedSessions) {
    sessionCountByLocation.set(
      session.locationId,
      (sessionCountByLocation.get(session.locationId) ?? 0) + 1,
    );
  }

  const uniqueSessionCounts = [...new Set(sessionCountByLocation.values())];
  const seriesLabel =
    event.event_type === "group_class" && uniqueSessionCounts.length === 1
      ? `${uniqueSessionCounts[0]}-week series`
      : null;

  return [
    weekdayLabel,
    dateRange,
    allSameTime ? firstTimeRange : "Multiple times",
    uniqueLocationCount > 1 ? `${uniqueLocationCount} locations` : null,
    seriesLabel,
  ]
    .filter(Boolean)
    .join(" · ");
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
  if (!value) return "Event";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function availabilityLabel(params: {
  registrationRequired: boolean;
  capacity: number | null;
  activeCount: number;
  waitlistEnabled: boolean;
}) {
  const { registrationRequired, capacity, activeCount, waitlistEnabled } =
    params;

  if (!registrationRequired) {
    return {
      text: "No registration required",
      className: "bg-slate-100 text-slate-700",
    };
  }

  if (capacity == null) {
    return {
      text: "Open registration",
      className: "bg-green-50 text-green-700",
    };
  }

  const remaining = Math.max(capacity - activeCount, 0);

  if (remaining <= 0) {
    return waitlistEnabled
      ? {
          text: "Waitlist open",
          className: "bg-purple-50 text-purple-700",
        }
      : {
          text: "Sold out",
          className: "bg-red-50 text-red-700",
        };
  }

  if (remaining <= 5) {
    return {
      text: `${remaining} spots left`,
      className: "bg-amber-50 text-amber-700",
    };
  }

  return {
    text: "Open registration",
    className: "bg-green-50 text-green-700",
  };
}

function normalizeZip(value: string | null) {
  return (value ?? "").trim().toLowerCase();
}


function haversineMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.asin(Math.sqrt(a));
  return earthRadiusMiles * c;
}

export default async function DiscoverEventsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;

  const qRaw = cleanSearchParam(query.q, 120);
  const cityRaw = cleanSearchParam(query.city, 80);
  const stateRaw = cleanSearchParam(query.state, 2);
  const zipRaw = cleanSearchParam(query.zip, 12);
  const q = qRaw.toLowerCase();
  const city = cityRaw.toLowerCase();
  const state = STATE_PATTERN.test(stateRaw.toLowerCase()) ? stateRaw.toLowerCase() : "";
  const zip = ZIP_PATTERN.test(zipRaw.toLowerCase()) ? zipRaw.toLowerCase() : "";
  const style = normalizeOptionParam(
    query.style,
    STYLE_OPTIONS.map((option) => option.key),
  );
  const beginner = query.beginner === "1";
  const radius = normalizeRadiusParam(query.radius);
  const locationMode = normalizeLocationMode(query.locationMode);
  const searchLatitude = normalizeCoordinate(query.latitude, -90, 90);
  const searchLongitude = normalizeCoordinate(query.longitude, -180, 180);
  const resumeBanner = getResumeBanner(query);

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [
    { data: events, error: eventsError },
    { data: studios, error: studiosError },
    { data: organizers, error: organizersError },
    { data: eventStyles, error: eventStylesError },
    { data: registrations, error: registrationsError },
    { data: eventLocations, error: eventLocationsError },
  ] = await Promise.all([
    supabase
      .from("events")
      .select(
        `
        id,
        slug,
        studio_id,
        organizer_id,
        name,
        event_type,
        start_date,
        end_date,
        start_time,
        end_time,
        visibility,
        status,
        public_summary,
        public_description,
        public_cover_image_url,
        beginner_friendly,
        public_directory_enabled,
        capacity,
        waitlist_enabled,
        registration_required,
        postal_code,
        latitude,
        longitude,
        created_at
      `,
      )
      .eq("visibility", "public")
      .eq("public_directory_enabled", true)
      .in("status", ["published", "open"])
      .order("start_date", { ascending: true }),

    supabase.from("studios").select(
      `
        id,
        slug,
        public_name,
        name,
        city,
        state,
        postal_code,
        latitude,
        longitude,
        public_directory_enabled,
        billing_plan,
        subscription_status
      `,
    ),

    supabase
      .from("organizers")
      .select(
        `
        id,
        name,
        slug,
        studio_id,
        active
      `,
      )
      .eq("active", true),

    supabase
      .from("event_public_styles")
      .select("event_id, style_key, display_name"),

    supabase
      .from("event_registrations")
      .select("event_id, status")
      .not("status", "in", "(cancelled,waitlisted)"),

    supabase
      .from("event_locations")
      .select(
        `
        id,
        event_id,
        location_name,
        venue_name,
        city,
        state,
        latitude,
        longitude,
        sort_order,
        event_location_sessions (
          event_location_id,
          session_date,
          start_time,
          end_time,
          sort_order
        )
      `,
      )
      .order("sort_order", { ascending: true }),
  ]);

  if (eventsError) {
    throw new Error(`Failed to load public events: ${eventsError.message}`);
  }

  if (studiosError) {
    throw new Error(`Failed to load studios: ${studiosError.message}`);
  }

  if (organizersError) {
    throw new Error(`Failed to load organizers: ${organizersError.message}`);
  }

  if (eventStylesError) {
    throw new Error(`Failed to load event styles: ${eventStylesError.message}`);
  }

  if (registrationsError) {
    throw new Error(
      `Failed to load registration summaries: ${registrationsError.message}`,
    );
  }

  if (eventLocationsError) {
    throw new Error(
      `Failed to load event locations: ${eventLocationsError.message}`,
    );
  }

  const typedEvents = (events ?? []) as EventRow[];
  const typedStudios = ((studios ?? []) as StudioRow[]).filter(hasActivePublicAccess);
  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const typedEventStyles = (eventStyles ?? []) as EventStyleRow[];
  const typedRegistrations = (registrations ?? []) as RegistrationSummaryRow[];
  const typedEventLocations = (eventLocations ?? []) as EventLocationRow[];

  const favoriteEventIds = new Set<string>();

  if (user && typedEvents.length > 0) {
    const { data: favorites, error: favoritesError } = await supabase
      .from("user_favorites")
      .select("event_id")
      .eq("user_id", user.id)
      .in(
        "event_id",
        typedEvents.map((event) => event.id),
      );

    if (favoritesError) {
      throw new Error(
        `Failed to load event favorites: ${favoritesError.message}`,
      );
    }

    for (const row of favorites ?? []) {
      if (row.event_id) {
        favoriteEventIds.add(row.event_id);
      }
    }
  }

  const studioById = new Map(typedStudios.map((studio) => [studio.id, studio]));
  const organizerById = new Map(
    typedOrganizers.map((organizer) => [organizer.id, organizer]),
  );

  const stylesByEventId = new Map<string, EventStyleRow[]>();
  for (const row of typedEventStyles) {
    const current = stylesByEventId.get(row.event_id) ?? [];
    current.push(row);
    stylesByEventId.set(row.event_id, current);
  }

  const locationsByEventId = new Map<string, EventLocationRow[]>();
  for (const location of typedEventLocations) {
    const current = locationsByEventId.get(location.event_id) ?? [];
    current.push(location);
    locationsByEventId.set(location.event_id, current);
  }

  const activeRegistrationCountByEventId = new Map<string, number>();
  for (const row of typedRegistrations) {
    const current = activeRegistrationCountByEventId.get(row.event_id) ?? 0;
    activeRegistrationCountByEventId.set(row.event_id, current + 1);
  }

  const hasAnyGeocodedEvents = typedEvents.some((event) => {
    const studio = event.studio_id
      ? studioById.get(event.studio_id)
      : undefined;
    const lat = event.latitude ?? studio?.latitude ?? null;
    const lng = event.longitude ?? studio?.longitude ?? null;

    return lat !== null && lng !== null;
  });

  const requestedCurrentLocation =
    locationMode === "current" &&
    searchLatitude !== null &&
    searchLongitude !== null;

  const usingCurrentLocation = requestedCurrentLocation && hasAnyGeocodedEvents;

  const filteredEvents = typedEvents
    .map((event) => {
      if (
        (!event.organizer_id && !event.studio_id) ||
        !event.public_directory_enabled ||
        !event.slug
      ) {
        return null;
      }

      let organizer: OrganizerRow | undefined;

      if (event.organizer_id) {
        organizer = organizerById.get(event.organizer_id);
        if (!organizer || !organizer.active) return null;
      }

      const studio = event.studio_id
        ? studioById.get(event.studio_id)
        : undefined;
      if (!studio || !studio.public_directory_enabled) return null;

      const eventStyleRows = stylesByEventId.get(event.id) ?? [];
      const eventLocationsForEvent = locationsByEventId.get(event.id) ?? [];
      let distanceMiles: number | null = null;

      if (beginner && !event.beginner_friendly) return null;

      if (usingCurrentLocation) {
        const firstGeocodedLocation = eventLocationsForEvent.find(
          (location) =>
            location.latitude !== null && location.longitude !== null,
        );
        const lat =
          event.latitude ?? firstGeocodedLocation?.latitude ?? studio.latitude;
        const lng =
          event.longitude ??
          firstGeocodedLocation?.longitude ??
          studio.longitude;

        if (lat !== null && lng !== null) {
          distanceMiles = haversineMiles(
            searchLatitude!,
            searchLongitude!,
            lat,
            lng,
          );

          if (distanceMiles > radius) return null;
        } else {
          /*
            Keep public events visible even if the event/studio has not been
            geocoded yet. They will sort after events with calculated distance.
          */
          distanceMiles = null;
        }
      } else {
        const effectiveZip = event.postal_code ?? studio.postal_code ?? "";
        const effectiveCity = studio.city ?? "";
        const effectiveState = studio.state ?? "";

        if (zip && !normalizeZip(effectiveZip).includes(zip)) return null;
        if (city && !effectiveCity.toLowerCase().includes(city)) return null;
        if (state && !effectiveState.toLowerCase().includes(state)) return null;
      }

      if (style) {
        const hasStyle = eventStyleRows.some(
          (row) =>
            row.style_key.toLowerCase() === style ||
            row.display_name.toLowerCase() === style,
        );

        if (!hasStyle) return null;
      }

      if (q) {
        const haystack = [
          event.name,
          event.public_summary ?? "",
          event.public_description ?? "",
          eventTypeLabel(event.event_type),
          hostStudioName(studio),
          organizer?.name ?? "",
          organizer?.slug ?? "",
          studio.city ?? "",
          studio.state ?? "",
          event.postal_code ?? "",
          studio.postal_code ?? "",
          ...eventLocationsForEvent.flatMap((location) => [
            location.location_name ?? "",
            location.venue_name ?? "",
            location.city ?? "",
            location.state ?? "",
          ]),
          ...eventStyleRows.map((row) => row.display_name),
        ]
          .join(" ")
          .toLowerCase();

        if (!haystack.includes(q)) return null;
      }

      return {
        event,
        studio,
        organizer,
        eventStyleRows,
        eventLocations: eventLocationsForEvent,
        distanceMiles,
      };
    })
    .filter(
      (
        row,
      ): row is {
        event: EventRow;
        studio: StudioRow;
        organizer: OrganizerRow | undefined;
        eventStyleRows: EventStyleRow[];
        eventLocations: EventLocationRow[];
        distanceMiles: number | null;
      } => Boolean(row),
    )
    .sort((a, b) => {
      if (usingCurrentLocation) {
        return (
          (a.distanceMiles ?? Number.MAX_SAFE_INTEGER) -
          (b.distanceMiles ?? Number.MAX_SAFE_INTEGER)
        );
      }

      const firstSessionDate = (row: {
        event: EventRow;
        eventLocations: EventLocationRow[];
      }) => {
        const sessions = row.eventLocations
          .flatMap((location) => location.event_location_sessions ?? [])
          .filter((session) => session.session_date)
          .sort((sessionA, sessionB) =>
            `${sessionA.session_date ?? ""} ${sessionA.start_time ?? ""}`.localeCompare(
              `${sessionB.session_date ?? ""} ${sessionB.start_time ?? ""}`,
            ),
          );

        return sessions[0]?.session_date ?? row.event.start_date;
      };

      const aStart = firstSessionDate(a);
      const bStart = firstSessionDate(b);

      const aDate = aStart
        ? new Date(aStart).getTime()
        : Number.MAX_SAFE_INTEGER;
      const bDate = bStart
        ? new Date(bStart).getTime()
        : Number.MAX_SAFE_INTEGER;

      return aDate - bDate;
    });

  const newlyAddedEvents = [...filteredEvents]
    .sort((a, b) => {
      const aTime = a.event.created_at
        ? new Date(a.event.created_at).getTime()
        : 0;
      const bTime = b.event.created_at
        ? new Date(b.event.created_at).getTime()
        : 0;
      return bTime - aTime;
    })
    .slice(0, 3);

  return (
    <>
      <PublicSiteHeader currentPath="events" isAuthenticated={!!user} />

      <main className="min-h-screen bg-slate-50">
        {resumeBanner ? (
          <div className="mx-auto max-w-7xl px-4 pt-4 sm:px-6 lg:px-8">
            <div
              className={`rounded-2xl border px-4 py-3 text-sm ${
                resumeBanner.kind === "success"
                  ? "border-green-200 bg-green-50 text-green-700"
                  : "border-red-200 bg-red-50 text-red-700"
              }`}
            >
              {resumeBanner.message}
            </div>
          </div>
        ) : null}
        <section className="border-b border-orange-200/70 bg-[linear-gradient(135deg,#111827_0%,#4c1d95_52%,#f97316_145%)] text-white">
          <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-200">
                  DanceFlow Discovery
                </p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                  Find dance events
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-white/80 sm:text-base">
                  Search public classes, socials, workshops, competitions, and special dance experiences.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Link
                  href="/discover/studios"
                  className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white backdrop-blur hover:bg-white/15"
                >
                  Browse studios
                </Link>
                {!user ? (
                  <Link
                    href="/signup"
                    className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-orange-50"
                  >
                    Create free account
                  </Link>
                ) : (
                  <span className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white backdrop-blur">
                    Signed in · favorites enabled
                  </span>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          {newlyAddedEvents.length > 0 ? (
            <details className="rounded-3xl border border-violet-200 bg-white shadow-sm">
              <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-slate-900">
                Newly added events
              </summary>
              <div className="grid gap-3 border-t border-slate-100 p-4 md:grid-cols-3">
                {newlyAddedEvents.map(
                  ({ event, studio, organizer, eventLocations }) => (
                    <Link
                      key={event.id}
                      href={`/events/${event.slug}`}
                      className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 hover:bg-white hover:shadow-sm"
                    >
                      <p className="font-medium text-slate-950">{event.name}</p>
                      <p className="mt-1 text-sm text-slate-500">
                        {formatEventScheduleFromLocations(event, eventLocations)} ·{" "}
                        {organizer?.name || hostStudioName(studio)}
                      </p>
                    </Link>
                  ),
                )}
              </div>
            </details>
          ) : null}

          <form className="mt-6 overflow-hidden rounded-3xl border border-orange-200/80 bg-white shadow-[0_18px_50px_rgba(76,29,149,0.10)]">
            <input
              id="search-location-mode"
              type="hidden"
              name="locationMode"
              defaultValue={locationMode}
            />
            <input
              id="search-latitude"
              type="hidden"
              name="latitude"
              defaultValue={searchLatitude !== null ? String(searchLatitude) : ""}
            />
            <input
              id="search-longitude"
              type="hidden"
              name="longitude"
              defaultValue={searchLongitude !== null ? String(searchLongitude) : ""}
            />

            <div className="p-4 sm:p-5">
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
                <input
                  id="q"
                  name="q"
                  defaultValue={qRaw}
                  placeholder="Search event, host, style, or location"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                />
                <button
                  type="submit"
                  className="inline-flex items-center justify-center rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-5 py-2.5 text-sm font-semibold text-white hover:brightness-110"
                >
                  Search events
                </button>
              </div>

              <details className="mt-4 rounded-2xl border border-slate-200 bg-slate-50">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-slate-800">
                  <span>More filters</span>
                  <span className="text-xs font-medium text-slate-500">
                    Location · style · radius
                  </span>
                </summary>

                <div className="border-t border-slate-200 p-4">
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <div>
                      <label htmlFor="city" className="mb-1.5 block text-sm font-medium text-slate-800">
                        City
                      </label>
                      <input
                        id="city"
                        name="city"
                        defaultValue={cityRaw}
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"
                      />
                    </div>

                    <div>
                      <label htmlFor="state" className="mb-1.5 block text-sm font-medium text-slate-800">
                        State
                      </label>
                      <input
                        id="state"
                        name="state"
                        defaultValue={stateRaw}
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"
                      />
                    </div>

                    <div>
                      <label htmlFor="zip" className="mb-1.5 block text-sm font-medium text-slate-800">
                        ZIP
                      </label>
                      <input
                        id="zip"
                        name="zip"
                        defaultValue={zipRaw}
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"
                      />
                    </div>

                    <div>
                      <label htmlFor="style" className="mb-1.5 block text-sm font-medium text-slate-800">
                        Dance style
                      </label>
                      <select
                        id="style"
                        name="style"
                        defaultValue={style}
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"
                      >
                        <option value="">All styles</option>
                        {STYLE_OPTIONS.map((option) => (
                          <option key={option.key} value={option.key}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-col gap-3 border-t border-slate-200 pt-4 lg:flex-row lg:items-end lg:justify-between">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                      <CurrentLocationButton />

                      <div className="w-full sm:w-40">
                        <label htmlFor="radius" className="mb-1.5 block text-sm font-medium text-slate-800">
                          Radius
                        </label>
                        <select
                          id="radius"
                          name="radius"
                          defaultValue={String(radius)}
                          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"
                        >
                          {RADIUS_OPTIONS.map((value) => (
                            <option key={value} value={value}>
                              {value} miles
                            </option>
                          ))}
                        </select>
                      </div>

                      <label className="inline-flex min-h-11 items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          name="beginner"
                          value="1"
                          defaultChecked={beginner}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                        Beginner-friendly only
                      </label>
                    </div>

                    <Link
                      href="/discover/events"
                      className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-center text-sm font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      Clear filters
                    </Link>
                  </div>
                </div>
              </details>
            </div>
          </form>

          <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">Event directory</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
                {filteredEvents.length} event{filteredEvents.length === 1 ? "" : "s"}
              </h2>

              <p className="mt-1 text-sm text-slate-600">
                Browse public events
                {usingCurrentLocation
                  ? ` within ${radius} miles of your location`
                  : ""}
              </p>

              {usingCurrentLocation ? (
                <p className="mt-1 text-xs font-medium text-violet-600">
                  Sorted by distance when event or studio coordinates are
                  available
                </p>
              ) : requestedCurrentLocation ? (
                <p className="mt-1 text-xs font-medium text-amber-700">
                  Showing all public events. Location sorting will improve as
                  event and studio map details are added.
                </p>
              ) : null}
            </div>

            <Link
              href="/discover/events"
              className="inline-flex rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            >
              Reset Filters
            </Link>
          </div>

          {filteredEvents.length === 0 ? (
            <div className="mt-8 rounded-[2rem] border border-slate-200/80 bg-white px-6 py-16 text-center shadow-sm">
              <h3 className="text-xl font-semibold text-slate-950">
                No events found
              </h3>

              <p className="mt-2 text-slate-600">
                Try a broader search or clear filters to see more events.
              </p>
            </div>
          ) : (
            <div className="mt-8 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
              {filteredEvents.map(
                ({
                  event,
                  studio,
                  organizer,
                  eventStyleRows,
                  eventLocations,
                  distanceMiles,
                }) => {
                  const activeCount =
                    activeRegistrationCountByEventId.get(event.id) ?? 0;
                  const availability = availabilityLabel({
                    registrationRequired: event.registration_required,
                    capacity: event.capacity,
                    activeCount,
                    waitlistEnabled: event.waitlist_enabled,
                  });

                  return (
                    <article
                      key={event.id}
                      className="overflow-hidden rounded-[2rem] border border-slate-200/80 bg-white shadow-sm hover:shadow-md"
                    >
                      <div className="h-52 bg-slate-100">
                        {event.public_cover_image_url ? (
                          <img
                            src={event.public_cover_image_url}
                            alt={event.name}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center bg-[linear-gradient(135deg,#f8fafc_0%,#ede9fe_40%,#fff7ed_100%)] px-6 text-center text-sm text-slate-500">
                            Event image coming soon
                          </div>
                        )}
                      </div>

                      <div className="space-y-4 p-6">
                        <div className="flex flex-wrap gap-2">
                          <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                            {eventTypeLabel(event.event_type)}
                          </span>

                          <span className="inline-flex rounded-full bg-orange-50 px-3 py-1 text-xs font-medium text-orange-700">
                            {formatEventScheduleFromLocations(
                              event,
                              eventLocations,
                            )}
                          </span>

                          <span
                            className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${availability.className}`}
                          >
                            {availability.text}
                          </span>

                          {event.beginner_friendly ? (
                            <span className="inline-flex rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-700">
                              Beginner Friendly
                            </span>
                          ) : null}
                        </div>

                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h3 className="text-xl font-semibold text-slate-950">
                              {event.name}
                            </h3>

                            <p className="mt-1 text-sm text-slate-500">
                              {studio
                                ? `${hostStudioName(studio)} • ${[
                                    studio.city,
                                    studio.state,
                                  ]
                                    .filter(Boolean)
                                    .join(", ")}`
                                : "Host coming soon"}
                            </p>

                            {usingCurrentLocation && distanceMiles !== null ? (
                              <p className="mt-1 text-xs font-medium text-violet-600">
                                {distanceMiles.toFixed(1)} miles away
                              </p>
                            ) : null}

                            {organizer ? (
                              <p className="mt-1 text-xs text-slate-500">
                                Published by {organizer.name}
                              </p>
                            ) : null}
                          </div>

                          <div className="flex items-center gap-2">
                            <ShareButton
                              title={event.name}
                              text={`Check out ${event.name} on DanceFlow.`}
                              url={`/events/${event.slug}`}
                              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
                            />
                            <FavoriteButton
                              targetType="event"
                              targetId={event.id}
                              initiallyFavorited={favoriteEventIds.has(
                                event.id,
                              )}
                              isAuthenticated={!!user}
                              returnPath="/discover/events"
                            />
                          </div>
                        </div>

                        <p className="text-sm leading-6 text-slate-600">
                          {event.public_summary ||
                            event.public_description ||
                            "Public event details coming soon."}
                        </p>

                        {eventStyleRows.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {eventStyleRows.slice(0, 4).map((row) => (
                              <span
                                key={`${event.id}-${row.style_key}`}
                                className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700"
                              >
                                {row.display_name}
                              </span>
                            ))}
                          </div>
                        ) : null}

                        <div className="flex flex-wrap gap-3 pt-1">
                          <Link
                            href={`/events/${event.slug}`}
                            className="inline-flex rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                          >
                            View Event
                          </Link>

                          {studio?.slug ? (
                            <Link
                              href={`/studios/${studio.slug}`}
                              className="inline-flex rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                            >
                              View Studio
                            </Link>
                          ) : null}
                        </div>
                      </div>
                    </article>
                  );
                },
              )}
            </div>
          )}
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}



