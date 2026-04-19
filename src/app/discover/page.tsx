import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

type StudioPreviewRow = {
  id: string;
  slug: string | null;
  public_name: string | null;
  name: string;
  city: string | null;
  state: string | null;
  public_short_description: string | null;
  public_logo_url: string | null;
  public_hero_image_url: string | null;
  beginner_friendly: boolean;
};

type EventPreviewRow = {
  id: string;
  slug: string | null;
  name: string;
  start_date: string | null;
  public_summary: string | null;
  public_cover_image_url: string | null;
  beginner_friendly: boolean;
  studio_id: string | null;
};

type StudioHostRow = {
  id: string;
  slug: string | null;
  public_name: string | null;
  name: string;
  city: string | null;
  state: string | null;
};

function studioTitle(studio: {
  public_name: string | null;
  name: string;
}) {
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

function locationLabel(city: string | null, state: string | null) {
  const parts = [city, state].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "Location coming soon";
}

export default async function DiscoverLandingPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [
    studioCountResult,
    eventCountResult,
    { data: featuredStudios, error: featuredStudiosError },
    { data: featuredEvents, error: featuredEventsError },
    { data: hostStudios, error: hostStudiosError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("*", { count: "exact", head: true })
      .eq("public_directory_enabled", true),

    supabase
      .from("events")
      .select("*", { count: "exact", head: true })
      .eq("visibility", "public")
      .eq("public_directory_enabled", true)
      .in("status", ["published", "open"]),

    supabase
      .from("studios")
      .select(`
        id,
        slug,
        public_name,
        name,
        city,
        state,
        public_short_description,
        public_logo_url,
        public_hero_image_url,
        beginner_friendly
      `)
      .eq("public_directory_enabled", true)
      .order("beginner_friendly", { ascending: false })
      .order("public_name", { ascending: true })
      .limit(6),

    supabase
      .from("events")
      .select(`
        id,
        slug,
        name,
        start_date,
        public_summary,
        public_cover_image_url,
        beginner_friendly,
        studio_id
      `)
      .eq("visibility", "public")
      .eq("public_directory_enabled", true)
      .in("status", ["published", "open"])
      .order("start_date", { ascending: true })
      .limit(6),

    supabase
      .from("studios")
      .select(`
        id,
        slug,
        public_name,
        name,
        city,
        state
      `),
  ]);

  if (featuredStudiosError) {
    throw new Error(`Failed to load featured studios: ${featuredStudiosError.message}`);
  }

  if (featuredEventsError) {
    throw new Error(`Failed to load featured events: ${featuredEventsError.message}`);
  }

  if (hostStudiosError) {
    throw new Error(`Failed to load host studios: ${hostStudiosError.message}`);
  }

  const publicStudioCount = studioCountResult.count ?? 0;
  const publicEventCount = eventCountResult.count ?? 0;

  const typedFeaturedStudios = (featuredStudios ?? []) as StudioPreviewRow[];
  const typedFeaturedEvents = (featuredEvents ?? []) as EventPreviewRow[];
  const typedHostStudios = (hostStudios ?? []) as StudioHostRow[];

  const hostStudioById = new Map(typedHostStudios.map((studio) => [studio.id, studio]));

  return (
    <main className="min-h-screen bg-slate-50">
      <section className="border-b bg-white">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:py-24">
          <div className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                Discover Dance
              </p>

              <h1 className="mt-4 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl lg:text-6xl">
                {user
                  ? "Welcome back — keep discovering dance near you"
                  : "Make DanceFlow the front door to dance"}
              </h1>

              <p className="mt-5 max-w-3xl text-lg text-slate-600">
                Search studios, explore events, and discover your next step into
                dance from one public directory built for new dancers, returning
                dancers, and growing communities.
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  href="/discover/studios"
                  className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-slate-800"
                >
                  Find Studios
                </Link>

                <Link
                  href="/discover/events"
                  className="rounded-xl border bg-white px-5 py-3 text-sm font-medium hover:bg-slate-50"
                >
                  Find Events
                </Link>

                {!user ? (
                  <Link
                    href="/signup"
                    className="rounded-xl border bg-white px-5 py-3 text-sm font-medium hover:bg-slate-50"
                  >
                    Create Free Account
                  </Link>
                ) : null}
              </div>

              <div className="mt-10 grid gap-4 sm:grid-cols-3">
                <div className="rounded-2xl border bg-slate-50 p-5">
                  <p className="text-sm text-slate-500">Public Studios</p>
                  <p className="mt-2 text-3xl font-semibold text-slate-900">
                    {publicStudioCount}
                  </p>
                </div>

                <div className="rounded-2xl border bg-slate-50 p-5">
                  <p className="text-sm text-slate-500">Public Events</p>
                  <p className="mt-2 text-3xl font-semibold text-slate-900">
                    {publicEventCount}
                  </p>
                </div>

                <div className="rounded-2xl border bg-slate-50 p-5">
                  <p className="text-sm text-slate-500">Best For</p>
                  <p className="mt-2 text-lg font-semibold text-slate-900">
                    New dancers and returning dancers
                  </p>
                </div>
              </div>

              {user ? (
                <div className="mt-6 rounded-2xl border border-green-200 bg-green-50 px-4 py-4 text-sm text-green-800">
                  You are signed in with a free account. This side of DanceFlow
                  stays open for browsing even without a studio workspace.
                </div>
              ) : null}
            </div>

            <div className="overflow-hidden rounded-[32px] border bg-[linear-gradient(135deg,#f8fafc_0%,#fff7ed_100%)] p-8 shadow-sm">
              <div className="rounded-3xl border bg-white p-6 shadow-sm">
                <p className="text-sm font-semibold uppercase tracking-[0.14em] text-[var(--brand-accent-dark)]">
                  Start Here
                </p>

                <div className="mt-5 space-y-4">
                  <Link
                    href="/discover/studios?beginner=1"
                    className="block rounded-2xl border bg-slate-50 px-4 py-4 hover:bg-slate-100"
                  >
                    <p className="font-medium text-slate-900">I am brand new to dance</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Find beginner-friendly studios and intro lesson options.
                    </p>
                  </Link>

                  <Link
                    href="/discover/events"
                    className="block rounded-2xl border bg-slate-50 px-4 py-4 hover:bg-slate-100"
                  >
                    <p className="font-medium text-slate-900">I want to find an event</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Browse workshops, socials, classes, and public dance events.
                    </p>
                  </Link>

                  <Link
                    href="/discover/studios?offering=private_lessons"
                    className="block rounded-2xl border bg-slate-50 px-4 py-4 hover:bg-slate-100"
                  >
                    <p className="font-medium text-slate-900">I want private lessons</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Explore studios offering one-on-one instruction and coaching.
                    </p>
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-12">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.14em] text-[var(--brand-accent-dark)]">
              Featured Studios
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
              Explore public studio profiles
            </h2>
            <p className="mt-2 max-w-3xl text-slate-600">
              Learn about studios, offerings, and instructor teams before you ever walk through the door.
            </p>
          </div>

          <Link href="/discover/studios" className="text-sm font-medium underline">
            Browse all studios
          </Link>
        </div>

        {typedFeaturedStudios.length === 0 ? (
          <div className="mt-8 rounded-3xl border bg-white px-6 py-16 text-center shadow-sm">
            <h3 className="text-xl font-semibold text-slate-900">Studios coming soon</h3>
            <p className="mt-2 text-slate-600">
              Public studio listings will appear here as studios publish their profiles.
            </p>
          </div>
        ) : (
          <div className="mt-8 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {typedFeaturedStudios.map((studio) => (
              <article
                key={studio.id}
                className="overflow-hidden rounded-3xl border bg-white shadow-sm"
              >
                <div className="h-48 bg-slate-100">
                  {studio.public_hero_image_url ? (
                    <img
                      src={studio.public_hero_image_url}
                      alt={studioTitle(studio)}
                      className="h-full w-full object-cover"
                    />
                  ) : studio.public_logo_url ? (
                    <div className="flex h-full items-center justify-center bg-[linear-gradient(135deg,#f8fafc_0%,#fff7ed_100%)] p-8">
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

                <div className="space-y-4 p-6">
                  <div className="flex flex-wrap items-center gap-2">
                    {studio.beginner_friendly ? (
                      <span className="inline-flex rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-700">
                        Beginner Friendly
                      </span>
                    ) : null}

                    <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                      {locationLabel(studio.city, studio.state)}
                    </span>
                  </div>

                  <div>
                    <h3 className="text-xl font-semibold text-slate-900">
                      {studioTitle(studio)}
                    </h3>
                    <p className="mt-2 text-sm text-slate-600">
                      {studio.public_short_description ||
                        "Explore this studio’s public profile, offerings, and instructor team."}
                    </p>
                  </div>

                  {studio.slug ? (
                    <Link
                      href={`/studios/${studio.slug}`}
                      className="inline-flex rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
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

      <section className="border-y bg-white">
        <div className="mx-auto max-w-7xl px-6 py-12">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.14em] text-[var(--brand-accent-dark)]">
                Featured Events
              </p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
                Find your next class, social, or workshop
              </h2>
              <p className="mt-2 max-w-3xl text-slate-600">
                Browse public events and jump straight into event details or the hosting studio.
              </p>
            </div>

            <Link href="/discover/events" className="text-sm font-medium underline">
              Browse all events
            </Link>
          </div>

          {typedFeaturedEvents.length === 0 ? (
            <div className="mt-8 rounded-3xl border bg-slate-50 px-6 py-16 text-center">
              <h3 className="text-xl font-semibold text-slate-900">Events coming soon</h3>
              <p className="mt-2 text-slate-600">
                Public event listings will appear here as studios and organizers publish them.
              </p>
            </div>
          ) : (
            <div className="mt-8 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
              {typedFeaturedEvents.map((event) => {
                const hostStudio = event.studio_id
                  ? hostStudioById.get(event.studio_id)
                  : undefined;

                return (
                  <article
                    key={event.id}
                    className="overflow-hidden rounded-3xl border bg-slate-50"
                  >
                    <div className="h-44 bg-slate-100">
                      {event.public_cover_image_url ? (
                        <img
                          src={event.public_cover_image_url}
                          alt={event.name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center bg-[linear-gradient(135deg,#f8fafc_0%,#fff7ed_100%)] text-sm text-slate-500">
                          Event image coming soon
                        </div>
                      )}
                    </div>

                    <div className="space-y-4 p-6">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex rounded-full bg-orange-50 px-3 py-1 text-xs font-medium text-orange-700">
                          {formatDate(event.start_date)}
                        </span>

                        {event.beginner_friendly ? (
                          <span className="inline-flex rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-700">
                            Beginner Friendly
                          </span>
                        ) : null}
                      </div>

                      <div>
                        <h3 className="text-xl font-semibold text-slate-900">{event.name}</h3>
                        <p className="mt-1 text-sm text-slate-500">
                          {hostStudio
                            ? `${studioTitle(hostStudio)} • ${locationLabel(
                                hostStudio.city,
                                hostStudio.state
                              )}`
                            : "Host coming soon"}
                        </p>
                        <p className="mt-2 text-sm text-slate-600">
                          {event.public_summary ||
                            "Explore this event and discover the hosting studio."}
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-3">
                        {event.slug ? (
                          <Link
                            href={`/events/${event.slug}`}
                            className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
                          >
                            View Event
                          </Link>
                        ) : (
                          <span className="rounded-xl bg-slate-200 px-4 py-2 text-sm text-slate-500">
                            Event details coming soon
                          </span>
                        )}

                        {hostStudio?.slug ? (
                          <Link
                            href={`/studios/${hostStudio.slug}`}
                            className="rounded-xl border bg-white px-4 py-2 text-sm hover:bg-slate-50"
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
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-12">
        <div className="rounded-[32px] border bg-white p-8 shadow-sm">
          <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.14em] text-[var(--brand-accent-dark)]">
                Why DanceFlow
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900">
                A true front door into dance
              </h2>
              <p className="mt-3 max-w-3xl text-slate-600">
                Instead of hunting across scattered sites and social posts, dancers can discover studios,
                events, and next steps in one place.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/discover/studios?beginner=1"
                className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-slate-800"
              >
                Start with Beginner Studios
              </Link>

              <Link
                href="/discover/events"
                className="rounded-xl border px-5 py-3 text-sm font-medium hover:bg-slate-50"
              >
                Explore Events
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}