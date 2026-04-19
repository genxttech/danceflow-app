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
  offering?: string;
  beginner?: string;
  radius?: string;
  latitude?: string;
  longitude?: string;
  locationMode?: string;
}>;

type StudioRow = {
  id: string;
  slug: string | null;
  public_name: string | null;
  name: string;
  public_short_description: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
  public_logo_url: string | null;
  public_hero_image_url: string | null;
  beginner_friendly: boolean;
};

type StudioStyleRow = {
  studio_id: string;
  style_key: string;
  display_name: string;
};

type StudioOfferingRow = {
  studio_id: string;
  offering_key: string;
  display_name: string;
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

const OFFERING_OPTIONS = [
  { key: "private_lessons", label: "Private Lessons" },
  { key: "group_classes", label: "Group Classes" },
  { key: "wedding_dance", label: "Wedding Dance" },
  { key: "kids_classes", label: "Kids Classes" },
  { key: "socials", label: "Social Dancing" },
  { key: "competitive_coaching", label: "Competitive Coaching" },
  { key: "beginner_program", label: "Beginner Program" },
  { key: "floor_rental", label: "Floor Rental" },
] as const;

const RADIUS_OPTIONS = [10, 25, 50, 100];

function titleForStudio(studio: StudioRow) {
  return studio.public_name?.trim() || studio.name;
}

function locationLabel(studio: StudioRow) {
  const parts = [studio.city, studio.state].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "Location coming soon";
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

export default async function DiscoverStudiosPage({
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
  const offering = (query.offering ?? "").trim().toLowerCase();
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
    { data: studios, error: studiosError },
    { data: styles, error: stylesError },
    { data: offerings, error: offeringsError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select(`
        id,
        slug,
        public_name,
        name,
        public_short_description,
        city,
        state,
        postal_code,
        latitude,
        longitude,
        public_logo_url,
        public_hero_image_url,
        beginner_friendly
      `)
      .eq("public_directory_enabled", true)
      .order("public_name", { ascending: true }),

    supabase
      .from("studio_public_styles")
      .select("studio_id, style_key, display_name"),

    supabase
      .from("studio_public_offerings")
      .select("studio_id, offering_key, display_name"),
  ]);

  if (studiosError) {
    throw new Error(`Failed to load public studios: ${studiosError.message}`);
  }

  if (stylesError) {
    throw new Error(`Failed to load studio styles: ${stylesError.message}`);
  }

  if (offeringsError) {
    throw new Error(`Failed to load studio offerings: ${offeringsError.message}`);
  }

  const typedStudios = (studios ?? []) as StudioRow[];
  const typedStyles = (styles ?? []) as StudioStyleRow[];
  const typedOfferings = (offerings ?? []) as StudioOfferingRow[];

  const favoriteStudioIds = new Set<string>();

  if (user && typedStudios.length > 0) {
    const { data: favorites, error: favoritesError } = await supabase
      .from("user_favorites")
      .select("studio_id")
      .eq("user_id", user.id)
      .in(
        "studio_id",
        typedStudios.map((studio) => studio.id)
      );

    if (favoritesError) {
      throw new Error(`Failed to load studio favorites: ${favoritesError.message}`);
    }

    for (const row of favorites ?? []) {
      if (row.studio_id) {
        favoriteStudioIds.add(row.studio_id);
      }
    }
  }

  const stylesByStudioId = new Map<string, StudioStyleRow[]>();
  for (const row of typedStyles) {
    const current = stylesByStudioId.get(row.studio_id) ?? [];
    current.push(row);
    stylesByStudioId.set(row.studio_id, current);
  }

  const offeringsByStudioId = new Map<string, StudioOfferingRow[]>();
  for (const row of typedOfferings) {
    const current = offeringsByStudioId.get(row.studio_id) ?? [];
    current.push(row);
    offeringsByStudioId.set(row.studio_id, current);
  }

  const usingCurrentLocation =
    locationMode === "current" &&
    searchLatitude !== null &&
    searchLongitude !== null;

  const filteredStudios = typedStudios
    .map((studio) => {
      const studioStyles = stylesByStudioId.get(studio.id) ?? [];
      const studioOfferings = offeringsByStudioId.get(studio.id) ?? [];

      let distanceMiles: number | null = null;

      if (usingCurrentLocation) {
        if (studio.latitude == null || studio.longitude == null) {
          return null;
        }

        distanceMiles = haversineMiles(
          searchLatitude!,
          searchLongitude!,
          studio.latitude,
          studio.longitude
        );

        if (distanceMiles > radius) return null;
      } else {
        if (zip && !normalizeZip(studio.postal_code).includes(zip)) return null;
        if (city && !(studio.city ?? "").toLowerCase().includes(city)) return null;
        if (state && !(studio.state ?? "").toLowerCase().includes(state)) return null;
      }

      if (beginner && !studio.beginner_friendly) return null;

      if (style) {
        const hasStyle = studioStyles.some(
          (row) =>
            row.style_key.toLowerCase() === style ||
            row.display_name.toLowerCase() === style
        );
        if (!hasStyle) return null;
      }

      if (offering) {
        const hasOffering = studioOfferings.some(
          (row) =>
            row.offering_key.toLowerCase() === offering ||
            row.display_name.toLowerCase() === offering
        );
        if (!hasOffering) return null;
      }

      if (q) {
        const haystack = [
          titleForStudio(studio),
          studio.public_short_description ?? "",
          studio.city ?? "",
          studio.state ?? "",
          studio.postal_code ?? "",
          ...studioStyles.map((row) => row.display_name),
          ...studioOfferings.map((row) => row.display_name),
        ]
          .join(" ")
          .toLowerCase();

        if (!haystack.includes(q)) {
          return null;
        }
      }

      return { studio, studioStyles, studioOfferings, distanceMiles };
    })
    .filter(
      (
        row
      ): row is {
        studio: StudioRow;
        studioStyles: StudioStyleRow[];
        studioOfferings: StudioOfferingRow[];
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

      return titleForStudio(a.studio).localeCompare(titleForStudio(b.studio));
    });

  return (
    <>
      <PublicSiteHeader currentPath="discover" isAuthenticated={!!user} />

      <main className="min-h-screen bg-slate-50">
        <section className="border-b bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_24%,#f8fafc_100%)]">
          <div className="mx-auto max-w-7xl px-6 py-14">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
              Discover Studios
            </p>

            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
              {user
                ? "Welcome back — find a dance studio near you"
                : "Find a dance studio near you"}
            </h1>

            <p className="mt-4 max-w-3xl text-lg text-slate-600">
              Search by city, state, ZIP code, or your current location to find studios nearby.
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/discover/events"
                className="rounded-xl border bg-white px-5 py-3 text-sm font-medium hover:bg-slate-50"
              >
                Find Events
              </Link>

              {!user ? (
                <Link
                  href="/signup"
                  className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-slate-800"
                >
                  Create Free Account
                </Link>
              ) : (
                <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
                  You are signed in. You can now favorite studios while you browse.
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
                  href="/discover/events"
                  className="inline-flex rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Search Events Near Me
                </Link>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-6 py-8">
          <form className="rounded-3xl border bg-white p-6 shadow-sm">
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

            <div className="grid gap-4 xl:grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr_auto]">
              <div>
                <label htmlFor="q" className="mb-1.5 block text-sm font-medium text-slate-800">
                  Search
                </label>
                <input
                  id="q"
                  name="q"
                  defaultValue={query.q ?? ""}
                  placeholder="Studio name, dance style, or offering"
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
                  <option value="">All</option>
                  {STYLE_OPTIONS.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="offering"
                  className="mb-1.5 block text-sm font-medium text-slate-800"
                >
                  Offering
                </label>
                <select
                  id="offering"
                  name="offering"
                  defaultValue={query.offering ?? ""}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"
                >
                  <option value="">All</option>
                  {OFFERING_OPTIONS.map((option) => (
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

          <div className="mt-8 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold text-slate-900">Studios</h2>
              <p className="mt-1 text-sm text-slate-600">
                Showing {filteredStudios.length} public studios
                {usingCurrentLocation ? ` within ${radius} miles of your location` : ""}
              </p>
              {usingCurrentLocation ? (
                <p className="mt-1 text-xs font-medium text-violet-600">
                  Sorted by distance from your location
                </p>
              ) : null}
            </div>

            <Link
              href="/discover/studios"
              className="rounded-xl border bg-white px-4 py-2 text-sm hover:bg-slate-50"
            >
              Reset filters
            </Link>
          </div>

          {filteredStudios.length === 0 ? (
            <div className="mt-8 rounded-3xl border bg-white px-6 py-16 text-center shadow-sm">
              <h3 className="text-xl font-semibold text-slate-900">No studios found</h3>
              <p className="mt-2 text-slate-600">
                Try broadening your search, changing your radius, or switching to manual filters.
              </p>
            </div>
          ) : (
            <div className="mt-8 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
              {filteredStudios.map(({ studio, studioStyles, studioOfferings, distanceMiles }) => {
                const publicHref = studio.slug ? `/studios/${studio.slug}` : "#";

                return (
                  <article
                    key={studio.id}
                    className="overflow-hidden rounded-3xl border bg-white shadow-sm"
                  >
                    <div className="h-48 bg-slate-100">
                      {studio.public_hero_image_url ? (
                        <img
                          src={studio.public_hero_image_url}
                          alt={titleForStudio(studio)}
                          className="h-full w-full object-cover"
                        />
                      ) : studio.public_logo_url ? (
                        <div className="flex h-full items-center justify-center p-8">
                          <img
                            src={studio.public_logo_url}
                            alt={titleForStudio(studio)}
                            className="max-h-full max-w-full object-contain"
                          />
                        </div>
                      ) : (
                        <div className="flex h-full items-center justify-center bg-[linear-gradient(135deg,#f8fafc_0%,#fff7ed_100%)] text-sm text-slate-500">
                          Studio image coming soon
                        </div>
                      )}
                    </div>

                    <div className="space-y-4 p-6">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="text-xl font-semibold text-slate-900">
                            {titleForStudio(studio)}
                          </h3>
                          <p className="mt-1 text-sm text-slate-500">
                            {locationLabel(studio)}
                          </p>
                          {usingCurrentLocation && distanceMiles !== null ? (
                            <p className="mt-1 text-xs font-medium text-violet-600">
                              {distanceMiles.toFixed(1)} miles away
                            </p>
                          ) : null}
                        </div>

                        <div className="flex items-center gap-2">
                          <FavoriteButton
                            targetType="studio"
                            targetId={studio.id}
                            initiallyFavorited={favoriteStudioIds.has(studio.id)}
                            isAuthenticated={!!user}
                            returnPath="/discover/studios"
                          />

                          {studio.beginner_friendly ? (
                            <span className="inline-flex rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-700">
                              Beginner Friendly
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <p className="text-sm text-slate-600">
                        {studio.public_short_description ||
                          "Explore this studio’s public profile, instructors, and offerings."}
                      </p>

                      {studioStyles.length > 0 ? (
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                            Dance Styles
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {studioStyles.slice(0, 4).map((row) => (
                              <span
                                key={`${studio.id}-${row.style_key}`}
                                className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700"
                              >
                                {row.display_name}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {studioOfferings.length > 0 ? (
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                            Offerings
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {studioOfferings.slice(0, 4).map((row) => (
                              <span
                                key={`${studio.id}-${row.offering_key}`}
                                className="rounded-full bg-orange-50 px-3 py-1 text-xs text-orange-700"
                              >
                                {row.display_name}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      <div className="flex flex-wrap gap-3 pt-2">
                        {studio.slug ? (
                          <Link
                            href={publicHref}
                            className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
                          >
                            View Studio
                          </Link>
                        ) : (
                          <span className="rounded-xl bg-slate-200 px-4 py-2 text-sm text-slate-500">
                            Public page coming soon
                          </span>
                        )}

                        {studio.slug ? (
                          <Link
                            href={`${publicHref}#lead`}
                            className="rounded-xl border px-4 py-2 text-sm hover:bg-slate-50"
                          >
                            Contact Studio
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