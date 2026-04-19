import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import FavoriteButton from "@/components/public/FavoriteButton";
import PublicLeadForm from "@/app/lead/[studioSlug]/PublicLeadForm";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";

type StudioPageParams = Promise<{
  studioSlug: string;
}>;

type StudioPageSearchParams = Promise<{
  inquiry?: string;
}>;

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
};

type StyleRow = {
  style_key: string;
  display_name: string | null;
};

type OfferingRow = {
  offering_key: string;
  display_name: string | null;
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
        beginner_friendly
      `
    )
    .eq("slug", studioSlug)
    .eq("public_directory_enabled", true)
    .maybeSingle<StudioRow>();

  if (studioError) {
    throw new Error(`Failed to load studio: ${studioError.message}`);
  }

  if (!studio) {
    return (
      <>
        <PublicSiteHeader currentPath="studios" isAuthenticated={!!user} />
        <main className="min-h-screen bg-slate-50">
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

  if (favoriteResult?.error) {
    throw new Error(`Failed to load studio favorite state: ${favoriteResult.error.message}`);
  }

  const typedStyles = (styles ?? []) as StyleRow[];
  const typedOfferings = (offerings ?? []) as OfferingRow[];
  const typedEvents = (events ?? []) as EventRow[];
  const title = studioTitle(studio);
  const location = locationLabel(studio);
  const studioUrlSlug = studio.slug ?? studioSlug;
  const isFavorited = Boolean(favoriteResult?.data?.id);

  return (
    <>
      <PublicSiteHeader currentPath="studios" isAuthenticated={!!user} />

      <main className="min-h-screen bg-slate-50">
        <section className="border-b bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_24%,#f8fafc_100%)]">
          <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
            <div className="mb-4">
              <Link
                href="/discover/studios"
                className="inline-flex rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Back to Studios
              </Link>
            </div>

            <div className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                  Public Studio Profile
                </p>

                <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h1 className="text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
                      {title}
                    </h1>
                    <p className="mt-3 text-lg text-slate-600">{location}</p>
                    {studio.beginner_friendly ? (
                      <span className="mt-4 inline-flex rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-700">
                        Beginner Friendly
                      </span>
                    ) : null}
                  </div>

                  <FavoriteButton
                    targetType="studio"
                    targetId={studio.id}
                    initiallyFavorited={isFavorited}
                    isAuthenticated={!!user}
                    returnPath={`/studios/${studioUrlSlug}`}
                  />
                </div>

                <p className="mt-6 max-w-3xl text-lg leading-8 text-slate-600">
                  {studio.public_short_description ||
                    "Explore this studio’s offerings, upcoming events, and ways to connect."}
                </p>

                <div className="mt-6 flex flex-wrap gap-3">
                  {studio.public_lead_enabled ? (
                    <a
                      href="#lead"
                      className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-slate-800"
                    >
                      {studio.public_lead_cta_text?.trim() || "Contact Studio"}
                    </a>
                  ) : null}

                  {studio.public_website_url ? (
                    <a
                      href={studio.public_website_url}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Visit Website
                    </a>
                  ) : null}

                  <Link
                    href="/discover/events"
                    className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Browse Events
                  </Link>
                </div>
              </div>

              <div className="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm">
                <div className="h-[320px] bg-slate-100">
                  {studio.public_hero_image_url ? (
                    <img
                      src={studio.public_hero_image_url}
                      alt={title}
                      className="h-full w-full object-cover"
                    />
                  ) : studio.public_logo_url ? (
                    <div className="flex h-full items-center justify-center p-10">
                      <img
                        src={studio.public_logo_url}
                        alt={title}
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                  ) : (
                    <div className="flex h-full items-center justify-center bg-[linear-gradient(135deg,#f8fafc_0%,#fff7ed_100%)] text-sm text-slate-500">
                      Studio image coming soon
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="grid gap-8 lg:grid-cols-[1fr_340px]">
            <div className="space-y-8">
              <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                  About This Studio
                </h2>
                <p className="mt-4 text-sm leading-7 text-slate-600">
                  {studio.public_about ||
                    studio.public_short_description ||
                    "Public studio details coming soon."}
                </p>
              </section>

              <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                  Dance Styles
                </h2>

                {typedStyles.length === 0 ? (
                  <p className="mt-4 text-sm text-slate-600">
                    Dance styles will appear here as this studio updates its public profile.
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

              <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                  Offerings
                </h2>

                {typedOfferings.length === 0 ? (
                  <p className="mt-4 text-sm text-slate-600">
                    Public offerings will appear here as this studio updates its profile.
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

              <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
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
                        className="overflow-hidden rounded-2xl border border-slate-200 bg-white"
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
                              {formatEventDateRange(event.start_date, event.end_date)}
                            </span>
                            {event.beginner_friendly ? (
                              <span className="rounded-full bg-green-50 px-3 py-1 text-xs text-green-700">
                                Beginner Friendly
                              </span>
                            ) : null}
                          </div>

                          <h3 className="text-lg font-semibold text-slate-950">{event.name}</h3>

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
                  className="rounded-[2rem] border border-violet-200 bg-violet-50 p-6 shadow-sm"
                >
                  <div className="mb-5">
                    <p className="text-sm font-semibold uppercase tracking-[0.16em] text-violet-700">
                      Reach Out
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                      {studio.public_lead_headline?.trim() || `Connect with ${title}`}
                    </h2>
                    <p className="mt-2 text-sm leading-7 text-slate-600">
                      {studio.public_lead_description?.trim() ||
                        "Send a message and this studio can follow up with you directly."}
                    </p>
                  </div>

                  {inquirySuccess ? (
                    <div className="mb-5 rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
                      Your inquiry was sent successfully.
                    </div>
                  ) : null}

                  <PublicLeadForm studioSlug={studioUrlSlug} />
                </section>
              ) : null}
            </div>

            <aside className="space-y-6">
              <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
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

              <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-xl font-semibold tracking-tight text-slate-950">
                  Explore More
                </h2>

                <div className="mt-5 grid gap-3">
                  <Link
                    href="/discover/studios"
                    className="rounded-2xl border bg-slate-50 p-4 hover:bg-slate-100"
                  >
                    <p className="font-medium text-slate-900">Browse other studios</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Compare more options nearby.
                    </p>
                  </Link>

                  <Link
                    href="/discover/events"
                    className="rounded-2xl border bg-slate-50 p-4 hover:bg-slate-100"
                  >
                    <p className="font-medium text-slate-900">Browse public events</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Find classes, socials, and workshops.
                    </p>
                  </Link>

                  {!user ? (
                    <Link
                      href="/signup"
                      className="rounded-2xl border border-violet-200 bg-violet-50 p-4 hover:bg-violet-100"
                    >
                      <p className="font-medium text-slate-900">Create a free account</p>
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