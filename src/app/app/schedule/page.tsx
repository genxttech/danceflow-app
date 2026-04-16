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
import { getCurrentStudioContext } from "@/lib/auth/studio";

type SearchParams = Promise<{
  q?: string;
  scope?: string;
  instructor?: string;
  room?: string;
  status?: string;
  source?: string;
  date?: string;
  success?: string;
  error?: string;
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

type EventRow = {
  id: string;
  name: string;
  slug: string;
  event_type: string;
  status: string;
  visibility: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  venue_name: string | null;
  city: string | null;
  state: string | null;
  organizers:
    | { name: string }
    | { name: string }[]
    | null;
};

type ScheduleListItem =
  | {
      kind: "appointment";
      sort_key: string;
      appointment: AppointmentRow;
    }
  | {
      kind: "event";
      sort_key: string;
      event: EventRow;
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

function getBaseDate(raw?: string) {
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return new Date().toISOString().slice(0, 10);
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatEventDateRange(event: EventRow) {
  const sameDay = event.start_date === event.end_date;
  const hasTimes = Boolean(event.start_time && event.end_time);

  if (sameDay && hasTimes) {
    return `${formatDate(event.start_date)} • ${event.start_time} – ${event.end_time}`;
  }

  if (sameDay) {
    return `${formatDate(event.start_date)} • All day`;
  }

  return `${formatDate(event.start_date)} – ${formatDate(event.end_date)}`;
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
  return value.replaceAll("_", " ");
}

function statusBadgeClass(status: string) {
  if (status === "scheduled") return "bg-blue-50 text-blue-700";
  if (status === "attended") return "bg-green-50 text-green-700";
  if (status === "cancelled") return "bg-red-50 text-red-700";
  if (status === "no_show") return "bg-amber-50 text-amber-700";
  if (status === "rescheduled") return "bg-purple-50 text-purple-700";
  if (status === "published") return "bg-green-50 text-green-700";
  if (status === "draft") return "bg-amber-50 text-amber-700";
  return "bg-slate-100 text-slate-700";
}

function appointmentTypeBadgeClass(type: string) {
  if (type === "floor_space_rental") return "bg-indigo-50 text-indigo-700";
  if (type === "intro_lesson") return "bg-cyan-50 text-cyan-700";
  if (type === "group_class") return "bg-green-50 text-green-700";
  if (type === "coaching") return "bg-purple-50 text-purple-700";
  if (type === "practice_party") return "bg-amber-50 text-amber-700";
  if (type === "event") return "bg-rose-50 text-rose-700";
  return "bg-slate-100 text-slate-700";
}

function eventTypeBadgeClass(type: string) {
  if (type === "group_class") return "bg-blue-50 text-blue-700";
  if (type === "practice_party") return "bg-amber-50 text-amber-700";
  if (type === "workshop") return "bg-violet-50 text-violet-700";
  if (type === "social_dance") return "bg-emerald-50 text-emerald-700";
  return "bg-rose-50 text-rose-700";
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

function getOrganizerName(
  value: { name: string } | { name: string }[] | null
) {
  const organizer = Array.isArray(value) ? value[0] : value;
  return organizer?.name ?? "Organizer";
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

function getBanner(search: { success?: string; error?: string }) {
  if (search.success === "appointment_created") {
    return {
      kind: "success" as const,
      message: "Appointment created successfully.",
    };
  }

  if (search.success === "floor_rentals_created") {
    return {
      kind: "success" as const,
      message: "Floor rentals created successfully.",
    };
  }

  if (search.success === "appointment_cancelled") {
    return {
      kind: "success" as const,
      message: "Appointment cancelled.",
    };
  }

  if (search.success === "appointment_attended") {
    return {
      kind: "success" as const,
      message: "Appointment marked attended.",
    };
  }

  if (search.success === "appointment_no_show") {
    return {
      kind: "success" as const,
      message: "Appointment marked no show.",
    };
  }

  if (search.error === "appointment_missing") {
    return {
      kind: "error" as const,
      message: "Appointment not found.",
    };
  }

  if (search.error === "appointment_cancel_failed") {
    return {
      kind: "error" as const,
      message: "Could not cancel the appointment.",
    };
  }

  if (search.error === "appointment_series_cancel_failed") {
    return {
      kind: "error" as const,
      message: "Could not cancel the recurring appointment series.",
    };
  }

  if (search.error === "appointment_attended_failed") {
    return {
      kind: "error" as const,
      message: "Could not mark the appointment attended.",
    };
  }

  if (search.error === "appointment_no_show_failed") {
    return {
      kind: "error" as const,
      message: "Could not mark the appointment no show.",
    };
  }

  if (search.error === "unknown") {
    return {
      kind: "error" as const,
      message: "Something went wrong.",
    };
  }

  return null;
}

function buildQuery(params: Record<string, string | undefined>) {
  const search = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value && value !== "all") search.set(key, value);
  });

  const query = search.toString();
  return query ? `?${query}` : "";
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
  const baseDate = getBaseDate(params.date);
  const banner = getBanner(params);

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  const role = context.studioRole ?? "";
  const studioId = context.studioId;

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

  let eventsQuery = supabase
    .from("events")
    .select(`
      id,
      name,
      slug,
      event_type,
      status,
      visibility,
      start_date,
      end_date,
      start_time,
      end_time,
      venue_name,
      city,
      state,
      organizers ( name )
    `)
    .eq("studio_id", studioId)
    .in("status", ["draft", "published"])
    .not("visibility", "eq", "private")
    .order("start_date", { ascending: true });

  const todayDate = todayStart.slice(0, 10);
  const next7Date = next7End.slice(0, 10);

  if (scope === "today") {
    eventsQuery = eventsQuery.lte("start_date", todayDate).gte("end_date", todayDate);
  } else if (scope === "next7") {
    eventsQuery = eventsQuery.lte("start_date", next7Date).gte("end_date", todayDate);
  }

  if (statusFilter !== "all") {
    if (
      statusFilter === "scheduled" ||
      statusFilter === "attended" ||
      statusFilter === "cancelled" ||
      statusFilter === "no_show" ||
      statusFilter === "rescheduled"
    ) {
      eventsQuery = eventsQuery.eq("id", "__no_event_match__");
    } else {
      eventsQuery = eventsQuery.eq("status", statusFilter);
    }
  }

  const [
    { data: appointments, error: appointmentsError },
    { data: events, error: eventsError },
    { data: instructors },
    { data: rooms },
  ] = await Promise.all([
    appointmentsQuery,
    eventsQuery,
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

  if (appointmentsError) {
    throw new Error(`Failed to load appointments: ${appointmentsError.message}`);
  }

  if (eventsError) {
    throw new Error(`Failed to load events: ${eventsError.message}`);
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
      if (sourceFilter === "events") return false;

      return true;
    })
    .filter((appointment) => {
      if (!q) return true;

      const referralSource = getClientReferralSource(appointment.clients);
      const clientName = getClientName(appointment.clients).toLowerCase();
      const instructorName = getInstructorName(appointment.instructors).toLowerCase();
      const roomName = getRoomName(appointment.rooms).toLowerCase();
      const typeLabel = appointmentTypeLabel(appointment.appointment_type).toLowerCase();
      const title = (appointment.title ?? "").toLowerCase();
      const recurringLabel = appointment.is_recurring ? "recurring" : "";
      const publicIntroLabel =
        appointment.appointment_type === "intro_lesson" &&
        referralSource === "public_intro_booking"
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

  const typedEvents = ((events ?? []) as EventRow[])
    .filter((event) => {
      if (sourceFilter === "public_intro") return false;
      if (sourceFilter === "intro_lessons") return false;
      if (sourceFilter === "floor_rentals") return false;
      if (instructorFilter !== "all") return false;
      if (roomFilter !== "all") return false;

      return true;
    })
    .filter((event) => {
      if (!q) return true;

      const name = event.name.toLowerCase();
      const type = eventTypeLabel(event.event_type).toLowerCase();
      const organizer = getOrganizerName(event.organizers).toLowerCase();
      const location = [event.venue_name, event.city, event.state]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        name.includes(q) ||
        type.includes(q) ||
        organizer.includes(q) ||
        location.includes(q) ||
        "event class party workshop".includes(q)
      );
    });

  const mixedItems: ScheduleListItem[] = [
    ...typedAppointments.map((appointment) => ({
      kind: "appointment" as const,
      sort_key: appointment.starts_at,
      appointment,
    })),
    ...typedEvents.map((event) => ({
      kind: "event" as const,
      sort_key: `${event.start_date}T${event.start_time || "00:00:00"}`,
      event,
    })),
  ].sort((a, b) => a.sort_key.localeCompare(b.sort_key));

  const scheduledCount = typedAppointments.filter((a) => a.status === "scheduled").length;
  const attendedCount = typedAppointments.filter((a) => a.status === "attended").length;
  const recurringCount = typedAppointments.filter((a) => a.is_recurring).length;
  const floorRentalCount = typedAppointments.filter(
    (a) => a.appointment_type === "floor_space_rental"
  ).length;
  const eventCount = typedEvents.length;

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

      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">Schedule</h2>
          <p className="mt-2 text-slate-600">
            Front-desk view for appointments, event offerings, attendance, and daily flow.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <Link
            href={`/app/schedule/calendar${buildQuery({
              view: "week",
              date: baseDate,
              instructor: instructorFilter !== "all" ? instructorFilter : undefined,
              room: roomFilter !== "all" ? roomFilter : undefined,
              status: statusFilter !== "all" ? statusFilter : undefined,
            })}`}
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Week Calendar
          </Link>

          <Link
            href={`/app/schedule/calendar${buildQuery({
              view: "agenda",
              date: baseDate,
              instructor: instructorFilter !== "all" ? instructorFilter : undefined,
              room: roomFilter !== "all" ? roomFilter : undefined,
              status: statusFilter !== "all" ? statusFilter : undefined,
            })}`}
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Agenda View
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

      <div className="grid gap-4 md:grid-cols-7">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Visible Items</p>
          <p className="mt-2 text-3xl font-semibold">{mixedItems.length}</p>
        </div>
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Appointments</p>
          <p className="mt-2 text-3xl font-semibold">{typedAppointments.length}</p>
        </div>
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Events</p>
          <p className="mt-2 text-3xl font-semibold">{eventCount}</p>
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
              placeholder="Client, instructor, room, type, event..."
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
              <option value="events">Events Only</option>
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
              <option value="published">Published</option>
              <option value="draft">Draft</option>
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
        {mixedItems.length === 0 ? (
          <div className="rounded-2xl border bg-white p-8 text-center text-slate-500">
            No schedule items match your current filters.
          </div>
        ) : (
          mixedItems.map((item) => {
            if (item.kind === "event") {
              const event = item.event;

              return (
                <div
                  key={`event-${event.id}`}
                  className="rounded-2xl border bg-white p-5 shadow-sm"
                >
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-3">
                        <Link
                          href={`/app/events/${event.id}`}
                          className="text-lg font-semibold text-slate-900 hover:underline"
                        >
                          {event.name}
                        </Link>

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

                        <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                          Read Only
                        </span>
                      </div>

                      <p className="mt-2 text-sm text-slate-600">
                        Event offering shown here for operational visibility.
                      </p>

                      <div className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
                        <div className="min-w-0">
                          <p className="text-xs uppercase tracking-wide text-slate-400">When</p>
                          <p className="mt-1 text-sm font-medium text-slate-900">
                            {formatEventDateRange(event)}
                          </p>
                        </div>

                        <div className="min-w-0">
                          <p className="text-xs uppercase tracking-wide text-slate-400">
                            Organizer
                          </p>
                          <p className="mt-1 text-sm font-medium text-slate-900">
                            {getOrganizerName(event.organizers)}
                          </p>
                        </div>

                        <div className="min-w-0">
                          <p className="text-xs uppercase tracking-wide text-slate-400">
                            Location
                          </p>
                          <p className="mt-1 text-sm font-medium text-slate-900">
                            {event.venue_name ||
                              [event.city, event.state].filter(Boolean).join(", ") ||
                              "No location"}
                          </p>
                        </div>

                        <div className="min-w-0">
                          <p className="text-xs uppercase tracking-wide text-slate-400">
                            Visibility
                          </p>
                          <p className="mt-1 text-sm font-medium text-slate-900">
                            {event.visibility}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-3 xl:justify-end">
                      <Link
                        href={`/app/events/${event.id}`}
                        className="rounded-xl border px-4 py-2 hover:bg-slate-50"
                      >
                        View Event
                      </Link>

                      <Link
                        href={`/app/events/${event.id}`}
                        className="rounded-xl border px-4 py-2 hover:bg-slate-50"
                      >
                        Check-In / Roster
                      </Link>
                    </div>
                  </div>
                </div>
              );
            }

            const appointment = item.appointment;
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
                key={`appointment-${appointment.id}`}
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
                        {isFloorRental
                          ? "Floor Rental"
                          : appointmentTypeLabel(appointment.appointment_type)}
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
                        Independent instructor floor rental. No package deduction. Instructor and room may be optionally assigned for internal tracking.
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
                          Instructor
                        </p>
                        <p className="mt-1 text-sm font-medium text-slate-900">
                          {getInstructorName(appointment.instructors)}
                        </p>
                      </div>

                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-wide text-slate-400">Room</p>
                        <p className="mt-1 text-sm font-medium text-slate-900">
                          {getRoomName(appointment.rooms)}
                        </p>
                      </div>

                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-wide text-slate-400">
                          Package
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