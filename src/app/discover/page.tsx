import Link from "next/link";
import {
  ArrowRight,
  BriefcaseBusiness,
  CalendarDays,
  GraduationCap,
  MapPinned,
  Sparkles,
  UsersRound,
} from "lucide-react";
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


const discoveryPaths = [
  {
    title: "Find a Studio",
    description:
      "Explore welcoming studio profiles, specialties, instructors, and beginner-friendly options near you.",
    href: "/discover/studios",
    cta: "Explore studios",
    icon: MapPinned,
    shell: "from-violet-600 to-purple-800",
    glow: "bg-violet-300/30",
  },
  {
    title: "Discover Events",
    description:
      "Find socials, workshops, classes, competitions, and special dance experiences worth planning for.",
    href: "/discover/events",
    cta: "Browse events",
    icon: CalendarDays,
    shell: "from-orange-500 to-rose-600",
    glow: "bg-orange-200/30",
  },
  {
    title: "Meet Dance Partners",
    description:
      "Connect with dancers looking for practice, social dancing, showcases, or competition partnerships.",
    href: "/discover/partners",
    cta: "Search partners",
    icon: UsersRound,
    shell: "from-pink-600 to-fuchsia-800",
    glow: "bg-pink-200/30",
  },
  {
    title: "Find Dance Work",
    description:
      "Browse instructor, coach, front-desk, event, and other opportunities posted by dance businesses.",
    href: "/discover/jobs",
    cta: "View openings",
    icon: BriefcaseBusiness,
    shell: "from-emerald-600 to-teal-800",
    glow: "bg-emerald-200/30",
  },
  {
    title: "Learn in Marketplace",
    description:
      "Browse studio-created videos and series, then keep purchased learning available in DanceFlow.",
    href: "/marketplace",
    cta: "Explore marketplace",
    icon: GraduationCap,
    shell: "from-blue-600 to-indigo-800",
    glow: "bg-blue-200/30",
  },
];

export default async function DiscoverLandingPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [
    studioCountResult,
    eventCountResult,
    partnerCountResult,
    jobCountResult,
    marketplaceCountResult,
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
      .from("dancer_partner_profiles")
      .select("*", { count: "exact", head: true })
      .eq("visibility", "published")
      .eq("moderation_status", "approved"),

    supabase
      .from("studio_job_postings")
      .select("*", { count: "exact", head: true })
      .eq("status", "published"),

    supabase
      .from("commerce_catalog_items")
      .select("*", { count: "exact", head: true })
      .eq("active", true)
      .eq("published", true)
      .eq("marketplace_visible", true)
      .in("item_type", ["digital_video", "video_series"]),

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
  const publicPartnerCount = partnerCountResult.count ?? 0;
  const publicJobCount = jobCountResult.count ?? 0;
  const marketplaceCount = marketplaceCountResult.count ?? 0;
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
                Search studios, explore public events, find partner listings,
                and browse studio opportunities from one clean directory built
                for dancers and the communities that serve them.
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <a
                  href="#discovery-paths"
                  className="inline-flex items-center gap-2 rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-800"
                >
                  Choose your discovery path
                  <ArrowRight className="h-4 w-4" />
                </a>

                {!user ? (
                  <Link
                    href="/signup"
                    className="rounded-2xl border border-[var(--brand-border)] bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow-sm hover:bg-slate-50"
                  >
                    Create Free Account
                  </Link>
                ) : null}
              </div>

              <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
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
                  <p className="text-sm font-medium text-slate-500">Partner Listings</p>
                  <p className="mt-2 text-3xl font-semibold text-slate-950">
                    {publicPartnerCount}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">Dancer profiles</p>
                </div>

                <div className="rounded-3xl border border-[var(--brand-border)] bg-white/80 p-5 shadow-sm">
                  <p className="text-sm font-medium text-slate-500">Now Hiring</p>
                  <p className="mt-2 text-3xl font-semibold text-slate-950">
                    {publicJobCount}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">Studio openings</p>
                </div>

                <div className="rounded-3xl border border-[var(--brand-border)] bg-white/80 p-5 shadow-sm">
                  <p className="text-sm font-medium text-slate-500">Marketplace</p>
                  <p className="mt-2 text-3xl font-semibold text-slate-950">
                    {marketplaceCount}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">Videos and series</p>
                </div>
              </div>

              {user ? (
                <div className="mt-6 rounded-3xl border border-green-200 bg-green-50 px-5 py-4 text-sm text-green-800 shadow-sm">
                  You are signed in with a free account. Discovery stays open for
                  browsing even without a studio workspace.
                </div>
              ) : null}
            </div>

            <div className="relative overflow-hidden rounded-[34px] bg-[linear-gradient(135deg,#2e1065_0%,#6d28d9_50%,#f97316_100%)] p-8 text-white shadow-xl">
              <div className="absolute -right-16 -top-16 h-56 w-56 rounded-full bg-white/10 blur-2xl" />
              <div className="absolute -bottom-20 -left-12 h-56 w-56 rounded-full bg-orange-300/20 blur-2xl" />
              <div className="relative">
                <Sparkles className="h-10 w-10 text-orange-200" />
                <p className="mt-8 text-xs font-semibold uppercase tracking-[0.22em] text-white/65">
                  One connected dance world
                </p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight">
                  Every section is a different doorway into dance.
                </h2>
                <p className="mt-4 text-base leading-7 text-white/80">
                  Start with the need you have today. Find a place to dance, an
                  event to attend, someone to practice with, an opportunity to
                  work, or a lesson you can learn from anywhere.
                </p>
                <div className="mt-8 grid gap-3 sm:grid-cols-2">
                  {["Places", "Experiences", "People", "Opportunities", "Learning"].map(
                    (label) => (
                      <div
                        key={label}
                        className="rounded-2xl border border-white/15 bg-white/10 px-4 py-3 text-sm font-semibold backdrop-blur"
                      >
                        {label}
                      </div>
                    ),
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section id="discovery-paths" className="relative mx-auto max-w-7xl px-6 py-14">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent-dark)]">
            Choose what draws you in
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
            Five ways to step deeper into the dance community
          </h2>
          <p className="mt-4 text-base leading-7 text-slate-600">
            Each path is designed to lead somewhere useful—not just another
            directory. Pick one now, then come back and explore the others.
          </p>
        </div>

        <div className="mt-10 grid gap-6 md:grid-cols-2 xl:grid-cols-5">
          {discoveryPaths.map((path, index) => {
            const Icon = path.icon;
            return (
              <Link
                key={path.href}
                href={path.href}
                className={`group relative min-h-[330px] overflow-hidden rounded-[30px] bg-gradient-to-br ${path.shell} p-6 text-white shadow-lg transition duration-300 hover:-translate-y-2 hover:shadow-2xl`}
              >
                <div className={`absolute -right-12 -top-12 h-40 w-40 rounded-full ${path.glow} blur-2xl transition group-hover:scale-125`} />
                <div className="relative flex h-full flex-col">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-[0.18em] text-white/65">
                      Path {index + 1}
                    </span>
                    <div className="rounded-2xl border border-white/20 bg-white/15 p-3 backdrop-blur">
                      <Icon className="h-6 w-6" />
                    </div>
                  </div>

                  <h3 className="mt-8 text-2xl font-semibold tracking-tight">
                    {path.title}
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-white/78">
                    {path.description}
                  </p>

                  <div className="mt-auto flex items-center gap-2 pt-8 text-sm font-semibold">
                    {path.cta}
                    <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
                  </div>
                </div>
              </Link>
            );
          })}
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