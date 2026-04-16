import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ScheduleCalendarView from "./ScheduleCalendarView";
import ScheduleAgendaView from "./ScheduleAgendaView";
import { startOfWeek, addDays } from "@/lib/utils/schedule";

type SearchParams = Promise<{
  view?: string;
  date?: string;
  instructorId?: string;
  roomId?: string;
  appointmentType?: string;
  status?: string;
  source?: string;
  groupBy?: string;
}>;

type AppointmentRow = {
  id: string;
  title: string | null;
  appointment_type: string;
  status: string;
  starts_at: string;
  ends_at: string;
  is_recurring?: boolean;
  recurrence_series_id?: string | null;
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
  instructors:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
  rooms:
    | { name: string }
    | { name: string }[]
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

type InstructorOption = {
  id: string;
  first_name: string;
  last_name: string;
};

type RoomOption = {
  id: string;
  name: string;
};

export type CalendarItem = {
  id: string;
  kind: "appointment" | "event";
  title: string | null;
  slug?: string | null;
  appointment_type?: string | null;
  event_type?: string | null;
  status: string;
  starts_at: string;
  ends_at: string;
  display_date?: string;
  is_all_day?: boolean;
  is_recurring?: boolean;
  recurrence_series_id?: string | null;
  clients?:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
  instructors?:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
  rooms?:
    | { name: string }
    | { name: string }[]
    | null;
  organizers?:
    | { name: string }
    | { name: string }[]
    | null;
  venue_name?: string | null;
  city?: string | null;
  state?: string | null;
};

const APPOINTMENT_TYPES = new Set([
  "private_lesson",
  "group_class",
  "intro_lesson",
  "coaching",
  "practice_party",
  "event",
  "floor_space_rental",
]);

const EVENT_TYPES = new Set([
  "group_class",
  "practice_party",
  "workshop",
  "social_dance",
  "competition",
  "showcase",
  "festival",
  "special_event",
  "other",
]);

const APPOINTMENT_STATUSES = new Set([
  "scheduled",
  "attended",
  "cancelled",
  "no_show",
  "rescheduled",
]);

const EVENT_STATUSES = new Set(["draft", "published"]);

function getBaseDate(rawDate?: string) {
  if (rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    return rawDate;
  }

  return new Date().toISOString().slice(0, 10);
}

function toDateTime(
  dateValue: string,
  timeValue: string | null | undefined,
  fallback: string
) {
  return `${dateValue}T${timeValue || fallback}`;
}

function eventIntersectsDay(event: EventRow, day: string) {
  return event.start_date <= day && event.end_date >= day;
}

function buildEventInstance(event: EventRow, day: string): CalendarItem {
  const isSingleDay = event.start_date === event.end_date;
  const hasTimes = Boolean(event.start_time && event.end_time);

  let startsAt = `${day}T00:00:00`;
  let endsAt = `${day}T23:59:59`;
  let isAllDay = true;

  if (hasTimes) {
    isAllDay = false;

    if (isSingleDay) {
      startsAt = toDateTime(day, event.start_time, "00:00:00");
      endsAt = toDateTime(day, event.end_time, "23:59:59");
    } else if (day === event.start_date) {
      startsAt = toDateTime(day, event.start_time, "00:00:00");
      endsAt = `${day}T23:59:59`;
    } else if (day === event.end_date) {
      startsAt = `${day}T00:00:00`;
      endsAt = toDateTime(day, event.end_time, "23:59:59");
    }
  }

  return {
    id: event.id,
    kind: "event",
    title: event.name,
    slug: event.slug,
    appointment_type: null,
    event_type: event.event_type,
    status: event.status,
    starts_at: startsAt,
    ends_at: endsAt,
    display_date: day,
    is_all_day: isAllDay,
    is_recurring: false,
    recurrence_series_id: null,
    clients: null,
    instructors: null,
    rooms: null,
    organizers: event.organizers,
    venue_name: event.venue_name,
    city: event.city,
    state: event.state,
  };
}

export default async function ScheduleCalendarPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;

  const rawView = params.view ?? "week";
  const view: "day" | "week" | "agenda" =
    rawView === "day" || rawView === "agenda" || rawView === "week"
      ? rawView
      : "week";

  const rawSource = params.source ?? "all";
  const source: "all" | "appointments" | "events" =
    rawSource === "appointments" || rawSource === "events" ? rawSource : "all";

  const rawGroupBy = params.groupBy ?? "instructor";
  const groupBy: "instructor" | "none" =
    rawGroupBy === "none" ? "none" : "instructor";

  const baseDate = getBaseDate(params.date);

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

  const base = new Date(`${baseDate}T00:00:00`);
  const rangeStart = view === "day" ? base : startOfWeek(base);

  const days =
    view === "day"
      ? [base.toISOString().slice(0, 10)]
      : Array.from({ length: 7 }).map((_, index) =>
          addDays(rangeStart, index).toISOString().slice(0, 10)
        );

  const rangeStartIso = `${days[0]}T00:00:00`;
  const rangeEndIso = `${addDays(
    new Date(`${days[days.length - 1]}T00:00:00`),
    1
  )
    .toISOString()
    .slice(0, 10)}T00:00:00`;

  const shouldLoadAppointments = source !== "events";
  const shouldLoadEvents = source !== "appointments";

  const selectedType = params.appointmentType?.trim() || "";
  const selectedStatus = params.status?.trim() || "";

  const selectedTypeAppliesToAppointments =
    !selectedType || APPOINTMENT_TYPES.has(selectedType);
  const selectedTypeAppliesToEvents =
    !selectedType || EVENT_TYPES.has(selectedType);

  const selectedStatusAppliesToAppointments =
    !selectedStatus || APPOINTMENT_STATUSES.has(selectedStatus);
  const selectedStatusAppliesToEvents =
    !selectedStatus || EVENT_STATUSES.has(selectedStatus);

  const appointmentsPromise = shouldLoadAppointments
    ? (() => {
        let query = supabase
          .from("appointments")
          .select(`
            id,
            title,
            appointment_type,
            status,
            starts_at,
            ends_at,
            is_recurring,
            recurrence_series_id,
            clients ( first_name, last_name ),
            instructors ( first_name, last_name ),
            rooms ( name )
          `)
          .eq("studio_id", studioId)
          .gte("starts_at", rangeStartIso)
          .lt("starts_at", rangeEndIso)
          .order("starts_at", { ascending: true });

        if (params.instructorId) {
          query = query.eq("instructor_id", params.instructorId);
        }

        if (params.roomId) {
          query = query.eq("room_id", params.roomId);
        }

        if (selectedType && selectedTypeAppliesToAppointments) {
          query = query.eq("appointment_type", selectedType);
        }

        if (selectedStatus && selectedStatusAppliesToAppointments) {
          query = query.eq("status", selectedStatus);
        }

        return query;
      })()
    : Promise.resolve({ data: [], error: null });

  const eventsPromise = shouldLoadEvents
    ? (() => {
        let query = supabase
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
          .lte("start_date", days[days.length - 1])
          .gte("end_date", days[0])
          .order("start_date", { ascending: true });

        if (selectedStatus && selectedStatusAppliesToEvents) {
          query = query.eq("status", selectedStatus);
        }

        return query;
      })()
    : Promise.resolve({ data: [], error: null });

  const [
    { data: appointments, error: appointmentsError },
    { data: events, error: eventsError },
    { data: instructors, error: instructorsError },
    { data: rooms, error: roomsError },
  ] = await Promise.all([
    appointmentsPromise,
    eventsPromise,
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

  if (instructorsError) {
    throw new Error(`Failed to load instructors: ${instructorsError.message}`);
  }

  if (roomsError) {
    throw new Error(`Failed to load rooms: ${roomsError.message}`);
  }

  const typedAppointments = (appointments ?? []) as AppointmentRow[];
  const typedEvents = (events ?? []) as EventRow[];

  const appointmentItems: CalendarItem[] = typedAppointments.map((appointment) => ({
    ...appointment,
    kind: "appointment",
    slug: null,
    event_type: null,
    display_date: appointment.starts_at.slice(0, 10),
    is_all_day: false,
  }));

  const filteredEvents = typedEvents.filter((event) => {
    if (!selectedType) return true;
    return event.event_type === selectedType;
  });

  const eventInstances: CalendarItem[] = days.flatMap((day) =>
    filteredEvents
      .filter((event) => eventIntersectsDay(event, day))
      .map((event) => buildEventInstance(event, day))
  );

  const allItems = [...appointmentItems, ...eventInstances].sort((a, b) => {
    if (a.display_date !== b.display_date) {
      return (a.display_date ?? "").localeCompare(b.display_date ?? "");
    }

    if ((a.is_all_day ?? false) !== (b.is_all_day ?? false)) {
      return a.is_all_day ? -1 : 1;
    }

    return a.starts_at.localeCompare(b.starts_at);
  });

  const groupedItems = days.reduce<Record<string, CalendarItem[]>>((acc, day) => {
    acc[day] = allItems.filter((item) => item.display_date === day);
    return acc;
  }, {});

  if (view === "agenda") {
    return (
      <ScheduleAgendaView
        baseDate={baseDate}
        days={days}
        groupedAppointments={groupedItems}
        instructors={(instructors ?? []) as InstructorOption[]}
        rooms={(rooms ?? []) as RoomOption[]}
        selectedInstructorId={params.instructorId}
        selectedRoomId={params.roomId}
        selectedAppointmentType={params.appointmentType}
        selectedStatus={params.status}
        selectedSource={source}
        groupBy={groupBy}
      />
    );
  }

  return (
    <ScheduleCalendarView
      view={view}
      baseDate={baseDate}
      days={days}
      groupedAppointments={groupedItems}
      instructors={(instructors ?? []) as InstructorOption[]}
      rooms={(rooms ?? []) as RoomOption[]}
      selectedInstructorId={params.instructorId}
      selectedRoomId={params.roomId}
      selectedAppointmentType={params.appointmentType}
      selectedStatus={params.status}
      selectedSource={source}
    />
  );
}