import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import PublicLeadForm from "@/app/lead/[studioSlug]/PublicLeadForm";

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
  return [studio.city, studio.state].filter(Boolean).join(", ");
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
    case "class":
      return "Class";
    case "social":
      return "Social";
    case "workshop":
      return "Workshop";
    case "party":
      return "Party";
    case "performance":
      return "Performance";
    case "private_lesson":
      return "Private Lesson";
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
      <main className="min-h-screen bg-slate-50">
        <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6 lg:px-8">
          <div className="rounded-3xl border border-rose-200 bg-rose-50 px-6 py-5 text-rose-800">
            Missing studio.
          </div>
        </div>
      </main>
    );
  }

  const [
    { data: styles, error: stylesError },
    { data: offerings, error: offeringsError },
    { data: events, error: eventsError },
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

  const typedStyles = (styles ?? []) as StyleRow[];
  const typedOfferings = (offerings ?? []) as OfferingRow[];
  const typedEvents = (events ?? []) as EventRow[];
  const title = studioTitle(studio);
  const location = locationLabel(studio);
  const studioUrlSlug = studio.slug ?? studioSlug;

  return (
    <main className="min-h-screen bg-slate-50">
      <section className="border-b border-slate-200/70 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)]">
        <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
          <div className="grid gap-8 lg:grid-cols-[1.4fr_0.9fr] lg:items-center">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <Link
                  href="/discover/studios"
                  className="inline-flex rounded-full border border-slate-200 bg-white px-4 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                >
                  Back to studio discovery
                </Link>

                {studio.beginner_friendly ? (
                  <span className="inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-700">
                    Beginner Friendly
                  </span>
                ) : null}
              </div>

              <h1 className="mt-5 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
                {title}
              </h1>

              {studio.public_short_description ? (
                <p className="mt-4 max-w-3xl text-lg leading-8 text-slate-600">
                  {studio.public_short_description}
                </p>
              ) : null}

              <div className="mt-6 flex flex-wrap gap-3 text-sm text-slate-600">
                {location ? (
                  <span className="rounded-full bg-white px-3 py-1.5 shadow-sm ring-1 ring-slate-200">
                    {location}
                  </span>
                ) : null}

                {typedStyles.slice(0, 4).map((style) => (
                  <span
                    key={style.style_key}
                    className="rounded-full bg-white px-3 py-1.5 shadow-sm ring-1 ring-slate-200"
                  >
                    {style.display_name || style.style_key}
                  </span>
                ))}
              </div>
            </div>

            <div className="overflow-hidden rounded-[2rem] border border-slate-200/80 bg-white shadow-sm">
              {studio.public_hero_image_url ? (
                <img
                  src={studio.public_hero_image_url}
                  alt={title}
                  className="h-72 w-full object-cover"
                />
              ) : (
                <div className="flex h-72 items-center justify-center bg-[linear-gradient(135deg,#f8fafc_0%,#ede9fe_40%,#fff7ed_100%)] px-8 text-center text-sm text-slate-500">
                  Public studio image coming soon
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {inquirySuccess ? (
          <div className="mb-8 rounded-[2rem] border border-emerald-200 bg-emerald-50 px-6 py-5 text-emerald-800">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">Inquiry sent</h2>
                <p className="mt-1 text-sm">
                  Thanks for reaching out to {title}. Your inquiry went through
                  successfully.
                </p>
              </div>
              <a
                href={`#inquiry-form`}
                className="inline-flex rounded-xl bg-white px-4 py-2 text-sm font-medium text-emerald-800 shadow-sm ring-1 ring-emerald-200"
              >
                View inquiry section
              </a>
            </div>
          </div>
        ) : null}

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.35fr)_380px]">
          <div className="space-y-8">
            <section className="rounded-[2rem] border border-slate-200/80 bg-white p-6 shadow-sm sm:p-8">
              <div className="flex items-center gap-4">
                {studio.public_logo_url ? (
                  <img
                    src={studio.public_logo_url}
                    alt={`${title} logo`}
                    className="h-16 w-16 rounded-2xl object-cover ring-1 ring-slate-200"
                  />
                ) : null}

                <div>
                  <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                    About {title}
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Studio profile and public offerings
                  </p>
                </div>
              </div>

              <div className="mt-6 space-y-4 text-base leading-8 text-slate-700">
                {studio.public_about ? (
                  <p>{studio.public_about}</p>
                ) : (
                  <p>
                    This studio has not added a full public bio yet. Check their
                    offerings, upcoming events, or submit an inquiry for more
                    details.
                  </p>
                )}
              </div>
            </section>

            <section className="rounded-[2rem] border border-slate-200/80 bg-white p-6 shadow-sm sm:p-8">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                Dance styles
              </h2>

              {typedStyles.length === 0 ? (
                <p className="mt-4 text-sm text-slate-600">
                  Styles coming soon.
                </p>
              ) : (
                <div className="mt-5 flex flex-wrap gap-3">
                  {typedStyles.map((style) => (
                    <span
                      key={style.style_key}
                      className="rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700"
                    >
                      {style.display_name || style.style_key}
                    </span>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-[2rem] border border-slate-200/80 bg-white p-6 shadow-sm sm:p-8">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                Public offerings
              </h2>

              {typedOfferings.length === 0 ? (
                <p className="mt-4 text-sm text-slate-600">
                  Offerings coming soon.
                </p>
              ) : (
                <div className="mt-5 flex flex-wrap gap-3">
                  {typedOfferings.map((offering) => (
                    <span
                      key={offering.offering_key}
                      className="rounded-full bg-orange-50 px-4 py-2 text-sm font-medium text-orange-700"
                    >
                      {offering.display_name || offering.offering_key}
                    </span>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-[2rem] border border-slate-200/80 bg-white p-6 shadow-sm sm:p-8">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                    Upcoming public events
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    Organizer-published events currently visible to the public
                  </p>
                </div>

                <Link
                  href="/discover/events"
                  className="inline-flex rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Browse all events
                </Link>
              </div>

              {typedEvents.length === 0 ? (
                <div className="mt-6 rounded-2xl border border-dashed border-slate-300 px-5 py-8 text-sm text-slate-600">
                  No public events are listed right now.
                </div>
              ) : (
                <div className="mt-6 grid gap-5 md:grid-cols-2">
                  {typedEvents.map((event) => (
                    <article
                      key={event.id}
                      className="overflow-hidden rounded-[1.5rem] border border-slate-200/80 bg-slate-50"
                    >
                      <div className="h-44 bg-slate-100">
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

                      <div className="space-y-4 p-5">
                        <div className="flex flex-wrap gap-2">
                          <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                            {eventTypeLabel(event.event_type)}
                          </span>

                          <span className="inline-flex rounded-full bg-orange-50 px-3 py-1 text-xs font-medium text-orange-700">
                            {formatEventDateRange(event.start_date, event.end_date)}
                          </span>

                          {event.beginner_friendly ? (
                            <span className="inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
                              Beginner Friendly
                            </span>
                          ) : null}
                        </div>

                        <div>
                          <h3 className="text-lg font-semibold text-slate-950">
                            {event.name}
                          </h3>
                          <p className="mt-2 text-sm leading-6 text-slate-600">
                            {event.public_summary ||
                              event.public_description ||
                              "Public event details coming soon."}
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
          </div>

          <div className="space-y-8">
            <section className="rounded-[2rem] border border-slate-200/80 bg-white p-6 shadow-sm sm:p-8">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                Studio Info
              </h2>

              <div className="mt-6 space-y-5 text-sm text-slate-700">
                {location ? (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                      Location
                    </p>
                    <p className="mt-1 text-base text-slate-900">{location}</p>
                  </div>
                ) : null}

                {studio.public_phone ? (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                      Phone
                    </p>
                    <a
                      href={`tel:${studio.public_phone}`}
                      className="mt-1 inline-block text-base text-slate-900 hover:text-slate-700"
                    >
                      {studio.public_phone}
                    </a>
                  </div>
                ) : null}

                {studio.public_email ? (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                      Email
                    </p>
                    <a
                      href={`mailto:${studio.public_email}`}
                      className="mt-1 inline-block break-all text-base text-slate-900 hover:text-slate-700"
                    >
                      {studio.public_email}
                    </a>
                  </div>
                ) : null}

                {studio.public_website_url ? (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                      Website
                    </p>
                    <a
                      href={studio.public_website_url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block break-all text-base text-slate-900 hover:text-slate-700"
                    >
                      {normalizeWebsiteLabel(studio.public_website_url)}
                    </a>
                  </div>
                ) : null}

                {!location &&
                !studio.public_phone &&
                !studio.public_email &&
                !studio.public_website_url ? (
                  <p className="text-sm text-slate-600">
                    Public contact details coming soon.
                  </p>
                ) : null}
              </div>
            </section>

            <section
              id="inquiry-form"
              className="rounded-[2rem] border border-slate-200/80 bg-white p-6 shadow-sm sm:p-8"
            >
              {inquirySuccess ? (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-emerald-800">
                  Your inquiry has been sent successfully.
                </div>
              ) : (
                <>
                  <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                    Submit Inquiry
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Ask about beginner options, lessons, events, rentals, or
                    anything else before you visit.
                  </p>

                  <div className="mt-6">
                    <PublicLeadForm
                      studio={{
                        id: studio.id,
                        name: title,
                        slug: studioUrlSlug,
                        public_lead_enabled: studio.public_lead_enabled,
                        public_lead_headline: studio.public_lead_headline,
                        public_lead_description: studio.public_lead_description,
                        public_logo_url: studio.public_logo_url,
                        public_primary_color: studio.public_primary_color,
                        public_lead_cta_text: studio.public_lead_cta_text,
                      }}
                      successRedirect={`/studios/${encodeURIComponent(
                        studioUrlSlug
                      )}?inquiry=success`}
                    />
                  </div>
                </>
              )}
            </section>
          </div>
        </div>
      </section>
    </main>
  );
}