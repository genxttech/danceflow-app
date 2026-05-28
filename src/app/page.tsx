import Image from "next/image";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUserPlatformRole } from "@/lib/auth/platform";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import { JsonLd } from "@/components/seo/JsonLd";

const featureCards = [
  {
    eyebrow: "For dancers",
    title: "Find places to dance and events to attend.",
    description:
      "DanceFlow gives dancers a public discovery path for studios, events, favorites, registrations, and future portal access from the studios they dance with.",
    accent: "pink",
    bullets: [
      "Discover studios and events",
      "Register for events and private lesson opportunities",
      "Save favorites and use portal access when invited",
    ],
  },
  {
    eyebrow: "For studios",
    title: "Keep the business side connected.",
    description:
      "Studios can manage clients, schedules, packages, leads, payments, campaigns, public profiles, and event activity without stitching together disconnected tools.",
    accent: "purple",
    bullets: [
      "CRM, scheduling, packages, and payments",
      "Public profiles connected to leads",
      "Marketing campaigns and follow-up workflows",
    ],
  },
  {
    eyebrow: "For events",
    title: "Make registration and check-in easier.",
    description:
      "Organizers and studios can publish events, sell tickets, offer early bird pricing, add guest coach private lesson slots, and check people in with ticket codes or QR codes.",
    accent: "orange",
    bullets: [
      "Event pages, tickets, and early bird pricing",
      "Guest coach private lesson options",
      "Ticket codes, QR confirmations, and check-in",
    ],
  },
];

const audienceCards = [
  {
    title: "Dancers",
    description:
      "Find studios and events, save favorites, register when events are open, and use your portal when a studio invites you.",
    href: "/discover/events",
    cta: "Find Events",
    accent: "pink",
  },
  {
    title: "Studios",
    description:
      "Manage clients, schedules, packages, leads, payments, campaigns, public profiles, and event sales in one connected workspace.",
    href: "/get-started/studio",
    cta: "View Studio Plans",
    accent: "purple",
  },
  {
    title: "Organizers",
    description:
      "Publish events, sell tickets, offer private lesson slots, send confirmations, and check in attendees with ticket codes or QR codes.",
    href: "/get-started/organizer",
    cta: "For Organizers",
    accent: "orange",
  },
];

function accentClasses(accent: string) {
  switch (accent) {
    case "orange":
      return {
        border: "border-orange-200",
        soft: "bg-orange-50",
        text: "text-orange-700",
        button: "bg-orange-500 hover:bg-orange-600",
      };
    case "pink":
      return {
        border: "border-pink-200",
        soft: "bg-pink-50",
        text: "text-pink-700",
        button: "bg-pink-600 hover:bg-pink-700",
      };
    default:
      return {
        border: "border-purple-200",
        soft: "bg-purple-50",
        text: "text-purple-700",
        button: "bg-purple-700 hover:bg-purple-800",
      };
  }
}

export default async function HomePage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  let dashboardHref = "/login";
  let dashboardLabel = "Log In";

  if (user) {
    const platformRole = await getCurrentUserPlatformRole();

    if (platformRole === "platform_admin") {
      dashboardHref = "/platform";
      dashboardLabel = "Platform Dashboard";
    } else {
      const { data: studioRole } = await supabase
        .from("user_studio_roles")
        .select("studio_id")
        .eq("user_id", user.id)
        .eq("active", true)
        .limit(1)
        .maybeSingle();

      if (studioRole) {
        dashboardHref = "/app";
        dashboardLabel = "Workspace";
      } else {
        dashboardHref = "/account";
        dashboardLabel = "My Account";
      }
    }
  }

  const siteUrl = "https://www.idanceflow.com";

  const organizationJsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "DanceFlow",
    url: siteUrl,
    logo: `${siteUrl}/brand/danceflow-logo.png`,
    description:
      "DanceFlow provides dance studio CRM, scheduling, event registration, ticketing, public discovery, payments, email marketing, and organizer tools for the dance community.",
  };

  const websiteJsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "DanceFlow",
    url: siteUrl,
    description:
      "DanceFlow helps dancers find studios and events while giving studios and organizers connected tools for CRM, scheduling, ticketing, and public discovery.",
    publisher: {
      "@type": "Organization",
      name: "DanceFlow",
      url: siteUrl,
    },
  };

  const softwareApplicationJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "DanceFlow",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url: siteUrl,
    description:
      "DanceFlow is a public dance discovery platform with CRM, scheduling, event ticketing, payments, and marketing tools for studios, organizers, instructors, and dancers.",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description:
        "DanceFlow offers public dancer discovery accounts and trial options for studio and organizer workspaces.",
    },
    publisher: {
      "@type": "Organization",
      name: "DanceFlow",
      url: siteUrl,
    },
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: siteUrl,
      },
    ],
  };

  return (
    <>
      <JsonLd
        data={[
          organizationJsonLd,
          websiteJsonLd,
          softwareApplicationJsonLd,
          breadcrumbJsonLd,
        ]}
      />

      <PublicSiteHeader currentPath="home" isAuthenticated={Boolean(user)} />

      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_18%,#f8fafc_100%)]">
        <section className="relative overflow-hidden border-b border-slate-200/70">
          <div className="absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_top_left,rgba(251,146,60,0.22),transparent_45%),radial-gradient(circle_at_top_right,rgba(168,85,247,0.18),transparent_42%)]" />

          <div className="relative mx-auto max-w-7xl px-6 py-14 lg:px-8 lg:py-20">
            <div className="grid gap-12 lg:grid-cols-[1.03fr_0.97fr] lg:items-center">
              <div>
                <div className="inline-flex rounded-full border border-orange-200 bg-white/80 px-4 py-2 text-sm font-semibold text-orange-700 shadow-sm">
                  Built for dancers, studios, instructors, and organizers
                </div>

                <div className="mt-6 flex flex-col gap-5 sm:flex-row sm:items-center">
                  <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded-[32px] bg-white shadow-sm ring-1 ring-slate-200 sm:h-36 sm:w-36">
                    <Image
                      src="/brand/danceflow-logo.png"
                      alt="DanceFlow logo"
                      width={160}
                      height={160}
                      className="h-24 w-24 object-contain sm:h-30 sm:w-30"
                      priority
                    />
                  </div>

                  <div>
                    <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                      DanceFlow
                    </p>
                    <p className="mt-1 text-base text-slate-600">
                      Find dance opportunities and keep dance businesses connected
                    </p>
                  </div>
                </div>

                <h1 className="mt-8 max-w-4xl text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl lg:text-6xl">
                  Find dance. Run the studio. Grow the community.
                </h1>

                <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-600">
                  DanceFlow helps dancers discover studios and events, while giving studios and organizers the tools to manage schedules, registrations, tickets, payments, and follow-up in one connected place.
                </p>

                <div className="mt-8 flex flex-wrap gap-3">
                  <Link
                    href="/get-started/studio"
                    className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800"
                  >
                    For Studios
                  </Link>

                  <Link
                    href="/get-started/organizer"
                    className="rounded-xl bg-orange-500 px-5 py-3 text-sm font-semibold text-white hover:bg-orange-600"
                  >
                    For Organizers
                  </Link>

                  <Link
                    href="/discover/events"
                    className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Find Events
                  </Link>
                </div>

                <div className="mt-8 grid gap-3 sm:grid-cols-3">
                  {[
                    "Find studios and events nearby",
                    "Register and check in faster",
                    "Studios keep follow-up connected",
                  ].map((item) => (
                    <div
                      key={item}
                      className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 text-sm font-medium text-slate-700 shadow-sm"
                    >
                      {item}
                    </div>
                  ))}
                </div>
              </div>

              <div className="relative">
                <div className="rounded-[34px] border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="overflow-hidden rounded-[28px] bg-[linear-gradient(135deg,#fff7ed_0%,#fdf2f8_38%,#eef2ff_100%)]">
                    <Image
                      src="/brand/danceflow-home-hero.png"
                      alt="DanceFlow connects studio operations, public discovery, and dance events"
                      width={1400}
                      height={1000}
                      className="h-auto w-full object-cover"
                      priority
                    />
                  </div>
                </div>

                <div className="absolute -bottom-5 left-5 rounded-2xl border border-orange-100 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-700">
                    Dance Discovery
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Studios, events, and dance opportunities
                  </p>
                </div>

                <div className="absolute -top-5 right-5 rounded-2xl border border-violet-100 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                    Connected Tools
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Scheduling, tickets, CRM, and follow-up
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-6 py-14 lg:px-8">
          <div className="mx-auto max-w-3xl text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
              One platform, two sides of dance
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              Built for dancers and the people who run dance
            </h2>
            <p className="mt-4 text-lg leading-8 text-slate-600">
              Dancers need a simple way to find where to dance. Studios and organizers need tools that turn interest into registrations, relationships, and smoother day-to-day operations.
            </p>
          </div>

          <div className="mt-10 grid gap-6 lg:grid-cols-3">
            {featureCards.map((card) => {
              const colors = accentClasses(card.accent);

              return (
                <article
                  key={card.title}
                  className={`rounded-[2rem] border ${colors.border} bg-white p-6 shadow-sm`}
                >
                  <div className={`inline-flex rounded-full ${colors.soft} px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] ${colors.text}`}>
                    {card.eyebrow}
                  </div>

                  <h3 className="mt-4 text-2xl font-semibold tracking-tight text-slate-950">
                    {card.title}
                  </h3>

                  <p className="mt-3 text-sm leading-7 text-slate-600">
                    {card.description}
                  </p>

                  <div className="mt-5 grid gap-2">
                    {card.bullets.map((bullet) => (
                      <div
                        key={bullet}
                        className={`rounded-2xl ${colors.soft} px-4 py-3 text-sm leading-6 text-slate-700`}
                      >
                        {bullet}
                      </div>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="border-y border-slate-200 bg-white/80">
          <div className="mx-auto max-w-7xl px-6 py-14 lg:px-8">
            <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                  Choose your path
                </p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
                  Dancers, studios, and organizers each get a clear experience.
                </h2>
                <p className="mt-4 text-base leading-7 text-slate-600">
                  DanceFlow is public-facing for dancers and operational for the businesses and organizers that serve them.
                </p>
              </div>

              <div className="grid gap-4">
                {audienceCards.map((card) => {
                  const colors = accentClasses(card.accent);

                  return (
                    <article
                      key={card.title}
                      className={`rounded-[2rem] border ${colors.border} bg-white p-6 shadow-sm`}
                    >
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <h3 className="text-xl font-semibold tracking-tight text-slate-950">
                            {card.title}
                          </h3>
                          <p className="mt-2 text-sm leading-7 text-slate-600">
                            {card.description}
                          </p>
                        </div>

                        <Link
                          href={card.href}
                          className={`shrink-0 rounded-xl px-4 py-3 text-center text-sm font-semibold text-white ${colors.button}`}
                        >
                          {card.cta}
                        </Link>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-6 py-14 lg:px-8">
          <div className="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm">
            <div className="bg-[linear-gradient(135deg,#2e1065_0%,#4c1d95_48%,#f97316_100%)] p-8 text-white sm:p-10">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/75">
                Event experience highlight
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                From event discovery to check-in, keep the experience simple.
              </h2>
              <p className="mt-4 max-w-3xl text-sm leading-7 text-white/85 sm:text-base">
                Dancers can discover events and register clearly. Studios and organizers can manage tickets, early bird pricing, guest coach private lesson slots, confirmations, QR codes, and check-in tools behind the scenes.
              </p>
            </div>

            <div className="grid gap-4 bg-slate-50 p-5 sm:p-6 lg:grid-cols-4">
              {[
                "Tabbed event pages with clear checkout",
                "Early bird pricing when offered",
                "Guest coach private lesson options",
                "Ticket codes and QR check-in",
              ].map((item) => (
                <div
                  key={item}
                  className="rounded-2xl border border-slate-200 bg-white p-5 text-sm font-medium leading-6 text-slate-700 shadow-sm"
                >
                  {item}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-y border-slate-200 bg-white/70">
          <div className="mx-auto max-w-7xl px-6 py-14 lg:px-8">
            <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
                  Ready to explore DanceFlow?
                </p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                  Find an event, explore studios, or start setting up your DanceFlow workspace.
                </h2>
                <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
                  DanceFlow is live and continuing to grow around real ballroom, country, and social dance community workflows.
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <Link
                  href="/get-started/studio"
                  className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  Studio Trial
                </Link>

                <Link
                  href="/get-started/organizer"
                  className="rounded-xl bg-orange-500 px-5 py-3 text-sm font-semibold text-white hover:bg-orange-600"
                >
                  Organizer Suite
                </Link>

                <Link
                  href={dashboardHref}
                  className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  {dashboardLabel}
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}

