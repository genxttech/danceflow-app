import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import FavoriteButton from "@/components/public/FavoriteButton";
import CurrentLocationButton from "@/components/public/CurrentLocationButton";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";

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

function hostStudioName(studio: StudioRow | undefined) {
  if (!studio) return "Studio";
  return studio.public_name?.trim() || studio.name;
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
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function availabilityLabel(params: {
  registrationRequired: boolean;
  capacity: number | null;
  activeCount: number;
  waitlistEnabled: boolean;
}) {
  const { registrationRequired, capacity, activeCount, waitlistEnabled } = params;

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

function toNumber(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function haversineMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.asin(Math.sqrt(a));
  return earthRadiusMiles * c;
}

export default async function DiscoverEventsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;

  const q = (query.q ?? "").trim().toLowerCase();
  const city = (query.city ?? "").trim().toLowerCase();
  const state = (query.state ?? "").trim().toLowerCase();
  const zip = (query.zip ?? "").trim().toLowerCase();
  const style = (query.style ?? "").trim().toLowerCase();
  const beginner = query.beginner === "1";
  const radius = Number(query.radius ?? "25");
  const locationMode = query.locationMode === "current" ? "current" : "manual";
  const searchLatitude = toNumber(query.latitude);
  const searchLongitude = toNumber(query.longitude);

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
  ] = await Promise.all([
    supabase
      .from("events")
      .select(`
        id,
        slug,
        studio_id,
        organizer_id,
        name,
        event_type,
        start_date,
        end_date,
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
        longitude
      `)
      .eq("visibility", "public")
      .eq("public_directory_enabled", true)
      .in("status", ["published", "open"])
      .not("organizer_id", "is", null)
      .order("start_date", { ascending: true }),

    supabase
      .from("studios")
      .select(`
        id,
        slug,
        public_name,
        name,
        city,
        state,
        postal_code,
        latitude,
        longitude,
        public_directory_enabled
      `),

    supabase
      .from("organizers")
      .select(`
        id,
        name,
        slug,
        studio_id,
        active
      `)
      .eq("active", true),

    supabase
      .from("event_public_styles")
      .select("event_id, style_key, display_name"),

    supabase
      .from("event_registrations")
      .select("event_id, status")
      .not("status", "in", "(cancelled,waitlisted)"),
  ]);

  if (eventsError) throw new Error(`Failed to load public events: ${eventsError.message}`);
  if (studiosError) throw new Error(`Failed to load studios: ${studiosError.message}`);
  if (organizersError) throw new Error(`Failed to load organizers: ${organizersError.message}`);
  if (eventStylesError) throw new Error(`Failed to load event styles: ${eventStylesError.message}`);
  if (registrationsError) {
    throw new Error(`Failed to load registration summaries: ${registrationsError.message}`);
  }

  const typedEvents = (events ?? []) as EventRow[];
  const typedStudios = (studios ?? []) as StudioRow[];
  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const typedEventStyles = (eventStyles ?? []) as EventStyleRow[];
  const typedRegistrations = (registrations ?? []) as RegistrationSummaryRow[];

  const favoriteEventIds = new Set<string>();

  if (user && typedEvents.length > 0) {
    const { data: favorites, error: favoritesError } = await supabase
      .from("user_favorites")
      .select("event_id")
      .eq("user_id", user.id)
      .in(
        "event_id",
        typedEvents.map((event) => event.id)
      );

    if (favoritesError) {
      throw new Error(`Failed to load event favorites: ${favoritesError.message}`);
    }

    for (const row of favorites ?? []) {
      if (row.event_id) {
        favoriteEventIds.add(row.event_id);
      }
    }
  }

  const studioById = new Map(typedStudios.map((studio) => [studio.id, studio]));
  const organizerById = new Map(typedOrganizers.map((organizer) => [organizer.id, organizer]));

  const stylesByEventId = new Map<string, EventStyleRow[]>();
  for (const row of typedEventStyles) {
    const current = stylesByEventId.get(row.event_id) ?? [];
    current.push(row);
    stylesByEventId.set(row.event_id, current);
  }

  const activeRegistrationCountByEventId = new Map<string, number>();
  for (const row of typedRegistrations) {
    const current = activeRegistrationCountByEventId.get(row.event_id) ?? 0;
    activeRegistrationCountByEventId.set(row.event_id, current + 1);
  }

  const usingCurrentLocation =
    locationMode === "current" &&
    searchLatitude !== null &&
    searchLongitude !== null;

  const filteredEvents = typedEvents
    .map((event) => {
      if (!event.organizer_id || !event.public_directory_enabled || !event.slug) return null;

      const organizer = organizerById.get(event.organizer_id);
      if (!organizer || !organizer.active) return null;

      const studio = event.studio_id ? studioById.get(event.studio_id) : undefined;
      if (!studio || !studio.public_directory_enabled) return null;

      const eventStyleRows = stylesByEventId.get(event.id) ?? [];
      let distanceMiles: number | null = null;

      if (beginner && !event.beginner_friendly) return null;

      if (usingCurrentLocation) {
        const lat = event.latitude ?? studio.latitude;
        const lng = event.longitude ?? studio.longitude;

        if (lat == null || lng == null) return null;

        distanceMiles = haversineMiles(searchLatitude!, searchLongitude!, lat, lng);
        if (distanceMiles > radius) return null;
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
            row.display_name.toLowerCase() === style
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
          organizer.name,
          organizer.slug,
          studio.city ?? "",
          studio.state ?? "",
          event.postal_code ?? "",
          studio.postal_code ?? "",
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
        distanceMiles,
      };
    })
    .filter(
      (
        row
      ): row is {
        event: EventRow;
        studio: StudioRow;
        organizer: OrganizerRow;
        eventStyleRows: EventStyleRow[];
        distanceMiles: number | null;
      } => Boolean(row)
    )
    .sort((a, b) => {
      if (usingCurrentLocation) {
        return (
          (a.distanceMiles ?? Number.MAX_SAFE_INTEGER) -
          (b.distanceMiles ?? Number.MAX_SAFE_INTEGER)
        );
      }

      const aDate = a.event.start_date
        ? new Date(a.event.start_date).getTime()
        : Number.MAX_SAFE_INTEGER;
      const bDate = b.event.start_date
        ? new Date(b.event.start_date).getTime()
        : Number.MAX_SAFE_INTEGER;

      return aDate - bDate;
    });

  return (
    <>
      <PublicSiteHeader currentPath="events" isAuthenticated={!!user} />

      <main className="min-h-screen bg-slate-50">
        <section className="border-b bg-[linear-gradient(180deg,#f5f3ff_0%,#ffffff_24%,#f8fafc_100%)]">
          <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-600">
              Public Events
            </p>

            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              {user
                ? "Welcome back — find dance events near you"
                : "Find dance events near you"}
            </h1>

            <p className="mt-4 max-w-3xl text-lg leading-8 text-slate-600">
              Search by city, state, ZIP code, or your current location to find public events nearby.
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/discover/studios"
                className="inline-flex rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
              >
                Browse Studios
              </Link>

              {!user ? (
                <Link
                  href="/signup"
                  className="inline-flex rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                >
                  Create Free Account
                </Link>
              ) : (
                <div className="inline-flex rounded-xl border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">
                  You are signed in. You can now favorite events while you browse.
                </div>
              )}
            </div>

            <div className="mt-6 rounded-2xl border border-violet-200 bg-violet-50 px-5 py-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-violet-700">
                    Near-Me Search
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Use your current location, or search by city, state, or ZIP code.
                  </p>
                </div>

                <Link
                  href="/discover/studios"
                  className="inline-flex rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Search Studios Near Me
                </Link>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <form className="rounded-[2rem] border border-slate-200/80 bg-white p-6 shadow-sm">
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
              defaultValue={query.latitude ?? ""}
            />
            <input
              id="search-longitude"
              type="hidden"
              name="longitude"
              defaultValue={query.longitude ?? ""}
            />

            <div className="grid gap-4 xl:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto]">
              <div>
                <label htmlFor="q" className="mb-1.5 block text-sm font-medium text-slate-800">
                  Search
                </label>
                <input
                  id="q"
                  name="q"
                  defaultValue={query.q ?? ""}
                  placeholder="Event name, host, or dance style"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"
                />
              </div>

              <div>
                <label htmlFor="city" className="mb-1.5 block text-sm font-medium text-slate-800">
                  City
                </label>
                <input
                  id="city"
                  name="city"
                  defaultValue={query.city ?? ""}
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
                  defaultValue={query.state ?? ""}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"
                />
              </div>

              <div>
                <label htmlFor="zip" className="mb-1.5 block text-sm font-medium text-slate-800">
                  ZIP Code
                </label>
                <input
                  id="zip"
                  name="zip"
                  defaultValue={query.zip ?? ""}
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
                  defaultValue={query.style ?? ""}
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

              <div className="flex items-end">
                <button
                  type="submit"
                  className="inline-flex w-full justify-center rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                >
                  Search
                </button>
              </div>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-[auto_180px] lg:items-end">
              <div>
                <CurrentLocationButton />
              </div>

              <div>
                <label htmlFor="radius" className="mb-1.5 block text-sm font-medium text-slate-800">
                  Radius
                </label>
                <select
                  id="radius"
                  name="radius"
                  defaultValue={String(RADIUS_OPTIONS.includes(radius) ? radius : 25)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"
                >
                  {RADIUS_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value} miles
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <label className="mt-4 inline-flex items-center gap-3 text-sm text-slate-700">
              <input
                type="checkbox"
                name="beginner"
                value="1"
                defaultChecked={beginner}
                className="h-4 w-4 rounded border-slate-300"
              />
              Beginner-friendly only
            </label>
          </form>

          <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">Events</h2>
              <p className="mt-1 text-sm text-slate-600">
                Showing {filteredEvents.length} organizer-published public events
                {usingCurrentLocation ? ` within ${radius} miles of your location` : ""}
              </p>
              {usingCurrentLocation ? (
                <p className="mt-1 text-xs font-medium text-violet-600">
                  Sorted by distance from your location
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
              <h3 className="text-xl font-semibold text-slate-950">No events found</h3>
              <p className="mt-2 text-slate-600">
                Try broadening your filters, changing your radius, or switching to manual filters.
              </p>
            </div>
          ) : (
            <div className="mt-8 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
              {filteredEvents.map(({ event, studio, organizer, eventStyleRows, distanceMiles }) => {
                const activeCount = activeRegistrationCountByEventId.get(event.id) ?? 0;
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
                          {formatDateRange(event.start_date, event.end_date)}
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
                          <h3 className="text-xl font-semibold text-slate-950">{event.name}</h3>
                          <p className="mt-1 text-sm text-slate-500">
                            {studio
                              ? `${hostStudioName(studio)} • ${[studio.city, studio.state]
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

                        <FavoriteButton
                          targetType="event"
                          targetId={event.id}
                          initiallyFavorited={favoriteEventIds.has(event.id)}
                          isAuthenticated={!!user}
                          returnPath="/discover/events"
                        />
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
              })}
            </div>
          )}
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}
