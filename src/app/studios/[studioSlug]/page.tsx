import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import FavoriteButton from "@/components/public/FavoriteButton";
import ShareButton from "@/components/public/ShareButton";
import PublicLeadForm from "@/app/lead/[studioSlug]/PublicLeadForm";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import { JsonLd } from "@/components/seo/JsonLd";

type StudioPageParams = Promise<{
  studioSlug: string;
}>;

type StudioPageSearchParams = Promise<{
  inquiry?: string;
  tab?: string;
}>;

type StudioPublicTab =
  | "overview"
  | "about"
  | "dance-styles"
  | "staff"
  | "offerings"
  | "events"
  | "contact";

function normalizeStudioPublicTab(
  value: string | undefined,
  fallback: StudioPublicTab,
): StudioPublicTab {
  switch (value) {
    case "about":
    case "dance-styles":
    case "staff":
    case "offerings":
    case "events":
    case "contact":
    case "overview":
      return value;
    default:
      return fallback;
  }
}

function publicTabClass(isActive: boolean) {
  return isActive
    ? "shrink-0 rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-sm ring-2 ring-orange-200"
    : "shrink-0 rounded-full border border-orange-100 bg-white/90 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700";
}

function tabPanelClass(isActive: boolean, className: string) {
  return `${isActive ? "" : "hidden "}${className}`;
}

type StudioRow = {
  id: string;
  slug: string | null;
  name: string;
  public_name: string | null;
  public_directory_enabled: boolean;
  public_short_description: string | null;
  public_about: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  public_phone: string | null;
  public_email: string | null;
  public_website_url: string | null;
  public_logo_url: string | null;
  public_hero_image_url: string | null;
  public_lead_enabled: boolean;
  public_lead_headline: string | null;
  public_lead_description: string | null;
  public_primary_color: string | null;
  public_lead_cta_text: string | null;
  beginner_friendly: boolean;
  billing_plan: string | null;
  subscription_status: string | null;
};

type StyleRow = {
  style_key: string;
  display_name: string | null;
};

type OfferingRow = {
  offering_key: string;
  display_name: string | null;
};

type IntroSettingsRow = {
  public_intro_booking_enabled: boolean | null;
  intro_lesson_duration_minutes: number | null;
  intro_booking_window_days: number | null;
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
  visibility: string | null;
  status: string | null;
  public_directory_enabled: boolean | null;
};

const siteUrl = "https://www.idanceflow.com";

function studioTitle(studio: StudioRow) {
  return studio.public_name?.trim() || studio.name || "Studio";
}

function locationLabel(studio: StudioRow) {
  const parts = [studio.city, studio.state].filter(Boolean);
  return parts.length ? parts.join(", ") : "Location coming soon";
}

function normalizeWebsiteLabel(url: string) {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function hasActivePublicAccess(studio: {
  billing_plan?: string | null;
  subscription_status?: string | null;
}) {
  const status = (studio.subscription_status ?? "").trim().toLowerCase();

  return status === "active" || status === "trialing";
}

function absoluteUrl(value: string | null | undefined) {
  if (!value) return null;

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  if (value.startsWith("/")) {
    return `${siteUrl}${value}`;
  }

  return `${siteUrl}/${value}`;
}

function studioDescription(studio: StudioRow) {
  const title = studioTitle(studio);
  const location = locationLabel(studio);

  return (
    studio.public_short_description?.trim() ||
    studio.public_about?.trim() ||
    `Explore ${title} on DanceFlow, including dance styles, studio offerings, upcoming events, and ways to connect${
      location !== "Location coming soon" ? ` in ${location}` : ""
    }.`
  );
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

export async function generateMetadata({
  params,
}: {
  params: StudioPageParams;
}): Promise<Metadata> {
  const { studioSlug } = await params;
  const supabase = await createClient();

  const { data: studio } = await supabase
    .from("studios")
    .select(
      `
        id,
        slug,
        name,
        public_name,
        public_directory_enabled,
        public_short_description,
        public_about,
        city,
        state,
        postal_code,
        public_phone,
        public_email,
        public_website_url,
        public_logo_url,
        public_hero_image_url,
        public_lead_enabled,
        public_lead_headline,
        public_lead_description,
        public_primary_color,
        public_lead_cta_text,
        beginner_friendly,
        billing_plan,
        subscription_status
      `
    )
    .eq("slug", studioSlug)
    .eq("public_directory_enabled", true)
    .maybeSingle<StudioRow>();

  if (!studio || !hasActivePublicAccess(studio)) {
    return {
      title: "Studio Profile | DanceFlow",
      description:
        "Explore public dance studio profiles, events, classes, and ways to connect through DanceFlow.",
    };
  }

  const title = studioTitle(studio);
  const location = locationLabel(studio);
  const canonicalUrl = `${siteUrl}/studios/${studio.slug ?? studioSlug}`;
  const description = studioDescription(studio);
  const imageUrl =
    absoluteUrl(studio.public_hero_image_url) ||
    absoluteUrl(studio.public_logo_url) ||
    `${siteUrl}/brand/danceflow-home-hero.png`;

  return {
    title: `${title}${
      location !== "Location coming soon" ? ` in ${location}` : ""
    }`,
    description,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title: `${title} | DanceFlow Studio Profile`,
      description,
      url: canonicalUrl,
      siteName: "DanceFlow",
      type: "website",
      images: [
        {
          url: imageUrl,
          alt: `${title} on DanceFlow`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | DanceFlow Studio Profile`,
      description,
      images: [imageUrl],
    },
  };
}

export default async function PublicStudioPage({
  params,
  searchParams,
}: {
  params: StudioPageParams;
  searchParams: StudioPageSearchParams;
}) {
  const { studioSlug } = await params;
  const resolvedSearchParams = await searchParams;
  const inquirySuccess = resolvedSearchParams.inquiry === "success";
  const activeStudioTab = normalizeStudioPublicTab(
    resolvedSearchParams.tab,
    inquirySuccess ? "contact" : "overview",
  );

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select(
      `
        id,
        slug,
        name,
        public_name,
        public_directory_enabled,
        public_short_description,
        public_about,
        city,
        state,
        postal_code,
        public_phone,
        public_email,
        public_website_url,
        public_logo_url,
        public_hero_image_url,
        public_lead_enabled,
        public_lead_headline,
        public_lead_description,
        public_primary_color,
        public_lead_cta_text,
        beginner_friendly,
        billing_plan,
        subscription_status
      `
    )
    .eq("slug", studioSlug)
    .eq("public_directory_enabled", true)
    .maybeSingle<StudioRow>();

  if (studioError) {
    throw new Error(`Failed to load studio: ${studioError.message}`);
  }

  if (!studio || !hasActivePublicAccess(studio)) {
    return (
      <>
        <PublicSiteHeader currentPath="studios" isAuthenticated={!!user} />
        <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_34%),radial-gradient(circle_at_top_right,rgba(124,58,237,0.12),transparent_30%),linear-gradient(180deg,#fff7ed_0%,#f8fafc_38%,#ffffff_100%)]">
          <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6 lg:px-8">
            <div className="rounded-3xl border border-rose-200 bg-rose-50 px-6 py-5 text-rose-800">
              Missing studio.
            </div>
          </div>
        </main>
        <PublicSiteFooter />
      </>
    );
  }

  const [
    { data: styles, error: stylesError },
    { data: offerings, error: offeringsError },
    { data: events, error: eventsError },
    { data: introSettings, error: introSettingsError },
    favoriteResult,
  ] = await Promise.all([
    supabase
      .from("studio_public_styles")
      .select("style_key, display_name")
      .eq("studio_id", studio.id)
      .order("display_name", { ascending: true }),

    supabase
      .from("studio_public_offerings")
      .select("offering_key, display_name")
      .eq("studio_id", studio.id)
      .order("display_name", { ascending: true }),

    supabase
      .from("events")
      .select(
        `
          id,
          slug,
          name,
          event_type,
          start_date,
          end_date,
          public_summary,
          public_description,
          public_cover_image_url,
          beginner_friendly,
          visibility,
          status,
          public_directory_enabled
        `
      )
      .eq("studio_id", studio.id)
      .eq("visibility", "public")
      .eq("public_directory_enabled", true)
      .in("status", ["published", "open"])
      .order("start_date", { ascending: true })
      .limit(6),

    supabase
      .from("studio_settings")
      .select(
        `
          public_intro_booking_enabled,
          intro_lesson_duration_minutes,
          intro_booking_window_days
        `
      )
      .eq("studio_id", studio.id)
      .maybeSingle<IntroSettingsRow>(),

    user
      ? supabase
          .from("user_favorites")
          .select("id")
          .eq("user_id", user.id)
          .eq("studio_id", studio.id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (stylesError) {
    throw new Error(`Failed to load studio styles: ${stylesError.message}`);
  }

  if (offeringsError) {
    throw new Error(`Failed to load studio offerings: ${offeringsError.message}`);
  }

  if (eventsError) {
    throw new Error(`Failed to load studio events: ${eventsError.message}`);
  }

  if (introSettingsError) {
    throw new Error(
      `Failed to load intro lesson settings: ${introSettingsError.message}`
    );
  }

  if (favoriteResult?.error) {
    throw new Error(
      `Failed to load studio favorite state: ${favoriteResult.error.message}`
    );
  }

  const typedStyles = (styles ?? []) as StyleRow[];
  const typedOfferings = (offerings ?? []) as OfferingRow[];
  const typedEvents = (events ?? []) as EventRow[];
  const title = studioTitle(studio);
  const location = locationLabel(studio);
  const studioUrlSlug = studio.slug ?? studioSlug;
  const isFavorited = Boolean(favoriteResult?.data?.id);
  const introBookingEnabled = Boolean(
    introSettings?.public_intro_booking_enabled
  );
  const introLessonDuration =
    introSettings?.intro_lesson_duration_minutes ?? null;
  const introBookingWindowDays =
    introSettings?.intro_booking_window_days ?? null;
  const leadCtaText = introBookingEnabled
    ? "Request an Intro Lesson"
    : studio.public_lead_cta_text?.trim() || "Contact Studio";
  const leadHeading = introBookingEnabled
    ? "Request an Intro Lesson"
    : studio.public_lead_headline?.trim() || `Connect with ${title}`;
  const leadDescription = introBookingEnabled
    ? `Tell ${title} you are interested in an intro lesson${
        introLessonDuration ? ` (${introLessonDuration} minutes)` : ""
      }${
        introBookingWindowDays
          ? `. They can follow up with available times over the next ${introBookingWindowDays} days.`
          : ". They can follow up with available times."
      }`
    : studio.public_lead_description?.trim() ||
      "Send a message and this studio can follow up with you directly.";

  const leadStudio = {
    ...studio,
    public_intro_booking_enabled: introBookingEnabled,
    intro_lesson_duration_minutes: introLessonDuration,
    intro_booking_window_days: introBookingWindowDays,
  };

  const studioPublicUrl = `${siteUrl}/studios/${studioUrlSlug}`;
  const studioImageUrl =
    absoluteUrl(studio.public_hero_image_url) ||
    absoluteUrl(studio.public_logo_url) ||
    `${siteUrl}/brand/danceflow-home-hero.png`;

  const styleNames = typedStyles
    .map((style) => style.display_name || style.style_key)
    .filter(Boolean);

  const offeringNames = typedOfferings
    .map((offering) => offering.display_name || offering.offering_key)
    .filter(Boolean);

  const addressJsonLd =
    studio.city || studio.state || studio.postal_code
      ? {
          "@type": "PostalAddress",
          addressLocality: studio.city ?? undefined,
          addressRegion: studio.state ?? undefined,
          postalCode: studio.postal_code ?? undefined,
          addressCountry: "US",
        }
      : undefined;

  const studioJsonLd = {
    "@context": "https://schema.org",
    "@type": ["LocalBusiness", "DanceSchool"],
    name: title,
    url: studioPublicUrl,
    image: studioImageUrl,
    logo: absoluteUrl(studio.public_logo_url) ?? undefined,
    description: studioDescription(studio),
    address: addressJsonLd,
    telephone: studio.public_phone ?? undefined,
    email: studio.public_email ?? undefined,
    sameAs: studio.public_website_url ? [studio.public_website_url] : undefined,
    areaServed:
      studio.city || studio.state
        ? [studio.city, studio.state].filter(Boolean).join(", ")
        : undefined,
    knowsAbout: styleNames.length ? styleNames : undefined,
    makesOffer: offeringNames.length
      ? offeringNames.map((name) => ({
          "@type": "Offer",
          itemOffered: {
            "@type": "Service",
            name,
          },
        }))
      : undefined,
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
      {
        "@type": "ListItem",
        position: 2,
        name: "Studios",
        item: `${siteUrl}/discover/studios`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: title,
        item: studioPublicUrl,
      },
    ],
  };

  const studioTabs: { key: StudioPublicTab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "about", label: "About" },
    { key: "dance-styles", label: "Dance Styles" },
    { key: "staff", label: "Staff" },
    { key: "offerings", label: "Offerings" },
    { key: "events", label: "Events" },
    { key: "contact", label: "Contact" },
  ];

  return (
    <>
      <JsonLd data={[studioJsonLd, breadcrumbJsonLd]} />

      <PublicSiteHeader currentPath="studios" isAuthenticated={!!user} />

      <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_34%),radial-gradient(circle_at_top_right,rgba(124,58,237,0.12),transparent_30%),linear-gradient(180deg,#fff7ed_0%,#f8fafc_38%,#ffffff_100%)]">
        <section className="border-b border-orange-100/70 bg-[linear-gradient(135deg,#111827_0%,#4c1d95_48%,#f97316_140%)]">
          <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
            <div className="mb-4">
              <Link
                href="/discover/studios"
                className="inline-flex rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white shadow-sm backdrop-blur hover:bg-white/15"
              >
                Back to Studios
              </Link>
            </div>

            <div className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-200">
                  Public Studio Profile
                </p>

                <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                      {title}
                    </h1>
                    <p className="mt-3 text-lg text-white/80">{location}</p>
                    {studio.beginner_friendly ? (
                      <span className="mt-4 inline-flex rounded-full bg-green-400/15 px-3 py-1 text-xs font-semibold text-green-100 ring-1 ring-green-300/25">
                        Beginner Friendly
                      </span>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <ShareButton
                      title={title}
                      text={`Check out ${title} on DanceFlow.`}
                      url={`/studios/${studioUrlSlug}`}
                      label="Share Studio"
                      className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-white/15"
                    />
                    <FavoriteButton
                      targetType="studio"
                      targetId={studio.id}
                      initiallyFavorited={isFavorited}
                      isAuthenticated={!!user}
                      returnPath={`/studios/${studioUrlSlug}`}
                    />
                  </div>
                </div>

                <p className="mt-6 max-w-3xl text-lg leading-8 text-white/80">
                  {studio.public_short_description ||
                    "Explore this studio’s offerings, upcoming events, and ways to connect."}
                </p>

                <div className="mt-6 flex flex-wrap gap-3">
                  {studio.public_lead_enabled ? (
                    <Link
                      href={`/studios/${studioUrlSlug}?tab=contact#lead`}
                      className="rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-950 shadow-sm hover:bg-orange-50"
                    >
                      {leadCtaText}
                    </Link>
                  ) : null}

                  {studio.public_website_url ? (
                    <a
                      href={studio.public_website_url}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-xl border border-white/20 bg-white/10 px-5 py-3 text-sm font-semibold text-white backdrop-blur hover:bg-white/15"
                    >
                      Visit Website
                    </a>
                  ) : null}

                  <Link
                    href="/discover/events"
                    className="rounded-xl border border-white/20 bg-white/10 px-5 py-3 text-sm font-semibold text-white backdrop-blur hover:bg-white/15"
                  >
                    Browse Events
                  </Link>
                </div>
              </div>

              <div className="overflow-hidden rounded-[2rem] border border-white/20 bg-white/10 shadow-2xl shadow-slate-950/25 ring-1 ring-white/10">
                <div className="h-[320px] bg-white/10">
                  {studio.public_hero_image_url ? (
                    <img
                      src={studio.public_hero_image_url}
                      alt={title}
                      className="h-full w-full object-cover"
                    />
                  ) : studio.public_logo_url ? (
                    <div className="flex h-full items-center justify-center bg-white p-10">
                      <img
                        src={studio.public_logo_url}
                        alt={title}
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                  ) : (
                    <div className="flex h-full items-center justify-center bg-[linear-gradient(135deg,#f8fafc_0%,#ede9fe_45%,#fff7ed_100%)] text-sm text-slate-500">
                      Studio image coming soon
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        <nav
          aria-label="Studio page tabs"
          className="sticky top-0 z-20 border-b border-orange-100 bg-white/90 px-4 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-white/80 sm:px-6 lg:px-8"
        >
          <div className="mx-auto flex max-w-7xl gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {studioTabs.map((tab) => (
              <Link
                key={tab.key}
                href={`/studios/${studioUrlSlug}?tab=${tab.key}`}
                aria-current={activeStudioTab === tab.key ? "page" : undefined}
                className={publicTabClass(activeStudioTab === tab.key)}
              >
                {tab.label}
              </Link>
            ))}
          </div>
        </nav>

        <section className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="grid gap-8">
            <div className="space-y-8">
              <section id="overview" className={tabPanelClass(activeStudioTab === "overview", "rounded-[2rem] border border-orange-100/80 bg-white/95 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] ring-1 ring-white/70")}>
                <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                  Welcome to {title}
                </h2>
                <p className="mt-4 text-sm leading-7 text-slate-600">
                  {studio.public_short_description ||
                    studio.public_about ||
                    "Explore this studio’s dance styles, offerings, upcoming events, and ways to connect."}
                </p>
                <div className="mt-5 flex flex-wrap gap-3">
                  {studio.public_lead_enabled ? (
                    <Link
                      href={`/studios/${studioUrlSlug}?tab=contact#lead`}
                      className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                    >
                      {leadCtaText}
                    </Link>
                  ) : null}
                  <Link
                    href={`/studios/${studioUrlSlug}?tab=events`}
                    className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    View Events
                  </Link>
                  <Link
                    href={`/studios/${studioUrlSlug}?tab=offerings`}
                    className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    See Offerings
                  </Link>
                </div>
              </section>

              <section id="about" className={tabPanelClass(activeStudioTab === "about", "rounded-[2rem] border border-orange-100/80 bg-white/95 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] ring-1 ring-white/70")}>
                <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                  About This Studio
                </h2>
                <p className="mt-4 text-sm leading-7 text-slate-600">
                  {studio.public_about ||
                    studio.public_short_description ||
                    "Public studio details coming soon."}
                </p>
              </section>

              <section id="dance-styles" className={tabPanelClass(activeStudioTab === "dance-styles", "rounded-[2rem] border border-orange-100/80 bg-white/95 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] ring-1 ring-white/70")}>
                <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                  Dance Styles
                </h2>

                {typedStyles.length === 0 ? (
                  <p className="mt-4 text-sm text-slate-600">
                    Dance styles will appear here as this studio updates its
                    public profile.
                  </p>
                ) : (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {typedStyles.map((style) => (
                      <span
                        key={style.style_key}
                        className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700"
                      >
                        {style.display_name || style.style_key}
                      </span>
                    ))}
                  </div>
                )}
              </section>

              <section id="staff" className={tabPanelClass(activeStudioTab === "staff", "rounded-[2rem] border border-orange-100/80 bg-white/95 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] ring-1 ring-white/70")}>
                <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                  Staff
                </h2>
                <p className="mt-4 text-sm leading-7 text-slate-600">
                  Instructor and staff profiles will appear here as this studio
                  adds them to its public profile.
                </p>
              </section>

              <section id="offerings" className={tabPanelClass(activeStudioTab === "offerings", "rounded-[2rem] border border-orange-100/80 bg-white/95 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] ring-1 ring-white/70")}>
                <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                  Offerings
                </h2>

                {typedOfferings.length === 0 ? (
                  <p className="mt-4 text-sm text-slate-600">
                    Public offerings will appear here as this studio updates its
                    profile.
                  </p>
                ) : (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {typedOfferings.map((offering) => (
                      <span
                        key={offering.offering_key}
                        className="rounded-full bg-orange-50 px-3 py-1 text-xs text-orange-700"
                      >
                        {offering.display_name || offering.offering_key}
                      </span>
                    ))}
                  </div>
                )}
              </section>

              <section id="events" className={tabPanelClass(activeStudioTab === "events", "rounded-[2rem] border border-orange-100/80 bg-white/95 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] ring-1 ring-white/70")}>
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                      Upcoming Events
                    </h2>
                    <p className="mt-2 text-sm text-slate-600">
                      Public events connected to this studio.
                    </p>
                  </div>

                  <Link
                    href="/discover/events"
                    className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Discover More Events
                  </Link>
                </div>

                {typedEvents.length === 0 ? (
                  <div className="mt-6 rounded-2xl border border-dashed border-slate-200 px-5 py-10 text-center">
                    <p className="text-sm text-slate-600">
                      No public events are listed right now.
                    </p>
                  </div>
                ) : (
                  <div className="mt-6 grid gap-4 md:grid-cols-2">
                    {typedEvents.map((event) => (
                      <article
                        key={event.id}
                        className="overflow-hidden rounded-2xl border border-orange-100 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg"
                      >
                        <div className="h-40 bg-slate-100">
                          {event.public_cover_image_url ? (
                            <img
                              src={event.public_cover_image_url}
                              alt={event.name}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full items-center justify-center bg-[linear-gradient(135deg,#f8fafc_0%,#ede9fe_40%,#fff7ed_100%)] px-6 text-center text-sm text-slate-500">
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
                              {formatEventDateRange(
                                event.start_date,
                                event.end_date
                              )}
                            </span>
                            {event.beginner_friendly ? (
                              <span className="rounded-full bg-green-50 px-3 py-1 text-xs text-green-700">
                                Beginner Friendly
                              </span>
                            ) : null}
                          </div>

                          <h3 className="text-lg font-semibold text-slate-950">
                            {event.name}
                          </h3>

                          <p className="text-sm leading-6 text-slate-600">
                            {event.public_summary ||
                              event.public_description ||
                              "Public event details coming soon."}
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

              {studio.public_lead_enabled ? (
                <section
                  id="lead"
                  className={tabPanelClass(activeStudioTab === "contact", "scroll-mt-24 rounded-[2rem] border border-violet-200 bg-violet-50 p-6 shadow-sm")}
                >
                  <div className="mb-5">
                    <p className="text-sm font-semibold uppercase tracking-[0.16em] text-violet-700">
                      {introBookingEnabled ? "Intro Lesson" : "Reach Out"}
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                      {leadHeading}
                    </h2>
                    <p className="mt-2 text-sm leading-7 text-slate-600">
                      {leadDescription}
                    </p>
                  </div>

                  {inquirySuccess ? (
                    <div className="mb-5 rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
                      Your inquiry was sent successfully.
                    </div>
                  ) : null}

                  <PublicLeadForm
                    studio={leadStudio}
                    successRedirect={`/studios/${studioUrlSlug}?inquiry=success&tab=contact#lead`}
                  />
                </section>
              ) : null}
            </div>

            <aside className="space-y-6">
              <section id="contact" className={tabPanelClass(activeStudioTab === "contact", "rounded-[2rem] border border-orange-100/80 bg-white/95 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] ring-1 ring-white/70")}>
                <h2 className="text-xl font-semibold tracking-tight text-slate-950">
                  Contact Information
                </h2>

                <div className="mt-5 space-y-4 text-sm text-slate-600">
                  <div>
                    <p className="font-medium text-slate-900">Location</p>
                    <p className="mt-1">{location}</p>
                    {studio.postal_code ? <p>{studio.postal_code}</p> : null}
                  </div>

                  {studio.public_phone ? (
                    <div>
                      <p className="font-medium text-slate-900">Phone</p>
                      <a
                        href={`tel:${studio.public_phone}`}
                        className="mt-1 inline-block hover:text-slate-900"
                      >
                        {studio.public_phone}
                      </a>
                    </div>
                  ) : null}

                  {studio.public_email ? (
                    <div>
                      <p className="font-medium text-slate-900">Email</p>
                      <a
                        href={`mailto:${studio.public_email}`}
                        className="mt-1 inline-block hover:text-slate-900"
                      >
                        {studio.public_email}
                      </a>
                    </div>
                  ) : null}

                  {studio.public_website_url ? (
                    <div>
                      <p className="font-medium text-slate-900">Website</p>
                      <a
                        href={studio.public_website_url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-block break-all hover:text-slate-900"
                      >
                        {normalizeWebsiteLabel(studio.public_website_url)}
                      </a>
                    </div>
                  ) : null}
                </div>
              </section>

              <section className={tabPanelClass(activeStudioTab === "overview", "rounded-[2rem] border border-orange-100/80 bg-white/95 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] ring-1 ring-white/70")}>
                <h2 className="text-xl font-semibold tracking-tight text-slate-950">
                  Explore More
                </h2>

                <div className="mt-5 grid gap-3">
                  <Link
                    href="/discover/studios"
                    className="rounded-2xl border border-orange-100 bg-[linear-gradient(135deg,#ffffff_0%,#fff7ed_100%)] p-4 shadow-sm hover:bg-orange-50"
                  >
                    <p className="font-medium text-slate-900">
                      Browse other studios
                    </p>
                    <p className="mt-1 text-sm text-slate-600">
                      Compare more options nearby.
                    </p>
                  </Link>

                  <Link
                    href="/discover/events"
                    className="rounded-2xl border border-orange-100 bg-[linear-gradient(135deg,#ffffff_0%,#fff7ed_100%)] p-4 shadow-sm hover:bg-orange-50"
                  >
                    <p className="font-medium text-slate-900">
                      Browse public events
                    </p>
                    <p className="mt-1 text-sm text-slate-600">
                      Find classes, socials, and workshops.
                    </p>
                  </Link>

                  {!user ? (
                    <Link
                      href="/signup"
                      className="rounded-2xl border border-violet-200 bg-violet-50 p-4 hover:bg-violet-100"
                    >
                      <p className="font-medium text-slate-900">
                        Create a free account
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        Save favorites and keep track of discovery.
                      </p>
                    </Link>
                  ) : null}
                </div>
              </section>
            </aside>
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}