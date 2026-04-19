import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";

type FavoriteRow = {
  studio_id: string | null;
  event_id: string | null;
  created_at: string | null;
};

type StudioRow = {
  id: string;
  slug: string | null;
  public_name: string | null;
  name: string;
  city: string | null;
  state: string | null;
  public_short_description: string | null;
  public_logo_url: string | null;
  beginner_friendly: boolean | null;
};

type EventRegistrationRow = {
  id: string;
  event_id: string | null;
  status: string | null;
  created_at: string | null;
};

type EventRow = {
  id: string;
  slug: string | null;
  name: string;
  start_date: string | null;
  end_date: string | null;
  event_type: string | null;
  public_summary: string | null;
  public_cover_image_url: string | null;
  visibility: string | null;
  status: string | null;
};

function studioTitle(studio: StudioRow) {
  return studio.public_name?.trim() || studio.name;
}

function studioLocation(studio: StudioRow) {
  const parts = [studio.city, studio.state].filter(Boolean);
  return parts.length ? parts.join(", ") : "Location coming soon";
}

function formatDate(value: string | null) {
  if (!value) return "Date coming soon";

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "Date coming soon";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatDateRange(start: string | null, end: string | null) {
  if (!start) return "Date coming soon";
  if (!end || end === start) return formatDate(start);
  return `${formatDate(start)} – ${formatDate(end)}`;
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

function registrationStatusLabel(value: string | null) {
  if (!value) return "Registered";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export default async function PublicAccountPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  async function signOutAction() {
    "use server";

    const supabase = await createClient();
    await supabase.auth.signOut();
    redirect("/");
  }

  const [
    { data: favorites, error: favoritesError },
    { data: registrations, error: registrationsError },
  ] = await Promise.all([
    supabase
      .from("user_favorites")
      .select("studio_id, event_id, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),

    supabase
      .from("event_registrations")
      .select("id, event_id, status, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
  ]);

  if (favoritesError) {
    throw new Error(`Failed to load favorites: ${favoritesError.message}`);
  }

  if (registrationsError) {
    throw new Error(`Failed to load registrations: ${registrationsError.message}`);
  }

  const typedFavorites = (favorites ?? []) as FavoriteRow[];
  const typedRegistrations = (registrations ?? []) as EventRegistrationRow[];

  const studioIds = Array.from(
    new Set(
      typedFavorites
        .map((row) => row.studio_id)
        .filter((value): value is string => Boolean(value))
    )
  );

  const eventFavoriteIds = Array.from(
    new Set(
      typedFavorites
        .map((row) => row.event_id)
        .filter((value): value is string => Boolean(value))
    )
  );

  const registeredEventIds = Array.from(
    new Set(
      typedRegistrations
        .map((row) => row.event_id)
        .filter((value): value is string => Boolean(value))
    )
  );

  const allEventIds = Array.from(new Set([...eventFavoriteIds, ...registeredEventIds]));

  const [{ data: studios, error: studiosError }, { data: events, error: eventsError }] =
    await Promise.all([
      studioIds.length > 0
        ? supabase
            .from("studios")
            .select(
              `
                id,
                slug,
                public_name,
                name,
                city,
                state,
                public_short_description,
                public_logo_url,
                beginner_friendly
              `
            )
            .in("id", studioIds)
        : Promise.resolve({ data: [], error: null }),

      allEventIds.length > 0
        ? supabase
            .from("events")
            .select(
              `
                id,
                slug,
                name,
                start_date,
                end_date,
                event_type,
                public_summary,
                public_cover_image_url,
                visibility,
                status
              `
            )
            .in("id", allEventIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

  if (studiosError) {
    throw new Error(`Failed to load favorite studios: ${studiosError.message}`);
  }

  if (eventsError) {
    throw new Error(`Failed to load events: ${eventsError.message}`);
  }

  const typedStudios = (studios ?? []) as StudioRow[];
  const typedEvents = (events ?? []) as EventRow[];

  const studiosById = new Map(typedStudios.map((studio) => [studio.id, studio]));
  const eventsById = new Map(typedEvents.map((event) => [event.id, event]));

  const favoriteStudios = studioIds
    .map((id) => studiosById.get(id))
    .filter((value): value is StudioRow => Boolean(value));

  const favoriteEvents = eventFavoriteIds
    .map((id) => eventsById.get(id))
    .filter((value): value is EventRow => Boolean(value));

  const registeredEvents = typedRegistrations
    .map((registration) => {
      const event = registration.event_id ? eventsById.get(registration.event_id) : undefined;
      if (!event) return null;
      return { registration, event };
    })
    .filter(
      (
        value
      ): value is {
        registration: EventRegistrationRow;
        event: EventRow;
      } => Boolean(value)
    );

  const displayName =
    user.user_metadata?.first_name ||
    user.user_metadata?.full_name ||
    user.email?.split("@")[0] ||
    "there";

  return (
    <>
      <PublicSiteHeader currentPath="account" isAuthenticated={!!user} />

      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_18%,#f8fafc_100%)]">
        <section className="border-b border-slate-200/70">
          <div className="mx-auto max-w-7xl px-6 py-14 lg:px-8">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
              My Account
            </p>

            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              Welcome back, {displayName}
            </h1>

            <p className="mt-4 max-w-3xl text-lg leading-8 text-slate-600">
              Keep track of your favorites, revisit events you registered for, and jump back into discovery.
            </p>

            <div className="mt-8 grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-orange-100 bg-white p-5 shadow-sm">
                <p className="text-sm text-slate-500">Favorite Studios</p>
                <p className="mt-2 text-3xl font-semibold text-slate-950">
                  {favoriteStudios.length}
                </p>
              </div>

              <div className="rounded-2xl border border-violet-100 bg-white p-5 shadow-sm">
                <p className="text-sm text-slate-500">Favorite Events</p>
                <p className="mt-2 text-3xl font-semibold text-slate-950">
                  {favoriteEvents.length}
                </p>
              </div>

              <div className="rounded-2xl border border-sky-100 bg-white p-5 shadow-sm">
                <p className="text-sm text-slate-500">Registered Events</p>
                <p className="mt-2 text-3xl font-semibold text-slate-950">
                  {registeredEvents.length}
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl space-y-8 px-6 py-8 lg:px-8">
          <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
                  Account Actions
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                  Quick links and account controls
                </h2>
              </div>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <Link
                href="/favorites"
                className="rounded-2xl border border-slate-200 bg-slate-50 p-5 hover:bg-slate-100"
              >
                <p className="font-medium text-slate-900">View Favorites</p>
                <p className="mt-1 text-sm text-slate-600">
                  Go straight to your saved studios and events.
                </p>
              </Link>

              <Link
                href="/discover/studios"
                className="rounded-2xl border border-slate-200 bg-slate-50 p-5 hover:bg-slate-100"
              >
                <p className="font-medium text-slate-900">Browse Studios</p>
                <p className="mt-1 text-sm text-slate-600">
                  Continue exploring public studio pages.
                </p>
              </Link>

              <Link
                href="/discover/events"
                className="rounded-2xl border border-slate-200 bg-slate-50 p-5 hover:bg-slate-100"
              >
                <p className="font-medium text-slate-900">Browse Events</p>
                <p className="mt-1 text-sm text-slate-600">
                  Discover classes, socials, and workshops.
                </p>
              </Link>

              <form action={signOutAction} className="rounded-2xl border border-rose-200 bg-rose-50 p-5">
                <p className="font-medium text-slate-900">Log Out</p>
                <p className="mt-1 text-sm text-slate-600">
                  Sign out of your free account on this device.
                </p>

                <button
                  type="submit"
                  className="mt-4 rounded-xl bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700"
                >
                  Log Out
                </button>
              </form>
            </div>
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-orange-600">
                  Favorite Studios
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                  Studios you want to keep up with
                </h2>
              </div>

              <Link
                href="/discover/studios"
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Discover More Studios
              </Link>
            </div>

            {favoriteStudios.length === 0 ? (
              <div className="mt-6 rounded-2xl border border-dashed border-slate-200 px-5 py-10 text-center">
                <p className="text-sm text-slate-600">
                  You have not favorited any studios yet.
                </p>
              </div>
            ) : (
              <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {favoriteStudios.map((studio) => (
                  <article
                    key={studio.id}
                    className="overflow-hidden rounded-2xl border border-slate-200 bg-white"
                  >
                    <div className="h-36 bg-slate-100">
                      {studio.public_logo_url ? (
                        <div className="flex h-full items-center justify-center p-6">
                          <img
                            src={studio.public_logo_url}
                            alt={studioTitle(studio)}
                            className="max-h-full max-w-full object-contain"
                          />
                        </div>
                      ) : (
                        <div className="flex h-full items-center justify-center bg-[linear-gradient(135deg,#f8fafc_0%,#fff7ed_100%)] text-sm text-slate-500">
                          Studio image coming soon
                        </div>
                      )}
                    </div>

                    <div className="space-y-3 p-5">
                      <div>
                        <h3 className="text-lg font-semibold text-slate-950">
                          {studioTitle(studio)}
                        </h3>
                        <p className="mt-1 text-sm text-slate-500">
                          {studioLocation(studio)}
                        </p>
                      </div>

                      {studio.beginner_friendly ? (
                        <span className="inline-flex rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-700">
                          Beginner Friendly
                        </span>
                      ) : null}

                      <p className="text-sm leading-6 text-slate-600">
                        {studio.public_short_description ||
                          "Explore this studio’s public profile and offerings."}
                      </p>

                      {studio.slug ? (
                        <Link
                          href={`/studios/${studio.slug}`}
                          className="inline-flex rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                        >
                          View Studio
                        </Link>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-violet-600">
                  Favorite Events
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                  Events you saved for later
                </h2>
              </div>

              <Link
                href="/discover/events"
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Discover More Events
              </Link>
            </div>

            {favoriteEvents.length === 0 ? (
              <div className="mt-6 rounded-2xl border border-dashed border-slate-200 px-5 py-10 text-center">
                <p className="text-sm text-slate-600">
                  You have not favorited any events yet.
                </p>
              </div>
            ) : (
              <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {favoriteEvents.map((event) => (
                  <article
                    key={event.id}
                    className="overflow-hidden rounded-2xl border border-slate-200 bg-white"
                  >
                    <div className="h-36 bg-slate-100">
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

                    <div className="space-y-3 p-5">
                      <div className="flex flex-wrap gap-2">
                        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700">
                          {eventTypeLabel(event.event_type)}
                        </span>
                        <span className="rounded-full bg-orange-50 px-3 py-1 text-xs text-orange-700">
                          {formatDateRange(event.start_date, event.end_date)}
                        </span>
                      </div>

                      <h3 className="text-lg font-semibold text-slate-950">
                        {event.name}
                      </h3>

                      <p className="text-sm leading-6 text-slate-600">
                        {event.public_summary || "Public event details coming soon."}
                      </p>

                      {event.slug ? (
                        <Link
                          href={`/events/${event.slug}`}
                          className="inline-flex rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                        >
                          View Event
                        </Link>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-sky-600">
                  Registered Events
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                  Events you already signed up for
                </h2>
              </div>

              <Link
                href="/discover/events"
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Find More Events
              </Link>
            </div>

            {registeredEvents.length === 0 ? (
              <div className="mt-6 rounded-2xl border border-dashed border-slate-200 px-5 py-10 text-center">
                <p className="text-sm text-slate-600">
                  You have not registered for any events yet.
                </p>
              </div>
            ) : (
              <div className="mt-6 grid gap-4">
                {registeredEvents.map(({ registration, event }) => (
                  <article
                    key={registration.id}
                    className="rounded-2xl border border-slate-200 bg-white p-5"
                  >
                    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                      <div>
                        <div className="flex flex-wrap gap-2">
                          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700">
                            {eventTypeLabel(event.event_type)}
                          </span>
                          <span className="rounded-full bg-sky-50 px-3 py-1 text-xs text-sky-700">
                            {registrationStatusLabel(registration.status)}
                          </span>
                          <span className="rounded-full bg-orange-50 px-3 py-1 text-xs text-orange-700">
                            {formatDateRange(event.start_date, event.end_date)}
                          </span>
                        </div>

                        <h3 className="mt-3 text-lg font-semibold text-slate-950">
                          {event.name}
                        </h3>

                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          {event.public_summary || "Public event details coming soon."}
                        </p>
                      </div>

                      {event.slug ? (
                        <Link
                          href={`/events/${event.slug}`}
                          className="inline-flex rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                        >
                          View Event
                        </Link>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}