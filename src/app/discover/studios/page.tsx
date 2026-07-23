import Link from "next/link";
import { MapPin, Search, SlidersHorizontal } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import FavoriteButton from "@/components/public/FavoriteButton";
import ShareButton from "@/components/public/ShareButton";
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
  billing_plan: string | null;
  subscription_status: string | null;
  created_at: string | null;
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


function hasActivePublicAccess(studio: {
  billing_plan?: string | null;
  subscription_status?: string | null;
}) {
  const status = (studio.subscription_status ?? "").trim().toLowerCase();

  return status === "active" || status === "trialing";
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
  const offering = normalizeOptionParam(
    query.offering,
    OFFERING_OPTIONS.map((option) => option.key),
  );
  const beginner = query.beginner === "1";

  const radius = normalizeRadiusParam(query.radius);

  const locationMode = normalizeLocationMode(query.locationMode);
  const searchLatitude = normalizeCoordinate(query.latitude, -90, 90);
  const searchLongitude = normalizeCoordinate(query.longitude, -180, 180);

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
      .select(
        `
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
        beginner_friendly,
        billing_plan,
        subscription_status,
        created_at
      `
      )
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
    throw new Error(
      `Failed to load studio offerings: ${offeringsError.message}`
    );
  }

  const typedStudios = ((studios ?? []) as StudioRow[]).filter(hasActivePublicAccess);
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
      throw new Error(
        `Failed to load studio favorites: ${favoritesError.message}`
      );
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

  const hasAnyGeocodedStudios = typedStudios.some(
    (studio) => studio.latitude !== null && studio.longitude !== null
  );

  const requestedCurrentLocation =
    locationMode === "current" &&
    searchLatitude !== null &&
    searchLongitude !== null;

  const usingCurrentLocation =
    requestedCurrentLocation && hasAnyGeocodedStudios;

  const shouldUseManualLocationFilters = !requestedCurrentLocation;

  const filteredStudios = typedStudios
    .map((studio) => {
      const studioStyles = stylesByStudioId.get(studio.id) ?? [];
      const studioOfferings = offeringsByStudioId.get(studio.id) ?? [];

      let distanceMiles: number | null = null;

      if (usingCurrentLocation) {
        if (studio.latitude !== null && studio.longitude !== null) {
          distanceMiles = haversineMiles(
            searchLatitude!,
            searchLongitude!,
            studio.latitude,
            studio.longitude
          );

          if (distanceMiles > radius) return null;
        } else {
          distanceMiles = null;
        }
      } else if (shouldUseManualLocationFilters) {
        if (zip && !normalizeZip(studio.postal_code).includes(zip)) {
          return null;
        }

        if (city && !(studio.city ?? "").toLowerCase().includes(city)) {
          return null;
        }

        if (state && !(studio.state ?? "").toLowerCase().includes(state)) {
          return null;
        }
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

  const newlyAddedStudios = [...filteredStudios]
    .sort((a, b) => {
      const aTime = a.studio.created_at
        ? new Date(a.studio.created_at).getTime()
        : 0;
      const bTime = b.studio.created_at
        ? new Date(b.studio.created_at).getTime()
        : 0;
      return bTime - aTime;
    })
    .slice(0, 3);

  return (
    <>
      <PublicSiteHeader currentPath="studios" isAuthenticated={!!user} />

      <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.10),transparent_28%),radial-gradient(circle_at_top_right,rgba(124,58,237,0.10),transparent_26%),linear-gradient(180deg,#fff7ed_0%,#f8fafc_34%,#ffffff_100%)]">
        <section className="border-b border-orange-200/70 bg-[linear-gradient(135deg,#111827_0%,#4c1d95_52%,#f97316_145%)] text-white">
          <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-200">
                  DanceFlow Discovery
                </p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                  Find a dance studio
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-white/80 sm:text-base">
                  Search by location, dance style, offering, or beginner-friendly options.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Link
                  href="/discover/events"
                  className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white backdrop-blur hover:bg-white/15"
                >
                  Browse events
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

        <section className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
          <form className="sticky top-0 z-20 overflow-hidden rounded-3xl border border-orange-200/80 bg-white/95 shadow-[0_18px_50px_rgba(76,29,149,0.10)] backdrop-blur">
            <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 sm:px-5">
              <span className="rounded-xl bg-[linear-gradient(135deg,#4c1d95_0%,#f97316_120%)] p-2 text-white shadow-sm">
                <SlidersHorizontal className="h-4 w-4" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-950">Search and filters</h2>
                <p className="text-xs text-slate-500">Refine studio results without leaving the page.</p>
              </div>
            </div>

            <div className="p-4 sm:p-5">
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

              <div className="grid gap-4 xl:grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr_auto]">
                <div>
                  <label
                    htmlFor="q"
                    className="mb-1.5 block text-sm font-medium text-slate-800"
                  >
                    Search
                  </label>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <input
                      id="q"
                      name="q"
                      defaultValue={qRaw}
                      placeholder="Studio name, dance style, or offering"
                      className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-9 pr-3"
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="city"
                    className="mb-1.5 block text-sm font-medium text-slate-800"
                  >
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
                  <label
                    htmlFor="state"
                    className="mb-1.5 block text-sm font-medium text-slate-800"
                  >
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
                  <label
                    htmlFor="zip"
                    className="mb-1.5 block text-sm font-medium text-slate-800"
                  >
                    ZIP Code
                  </label>
                  <input
                    id="zip"
                    name="zip"
                    defaultValue={zipRaw}
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"
                  />
                </div>

                <div>
                  <label
                    htmlFor="style"
                    className="mb-1.5 block text-sm font-medium text-slate-800"
                  >
                    Dance style
                  </label>
                  <select
                    id="style"
                    name="style"
                    defaultValue={style}
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
                    defaultValue={offering}
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
                    className="inline-flex w-full justify-center rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:brightness-110"
                  >
                    Search
                  </button>
                </div>
              </div>

              <div className="mt-4 flex flex-col gap-3 border-t border-slate-100 pt-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                  <CurrentLocationButton />

                  <div className="w-full sm:w-40">
                    <label
                      htmlFor="radius"
                      className="mb-1.5 block text-sm font-medium text-slate-800"
                    >
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

                  <label className="inline-flex min-h-11 items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700">
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
                  href="/discover/studios"
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-center text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Clear filters
                </Link>
              </div>
            </div>
          </form>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                Studio directory
              </p>
              <h2 className="mt-1 text-2xl font-semibold text-slate-950">
                {filteredStudios.length} studio{filteredStudios.length === 1 ? "" : "s"} found
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {usingCurrentLocation
                  ? `Within ${radius} miles, sorted by available distance data.`
                  : requestedCurrentLocation
                    ? "Location requested; studios without map coordinates remain visible."
                    : "Browse public profiles and compare styles, offerings, and location."}
              </p>
            </div>

            {usingCurrentLocation ? (
              <span className="inline-flex items-center gap-2 rounded-full bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-700">
                <MapPin className="h-3.5 w-3.5" />
                Distance sorted
              </span>
            ) : null}
          </div>

          {filteredStudios.length === 0 ? (
            <div className="mt-6 rounded-3xl border bg-white px-6 py-16 text-center shadow-sm">
              <h3 className="text-xl font-semibold text-slate-900">
                No studios found
              </h3>
              <p className="mt-2 text-slate-600">
                Try broadening your search, resetting filters, or searching by
                city, state, or ZIP code.
              </p>
            </div>
          ) : (
            <div className="mt-6 grid grid-cols-1 gap-5 xl:grid-cols-2">
              {filteredStudios.map(
                ({ studio, studioStyles, studioOfferings, distanceMiles }) => {
                  const publicHref = studio.slug
                    ? `/studios/${studio.slug}`
                    : "#";

                  return (
                    <article
                      key={studio.id}
                      className="overflow-hidden rounded-3xl border border-orange-100 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-violet-200 hover:shadow-[0_18px_45px_rgba(76,29,149,0.12)]"
                    >
                      <div className="h-44 bg-[linear-gradient(135deg,#f8fafc_0%,#ede9fe_45%,#fff7ed_100%)]">
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

                      <div className="space-y-4 p-5">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <h3 className="text-xl font-semibold text-slate-900">
                              {titleForStudio(studio)}
                            </h3>
                            <p className="mt-1 text-sm text-slate-500">
                              {locationLabel(studio)}
                            </p>

                            {usingCurrentLocation &&
                            distanceMiles !== null ? (
                              <p className="mt-1 text-xs font-medium text-violet-600">
                                {distanceMiles.toFixed(1)} miles away
                              </p>
                            ) : null}
                          </div>

                          <div className="flex items-center gap-2">
                            {studio.slug ? (
                              <ShareButton
                                title={titleForStudio(studio)}
                                text={`Check out ${titleForStudio(studio)} on DanceFlow.`}
                                url={`/studios/${studio.slug}`}
                                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
                              />
                            ) : null}

                            <FavoriteButton
                              targetType="studio"
                              targetId={studio.id}
                              initiallyFavorited={favoriteStudioIds.has(
                                studio.id
                              )}
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
                              className="rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_60%,#f97316_150%)] px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
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
                }
              )}
            </div>
          )}
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}