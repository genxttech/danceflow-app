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

function studioTitle(studio: {
  public_name: string | null;
  name: string;
}) {
  return studio.public_name?.trim() || studio.name;
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
  ]);

  if (featuredStudiosError) {
    throw new Error(`Failed to load featured studios: ${featuredStudiosError.message}`);
  }

  const publicStudioCount = studioCountResult.count ?? 0;
  const publicEventCount = eventCountResult.count ?? 0;
  const typedFeaturedStudios = (featuredStudios ?? []) as StudioPreviewRow[];

  return (
    <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#f8fafc_34%,#ffffff_100%)] text-slate-900">
      <section className="relative overflow-hidden border-b border-[var(--brand-border)] bg-white">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(251,146,60,0.22),transparent_34%),radial-gradient(circle_at_top_right,rgba(75,46,131,0.16),transparent_30%)]" />
        <div className="relative mx-auto max-w-7xl px-6 py-16 lg:py-24">
          <div className="grid gap-10 lg:grid-cols-[1.08fr_0.92fr] lg:items-center">
            <div>
              <div className="inline-flex items-center rounded-full border border-[var(--brand-border)] bg-white/80 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-[var(--brand-accent-dark)] shadow-sm">
                DanceFlow Discovery
              </div>

              <h1 className="mt-5 max-w-4xl text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl lg:text-6xl">
                {user
                  ? "Welcome back — keep discovering dance near you"
                  : "Find studios, events, and your next step into dance"}
              </h1>

              <p className="mt-5 max-w-3xl text-lg leading-8 text-slate-600">
                Search studios, explore public events, and discover beginner-friendly
                opportunities from one clean directory built for dancers and the
                communities that serve them.
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  href="/discover/studios"
                  className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
                >
                  Find Studios
                </Link>

                <Link
                  href="/discover/events"
                  className="rounded-2xl border border-[var(--brand-border)] bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow-sm hover:bg-slate-50"
                >
                  Browse Events
                </Link>

                {!user ? (
                  <Link
                    href="/signup"
                    className="rounded-2xl border border-[var(--brand-border)] bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow-sm hover:bg-slate-50"
                  >
                    Create Free Account
                  </Link>
                ) : null}
              </div>

              <div className="mt-10 grid gap-4 sm:grid-cols-3">
                <div className="rounded-3xl border border-[var(--brand-border)] bg-white/80 p-5 shadow-sm">
                  <p className="text-sm font-medium text-slate-500">Public Studios</p>
                  <p className="mt-2 text-3xl font-semibold text-slate-950">
                    {publicStudioCount}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">Published profiles</p>
                </div>

                <div className="rounded-3xl border border-[var(--brand-border)] bg-white/80 p-5 shadow-sm">
                  <p className="text-sm font-medium text-slate-500">Public Events</p>
                  <p className="mt-2 text-3xl font-semibold text-slate-950">
                    {publicEventCount}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">Open listings</p>
                </div>

                <div className="rounded-3xl border border-[var(--brand-border)] bg-white/80 p-5 shadow-sm">
                  <p className="text-sm font-medium text-slate-500">Best For</p>
                  <p className="mt-2 text-lg font-semibold text-slate-950">
                    New and returning dancers
                  </p>
                  <p className="mt-1 text-xs text-slate-500">Simple first steps</p>
                </div>
              </div>

              {user ? (
                <div className="mt-6 rounded-3xl border border-green-200 bg-green-50 px-5 py-4 text-sm text-green-800 shadow-sm">
                  You are signed in with a free account. Discovery stays open for
                  browsing even without a studio workspace.
                </div>
              ) : null}
            </div>

            <div className="overflow-hidden rounded-[34px] border border-[var(--brand-border)] bg-white p-4 shadow-sm">
              <div className="rounded-[28px] bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] p-6 text-white shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                  Start Here
                </p>
                <h2 className="mt-3 text-2xl font-semibold">What are you looking for?</h2>
                <p className="mt-2 text-sm leading-6 text-white/75">
                  Choose the path that fits what you want to do next. Discovery is
                  designed to reduce searching and help dancers take action.
                </p>

                <div className="mt-6 space-y-3">
                  <Link
                    href="/discover/studios?beginner=1"
                    className="block rounded-2xl border border-white/15 bg-white/10 px-4 py-4 text-white backdrop-blur hover:bg-white/15"
                  >
                    <p className="font-semibold">I am brand new to dance</p>
                    <p className="mt-1 text-sm text-white/75">
                      Find beginner-friendly studios and intro lesson options.
                    </p>
                  </Link>

                  <Link
                    href="/discover/events"
                    className="block rounded-2xl border border-white/15 bg-white/10 px-4 py-4 text-white backdrop-blur hover:bg-white/15"
                  >
                    <p className="font-semibold">I want to find an event</p>
                    <p className="mt-1 text-sm text-white/75">
                      Browse workshops, socials, classes, and public dance events.
                    </p>
                  </Link>

                  <Link
                    href="/discover/studios?offering=private_lessons"
                    className="block rounded-2xl border border-white/15 bg-white/10 px-4 py-4 text-white backdrop-blur hover:bg-white/15"
                  >
                    <p className="font-semibold">I want private lessons</p>
                    <p className="mt-1 text-sm text-white/75">
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
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
              Studio Directory
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
              Explore public studio profiles
            </h2>
            <p className="mt-2 max-w-3xl text-slate-600">
              Learn about studios, offerings, and instructor teams before you ever
              walk through the door.
            </p>
          </div>

          <Link
            href="/discover/studios"
            className="inline-flex rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2 text-sm font-semibold shadow-sm hover:bg-slate-50"
          >
            Browse all studios
          </Link>
        </div>

        {typedFeaturedStudios.length === 0 ? (
          <div className="mt-8 rounded-[32px] border border-[var(--brand-border)] bg-white px-6 py-16 text-center shadow-sm">
            <h3 className="text-xl font-semibold text-slate-950">Studios coming soon</h3>
            <p className="mt-2 text-slate-600">
              Public studio listings will appear here as studios publish their profiles.
            </p>
          </div>
        ) : (
          <div className="mt-8 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {typedFeaturedStudios.map((studio) => (
              <article
                key={studio.id}
                className="overflow-hidden rounded-[30px] border border-[var(--brand-border)] bg-white shadow-sm"
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
                      <span className="inline-flex rounded-full bg-green-50 px-3 py-1 text-xs font-semibold text-green-700">
                        Beginner Friendly
                      </span>
                    ) : null}

                    <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                      {locationLabel(studio.city, studio.state)}
                    </span>
                  </div>

                  <div>
                    <h3 className="text-xl font-semibold text-slate-950">
                      {studioTitle(studio)}
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      {studio.public_short_description ||
                        "Explore this studio’s public profile, offerings, and instructor team."}
                    </p>
                  </div>

                  {studio.slug ? (
                    <Link
                      href={`/studios/${studio.slug}`}
                      className="inline-flex rounded-2xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
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

      <section className="border-y border-[var(--brand-border)] bg-white/80">
        <div className="mx-auto max-w-7xl px-6 py-12">
          <div className="overflow-hidden rounded-[34px] border border-[var(--brand-border)] bg-white shadow-sm">
            <div className="grid gap-0 lg:grid-cols-[0.92fr_1.08fr]">
              <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] p-8 text-white md:p-10">
                <span className="inline-flex rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-white/80">
                  Coming Soon
                </span>
                <p className="mt-5 text-sm font-semibold uppercase tracking-[0.22em] text-white/65">
                  Featured Events
                </p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight">
                  Highlighted events without a crowded discovery page
                </h2>
                <p className="mt-4 max-w-2xl text-sm leading-7 text-white/78">
                  We’re preparing a highlighted event section to help dancers find
                  timely workshops, socials, competitions, and special events without
                  making discovery feel overwhelming.
                </p>
              </div>

              <div className="p-8 md:p-10">
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="rounded-3xl border border-[var(--brand-border)] bg-slate-50 p-5">
                    <p className="text-sm font-semibold text-slate-950">Workshops</p>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      Timely learning opportunities from studios and organizers.
                    </p>
                  </div>
                  <div className="rounded-3xl border border-[var(--brand-border)] bg-slate-50 p-5">
                    <p className="text-sm font-semibold text-slate-950">Socials</p>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      Community dance nights, parties, and practice events.
                    </p>
                  </div>
                  <div className="rounded-3xl border border-[var(--brand-border)] bg-slate-50 p-5">
                    <p className="text-sm font-semibold text-slate-950">Competitions</p>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      Larger public events worth planning ahead for.
                    </p>
                  </div>
                </div>

                <p className="mt-6 text-sm leading-6 text-slate-600">
                  For launch, browse all public events below. Boosted event placement
                  will be added later as a clear, limited, and labeled promotion option.
                </p>

                <div className="mt-6 flex flex-wrap gap-3">
                  <Link
                    href="/discover/events"
                    className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800"
                  >
                    Browse Events
                  </Link>
                  <Link
                    href="/discover/studios"
                    className="rounded-2xl border border-[var(--brand-border)] bg-white px-5 py-3 text-sm font-semibold hover:bg-slate-50"
                  >
                    Find Studios
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-12">
        <div className="rounded-[34px] border border-[var(--brand-border)] bg-white p-8 shadow-sm md:p-10">
          <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                Why DanceFlow
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                A true front door into dance
              </h2>
              <p className="mt-3 max-w-3xl leading-7 text-slate-600">
                Instead of hunting across scattered sites and social posts, dancers
                can discover studios, events, and next steps in one place.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/discover/studios?beginner=1"
                className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800"
              >
                Start with Beginner Studios
              </Link>

              <Link
                href="/discover/events"
                className="rounded-2xl border border-[var(--brand-border)] px-5 py-3 text-sm font-semibold hover:bg-slate-50"
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
