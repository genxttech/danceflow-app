import Link from "next/link";
import {
  ArrowRight,
  BriefcaseBusiness,
  CalendarDays,
  GraduationCap,
  MapPinned,
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
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(251,146,60,0.20),transparent_34%),radial-gradient(circle_at_top_right,rgba(75,46,131,0.14),transparent_30%)]" />
        <div className="relative mx-auto max-w-7xl px-6 py-14 lg:py-20">
          <div className="max-w-4xl">
            <div className="inline-flex items-center rounded-full border border-[var(--brand-border)] bg-white/80 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-[var(--brand-accent-dark)] shadow-sm">
              DanceFlow Discovery
            </div>

            <h1 className="mt-5 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl lg:text-6xl">
              {user
                ? "Welcome back — what are you looking for today?"
                : "Find your next place, event, partner, or opportunity in dance"}
            </h1>

            <p className="mt-5 max-w-3xl text-lg leading-8 text-slate-600">
              Start with one discovery path. DanceFlow keeps studios, events,
              partner listings, jobs, and learning in one connected dance directory.
            </p>

            <div className="mt-7 flex flex-wrap gap-3">
              <a
                href="#discovery-paths"
                className="inline-flex items-center gap-2 rounded-2xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:brightness-110"
              >
                Explore discovery
                <ArrowRight className="h-4 w-4" />
              </a>

              {!user ? (
                <Link
                  href="/signup"
                  className="rounded-2xl border border-[var(--brand-border)] bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow-sm hover:bg-slate-50"
                >
                  Create free account
                </Link>
              ) : null}
            </div>
          </div>

          <div className="mt-10 overflow-x-auto pb-1">
            <div className="flex min-w-max gap-3 lg:min-w-0 lg:grid lg:grid-cols-5">
              {[
                ["Studios", publicStudioCount],
                ["Events", publicEventCount],
                ["Partners", publicPartnerCount],
                ["Jobs", publicJobCount],
                ["Marketplace", marketplaceCount],
              ].map(([label, value]) => (
                <div
                  key={String(label)}
                  className="w-44 rounded-2xl border border-[var(--brand-border)] bg-white/90 p-4 shadow-sm lg:w-auto"
                >
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                    {label}
                  </p>
                  <p className="mt-1 text-2xl font-semibold text-slate-950">
                    {value}
                  </p>
                </div>
              ))}
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
            Choose what you need today
          </h2>
          <p className="mt-4 text-base leading-7 text-slate-600">
            Open the section that matches your goal. You can move between discovery areas without losing the larger DanceFlow experience.
          </p>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {discoveryPaths.map((path, index) => {
            const Icon = path.icon;
            return (
              <Link
                key={path.href}
                href={path.href}
                className={`group relative min-h-[240px] overflow-hidden rounded-[28px] bg-gradient-to-br ${path.shell} p-5 text-white shadow-md transition duration-300 hover:-translate-y-1 hover:shadow-xl`}
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

                  <h3 className="mt-6 text-xl font-semibold tracking-tight">
                    {path.title}
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-white/78">
                    {path.description}
                  </p>

                  <div className="mt-auto flex items-center gap-2 pt-6 text-sm font-semibold">
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

    </main>
  );
}
