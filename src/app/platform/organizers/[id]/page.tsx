import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";

type Params = Promise<{
  id: string;
}>;

type OrganizerRow = {
  id: string;
  studio_id: string;
  name: string;
  slug: string;
  active: boolean;
  created_at: string;
};

type StudioRow = {
  id: string;
  name: string;
  created_at: string;
};

type EventRow = {
  id: string;
  organizer_id: string | null;
  studio_id: string;
  name: string;
  slug: string;
  status: string;
  visibility: string;
  event_type: string;
  start_date: string;
  created_at: string;
};

type RegistrationRow = {
  id: string;
  event_id: string;
  payment_status: string | null;
  total_amount: number | null;
  created_at: string;
};

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.NumberFormat("en-US");
}

function formatDateLabel(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatMoney(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
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
  return value.replaceAll("_", " ");
}

export default async function PlatformOrganizerDetailPage({
  params,
}: {
  params: Params;
}) {
  await requirePlatformAdmin();

  const { id } = await params;
  const supabase = await createClient();

  const [
    { data: organizer, error: organizerError },
    { data: studios, error: studiosError },
    { data: events, error: eventsError },
    { data: registrations, error: registrationsError },
  ] = await Promise.all([
    supabase
      .from("organizers")
      .select("id, studio_id, name, slug, active, created_at")
      .eq("id", id)
      .maybeSingle(),

    supabase.from("studios").select("id, name, created_at"),

    supabase
      .from("events")
      .select(
        "id, organizer_id, studio_id, name, slug, status, visibility, event_type, start_date, created_at"
      )
      .eq("organizer_id", id)
      .order("created_at", { ascending: false }),

    supabase
      .from("event_registrations")
      .select("id, event_id, payment_status, total_amount, created_at"),
  ]);

  if (organizerError) {
    throw new Error(`Failed to load organizer: ${organizerError.message}`);
  }

  if (!organizer) {
    notFound();
  }

  if (studiosError) {
    throw new Error(`Failed to load studios: ${studiosError.message}`);
  }

  if (eventsError) {
    throw new Error(`Failed to load events: ${eventsError.message}`);
  }

  if (registrationsError) {
    throw new Error(`Failed to load registrations: ${registrationsError.message}`);
  }

  const typedOrganizer = organizer as OrganizerRow;
  const typedStudios = (studios ?? []) as StudioRow[];
  const typedEvents = (events ?? []) as EventRow[];
  const typedRegistrations = (registrations ?? []) as RegistrationRow[];

  const studio = typedStudios.find((item) => item.id === typedOrganizer.studio_id) ?? null;
  const organizerEventIds = new Set(typedEvents.map((event) => event.id));
  const organizerRegistrations = typedRegistrations.filter((registration) =>
    organizerEventIds.has(registration.event_id)
  );

  const publicEvents = typedEvents.filter(
    (event) => event.status === "published" && event.visibility === "public"
  ).length;

  const paidRegistrations = organizerRegistrations.filter(
    (registration) => registration.payment_status === "paid"
  ).length;

  const grossRevenue = organizerRegistrations.reduce((sum, registration) => {
    if (
      registration.payment_status !== "paid" &&
      registration.payment_status !== "partial"
    ) {
      return sum;
    }
    return sum + Number(registration.total_amount ?? 0);
  }, 0);

  const upcomingEvents = [...typedEvents]
    .filter((event) => new Date(`${event.start_date}T00:00:00`).getTime() >= Date.now() - 86400000)
    .sort(
      (a, b) =>
        new Date(`${a.start_date}T00:00:00`).getTime() -
        new Date(`${b.start_date}T00:00:00`).getTime()
    )
    .slice(0, 8);

  const recentEvents = typedEvents.slice(0, 8);

  return (
    <div className="space-y-8">
      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
          {typedOrganizer.name}
        </h1>
        <p className="mt-2 text-slate-600">
          Organizer detail, studio association, event publishing, registrations, and revenue.
        </p>
        <p className="mt-2 text-xs text-slate-500">{typedOrganizer.slug}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Status</p>
          <p className="mt-2">
            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                typedOrganizer.active
                  ? "bg-green-50 text-green-700"
                  : "bg-slate-100 text-slate-700"
              }`}
            >
              {typedOrganizer.active ? "Active" : "Inactive"}
            </span>
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Studio</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">
            {studio?.name ?? "Unknown"}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Events</p>
          <p className="mt-2 text-3xl font-semibold">{typedEvents.length}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Public Events</p>
          <p className="mt-2 text-3xl font-semibold">{publicEvents}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Registrations</p>
          <p className="mt-2 text-3xl font-semibold">{organizerRegistrations.length}</p>
          <p className="mt-1 text-sm text-slate-500">{paidRegistrations} paid</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Revenue</p>
          <p className="mt-2 text-3xl font-semibold">{formatMoney(grossRevenue)}</p>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Organizer Overview</h2>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Created</p>
              <p className="mt-1 font-medium text-slate-900">
                {formatDateLabel(typedOrganizer.created_at)}
              </p>
            </div>

            <div className="rounded-xl border bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Studio Created</p>
              <p className="mt-1 font-medium text-slate-900">
                {formatDateLabel(studio?.created_at ?? null)}
              </p>
            </div>

            <div className="rounded-xl border bg-slate-50 p-4 md:col-span-2">
              <p className="text-sm text-slate-500">Adoption</p>
              <p className="mt-1 font-medium text-slate-900">
                {publicEvents} public published events • {organizerRegistrations.length} registrations
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Upcoming Events</h2>

          {upcomingEvents.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500">
              No upcoming events.
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {upcomingEvents.map((event) => (
                <div key={event.id} className="rounded-xl border bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-slate-900">{event.name}</p>
                      <p className="mt-1 text-sm text-slate-500">
                        {eventTypeLabel(event.event_type)} • {event.visibility} • {event.status}
                      </p>
                    </div>

                    <p className="text-sm text-slate-500">{formatDateLabel(event.start_date)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">Recent Events</h2>

        {recentEvents.length === 0 ? (
          <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500">
            No events yet.
          </div>
        ) : (
          <div className="mt-5 overflow-hidden rounded-xl border">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Event</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Type</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Visibility</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Start</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {recentEvents.map((event) => (
                  <tr key={event.id}>
                    <td className="px-4 py-4 text-slate-900">
                      <div>
                        <p className="font-medium">{event.name}</p>
                        <p className="mt-1 text-xs text-slate-500">{event.slug}</p>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-slate-700">{eventTypeLabel(event.event_type)}</td>
                    <td className="px-4 py-4 text-slate-700">{event.visibility}</td>
                    <td className="px-4 py-4 text-slate-700">{event.status}</td>
                    <td className="px-4 py-4 text-slate-700">{formatDateLabel(event.start_date)}</td>
                    <td className="px-4 py-4 text-slate-700">{formatDateLabel(event.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {studio ? (
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Related Studio</h2>
          <div className="mt-4">
            <Link
              href={`/platform/studios/${studio.id}`}
              className="font-medium underline text-slate-900"
            >
              {studio.name}
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}