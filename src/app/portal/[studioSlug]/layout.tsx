import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  cancelAppointmentAction,
  markAppointmentAttendedAction,
  markAppointmentNoShowAction,
} from "./actions";
import { summarizeClientPackageItems } from "@/lib/utils/packageSummary";
import {
  canCreateAppointments,
  canEditAppointments,
  canMarkAttendance,
} from "@/lib/auth/permissions";

type SearchParams = Promise<{
  q?: string;
  scope?: string;
  instructor?: string;
  room?: string;
  status?: string;
  source?: string;
}>;

type ClientPackageItem = {
  usage_type: string;
  quantity_remaining: number | null;
  quantity_total: number | null;
  is_unlimited: boolean;
};

type PackageHealth =
  | "healthy"
  | "low_balance"
  | "depleted"
  | "inactive"
  | "unknown";

type AppointmentRow = {
  id: string;
  title: string | null;
  appointment_type: string;
  status: string;
  starts_at: string;
  ends_at: string;
  client_package_id: string | null;
  is_recurring: boolean;
  recurrence_series_id: string | null;
  clients:
    | { first_name: string; last_name: string; referral_source?: string | null }
    | { first_name: string; last_name: string; referral_source?: string | null }[]
    | null;
  instructors:
    | { id?: string; first_name: string; last_name: string }
    | { id?: string; first_name: string; last_name: string }[]
    | null;
  rooms:
    | { id?: string; name: string }
    | { id?: string; name: string }[]
    | null;
  client_packages:
    | {
        name_snapshot: string;
        active: boolean | null;
        client_package_items: ClientPackageItem[];
      }
    | {
        name_snapshot: string;
        active: boolean | null;
        client_package_items: ClientPackageItem[];
      }[]
    | null;
};

function startOfTodayLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function endOfTodayLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}

function startOfNext7DaysLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function appointmentTypeLabel(value: string) {
  if (value === "private_lesson") return "Private Lesson";
  if (value === "group_class") return "Group Class";
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "coaching") return "Coaching";
  if (value === "practice_party") return "Practice Party";
  if (value === "event") return "Event";
  if (value === "floor_space_rental") return "Floor Space Rental";
  return value.replaceAll("_", " ");
}

function statusBadgeClass(status: string) {
  if (status === "scheduled") return "bg-blue-50 text-blue-700";
  if (status === "attended") return "bg-green-50 text-green-700";
  if (status === "cancelled") return "bg-red-50 text-red-700";
  if (status === "no_show") return "bg-amber-50 text-amber-700";
  if (status === "rescheduled") return "bg-purple-50 text-purple-700";
  return "bg-slate-100 text-slate-700";
}

function appointmentTypeBadgeClass(type: string) {
  if (type === "floor_space_rental") return "bg-indigo-50 text-indigo-700";
  if (type === "intro_lesson") return "bg-cyan-50 text-cyan-700";
  return "bg-slate-100 text-slate-700";
}

function getClientName(
  value:
    | { first_name: string; last_name: string; referral_source?: string | null }
    | { first_name: string; last_name: string; referral_source?: string | null }[]
    | null
) {
  const client = Array.isArray(value) ? value[0] : value;
  return client ? `${client.first_name} ${client.last_name}` : "Unknown Client";
}

function getClientReferralSource(
  value:
    | { first_name: string; last_name: string; referral_source?: string | null }
    | { first_name: string; last_name: string; referral_source?: string | null }[]
    | null
) {
  const client = Array.isArray(value) ? value[0] : value;
  return client?.referral_source ?? null;
}

function getInstructorName(
  value:
    | { id?: string; first_name: string; last_name: string }
    | { id?: string; first_name: string; last_name: string }[]
    | null
) {
  const instructor = Array.isArray(value) ? value[0] : value;
  return instructor ? `${instructor.first_name} ${instructor.last_name}` : "Unassigned";
}

function getRoomName(
  value: { id?: string; name: string } | { id?: string; name: string }[] | null
) {
  const room = Array.isArray(value) ? value[0] : value;
  return room?.name ?? "No room";
}

function getLowestRemainingValue(items: ClientPackageItem[]) {
  const finiteItems = items.filter(
    (item) => !item.is_unlimited && typeof item.quantity_remaining === "number"
  );

  if (finiteItems.length === 0) return null;

  return Math.min(...finiteItems.map((item) => Number(item.quantity_remaining ?? 0)));
}

function getPackageHealth(pkg: {
  active?: boolean | null;
  client_package_items?: ClientPackageItem[] | null;
} | null): PackageHealth {
  if (!pkg) return "unknown";
  if (pkg.active === false) return "inactive";

  const items = pkg.client_package_items ?? [];
  const lowestRemaining = getLowestRemainingValue(items);

  if (lowestRemaining === null) return "healthy";
  if (lowestRemaining <= 0) return "depleted";
  if (lowestRemaining === 1) return "low_balance";

  return "healthy";
}

function packageHealthLabel(health: PackageHealth) {
  if (health === "healthy") return "Pkg Active";
  if (health === "low_balance") return "Pkg Low";
  if (health === "depleted") return "Pkg Empty";
  if (health === "inactive") return "Pkg Inactive";
  return "Pkg Unknown";
}

function packageHealthClass(health: PackageHealth) {
  if (health === "healthy") return "bg-green-50 text-green-700";
  if (health === "low_balance") return "bg-amber-50 text-amber-700";
  if (health === "depleted") return "bg-red-50 text-red-700";
  if (health === "inactive") return "bg-slate-100 text-slate-700";
  return "bg-slate-100 text-slate-700";
}

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const q = (params.q ?? "").trim().toLowerCase();
  const scope = params.scope ?? "today";
  const instructorFilter = params.instructor ?? "all";
  const roomFilter = params.room ?? "all";
  const statusFilter = params.status ?? "all";
  const sourceFilter = params.source ?? "all";

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: roleRow } = await supabase
    .from("user_studio_roles")
    .select("studio_id, role")
    .eq("user_id", user.id)
    .eq("active", true)
    .limit(1)
    .single();

  if (!roleRow) {
    redirect("/login");
  }

  const role = roleRow.role as string;
  const studioId = roleRow.studio_id;

  const todayStart = startOfTodayLocal().toISOString();
  const todayEnd = endOfTodayLocal().toISOString();
  const next7End = startOfNext7DaysLocal().toISOString();

  let appointmentsQuery = supabase
    .from("appointments")
    .select(`
      id,
      title,
      appointment_type,
      status,
      starts_at,
      ends_at,
      client_package_id,
      is_recurring,
      recurrence_series_id,
      clients ( first_name, last_name, referral_source ),
      instructors ( id, first_name, last_name ),
      rooms ( id, name ),
      client_packages (
        name_snapshot,
        active,
        client_package_items (
          usage_type,
          quantity_remaining,
          quantity_total,
          is_unlimited
        )
      )
    `)
    .eq("studio_id", studioId)
    .order("starts_at", { ascending: true });

  if (scope === "today") {
    appointmentsQuery = appointmentsQuery.gte("starts_at", todayStart).lt("starts_at", todayEnd);
  } else if (scope === "next7") {
    appointmentsQuery = appointmentsQuery.gte("starts_at", todayStart).lt("starts_at", next7End);
  }

  if (statusFilter !== "all") {
    appointmentsQuery = appointmentsQuery.eq("status", statusFilter);
  }

  if (instructorFilter !== "all") {
    appointmentsQuery = appointmentsQuery.eq("instructor_id", instructorFilter);
  }

  if (roomFilter !== "all") {
    appointmentsQuery = appointmentsQuery.eq("room_id", roomFilter);
  }

  const [
    { data: appointments, error },
    { data: instructors },
    { data: rooms },
  ] = await Promise.all([
    appointmentsQuery,
    supabase
      .from("instructors")
      .select("id, first_name, last_name")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("first_name", { ascending: true }),
    supabase
      .from("rooms")
      .select("id, name")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("name", { ascending: true }),
  ]);

  if (error) {
    throw new Error(`Failed to load appointments: ${error.message}`);
  }

  const typedAppointments = ((appointments ?? []) as AppointmentRow[])
    .filter((appointment) => {
      const referralSource = getClientReferralSource(appointment.clients);
      const isPublicIntro =
        appointment.appointment_type === "intro_lesson" &&
        referralSource === "public_intro_booking";
      const isFloorRental = appointment.appointment_type === "floor_space_rental";

      if (sourceFilter === "public_intro" && !isPublicIntro) return false;
      if (sourceFilter === "intro_lessons" && appointment.appointment_type !== "intro_lesson") {
        return false;
      }
      if (sourceFilter === "floor_rentals" && !isFloorRental) return false;

      return true;
    })
    .filter((appointment) => {
      if (!q) return true;

      const clientName = getClientName(appointment.clients).toLowerCase();
      const instructorName = getInstructorName(appointment.instructors).toLowerCase();
      const roomName = getRoomName(appointment.rooms).toLowerCase();
      const typeLabel = appointmentTypeLabel(appointment.appointment_type).toLowerCase();
      const title = (appointment.title ?? "").toLowerCase();
      const recurringLabel = appointment.is_recurring ? "recurring" : "";
      const publicIntroLabel =
        appointment.appointment_type === "intro_lesson" &&
        getClientReferralSource(appointment.clients) === "public_intro_booking"
          ? "public intro"
          : "";
      const floorRentalLabel =
        appointment.appointment_type === "floor_space_rental"
          ? "floor rental floor space rental rental"
          : "";

      return (
        clientName.includes(q) ||
        instructorName.includes(q) ||
        roomName.includes(q) ||
        typeLabel.includes(q) ||
        title.includes(q) ||
        recurringLabel.includes(q) ||
        publicIntroLabel.includes(q) ||
        floorRentalLabel.includes(q)
      );
    });

  const scheduledCount = typedAppointments.filter((a) => a.status === "scheduled").length;
  const attendedCount = typedAppointments.filter((a) => a.status === "attended").length;
  const recurringCount = typedAppointments.filter((a) => a.is_recurring).length;
  const publicIntroCount = typedAppointments.filter(
    (a) =>
      a.appointment_type === "intro_lesson" &&
      getClientReferralSource(a.clients) === "public_intro_booking"
  ).length;
  const floorRentalCount = typedAppointments.filter(
    (a) => a.appointment_type === "floor_space_rental"
  ).length;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">Schedule</h2>
          <p className="mt-2 text-slate-600">
            Front-desk view for appointments, attendance, and daily flow.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <Link
            href="/app/schedule/calendar"
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Calendar View
          </Link>

          {canCreateAppointments(role) ? (
            <Link
              href="/app/schedule/new"
              className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
            >
              New Appointment
            </Link>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-6">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Visible Appointments</p>
          <p className="mt-2 text-3xl font-semibold">{typedAppointments.length}</p>
        </div>
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Scheduled</p>
          <p className="mt-2 text-3xl font-semibold">{scheduledCount}</p>
        </div>
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Attended</p>
          <p className="mt-2 text-3xl font-semibold">{attendedCount}</p>
        </div>
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Recurring</p>
          <p className="mt-2 text-3xl font-semibold">{recurringCount}</p>
        </div>
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Public Intro</p>
          <p className="mt-2 text-3xl font-semibold">{publicIntroCount}</p>
        </div>
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Floor Rentals</p>
          <p className="mt-2 text-3xl font-semibold">{floorRentalCount}</p>
        </div>
      </div>

      <form className="rounded-2xl border bg-white p-5">
        <div className="grid gap-4 lg:grid-cols-[1.5fr_repeat(5,minmax(0,1fr))]">
          <div>
            <label htmlFor="q" className="mb-1 block text-sm font-medium">
              Search
            </label>
            <input
              id="q"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Client, instructor, room, type..."
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>

          <div>
            <label htmlFor="scope" className="mb-1 block text-sm font-medium">
              Date Scope
            </label>
            <select
              id="scope"
              name="scope"
              defaultValue={scope}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="today">Today</option>
              <option value="next7">Next 7 Days</option>
              <option value="all">All</option>
            </select>
          </div>

          <div>
            <label htmlFor="source" className="mb-1 block text-sm font-medium">
              Source
            </label>
            <select
              id="source"
              name="source"
              defaultValue={sourceFilter}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="all">All</option>
              <option value="intro_lessons">Intro Lessons</option>
              <option value="public_intro">Public Intro</option>
              <option value="floor_rentals">Floor Rentals</option>
            </select>
          </div>

          <div>
            <label htmlFor="instructor" className="mb-1 block text-sm font-medium">
              Instructor
            </label>
            <select
              id="instructor"
              name="instructor"
              defaultValue={instructorFilter}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="all">All</option>
              {(instructors ?? []).map((instructor) => (
                <option key={instructor.id} value={instructor.id}>
                  {instructor.first_name} {instructor.last_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="room" className="mb-1 block text-sm font-medium">
              Room
            </label>
            <select
              id="room"
              name="room"
              defaultValue={roomFilter}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="all">All</option>
              {(rooms ?? []).map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
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
              <option value="scheduled">Scheduled</option>
              <option value="attended">Attended</option>
              <option value="cancelled">Cancelled</option>
              <option value="no_show">No Show</option>
              <option value="rescheduled">Rescheduled</option>
            </select>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="submit"
            className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
          >
            Apply Filters
          </button>
          <Link
            href="/app/schedule"
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Reset
          </Link>
        </div>
      </form>

      <div className="space-y-4">
        {typedAppointments.length === 0 ? (
          <div className="rounded-2xl border bg-white p-8 text-center text-slate-500">
            No appointments match your current filters.
          </div>
        ) : (
          typedAppointments.map((appointment) => {
            const pkg = Array.isArray(appointment.client_packages)
              ? appointment.client_packages[0]
              : appointment.client_packages;

            const packageHealth = pkg ? getPackageHealth(pkg) : null;
            const referralSource = getClientReferralSource(appointment.clients);
            const isPublicIntro =
              appointment.appointment_type === "intro_lesson" &&
              referralSource === "public_intro_booking";
            const isFloorRental = appointment.appointment_type === "floor_space_rental";

            const isFinalStatus =
              appointment.status === "attended" ||
              appointment.status === "cancelled" ||
              appointment.status === "no_show";

            const showAttendanceActions =
              !isFinalStatus &&
              canMarkAttendance(role) &&
              !isFloorRental;

            return (
              <div
                key={appointment.id}
                className="rounded-2xl border bg-white p-5 shadow-sm"
              >
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-3">
                      <Link
                        href={`/app/schedule/${appointment.id}`}
                        className="text-lg font-semibold text-slate-900 hover:underline"
                      >
                        {getClientName(appointment.clients)}
                      </Link>

                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                          appointment.status
                        )}`}
                      >
                        {appointment.status}
                      </span>

                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${appointmentTypeBadgeClass(
                          appointment.appointment_type
                        )}`}
                      >
                        {isFloorRental ? "Floor Rental" : appointmentTypeLabel(appointment.appointment_type)}
                      </span>

                      {appointment.is_recurring ? (
                        <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                          Recurring
                        </span>
                      ) : null}

                      {isPublicIntro ? (
                        <span className="inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
                          Public Intro
                        </span>
                      ) : null}

                      {!isFloorRental && pkg && packageHealth ? (
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${packageHealthClass(
                            packageHealth
                          )}`}
                        >
                          {packageHealthLabel(packageHealth)}
                        </span>
                      ) : null}
                    </div>

                    <p className="mt-2 text-sm text-slate-600">
                      {appointment.title || appointmentTypeLabel(appointment.appointment_type)}
                    </p>

                    {appointment.is_recurring ? (
                      <p className="mt-1 text-xs text-slate-500">
                        Attendance applies per lesson. Cancellation can affect this lesson or this and future.
                      </p>
                    ) : null}

                    {isFloorRental ? (
                      <p className="mt-1 text-xs text-slate-500">
                        Independent instructor floor space booking. No package deduction and no room reservation required.
                      </p>
                    ) : null}

                    <div className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-wide text-slate-400">Start</p>
                        <p className="mt-1 text-sm font-medium text-slate-900">
                          {formatDateTime(appointment.starts_at)}
                        </p>
                      </div>

                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-wide text-slate-400">
                          {isFloorRental ? "Rental For" : "Instructor"}
                        </p>
                        <p className="mt-1 text-sm font-medium text-slate-900">
                          {isFloorRental
                            ? getClientName(appointment.clients)
                            : getInstructorName(appointment.instructors)}
                        </p>
                      </div>

                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-wide text-slate-400">
                          {isFloorRental ? "Room" : "Room"}
                        </p>
                        <p className="mt-1 text-sm font-medium text-slate-900">
                          {isFloorRental ? "Not required" : getRoomName(appointment.rooms)}
                        </p>
                      </div>

                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-wide text-slate-400">
                          {isFloorRental ? "Package" : "Package"}
                        </p>
                        <p className="mt-1 break-words text-sm font-medium text-slate-900">
                          {isFloorRental
                            ? "No package deduction"
                            : pkg
                            ? `${pkg.name_snapshot} — ${summarizeClientPackageItems(
                                pkg.client_package_items ?? []
                              )}`
                            : "—"}
                        </p>

                        {!isFloorRental && pkg && packageHealth && packageHealth !== "healthy" ? (
                          <p className="mt-1 text-xs text-slate-500">
                            {packageHealth === "low_balance"
                              ? "Linked package is running low."
                              : packageHealth === "depleted"
                              ? "Linked package has no remaining balance."
                              : packageHealth === "inactive"
                              ? "Linked package is inactive."
                              : ""}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-3 xl:justify-end">
                    <Link
                      href={`/app/schedule/${appointment.id}`}
                      className="rounded-xl border px-4 py-2 hover:bg-slate-50"
                    >
                      View
                    </Link>

                    {!isFinalStatus && canEditAppointments(role) ? (
                      <Link
                        href={`/app/schedule/${appointment.id}/edit`}
                        className="rounded-xl border px-4 py-2 hover:bg-slate-50"
                      >
                        Edit
                      </Link>
                    ) : null}
                  </div>
                </div>

                {showAttendanceActions ? (
                  <div className="mt-4 flex flex-wrap gap-3 border-t pt-4">
                    <form action={markAppointmentAttendedAction}>
                      <input type="hidden" name="appointmentId" value={appointment.id} />
                      <button
                        type="submit"
                        className="rounded-xl bg-green-600 px-4 py-2 text-white hover:bg-green-700"
                      >
                        Mark Attended
                      </button>
                    </form>

                    <form action={markAppointmentNoShowAction}>
                      <input type="hidden" name="appointmentId" value={appointment.id} />
                      <button
                        type="submit"
                        className="rounded-xl bg-amber-500 px-4 py-2 text-white hover:bg-amber-600"
                      >
                        Mark No Show
                      </button>
                    </form>

                    <form action={cancelAppointmentAction}>
                      <input type="hidden" name="appointmentId" value={appointment.id} />
                      <input type="hidden" name="cancelScope" value="this_lesson_only" />
                      <button
                        type="submit"
                        className="rounded-xl border border-red-200 px-4 py-2 text-red-700 hover:bg-red-50"
                      >
                        Cancel Appointment
                      </button>
                    </form>
                  </div>
                ) : null}

                {isFloorRental && !isFinalStatus && canEditAppointments(role) ? (
                  <div className="mt-4 border-t pt-4">
                    <p className="text-xs text-slate-500">
                      Floor space rentals are shown on the schedule for visibility, but they do not use standard lesson attendance and package workflows.
                    </p>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}