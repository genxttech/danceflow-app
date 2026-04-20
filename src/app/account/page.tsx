import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type FavoriteRow = {
  studio_id: string | null;
  event_id: string | null;
  created_at: string;
};

type RegistrationRow = {
  id: string;
  event_id: string | null;
  status: string | null;
  created_at: string;
};

type StudioRow = {
  id: string;
  slug: string | null;
  name: string;
  public_name: string | null;
  city: string | null;
  state: string | null;
};

type EventRow = {
  id: string;
  slug: string | null;
  title: string;
  starts_at: string | null;
  city: string | null;
  state: string | null;
};

type PortalLinkRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  is_independent_instructor: boolean | null;
  studios:
    | {
        id: string;
        slug: string | null;
        name: string;
        public_name: string | null;
        city: string | null;
        state: string | null;
      }
    | {
        id: string;
        slug: string | null;
        name: string;
        public_name: string | null;
        city: string | null;
        state: string | null;
      }[]
    | null;
};

function formatDate(value: string | null) {
  if (!value) return "Date coming soon";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function getEventLocation(event: EventRow) {
  return [event.city, event.state].filter(Boolean).join(", ") || "Location coming soon";
}

function getStudioLocation(studio: StudioRow) {
  return [studio.city, studio.state].filter(Boolean).join(", ") || "Location coming soon";
}

function getPortalStudio(
  value: PortalLinkRow["studios"]
):
  | {
      id: string;
      slug: string | null;
      name: string;
      public_name: string | null;
      city: string | null;
      state: string | null;
    }
  | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export default async function AccountPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [
    { data: favorites, error: favoritesError },
    { data: registrations, error: registrationsError },
    { data: portalLinks, error: portalLinksError },
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

    supabase
      .from("clients")
      .select(`
        id,
        first_name,
        last_name,
        is_independent_instructor,
        studios (
          id,
          slug,
          name,
          public_name,
          city,
          state
        )
      `)
      .eq("portal_user_id", user.id)
      .order("created_at", { ascending: false }),
  ]);

  if (favoritesError) {
    throw new Error(`Failed to load favorites: ${favoritesError.message}`);
  }

  if (registrationsError) {
    throw new Error(`Failed to load registrations: ${registrationsError.message}`);
  }

  if (portalLinksError) {
    throw new Error(`Failed to load studio portals: ${portalLinksError.message}`);
  }

  const typedFavorites = (favorites ?? []) as FavoriteRow[];
  const typedRegistrations = (registrations ?? []) as RegistrationRow[];
  const typedPortalLinks = (portalLinks ?? []) as PortalLinkRow[];

  const favoriteStudioIds = Array.from(
    new Set(typedFavorites.map((row) => row.studio_id).filter(Boolean))
  ) as string[];

  const favoriteEventIds = Array.from(
    new Set(typedFavorites.map((row) => row.event_id).filter(Boolean))
  ) as string[];

  const registrationEventIds = Array.from(
    new Set(typedRegistrations.map((row) => row.event_id).filter(Boolean))
  ) as string[];

  const allEventIds = Array.from(new Set([...favoriteEventIds, ...registrationEventIds]));

  const [
    { data: favoriteStudios, error: favoriteStudiosError },
    { data: relatedEvents, error: relatedEventsError },
  ] = await Promise.all([
    favoriteStudioIds.length
      ? supabase
          .from("studios")
          .select("id, slug, name, public_name, city, state")
          .in("id", favoriteStudioIds)
      : Promise.resolve({ data: [], error: null }),

    allEventIds.length
      ? supabase
          .from("events")
          .select("id, slug, title, starts_at, city, state")
          .in("id", allEventIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (favoriteStudiosError) {
    throw new Error(`Failed to load favorite studios: ${favoriteStudiosError.message}`);
  }

  if (relatedEventsError) {
    throw new Error(`Failed to load events: ${relatedEventsError.message}`);
  }

  const typedFavoriteStudios = (favoriteStudios ?? []) as StudioRow[];
  const typedRelatedEvents = (relatedEvents ?? []) as EventRow[];

  const studiosById = new Map(typedFavoriteStudios.map((studio) => [studio.id, studio]));
  const eventsById = new Map(typedRelatedEvents.map((event) => [event.id, event]));

  const favoriteStudiosList = typedFavorites
    .filter((row) => row.studio_id)
    .map((row) => {
      const studio = studiosById.get(row.studio_id!);
      if (!studio) return null;

      return {
        studio,
        createdAt: row.created_at,
      };
    })
    .filter(
      (
        value
      ): value is {
        studio: StudioRow;
        createdAt: string;
      } => Boolean(value)
    );

  const favoriteEventsList = typedFavorites
    .filter((row) => row.event_id)
    .map((row) => {
      const event = eventsById.get(row.event_id!);
      if (!event) return null;

      return {
        event,
        createdAt: row.created_at,
      };
    })
    .filter(
      (
        value
      ): value is {
        event: EventRow;
        createdAt: string;
      } => Boolean(value)
    );

  const registeredEventsList = typedRegistrations
    .map((row) => {
      const event = row.event_id ? eventsById.get(row.event_id) : null;
      if (!event) return null;

      return {
        registrationId: row.id,
        status: row.status ?? "registered",
        createdAt: row.created_at,
        event,
      };
    })
    .filter(
      (
        value
      ): value is {
        registrationId: string;
        status: string;
        createdAt: string;
        event: EventRow;
      } => Boolean(value)
    );

  const linkedPortals = typedPortalLinks
    .map((row) => {
      const studio = getPortalStudio(row.studios);
      if (!studio?.slug) return null;

      return {
        clientId: row.id,
        studioId: studio.id,
        studioSlug: studio.slug,
        studioName: studio.public_name?.trim() || studio.name,
        location: [studio.city, studio.state].filter(Boolean).join(", ") || "Location coming soon",
        isIndependentInstructor: Boolean(row.is_independent_instructor),
        clientName: `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "Portal Member",
      };
    })
    .filter(
      (
        value
      ): value is {
        clientId: string;
        studioId: string;
        studioSlug: string;
        studioName: string;
        location: string;
        isIndependentInstructor: boolean;
        clientName: string;
      } => Boolean(value)
    );

  const firstPortalName =
    linkedPortals.map((row) => row.clientName).find(Boolean) || null;

  const displayName =
    user.user_metadata?.full_name ||
    user.user_metadata?.first_name ||
    firstPortalName ||
    user.email?.split("@")[0] ||
    "there";

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <section className="overflow-hidden rounded-[36px] border border-slate-200 bg-[linear-gradient(135deg,#fff7ed_0%,#ffffff_42%,#f8fafc_100%)] p-8 shadow-sm sm:p-10">
          <div className="grid gap-8 xl:grid-cols-[1.2fr_0.8fr]">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-600">
                My Account
              </p>
              <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
                Welcome back, {displayName}
              </h1>
              <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600 sm:text-base">
                This is your public account home. Your favorites and event registrations stay here.
                If a studio links your account, your studio portals will appear here as separate destinations without replacing your public account.
              </p>

              <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-2xl border border-orange-100 bg-white p-5 shadow-sm">
                  <p className="text-sm text-slate-500">Favorite Studios</p>
                  <p className="mt-2 text-3xl font-semibold text-slate-950">
                    {favoriteStudiosList.length}
                  </p>
                </div>

                <div className="rounded-2xl border border-orange-100 bg-white p-5 shadow-sm">
                  <p className="text-sm text-slate-500">Favorite Events</p>
                  <p className="mt-2 text-3xl font-semibold text-slate-950">
                    {favoriteEventsList.length}
                  </p>
                </div>

                <div className="rounded-2xl border border-orange-100 bg-white p-5 shadow-sm">
                  <p className="text-sm text-slate-500">Registered Events</p>
                  <p className="mt-2 text-3xl font-semibold text-slate-950">
                    {registeredEventsList.length}
                  </p>
                </div>

                <div className="rounded-2xl border border-emerald-100 bg-white p-5 shadow-sm">
                  <p className="text-sm text-slate-500">Studio Portals</p>
                  <p className="mt-2 text-3xl font-semibold text-slate-950">
                    {linkedPortals.length}
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-[28px] border border-slate-200 bg-white/90 p-6 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
                Account Actions
              </p>

              <div className="mt-5 grid gap-3">
                {linkedPortals.length > 0 ? (
                  <Link
                    href={`/portal/${linkedPortals[0].studioSlug}`}
                    className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 hover:bg-emerald-100"
                  >
                    <p className="font-medium text-slate-900">Open Studio Portal</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Jump into your linked studio portal access.
                    </p>
                  </Link>
                ) : null}

                <Link
                  href="/discover"
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-5 hover:bg-slate-100"
                >
                  <p className="font-medium text-slate-900">Explore Studios & Events</p>
                  <p className="mt-1 text-sm text-slate-600">
                    Discover studios, events, and new opportunities near you.
                  </p>
                </Link>

                <form action="/auth/logout" method="post">
                  <button
                    type="submit"
                    className="w-full rounded-2xl border border-slate-200 bg-white p-5 text-left hover:bg-slate-50"
                  >
                    <p className="font-medium text-slate-900">Log Out</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Sign out of your public account and any linked studio portals.
                    </p>
                  </button>
                </form>
              </div>

              <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Signed in as
                </p>
                <p className="mt-2 text-sm font-medium text-slate-900">
                  {user.email || "No email found"}
                </p>
              </div>
            </div>
          </div>
        </section>

        <div className="mt-8 space-y-8">
          <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-emerald-700">
                  My Studio Portals
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                  Studio-linked portal access
                </h2>
                <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
                  Your public account stays separate from your studio portals. Favorites and event registrations live here, while each studio portal gives you access to that studio’s client experience.
                </p>
              </div>
            </div>

            {linkedPortals.length === 0 ? (
              <div className="mt-6 rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
                <p className="text-lg font-medium text-slate-900">No linked studio portals yet</p>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  When a studio links your account or sends you a portal invite, your studio portals will appear here.
                </p>
              </div>
            ) : (
              <div className="mt-6 grid gap-4 lg:grid-cols-2">
                {linkedPortals.map((portal) => (
                  <Link
                    key={`${portal.studioId}-${portal.clientId}`}
                    href={`/portal/${portal.studioSlug}`}
                    className="rounded-3xl border border-emerald-200 bg-emerald-50 p-6 shadow-sm transition hover:bg-emerald-100"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-lg font-semibold text-slate-950">
                          {portal.studioName}
                        </p>
                        <p className="mt-1 text-sm text-slate-600">{portal.location}</p>
                      </div>

                      <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200">
                        {portal.isIndependentInstructor
                          ? "Independent Instructor"
                          : "Client Portal"}
                      </span>
                    </div>

                    <p className="mt-4 text-sm text-slate-700">
                      Signed in as {portal.clientName}
                    </p>
                    <p className="mt-2 text-sm text-slate-600">
                      Open this studio’s private portal for lessons, memberships, rentals, and studio-specific access.
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-orange-600">
                  Favorite Studios
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                  Studios you want to keep nearby
                </h2>
                <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
                  Your public favorites stay attached to this account, even when studio portal access is added later.
                </p>
              </div>
            </div>

            {favoriteStudiosList.length === 0 ? (
              <div className="mt-6 rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
                <p className="text-lg font-medium text-slate-900">No favorite studios yet</p>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Favorite studios from discovery will appear here.
                </p>
              </div>
            ) : (
              <div className="mt-6 grid gap-4 lg:grid-cols-2">
                {favoriteStudiosList.map(({ studio }) => (
                  <Link
                    key={studio.id}
                    href={studio.slug ? `/studios/${studio.slug}` : "/discover"}
                    className="rounded-3xl border border-slate-200 bg-slate-50 p-6 shadow-sm transition hover:bg-white"
                  >
                    <p className="text-lg font-semibold text-slate-950">
                      {studio.public_name?.trim() || studio.name}
                    </p>
                    <p className="mt-1 text-sm text-slate-600">{getStudioLocation(studio)}</p>
                    <p className="mt-4 text-sm text-slate-600">
                      Open the public studio page.
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-violet-700">
                  Favorite Events
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                  Events you are tracking
                </h2>
                <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
                  Saved public events stay tied to your account, not to a specific studio portal.
                </p>
              </div>
            </div>

            {favoriteEventsList.length === 0 ? (
              <div className="mt-6 rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
                <p className="text-lg font-medium text-slate-900">No favorite events yet</p>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Favorite events from discovery will appear here.
                </p>
              </div>
            ) : (
              <div className="mt-6 grid gap-4 lg:grid-cols-2">
                {favoriteEventsList.map(({ event }) => (
                  <Link
                    key={event.id}
                    href={event.slug ? `/events/${event.slug}` : "/discover/events"}
                    className="rounded-3xl border border-slate-200 bg-slate-50 p-6 shadow-sm transition hover:bg-white"
                  >
                    <p className="text-lg font-semibold text-slate-950">{event.title}</p>
                    <p className="mt-1 text-sm text-slate-600">
                      {formatDate(event.starts_at)} • {getEventLocation(event)}
                    </p>
                    <p className="mt-4 text-sm text-slate-600">
                      Open the public event page.
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-sky-700">
                  Registered Events
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                  Events you have registered for
                </h2>
                <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
                  Your public event registrations stay with this account even after a studio portal is linked.
                </p>
              </div>
            </div>

            {registeredEventsList.length === 0 ? (
              <div className="mt-6 rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
                <p className="text-lg font-medium text-slate-900">No event registrations yet</p>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Public event registrations will appear here.
                </p>
              </div>
            ) : (
              <div className="mt-6 grid gap-4 lg:grid-cols-2">
                {registeredEventsList.map(({ registrationId, status, event }) => (
                  <Link
                    key={registrationId}
                    href={event.slug ? `/events/${event.slug}` : "/discover/events"}
                    className="rounded-3xl border border-slate-200 bg-slate-50 p-6 shadow-sm transition hover:bg-white"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-lg font-semibold text-slate-950">{event.title}</p>
                        <p className="mt-1 text-sm text-slate-600">
                          {formatDate(event.starts_at)} • {getEventLocation(event)}
                        </p>
                      </div>

                      <span className="rounded-full bg-sky-50 px-3 py-1 text-xs font-medium text-sky-700 ring-1 ring-sky-100">
                        {status.replaceAll("_", " ")}
                      </span>
                    </div>

                    <p className="mt-4 text-sm text-slate-600">
                      Open the public registration event page.
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}