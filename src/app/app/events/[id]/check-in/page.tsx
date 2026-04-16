import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireStudioFeature } from "@/lib/billing/access";
import { checkInEventRegistrationAction } from "../registrations/actions";

type Params = Promise<{
  id: string;
}>;

type SearchParams = Promise<{
  q?: string;
  status?: string;
  success?: string;
  error?: string;
}>;

type EventRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  visibility: string;
  organizers:
    | { name: string; slug: string }
    | { name: string; slug: string }[]
    | null;
};

type RegistrationRow = {
  id: string;
  status: string;
  attendee_first_name: string;
  attendee_last_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  checked_in_at: string | null;
  created_at: string;
  event_ticket_types:
    | { name: string; ticket_kind: string }
    | { name: string; ticket_kind: string }[]
    | null;
};

type AttendanceRow = {
  id: string;
  event_registration_id: string;
  status: string;
  checked_in_at: string | null;
};

function getOrganizer(
  value:
    | { name: string; slug: string }
    | { name: string; slug: string }[]
    | null
) {
  return Array.isArray(value) ? value[0] : value;
}

function getTicketTypeName(
  value:
    | { name: string; ticket_kind: string }
    | { name: string; ticket_kind: string }[]
    | null
) {
  const ticket = Array.isArray(value) ? value[0] : value;
  return ticket?.name ?? "No ticket type";
}

function getTicketKind(
  value:
    | { name: string; ticket_kind: string }
    | { name: string; ticket_kind: string }[]
    | null
) {
  const ticket = Array.isArray(value) ? value[0] : value;
  return ticket?.ticket_kind ?? "other";
}

function kindLabel(value: string) {
  if (value === "general_admission") return "General Admission";
  if (value === "vip") return "VIP";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusBadgeClass(status: string) {
  if (status === "registered") return "bg-green-50 text-green-700";
  if (status === "confirmed") return "bg-green-50 text-green-700";
  if (status === "pending") return "bg-amber-50 text-amber-700";
  if (status === "waitlisted") return "bg-blue-50 text-blue-700";
  if (status === "cancelled") return "bg-red-50 text-red-700";
  if (status === "checked_in") return "bg-indigo-50 text-indigo-700";
  if (status === "attended") return "bg-emerald-50 text-emerald-700";
  if (status === "no_show") return "bg-orange-50 text-orange-700";
  return "bg-slate-100 text-slate-700";
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function buildCheckInHref(params: {
  eventId: string;
  q?: string;
  status?: string;
}) {
  const search = new URLSearchParams();

  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);

  const query = search.toString();
  return query
    ? `/app/events/${params.eventId}/check-in?${query}`
    : `/app/events/${params.eventId}/check-in`;
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

function getBanner(search: { success?: string; error?: string; q?: string }) {
  if (search.success === "checked_in") {
    return {
      kind: "success" as const,
      message: search.q
        ? `Attendee checked in. Search kept for "${search.q}".`
        : "Attendee checked in.",
    };
  }

  if (search.success === "already_checked_in") {
    return {
      kind: "success" as const,
      message: "Attendee was already checked in.",
    };
  }

  if (search.error === "cannot_check_in_cancelled") {
    return {
      kind: "error" as const,
      message: "Cancelled registrations cannot be checked in.",
    };
  }

  if (search.error === "checkin_failed") {
    return {
      kind: "error" as const,
      message: "Could not check in attendee.",
    };
  }

  return null;
}

export default async function EventCheckInPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  await requireStudioFeature("check_in");

  const { id } = await params;
  const query = await searchParams;
  const q = (query.q ?? "").trim().toLowerCase();
  const statusFilter = (query.status ?? "ready").trim().toLowerCase();
  const banner = getBanner(query);

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: roleRow, error: roleError } = await supabase
    .from("user_studio_roles")
    .select("studio_id")
    .eq("user_id", user.id)
    .eq("active", true)
    .limit(1)
    .single();

  if (roleError || !roleRow) {
    redirect("/login");
  }

  const studioId = roleRow.studio_id as string;

  const [
    { data: event, error: eventError },
    { data: registrations, error: registrationsError },
  ] = await Promise.all([
    supabase
      .from("events")
      .select(`
        id,
        name,
        slug,
        status,
        visibility,
        organizers ( name, slug )
      `)
      .eq("id", id)
      .eq("studio_id", studioId)
      .single(),
    supabase
      .from("event_registrations")
      .select(`
        id,
        status,
        attendee_first_name,
        attendee_last_name,
        attendee_email,
        attendee_phone,
        checked_in_at,
        created_at,
        event_ticket_types ( name, ticket_kind )
      `)
      .eq("event_id", id)
      .order("created_at", { ascending: true }),
  ]);

  if (eventError || !event) {
    notFound();
  }

  if (registrationsError) {
    throw new Error(`Failed to load registrations: ${registrationsError.message}`);
  }

  const typedEvent = event as EventRow;
  const typedRegistrations = (registrations ?? []) as RegistrationRow[];
  const organizer = getOrganizer(typedEvent.organizers);

  const registrationIds = typedRegistrations.map((item) => item.id);

  let attendanceByRegistrationId = new Map<string, AttendanceRow>();

  if (registrationIds.length > 0) {
    const { data: attendanceRows, error: attendanceError } = await supabase
      .from("attendance_records")
      .select(`
        id,
        event_registration_id,
        status,
        checked_in_at
      `)
      .eq("studio_id", studioId)
      .in("event_registration_id", registrationIds);

    if (attendanceError) {
      throw new Error(`Failed to load attendance records: ${attendanceError.message}`);
    }

    const typedAttendanceRows = (attendanceRows ?? []) as AttendanceRow[];
    attendanceByRegistrationId = new Map(
      typedAttendanceRows.map((row) => [row.event_registration_id, row])
    );
  }

  const getEffectiveStatus = (registration: RegistrationRow) => {
    const attendance = attendanceByRegistrationId.get(registration.id);
    if (attendance?.status) return attendance.status;
    if (registration.status === "confirmed") return "registered";
    return registration.status;
  };

  const filteredRegistrations = typedRegistrations
    .filter((registration) => {
      const effectiveStatus = getEffectiveStatus(registration);

      if (statusFilter === "ready") {
        return effectiveStatus === "registered";
      }
      if (statusFilter === "checked_in") {
        return effectiveStatus === "checked_in" || effectiveStatus === "attended";
      }
      if (statusFilter === "cancelled") {
        return effectiveStatus === "cancelled";
      }
      if (statusFilter === "all") {
        return true;
      }
      return effectiveStatus === "registered";
    })
    .filter((registration) => {
      if (!q) return true;

      const fullName =
        `${registration.attendee_first_name} ${registration.attendee_last_name}`.toLowerCase();

      return (
        fullName.includes(q) ||
        registration.attendee_email.toLowerCase().includes(q) ||
        (registration.attendee_phone ?? "").toLowerCase().includes(q)
      );
    });

  const readyCount = typedRegistrations.filter(
    (registration) => getEffectiveStatus(registration) === "registered"
  ).length;
  const checkedInCount = typedRegistrations.filter((registration) => {
    const effectiveStatus = getEffectiveStatus(registration);
    return effectiveStatus === "checked_in" || effectiveStatus === "attended";
  }).length;
  const cancelledCount = typedRegistrations.filter(
    (registration) => getEffectiveStatus(registration) === "cancelled"
  ).length;

  return (
    <div className="space-y-8">
      {banner ? (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            banner.kind === "success"
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {banner.message}
        </div>
      ) : null}

      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-500">
              {organizer?.name ?? "Organizer"}
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900">
              Check-In Mode
            </h1>
            <p className="mt-2 text-slate-600">{typedEvent.name}</p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href={`/app/events/${typedEvent.id}`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Back to Event
            </Link>

            <Link
              href={`/app/events/${typedEvent.id}/registrations`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Registrations
            </Link>

            <Link
              href={`/events/${typedEvent.slug}`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Public Event Page
            </Link>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Ready to Check In</p>
          <p className="mt-2 text-3xl font-semibold">{readyCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Checked In</p>
          <p className="mt-2 text-3xl font-semibold">{checkedInCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Cancelled</p>
          <p className="mt-2 text-3xl font-semibold">{cancelledCount}</p>
        </div>
      </div>

      <form className="rounded-2xl border bg-white p-5 shadow-sm">
        <div className="grid gap-4 md:grid-cols-[1fr_220px_auto]">
          <div>
            <label htmlFor="q" className="mb-1 block text-sm font-medium">
              Search attendee
            </label>
            <input
              id="q"
              name="q"
              defaultValue={query.q ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="Name, email, or phone"
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="status" className="mb-1 block text-sm font-medium">
              View
            </label>
            <select
              id="status"
              name="status"
              defaultValue={statusFilter}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="ready">Ready to Check In</option>
              <option value="checked_in">Checked In</option>
              <option value="cancelled">Cancelled</option>
              <option value="all">All</option>
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
              href={`/app/events/${typedEvent.id}/check-in`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Reset
            </Link>
          </div>
        </div>
      </form>

      <div className="grid gap-4">
        {filteredRegistrations.length === 0 ? (
          <div className="rounded-2xl border bg-white px-6 py-12 text-center shadow-sm">
            <p className="text-base font-medium text-slate-900">No attendees found</p>
            <p className="mt-2 text-sm text-slate-500">
              Try a different search or filter.
            </p>
          </div>
        ) : (
          filteredRegistrations.map((registration) => {
            const attendance = attendanceByRegistrationId.get(registration.id) ?? null;
            const effectiveStatus = getEffectiveStatus(registration);
            const effectiveCheckedInAt = attendance?.checked_in_at ?? registration.checked_in_at;

            const fullName =
              `${registration.attendee_first_name} ${registration.attendee_last_name}`.trim();
            const ticketTypeName = getTicketTypeName(registration.event_ticket_types);
            const ticketKind = getTicketKind(registration.event_ticket_types);
            const canCheckIn = effectiveStatus === "registered";
            const returnTo = appendQueryParam(
              appendQueryParam(
                buildCheckInHref({
                  eventId: typedEvent.id,
                  q: query.q ?? "",
                  status: statusFilter,
                }),
                "q",
                query.q ?? ""
              ),
              "status",
              statusFilter
            );

            return (
              <div key={registration.id} className="rounded-2xl border bg-white p-5 shadow-sm">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-2xl font-semibold text-slate-900">{fullName}</h3>

                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                          effectiveStatus
                        )}`}
                      >
                        {effectiveStatus}
                      </span>

                      <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                        {ticketTypeName}
                      </span>

                      <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                        {kindLabel(ticketKind)}
                      </span>
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                      <div className="rounded-xl border bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Email</p>
                        <p className="mt-1 break-words font-medium text-slate-900">
                          {registration.attendee_email}
                        </p>
                      </div>

                      <div className="rounded-xl border bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Phone</p>
                        <p className="mt-1 font-medium text-slate-900">
                          {registration.attendee_phone || "—"}
                        </p>
                      </div>

                      <div className="rounded-xl border bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Registered</p>
                        <p className="mt-1 font-medium text-slate-900">
                          {formatDateTime(registration.created_at)}
                        </p>
                      </div>

                      <div className="rounded-xl border bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Checked In</p>
                        <p className="mt-1 font-medium text-slate-900">
                          {formatDateTime(effectiveCheckedInAt)}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-wrap gap-3 lg:w-48 lg:flex-col">
                    {canCheckIn ? (
                      <form action={checkInEventRegistrationAction}>
                        <input type="hidden" name="eventId" value={typedEvent.id} />
                        <input type="hidden" name="registrationId" value={registration.id} />
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <button
                          type="submit"
                          className="w-full rounded-xl bg-slate-900 px-4 py-3 text-white hover:bg-slate-800"
                        >
                          Check In
                        </button>
                      </form>
                    ) : null}

                    <Link
                      href={buildCheckInHref({
                        eventId: typedEvent.id,
                        q: registration.attendee_email,
                        status: "all",
                      })}
                      className="rounded-xl border px-4 py-3 text-center hover:bg-slate-50"
                    >
                      Find Similar
                    </Link>

                    <Link
                      href={`/app/events/${typedEvent.id}/registrations`}
                      className="rounded-xl border px-4 py-3 text-center hover:bg-slate-50"
                    >
                      Open Full Registry
                    </Link>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}