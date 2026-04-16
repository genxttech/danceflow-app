import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  checkInClassAttendeeAction,
  markClassAttendedAction,
  markClassNoShowAction,
  resetClassAttendanceAction,
} from "./actions";

type Params = Promise<{
  id: string;
}>;

type SearchParams = Promise<{
  q?: string;
  status?: string;
  success?: string;
  error?: string;
}>;

type AppointmentRow = {
  id: string;
  title: string | null;
  appointment_type: string | null;
  start_at: string;
  end_at: string;
  status: string | null;
};

type AppointmentAttendeeRow = {
  client_id: string;
  clients:
    | {
        id: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        phone: string | null;
      }
    | {
        id: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        phone: string | null;
      }[]
    | null;
};

type AttendanceRow = {
  id: string;
  appointment_id: string | null;
  client_id: string | null;
  status: string;
  checked_in_at: string | null;
  marked_attended_at: string | null;
};

function getClient(
  value:
    | {
        id: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        phone: string | null;
      }
    | {
        id: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        phone: string | null;
      }[]
    | null
) {
  return Array.isArray(value) ? value[0] : value;
}

function statusBadgeClass(status: string) {
  if (status === "registered") return "bg-green-50 text-green-700";
  if (status === "checked_in") return "bg-indigo-50 text-indigo-700";
  if (status === "attended") return "bg-emerald-50 text-emerald-700";
  if (status === "no_show") return "bg-orange-50 text-orange-700";
  if (status === "cancelled") return "bg-red-50 text-red-700";
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

function formatTimeRange(startAt: string, endAt: string) {
  const start = new Date(startAt);
  const end = new Date(endAt);

  return `${start.toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })} — ${end.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function buildAttendanceHref(params: {
  appointmentId: string;
  q?: string;
  status?: string;
}) {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);
  const query = search.toString();
  return query
    ? `/app/schedule/${params.appointmentId}/attendance?${query}`
    : `/app/schedule/${params.appointmentId}/attendance`;
}

function getBanner(search: { success?: string; error?: string }) {
  if (search.success === "checked_in") {
    return { kind: "success" as const, message: "Attendee checked in." };
  }
  if (search.success === "attended") {
    return { kind: "success" as const, message: "Attendee marked attended." };
  }
  if (search.success === "no_show") {
    return { kind: "success" as const, message: "Attendee marked no-show." };
  }
  if (search.success === "reset") {
    return { kind: "success" as const, message: "Attendance reset to registered." };
  }
  if (search.error === "checkin_failed") {
    return { kind: "error" as const, message: "Could not check in attendee." };
  }
  if (search.error === "attended_failed") {
    return { kind: "error" as const, message: "Could not mark attendee attended." };
  }
  if (search.error === "no_show_failed") {
    return { kind: "error" as const, message: "Could not mark attendee no-show." };
  }
  if (search.error === "reset_failed") {
    return { kind: "error" as const, message: "Could not reset attendance." };
  }
  return null;
}

export default async function ScheduleAttendancePage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const query = await searchParams;
  const q = (query.q ?? "").trim().toLowerCase();
  const statusFilter = (query.status ?? "all").trim().toLowerCase();
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
    { data: appointment, error: appointmentError },
    { data: attendees, error: attendeesError },
    { data: attendanceRows, error: attendanceError },
  ] = await Promise.all([
    supabase
      .from("appointments")
      .select("id, title, appointment_type, start_at, end_at, status")
      .eq("id", id)
      .eq("studio_id", studioId)
      .single(),

    supabase
      .from("appointment_attendees")
      .select(`
        client_id,
        clients (
          id,
          first_name,
          last_name,
          email,
          phone
        )
      `)
      .eq("appointment_id", id),

    supabase
      .from("attendance_records")
      .select(`
        id,
        appointment_id,
        client_id,
        status,
        checked_in_at,
        marked_attended_at
      `)
      .eq("studio_id", studioId)
      .eq("appointment_id", id),
  ]);

  if (appointmentError || !appointment) {
    notFound();
  }

  if (attendeesError) {
    throw new Error(`Failed to load class attendees: ${attendeesError.message}`);
  }

  if (attendanceError) {
    throw new Error(`Failed to load class attendance: ${attendanceError.message}`);
  }

  const typedAppointment = appointment as AppointmentRow;
  const typedAttendees = (attendees ?? []) as AppointmentAttendeeRow[];
  const typedAttendance = (attendanceRows ?? []) as AttendanceRow[];

  const attendanceByClientId = new Map(
    typedAttendance
      .filter((row) => row.client_id)
      .map((row) => [row.client_id as string, row])
  );

  const roster = typedAttendees
    .map((attendee) => {
      const client = getClient(attendee.clients);
      if (!client) return null;

      const attendance = attendanceByClientId.get(attendee.client_id) ?? null;
      const effectiveStatus = attendance?.status ?? "registered";

      return {
        clientId: attendee.client_id,
        firstName: client.first_name ?? "",
        lastName: client.last_name ?? "",
        email: client.email ?? "",
        phone: client.phone ?? "",
        attendance,
        effectiveStatus,
      };
    })
    .filter(Boolean)
    .filter((item) => {
      if (!item) return false;

      if (statusFilter !== "all" && item.effectiveStatus !== statusFilter) {
        return false;
      }

      if (!q) return true;

      const fullName = `${item.firstName} ${item.lastName}`.toLowerCase();
      return (
        fullName.includes(q) ||
        item.email.toLowerCase().includes(q) ||
        item.phone.toLowerCase().includes(q)
      );
    });

  const registeredCount = typedAttendees.filter((attendee) => {
    const attendance = attendanceByClientId.get(attendee.client_id);
    return (attendance?.status ?? "registered") === "registered";
  }).length;

  const checkedInCount = typedAttendees.filter((attendee) => {
    const attendance = attendanceByClientId.get(attendee.client_id);
    return (attendance?.status ?? "registered") === "checked_in";
  }).length;

  const attendedCount = typedAttendees.filter((attendee) => {
    const attendance = attendanceByClientId.get(attendee.client_id);
    return (attendance?.status ?? "registered") === "attended";
  }).length;

  const noShowCount = typedAttendees.filter((attendee) => {
    const attendance = attendanceByClientId.get(attendee.client_id);
    return (attendance?.status ?? "registered") === "no_show";
  }).length;

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
              Attendance Mode
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900">
              {typedAppointment.title || "Class Attendance"}
            </h1>
            <p className="mt-2 text-slate-600">
              {typedAppointment.appointment_type || "Group class"}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              {formatTimeRange(typedAppointment.start_at, typedAppointment.end_at)}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href={`/app/schedule/${typedAppointment.id}`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Back to Appointment
            </Link>

            <Link
              href="/app/schedule"
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Schedule
            </Link>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Registered</p>
          <p className="mt-2 text-3xl font-semibold">{registeredCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Checked In</p>
          <p className="mt-2 text-3xl font-semibold">{checkedInCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Attended</p>
          <p className="mt-2 text-3xl font-semibold">{attendedCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">No Show</p>
          <p className="mt-2 text-3xl font-semibold">{noShowCount}</p>
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
            />
          </div>

          <div>
            <label htmlFor="status" className="mb-1 block text-sm font-medium">
              Status
            </label>
            <select
              id="status"
              name="status"
              defaultValue={statusFilter}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="all">All</option>
              <option value="registered">Registered</option>
              <option value="checked_in">Checked In</option>
              <option value="attended">Attended</option>
              <option value="no_show">No Show</option>
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
              href={`/app/schedule/${typedAppointment.id}/attendance`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Reset
            </Link>
          </div>
        </div>
      </form>

      <div className="grid gap-4">
        {roster.length === 0 ? (
          <div className="rounded-2xl border bg-white px-6 py-12 text-center shadow-sm">
            <p className="text-base font-medium text-slate-900">
              No attendees found
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Try a different search or filter.
            </p>
          </div>
        ) : (
          roster.map((attendee) => {
            if (!attendee) return null;

            const fullName = `${attendee.firstName} ${attendee.lastName}`.trim() || "Unnamed attendee";
            const attendanceHref = buildAttendanceHref({
              appointmentId: typedAppointment.id,
              q: query.q ?? "",
              status: statusFilter,
            });

            return (
              <div
                key={attendee.clientId}
                className="rounded-2xl border bg-white p-5 shadow-sm"
              >
                <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-2xl font-semibold text-slate-900">
                        {fullName}
                      </h3>

                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                          attendee.effectiveStatus
                        )}`}
                      >
                        {attendee.effectiveStatus}
                      </span>
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                      <div className="rounded-xl border bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Email</p>
                        <p className="mt-1 break-words font-medium text-slate-900">
                          {attendee.email || "—"}
                        </p>
                      </div>

                      <div className="rounded-xl border bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Phone</p>
                        <p className="mt-1 font-medium text-slate-900">
                          {attendee.phone || "—"}
                        </p>
                      </div>

                      <div className="rounded-xl border bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Checked In</p>
                        <p className="mt-1 font-medium text-slate-900">
                          {formatDateTime(attendee.attendance?.checked_in_at ?? null)}
                        </p>
                      </div>

                      <div className="rounded-xl border bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Attended</p>
                        <p className="mt-1 font-medium text-slate-900">
                          {formatDateTime(attendee.attendance?.marked_attended_at ?? null)}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-wrap gap-3 lg:w-[260px] lg:flex-col">
                    <form action={checkInClassAttendeeAction}>
                      <input type="hidden" name="appointmentId" value={typedAppointment.id} />
                      <input type="hidden" name="clientId" value={attendee.clientId} />
                      <input type="hidden" name="returnTo" value={attendanceHref} />
                      <button
                        type="submit"
                        className="w-full rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
                      >
                        Check In
                      </button>
                    </form>

                    <form action={markClassAttendedAction}>
                      <input type="hidden" name="appointmentId" value={typedAppointment.id} />
                      <input type="hidden" name="clientId" value={attendee.clientId} />
                      <input type="hidden" name="returnTo" value={attendanceHref} />
                      <button
                        type="submit"
                        className="w-full rounded-xl border px-4 py-2 hover:bg-slate-50"
                      >
                        Mark Attended
                      </button>
                    </form>

                    <form action={markClassNoShowAction}>
                      <input type="hidden" name="appointmentId" value={typedAppointment.id} />
                      <input type="hidden" name="clientId" value={attendee.clientId} />
                      <input type="hidden" name="returnTo" value={attendanceHref} />
                      <button
                        type="submit"
                        className="w-full rounded-xl border border-red-200 px-4 py-2 text-red-700 hover:bg-red-50"
                      >
                        Mark No Show
                      </button>
                    </form>

                    <form action={resetClassAttendanceAction}>
                      <input type="hidden" name="appointmentId" value={typedAppointment.id} />
                      <input type="hidden" name="clientId" value={attendee.clientId} />
                      <input type="hidden" name="returnTo" value={attendanceHref} />
                      <button
                        type="submit"
                        className="w-full rounded-xl border px-4 py-2 hover:bg-slate-50"
                      >
                        Reset
                      </button>
                    </form>
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