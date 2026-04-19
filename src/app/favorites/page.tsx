import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import FavoriteButton from "@/components/public/FavoriteButton";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";

type FavoriteRow = {
  id: string;
  target_type: "studio" | "event";
  studio_id: string | null;
  event_id: string | null;
  created_at: string;
};

type StudioRow = {
  id: string;
  slug: string | null;
  public_name: string | null;
  name: string;
  public_short_description: string | null;
  city: string | null;
  state: string | null;
  public_hero_image_url: string | null;
  beginner_friendly: boolean | null;
};

type EventRow = {
  id: string;
  slug: string | null;
  name: string;
  event_type: string | null;
  start_date: string | null;
  end_date: string | null;
  public_summary: string | null;
  public_description: string | null;
  public_cover_image_url: string | null;
  beginner_friendly: boolean | null;
};

function studioTitle(studio: StudioRow) {
  return studio.public_name?.trim() || studio.name;
}

function locationLabel(studio: StudioRow) {
  const parts = [studio.city, studio.state].filter(Boolean);
  return parts.length ? parts.join(", ") : "Location coming soon";
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

function formatEventDateRange(start: string | null, end: string | null) {
  if (!start) return "Date coming soon";

  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) return "Date coming soon";

  const startText = startDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  if (!end) return startText;

  const endDate = new Date(end);
  if (Number.isNaN(endDate.getTime())) return startText;

  const sameDay =
    startDate.getFullYear() === endDate.getFullYear() &&
    startDate.getMonth() === endDate.getMonth() &&
    startDate.getDate() === endDate.getDate();

  if (sameDay) return startText;

  const endText = endDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return `${startText} - ${endText}`;
}

export default async function FavoritesPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/favorites");
  }

  const { data: favorites, error: favoritesError } = await supabase
    .from("user_favorites")
    .select("id, target_type, studio_id, event_id, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (favoritesError) {
    throw new Error(`Failed to load favorites: ${favoritesError.message}`);
  }

  const typedFavorites = (favorites ?? []) as FavoriteRow[];

  const studioIds = typedFavorites
    .map((favorite) => favorite.studio_id)
    .filter((value): value is string => Boolean(value));

  const eventIds = typedFavorites
    .map((favorite) => favorite.event_id)
    .filter((value): value is string => Boolean(value));

  const [
    { data: studios, error: studiosError },
    { data: events, error: eventsError },
  ] = await Promise.all([
    studioIds.length
      ? supabase
          .from("studios")
          .select(`
            id,
            slug,
            public_name,
            name,
            public_short_description,
            city,
            state,
            public_hero_image_url,
            beginner_friendly
          `)
          .in("id", studioIds)
      : Promise.resolve({ data: [], error: null }),

    eventIds.length
      ? supabase
          .from("events")
          .select(`
            id,
            slug,
            name,
            event_type,
            start_date,
            end_date,
            public_summary,
            public_description,
            public_cover_image_url,
            beginner_friendly
          `)
          .in("id", eventIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (studiosError) {
    throw new Error(`Failed to load favorite studios: ${studiosError.message}`);
  }

  if (eventsError) {
    throw new Error(`Failed to load favorite events: ${eventsError.message}`);
  }

  const studioById = new Map<string, StudioRow>(
    ((studios ?? []) as StudioRow[]).map((studio) => [studio.id, studio])
  );

  const eventById = new Map<string, EventRow>(
    ((events ?? []) as EventRow[]).map((event) => [event.id, event])
  );

  const favoriteStudios = typedFavorites
    .filter((favorite) => favorite.target_type === "studio" && favorite.studio_id)
    .map((favorite) => ({
      favorite,
      studio: favorite.studio_id ? studioById.get(favorite.studio_id) : undefined,
    }))
    .filter((row): row is { favorite: FavoriteRow; studio: StudioRow } => Boolean(row.studio));

  const favoriteEvents = typedFavorites
    .filter((favorite) => favorite.target_type === "event" && favorite.event_id)
    .map((favorite) => ({
      favorite,
      event: favorite.event_id ? eventById.get(favorite.event_id) : undefined,
    }))
    .filter((row): row is { favorite: FavoriteRow; event: EventRow } => Boolean(row.event));

  return (
    <>
      <PublicSiteHeader currentPath="favorites" isAuthenticated={!!user} />

      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_18%,#f8fafc_100%)]">
        <section className="border-b border-slate-200/70 bg-white/70">
          <div className="mx-auto max-w-7xl px-6 py-14 lg:px-8">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
              Favorites
            </p>

            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
              Your saved studios and events
            </h1>

            <p className="mt-4 max-w-3xl text-lg text-slate-600">
              Keep track of studios and events you want to revisit without searching
              for them every time.
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/discover/studios"
                className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Browse Studios
              </Link>

              <Link
                href="/discover/events"
                className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Browse Events
              </Link>

              <Link
                href="/account"
                className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-slate-800"
              >
                Back to Account
              </Link>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-6 py-8 lg:px-8">
          <div className="grid gap-10">
            <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
              <div className="mb-5 flex items-end justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-orange-600">
                    Favorite Studios
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold text-slate-900">
                    Studios you want to revisit
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    {favoriteStudios.length} saved studio{favoriteStudios.length === 1 ? "" : "s"}
                  </p>
                </div>
              </div>

              {favoriteStudios.length === 0 ? (
                <div className="rounded-3xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center">
                  <h3 className="text-xl font-semibold text-slate-900">No favorite studios yet</h3>
                  <p className="mt-2 text-slate-600">
                    Tap the heart on a studio to save it here.
                  </p>
                </div>
              ) : (
                <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
                  {favoriteStudios.map(({ studio }) => (
                    <article
                      key={studio.id}
                      className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"
                    >
                      <div className="h-48 bg-slate-100">
                        {studio.public_hero_image_url ? (
                          <img
                            src={studio.public_hero_image_url}
                            alt={studioTitle(studio)}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center bg-[linear-gradient(135deg,#f8fafc_0%,#fff7ed_100%)] text-sm text-slate-500">
                            Studio image coming soon
                          </div>
                        )}
                      </div>

                      <div className="space-y-4 p-6">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h3 className="text-xl font-semibold text-slate-900">
                              {studioTitle(studio)}
                            </h3>
                            <p className="mt-1 text-sm text-slate-500">
                              {locationLabel(studio)}
                            </p>
                          </div>

                          <FavoriteButton
                            targetType="studio"
                            targetId={studio.id}
                            initiallyFavorited={true}
                            isAuthenticated={true}
                            returnPath="/favorites"
                          />
                        </div>

                        <p className="text-sm text-slate-600">
                          {studio.public_short_description ||
                            "Explore this studio’s public profile, instructors, and offerings."}
                        </p>

                        {studio.beginner_friendly ? (
                          <span className="inline-flex rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-700">
                            Beginner Friendly
                          </span>
                        ) : null}

                        <div className="pt-2">
                          {studio.slug ? (
                            <Link
                              href={`/studios/${studio.slug}`}
                              className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
                            >
                              View Studio
                            </Link>
                          ) : (
                            <span className="rounded-xl bg-slate-200 px-4 py-2 text-sm text-slate-500">
                              Public page coming soon
                            </span>
                          )}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
              <div className="mb-5 flex items-end justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-violet-600">
                    Favorite Events
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold text-slate-900">
                    Events you saved for later
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    {favoriteEvents.length} saved event{favoriteEvents.length === 1 ? "" : "s"}
                  </p>
                </div>
              </div>

              {favoriteEvents.length === 0 ? (
                <div className="rounded-3xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center">
                  <h3 className="text-xl font-semibold text-slate-900">No favorite events yet</h3>
                  <p className="mt-2 text-slate-600">
                    Tap the heart on an event to save it here.
                  </p>
                </div>
              ) : (
                <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
                  {favoriteEvents.map(({ event }) => (
                    <article
                      key={event.id}
                      className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"
                    >
                      <div className="h-48 bg-slate-100">
                        {event.public_cover_image_url ? (
                          <img
                            src={event.public_cover_image_url}
                            alt={event.name}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center bg-[linear-gradient(135deg,#f8fafc_0%,#ede9fe_40%,#fff7ed_100%)] text-sm text-slate-500">
                            Event image coming soon
                          </div>
                        )}
                      </div>

                      <div className="space-y-4 p-6">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h3 className="text-xl font-semibold text-slate-900">{event.name}</h3>
                            <p className="mt-1 text-sm text-slate-500">
                              {formatEventDateRange(event.start_date, event.end_date)}
                            </p>
                          </div>

                          <FavoriteButton
                            targetType="event"
                            targetId={event.id}
                            initiallyFavorited={true}
                            isAuthenticated={true}
                            returnPath="/favorites"
                          />
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700">
                            {eventTypeLabel(event.event_type)}
                          </span>
                          {event.beginner_friendly ? (
                            <span className="rounded-full bg-green-50 px-3 py-1 text-xs text-green-700">
                              Beginner Friendly
                            </span>
                          ) : null}
                        </div>

                        <p className="text-sm text-slate-600">
                          {event.public_summary ||
                            event.public_description ||
                            "Public event details coming soon."}
                        </p>

                        <div className="pt-2">
                          {event.slug ? (
                            <Link
                              href={`/events/${event.slug}`}
                              className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
                            >
                              View Event
                            </Link>
                          ) : (
                            <span className="rounded-xl bg-slate-200 px-4 py-2 text-sm text-slate-500">
                              Public page coming soon
                            </span>
                          )}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}