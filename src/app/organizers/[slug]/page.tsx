import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type Params = Promise<{
  slug: string;
}>;

type OrganizerRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  logo_url: string | null;
  cover_image_url: string | null;
  website_url: string | null;
  city: string | null;
  state: string | null;
  active: boolean;
};

type EventRow = {
  id: string;
  name: string;
  slug: string;
  event_type: string;
  short_description: string | null;
  city: string | null;
  state: string | null;
  start_date: string;
  end_date: string;
  featured: boolean;
  cover_image_url: string | null;
};

type EventTagRow = {
  event_id: string;
  tag: string;
};

function eventTypeLabel(value: string) {
  if (value === "social_dance") return "Social Dance";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDateRange(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  const startText = start.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const endText = end.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return startDate === endDate ? startText : `${startText} - ${endText}`;
}

export default async function PublicOrganizerProfilePage({
  params,
}: {
  params: Params;
}) {
  const { slug } = await params;
  const supabase = await createClient();

  const { data: organizer, error: organizerError } = await supabase
    .from("organizers")
    .select(`
      id,
      name,
      slug,
      description,
      contact_email,
      contact_phone,
      logo_url,
      cover_image_url,
      website_url,
      city,
      state,
      active
    `)
    .eq("slug", slug)
    .eq("active", true)
    .single();

  if (organizerError || !organizer) {
    notFound();
  }

  const typedOrganizer = organizer as OrganizerRow;

  const { data: events, error: eventsError } = await supabase
    .from("events")
    .select(`
      id,
      name,
      slug,
      event_type,
      short_description,
      city,
      state,
      start_date,
      end_date,
      featured,
      cover_image_url
    `)
    .eq("organizer_id", typedOrganizer.id)
    .eq("status", "published")
    .in("visibility", ["public", "unlisted"])
    .order("featured", { ascending: false })
    .order("start_date", { ascending: true })
    .order("name", { ascending: true });

  if (eventsError) {
    throw new Error(`Failed to load organizer events: ${eventsError.message}`);
  }

  const typedEvents = (events ?? []) as EventRow[];
  const eventIds = typedEvents.map((event) => event.id);

  const { data: tagsRows, error: tagsError } = eventIds.length
    ? await supabase
        .from("event_tags")
        .select("event_id, tag")
        .in("event_id", eventIds)
        .order("tag", { ascending: true })
    : { data: [], error: null };

  if (tagsError) {
    throw new Error(`Failed to load organizer event tags: ${tagsError.message}`);
  }

  const typedTags = (tagsRows ?? []) as EventTagRow[];
  const tagsByEvent = new Map<string, string[]>();

  for (const row of typedTags) {
    const current = tagsByEvent.get(row.event_id) ?? [];
    current.push(row.tag);
    tagsByEvent.set(row.event_id, current);
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-10 sm:px-6 lg:px-8">
      <div className="overflow-hidden rounded-3xl border bg-white shadow-sm">
        <div className="aspect-[16/6] w-full bg-slate-100">
          {typedOrganizer.cover_image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={typedOrganizer.cover_image_url}
              alt={typedOrganizer.name}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
              No cover image
            </div>
          )}
        </div>

        <div className="p-6 sm:p-8">
          <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-4">
                {typedOrganizer.logo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={typedOrganizer.logo_url}
                    alt={`${typedOrganizer.name} logo`}
                    className="h-16 w-16 rounded-2xl border object-cover"
                  />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl border bg-slate-50 text-lg font-semibold text-slate-500">
                    {typedOrganizer.name.slice(0, 1).toUpperCase()}
                  </div>
                )}

                <div>
                  <h1 className="text-4xl font-semibold tracking-tight text-slate-900">
                    {typedOrganizer.name}
                  </h1>
                  <p className="mt-2 text-slate-600">
                    {[typedOrganizer.city, typedOrganizer.state].filter(Boolean).join(", ") ||
                      "Organizer profile"}
                  </p>
                </div>
              </div>

              <p className="mt-6 max-w-3xl whitespace-pre-wrap text-sm leading-6 text-slate-700">
                {typedOrganizer.description || "No organizer description provided."}
              </p>
            </div>

            <div className="w-full max-w-sm space-y-3 rounded-2xl border bg-slate-50 p-5">
              <div>
                <p className="text-sm text-slate-500">Published Events</p>
                <p className="mt-1 text-3xl font-semibold text-slate-900">
                  {typedEvents.length}
                </p>
              </div>

              {typedOrganizer.website_url ? (
                <a
                  href={typedOrganizer.website_url}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-xl border bg-white px-4 py-2 text-center hover:bg-slate-50"
                >
                  Visit Website
                </a>
              ) : null}

              {typedOrganizer.contact_email ? (
                <a
                  href={`mailto:${typedOrganizer.contact_email}`}
                  className="block rounded-xl border bg-white px-4 py-2 text-center hover:bg-slate-50"
                >
                  Email Organizer
                </a>
              ) : null}

              <Link
                href="/events"
                className="block rounded-xl border bg-white px-4 py-2 text-center hover:bg-slate-50"
              >
                Browse All Events
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-2xl font-semibold text-slate-900">
                Upcoming Events
              </h2>
              <Link href="/events" className="text-sm underline">
                View all events
              </Link>
            </div>

            {typedEvents.length === 0 ? (
              <div className="mt-6 rounded-2xl border bg-slate-50 px-6 py-12 text-center">
                <p className="text-base font-medium text-slate-900">
                  No published events yet
                </p>
                <p className="mt-2 text-sm text-slate-500">
                  Check back later for upcoming workshops, socials, and more.
                </p>
              </div>
            ) : (
              <div className="mt-6 space-y-4">
                {typedEvents.map((event) => {
                  const eventTags = tagsByEvent.get(event.id) ?? [];

                  return (
                    <Link
                      key={event.id}
                      href={`/events/${event.slug}`}
                      className="block overflow-hidden rounded-2xl border bg-white transition hover:shadow-sm"
                    >
                      <div className="flex flex-col gap-0 md:flex-row">
                        <div className="h-48 w-full bg-slate-100 md:h-auto md:w-64 md:flex-none">
                          {event.cover_image_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={event.cover_image_url}
                              alt={event.name}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full items-center justify-center text-sm text-slate-500">
                              No image
                            </div>
                          )}
                        </div>

                        <div className="flex-1 p-5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                              {eventTypeLabel(event.event_type)}
                            </span>

                            {event.featured ? (
                              <span className="inline-flex rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700">
                                Featured
                              </span>
                            ) : null}
                          </div>

                          <h3 className="mt-3 text-xl font-semibold text-slate-900">
                            {event.name}
                          </h3>

                          <div className="mt-3 space-y-1 text-sm text-slate-600">
                            <p>{formatDateRange(event.start_date, event.end_date)}</p>
                            <p>
                              {[event.city, event.state].filter(Boolean).join(", ") ||
                                "Location TBD"}
                            </p>
                          </div>

                          <p className="mt-4 line-clamp-3 text-sm text-slate-600">
                            {event.short_description || "No description provided."}
                          </p>

                          {eventTags.length > 0 ? (
                            <div className="mt-4 flex flex-wrap gap-2">
                              {eventTags.slice(0, 4).map((item) => (
                                <span
                                  key={item}
                                  className="inline-flex rounded-full bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200"
                                >
                                  {item}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-semibold text-slate-900">Organizer Info</h2>

            <div className="mt-4 space-y-4">
              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Location</p>
                <p className="mt-1 font-medium text-slate-900">
                  {[typedOrganizer.city, typedOrganizer.state].filter(Boolean).join(", ") ||
                    "Not provided"}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Email</p>
                <p className="mt-1 font-medium text-slate-900">
                  {typedOrganizer.contact_email || "Not provided"}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Phone</p>
                <p className="mt-1 font-medium text-slate-900">
                  {typedOrganizer.contact_phone || "Not provided"}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-semibold text-slate-900">Quick Links</h2>

            <div className="mt-4 grid gap-3">
              <Link
                href="/events"
                className="rounded-xl border px-4 py-3 hover:bg-slate-50"
              >
                Browse All Events
              </Link>

              {typedOrganizer.website_url ? (
                <a
                  href={typedOrganizer.website_url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-xl border px-4 py-3 hover:bg-slate-50"
                >
                  Visit Organizer Website
                </a>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}