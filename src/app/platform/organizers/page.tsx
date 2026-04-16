import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";

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
};

type EventRow = {
  id: string;
  organizer_id: string | null;
  studio_id: string;
  status: string;
  visibility: string;
};

type RegistrationRow = {
  id: string;
  event_id: string;
  payment_status: string | null;
  total_amount: number | null;
};

type SearchParams = Promise<{
  q?: string;
  status?: string;
}>;

function formatDate(value: string | null) {
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

export default async function PlatformOrganizersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requirePlatformAdmin();

  const query = await searchParams;
  const q = (query.q ?? "").trim().toLowerCase();
  const statusFilter = (query.status ?? "").trim().toLowerCase();

  const supabase = await createClient();

  const [
    { data: organizers, error: organizersError },
    { data: studios, error: studiosError },
    { data: events, error: eventsError },
    { data: registrations, error: registrationsError },
  ] = await Promise.all([
    supabase
      .from("organizers")
      .select("id, studio_id, name, slug, active, created_at")
      .order("created_at", { ascending: false }),

    supabase.from("studios").select("id, name"),

    supabase.from("events").select("id, organizer_id, studio_id, status, visibility"),

    supabase.from("event_registrations").select("id, event_id, payment_status, total_amount"),
  ]);

  if (organizersError) {
    throw new Error(`Failed to load organizers: ${organizersError.message}`);
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

  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const typedStudios = (studios ?? []) as StudioRow[];
  const typedEvents = (events ?? []) as EventRow[];
  const typedRegistrations = (registrations ?? []) as RegistrationRow[];

  const studioById = new Map(typedStudios.map((studio) => [studio.id, studio]));

  const eventsByOrganizerId = new Map<string, EventRow[]>();
  for (const event of typedEvents) {
    if (!event.organizer_id) continue;
    const current = eventsByOrganizerId.get(event.organizer_id) ?? [];
    current.push(event);
    eventsByOrganizerId.set(event.organizer_id, current);
  }

  const registrationsByEventId = new Map<string, RegistrationRow[]>();
  for (const registration of typedRegistrations) {
    const current = registrationsByEventId.get(registration.event_id) ?? [];
    current.push(registration);
    registrationsByEventId.set(registration.event_id, current);
  }

  const filteredOrganizers = typedOrganizers.filter((organizer) => {
    if (statusFilter) {
      const organizerStatus = organizer.active ? "active" : "inactive";
      if (organizerStatus !== statusFilter) {
        return false;
      }
    }

    if (q) {
      const studio = studioById.get(organizer.studio_id);
      const haystack = [
        organizer.name,
        organizer.slug,
        studio?.name ?? "",
        organizer.active ? "active" : "inactive",
      ]
        .join(" ")
        .toLowerCase();

      if (!haystack.includes(q)) {
        return false;
      }
    }

    return true;
  });

  const totalOrganizers = typedOrganizers.length;
  const activeOrganizers = typedOrganizers.filter((organizer) => organizer.active).length;
  const organizersWithEvents = typedOrganizers.filter(
    (organizer) => (eventsByOrganizerId.get(organizer.id) ?? []).length > 0
  ).length;

  return (
    <div className="space-y-8">
      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Organizers</h1>
        <p className="mt-2 text-slate-600">
          Track organizer adoption, event publishing activity, registration volume, and public event usage across studios.
        </p>
      </div>

      <form className="rounded-2xl border bg-white p-5 shadow-sm">
        <div className="grid gap-4 md:grid-cols-[1fr_220px_auto]">
          <div>
            <label htmlFor="q" className="mb-1 block text-sm font-medium">
              Search organizers
            </label>
            <input
              id="q"
              name="q"
              defaultValue={query.q ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="Organizer name, slug, or studio"
            />
          </div>

          <div>
            <label htmlFor="status" className="mb-1 block text-sm font-medium">
              Status
            </label>
            <select
              id="status"
              name="status"
              defaultValue={query.status ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>

          <div className="flex items-end gap-3">
            <button
              type="submit"
              className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
            >
              Apply
            </button>

            <Link
              href="/platform/organizers"
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Reset
            </Link>
          </div>
        </div>
      </form>

      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Organizers</p>
          <p className="mt-2 text-3xl font-semibold">{totalOrganizers}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Active</p>
          <p className="mt-2 text-3xl font-semibold">{activeOrganizers}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">With Events</p>
          <p className="mt-2 text-3xl font-semibold">{organizersWithEvents}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Filtered Results</p>
          <p className="mt-2 text-3xl font-semibold">{filteredOrganizers.length}</p>
        </div>
      </div>

      <div className="rounded-2xl border bg-white shadow-sm">
        <div className="border-b px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">Organizer Directory</h2>
          <p className="mt-1 text-sm text-slate-500">
            Showing {filteredOrganizers.length} of {typedOrganizers.length} organizers.
          </p>
        </div>

        {filteredOrganizers.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-base font-medium text-slate-900">No organizers found</p>
            <p className="mt-2 text-sm text-slate-500">Adjust your filters and try again.</p>
          </div>
        ) : (
          <div className="overflow-hidden">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Organizer</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Studio</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Events</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Public Events</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">
                    Registrations
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Revenue</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {filteredOrganizers.map((organizer) => {
                  const studio = studioById.get(organizer.studio_id);
                  const organizerEvents = eventsByOrganizerId.get(organizer.id) ?? [];
                  const publicEvents = organizerEvents.filter(
                    (event) => event.status === "published" && event.visibility === "public"
                  ).length;

                  const organizerRegistrations = organizerEvents.flatMap(
                    (event) => registrationsByEventId.get(event.id) ?? []
                  );

                  const revenue = organizerRegistrations.reduce((sum, registration) => {
                    if (
                      registration.payment_status !== "paid" &&
                      registration.payment_status !== "partial"
                    ) {
                      return sum;
                    }
                    return sum + Number(registration.total_amount ?? 0);
                  }, 0);

                  return (
                    <tr key={organizer.id}>
                      <td className="px-4 py-4 text-slate-900">
                        <div>
                          <Link
                            href={`/platform/organizers/${organizer.id}`}
                            className="font-medium underline"
                          >
                            {organizer.name}
                          </Link>
                          <p className="mt-1 text-xs text-slate-500">{organizer.slug}</p>
                        </div>
                      </td>

                      <td className="px-4 py-4 text-slate-700">
                        {studio?.name ?? "Unknown studio"}
                      </td>

                      <td className="px-4 py-4 text-slate-700">
                        {organizer.active ? "Active" : "Inactive"}
                      </td>

                      <td className="px-4 py-4 text-slate-700">{organizerEvents.length}</td>

                      <td className="px-4 py-4 text-slate-700">{publicEvents}</td>

                      <td className="px-4 py-4 text-slate-700">
                        {organizerRegistrations.length}
                      </td>

                      <td className="px-4 py-4 text-slate-700">
                        {formatMoney(revenue, "USD")}
                      </td>

                      <td className="px-4 py-4 text-slate-700">
                        {formatDate(organizer.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}