import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type EventRow = {
  id: string;
  organizer_id: string | null;
  name: string;
  slug: string;
  event_type: string;
  city: string | null;
  state: string | null;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  visibility: string;
  featured: boolean;
  status: string;
  registration_required: boolean;
  beginner_friendly: boolean;
  public_directory_enabled: boolean;
  organizers:
    | { id?: string; name: string; slug: string }
    | { id?: string; name: string; slug: string }[]
    | null;
};

type RegistrationSummaryRow = {
  id: string;
  event_id: string;
  status: string;
  payment_status: string | null;
  total_price: number | null;
  total_amount: number | null;
  currency: string | null;
};

type AttendanceSummaryRow = {
  id: string;
  event_registration_id: string;
  status: string;
};

function statusBadgeClass(status: string) {
  if (status === "published" || status === "open") return "bg-green-50 text-green-700";
  if (status === "draft") return "bg-amber-50 text-amber-700";
  if (status === "cancelled") return "bg-red-50 text-red-700";
  if (status === "completed") return "bg-slate-100 text-slate-700";
  return "bg-slate-100 text-slate-700";
}

function eventTypeLabel(value: string) {
  if (value === "group_class") return "Group Class";
  if (value === "practice_party") return "Practice Party";
  if (value === "workshop") return "Workshop";
  if (value === "social_dance") return "Social Dance";
  if (value === "competition") return "Competition";
  if (value === "showcase") return "Showcase";
  if (value === "festival") return "Festival";
  if (value === "special_event") return "Special Event";
  if (value === "other") return "Other";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function eventTypeBadgeClass(value: string) {
  if (value === "group_class") return "bg-blue-50 text-blue-700";
  if (value === "practice_party") return "bg-amber-50 text-amber-700";
  if (value === "workshop") return "bg-violet-50 text-violet-700";
  if (value === "social_dance") return "bg-emerald-50 text-emerald-700";
  if (value === "competition") return "bg-red-50 text-red-700";
  if (value === "showcase") return "bg-fuchsia-50 text-fuchsia-700";
  if (value === "festival") return "bg-cyan-50 text-cyan-700";
  if (value === "special_event") return "bg-orange-50 text-orange-700";
  return "bg-slate-100 text-slate-700";
}

function visibilityLabel(value: string) {
  if (value === "public") return "Public";
  if (value === "unlisted") return "Unlisted";
  if (value === "private") return "Private";
  return value;
}

function visibilityBadgeClass(value: string) {
  if (value === "public") return "bg-green-50 text-green-700";
  if (value === "unlisted") return "bg-amber-50 text-amber-700";
  if (value === "private") return "bg-slate-100 text-slate-700";
  return "bg-slate-100 text-slate-700";
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

function formatTimeRange(startTime: string | null, endTime: string | null) {
  if (!startTime && !endTime) return "Time not set";
  if (!startTime || !endTime) return startTime || endTime || "Time not set";

  const start = new Date(`2000-01-01T${startTime}`);
  const end = new Date(`2000-01-01T${endTime}`);

  const startText = start.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  const endText = end.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  return `${startText} - ${endText}`;
}

function getOrganizer(
  value:
    | { id?: string; name: string; slug: string }
    | { id?: string; name: string; slug: string }[]
    | null
) {
  return Array.isArray(value) ? value[0] : value;
}

function eventListingHint(eventType: string, visibility: string) {
  const publicHint =
    visibility === "public"
      ? "Shown in public offerings."
      : visibility === "unlisted"
        ? "Available by direct link only."
        : "Internal/private only.";

  if (eventType === "group_class") {
    return `Class offering managed as an event. ${publicHint}`;
  }

  if (eventType === "practice_party") {
    return `Practice party managed as an event. ${publicHint}`;
  }

  return publicHint;
}

function fmtCurrency(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(value);
}

export default async function EventsPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const { data: events, error: eventsError } = await supabase
    .from("events")
    .select(`
      id,
      organizer_id,
      name,
      slug,
      event_type,
      city,
      state,
      start_date,
      end_date,
      start_time,
      end_time,
      visibility,
      featured,
      status,
      registration_required,
      beginner_friendly,
      public_directory_enabled,
      organizers ( id, name, slug )
    `)
    .eq("studio_id", studioId)
    .order("start_date", { ascending: true })
    .order("start_time", { ascending: true })
    .order("name", { ascending: true });

  if (eventsError) {
    throw new Error(`Failed to load events: ${eventsError.message}`);
  }

  const typedEvents = (events ?? []) as EventRow[];
  const eventIds = typedEvents.map((event) => event.id);

  let typedRegistrations: RegistrationSummaryRow[] = [];
  let typedAttendance: AttendanceSummaryRow[] = [];

  if (eventIds.length > 0) {
    const [{ data: registrationRows, error: registrationsError }, { data: attendanceRows, error: attendanceError }] =
      await Promise.all([
        supabase
          .from("event_registrations")
          .select(`
            id,
            event_id,
            status,
            payment_status,
            total_price,
            total_amount,
            currency
          `)
          .in("event_id", eventIds),

        supabase
          .from("attendance_records")
          .select(`
            id,
            event_registration_id,
            status
          `),
      ]);

    if (registrationsError) {
      throw new Error(`Failed to load event reporting: ${registrationsError.message}`);
    }

    if (attendanceError) {
      throw new Error(`Failed to load attendance reporting: ${attendanceError.message}`);
    }

    typedRegistrations = (registrationRows ?? []) as RegistrationSummaryRow[];
    typedAttendance = (attendanceRows ?? []) as AttendanceSummaryRow[];
  }

  const attendanceByRegistrationId = new Map(
    typedAttendance.map((row) => [row.event_registration_id, row])
  );

  const registrationsByEventId = new Map<string, RegistrationSummaryRow[]>();
  for (const registration of typedRegistrations) {
    const current = registrationsByEventId.get(registration.event_id) ?? [];
    current.push(registration);
    registrationsByEventId.set(registration.event_id, current);
  }

  const groupClasses = typedEvents.filter((event) => event.event_type === "group_class");
  const publishedCount = typedEvents.filter(
    (event) => event.status === "published" || event.status === "open"
  ).length;
  const featuredCount = typedEvents.filter((event) => event.featured).length;
  const publicOfferingsCount = typedEvents.filter(
    (event) =>
      (event.status === "published" || event.status === "open") &&
      event.visibility === "public"
  ).length;
  const publicGroupClassesCount = groupClasses.filter(
    (event) =>
      (event.status === "published" || event.status === "open") &&
      event.visibility === "public"
  ).length;
  const publicDirectoryCount = typedEvents.filter(
    (event) => event.public_directory_enabled
  ).length;
  const discoveryReadyCount = typedEvents.filter(
    (event) =>
      event.public_directory_enabled &&
      event.visibility === "public" &&
      (event.status === "published" || event.status === "open") &&
      Boolean(event.organizer_id)
  ).length;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">Events</h2>
          <p className="mt-2 text-slate-600">
            Manage public and internal offerings like group classes, practice parties, workshops, socials, and special events.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link
            href="/app"
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Back to Dashboard
          </Link>

          <Link
            href="/app/events/new"
            className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
          >
            New Event
          </Link>
        </div>
      </div>

      <div className="rounded-2xl border border-blue-200 bg-blue-50 p-5">
        <h3 className="text-lg font-semibold text-blue-900">Group Classes Live Here</h3>
        <p className="mt-2 text-sm text-blue-800">
          Group classes are managed as events, not standard appointments. Use visibility
          settings to control whether a class is public, unlisted, or private.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-4 xl:grid-cols-6">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Total Events</p>
          <p className="mt-2 text-3xl font-semibold">{typedEvents.length}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Group Classes</p>
          <p className="mt-2 text-3xl font-semibold">{groupClasses.length}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Published / Open</p>
          <p className="mt-2 text-3xl font-semibold">{publishedCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Public Offerings</p>
          <p className="mt-2 text-3xl font-semibold">{publicOfferingsCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Directory Enabled</p>
          <p className="mt-2 text-3xl font-semibold">{publicDirectoryCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Discovery Ready</p>
          <p className="mt-2 text-3xl font-semibold">{discoveryReadyCount}</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Public Group Classes</p>
          <p className="mt-2 text-3xl font-semibold">{publicGroupClassesCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Featured Events</p>
          <p className="mt-2 text-3xl font-semibold">{featuredCount}</p>
        </div>
      </div>

      <div className="rounded-2xl border bg-white shadow-sm">
        <div className="border-b px-6 py-4">
          <h3 className="text-lg font-semibold text-slate-900">Event Listings</h3>
        </div>

        {typedEvents.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-base font-medium text-slate-900">
              No events yet
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Create your first event offering to start publishing classes, socials, and special events.
            </p>

            <div className="mt-6">
              <Link
                href="/app/events/new"
                className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
              >
                Create Event
              </Link>
            </div>
          </div>
        ) : (
          <div className="divide-y">
            {typedEvents.map((event) => {
              const organizer = getOrganizer(event.organizers);
              const discoveryReady =
                event.public_directory_enabled &&
                event.visibility === "public" &&
                (event.status === "published" || event.status === "open") &&
                Boolean(event.organizer_id);

              const eventRegistrations = registrationsByEventId.get(event.id) ?? [];
              const defaultCurrency =
                eventRegistrations.find((row) => row.currency)?.currency ?? "USD";

              const totalRegistrations = eventRegistrations.length;
              const paidCount = eventRegistrations.filter((row) => row.payment_status === "paid").length;
              const pendingPaymentCount = eventRegistrations.filter(
                (row) => row.payment_status === "pending"
              ).length;
              const checkedInCount = eventRegistrations.filter((row) => {
                const attendance = attendanceByRegistrationId.get(row.id);
                return attendance?.status === "checked_in" || attendance?.status === "attended";
              }).length;
              const grossRevenue = eventRegistrations.reduce((sum, row) => {
                if (row.payment_status !== "paid" && row.payment_status !== "partial") {
                  return sum;
                }
                return sum + Number(row.total_amount ?? row.total_price ?? 0);
              }, 0);

              return (
                <div key={event.id} className="px-6 py-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-lg font-semibold text-slate-900">
                          {event.name}
                        </h4>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                            event.status
                          )}`}
                        >
                          {event.status}
                        </span>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${eventTypeBadgeClass(
                            event.event_type
                          )}`}
                        >
                          {eventTypeLabel(event.event_type)}
                        </span>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${visibilityBadgeClass(
                            event.visibility
                          )}`}
                        >
                          {visibilityLabel(event.visibility)}
                        </span>

                        {event.featured ? (
                          <span className="inline-flex rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700">
                            Featured
                          </span>
                        ) : null}

                        {event.registration_required ? (
                          <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                            Registration Required
                          </span>
                        ) : null}
                      </div>

                      <div className="mt-2 flex flex-wrap gap-2">
                        {event.public_directory_enabled ? (
                          <span className="inline-flex rounded-full bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700">
                            Public Directory On
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                            Public Directory Off
                          </span>
                        )}

                        {event.beginner_friendly ? (
                          <span className="inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
                            Beginner Friendly
                          </span>
                        ) : null}

                        {organizer ? (
                          <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                            Organizer Linked
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
                            No Organizer
                          </span>
                        )}

                        {discoveryReady ? (
                          <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                            Discovery Ready
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
                            Needs Discovery Setup
                          </span>
                        )}
                      </div>

                      <p className="mt-2 text-sm text-slate-500">
                        Organizer: {organizer?.name ?? "None"} • /events/{event.slug}
                      </p>

                      <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-500">
                        <span>{formatDateRange(event.start_date, event.end_date)}</span>
                        <span>{formatTimeRange(event.start_time, event.end_time)}</span>
                        <span>
                          {[event.city, event.state].filter(Boolean).join(", ") || "No location"}
                        </span>
                      </div>

                      <p className="mt-3 text-sm text-slate-600">
                        {eventListingHint(event.event_type, event.visibility)}
                      </p>

                      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                        <div className="rounded-xl border bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">Registrations</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {totalRegistrations}
                          </p>
                        </div>

                        <div className="rounded-xl border bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">Paid</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {paidCount}
                          </p>
                        </div>

                        <div className="rounded-xl border bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">Pending Pay</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {pendingPaymentCount}
                          </p>
                        </div>

                        <div className="rounded-xl border bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">Checked In</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {checkedInCount}
                          </p>
                        </div>

                        <div className="rounded-xl border bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">Gross Revenue</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {fmtCurrency(grossRevenue, defaultCurrency)}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="shrink-0">
                      <Link
                        href={`/app/events/${event.id}`}
                        className="rounded-xl border px-4 py-2 hover:bg-slate-50"
                      >
                        View Event
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}