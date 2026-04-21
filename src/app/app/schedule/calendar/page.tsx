import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import ScheduleCalendarView from "./ScheduleCalendarView";
import ScheduleAgendaView from "./ScheduleAgendaView";

type SearchParams = Promise<{
  view?: string;
  date?: string;
  source?: string;
  instructorId?: string;
  roomId?: string;
  appointmentType?: string;
  status?: string;
  groupBy?: string;
}>;

type PersonRelation =
  | { first_name: string; last_name: string }
  | { first_name: string; last_name: string }[]
  | null;

type RoomRelation = { name: string } | { name: string }[] | null;
type OrganizerRelation = { name: string } | { name: string }[] | null;

export type CalendarItem = {
  kind: "appointment" | "event";
  id: string;
  title: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  appointment_type?: string;
  event_type?: string;
  is_recurring?: boolean | null;
  is_all_day?: boolean | null;
  clients: PersonRelation;
  instructors: PersonRelation;
  partner_client?: PersonRelation;
  rooms: RoomRelation;
  organizers?: OrganizerRelation;
  city?: string | null;
  state?: string | null;
  venue_name?: string | null;
  display_date?: string;
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

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

function addDays(date: Date, amount: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function startOfWeekMonday(date: Date) {
  const next = startOfDay(date);
  const day = next.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  return addDays(next, offset);
}

function isValidYmd(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toYmd(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getDaysForView(baseDate: string, view: "day" | "week" | "agenda") {
  const base = new Date(`${baseDate}T00:00:00`);

  if (view === "day") {
    return [baseDate];
  }

  const weekStart = startOfWeekMonday(base);
  return Array.from({ length: 7 }, (_, index) => toYmd(addDays(weekStart, index)));
}

function normalizePersonRelation(value: any): PersonRelation {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  return value;
}

function normalizeRoomRelation(value: any): RoomRelation {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  return value;
}

function normalizeOrganizerRelation(value: any): OrganizerRelation {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  return value;
}

function getItemDateKey(item: { starts_at: string; is_all_day?: boolean | null }) {
  return item.starts_at.slice(0, 10);
}

function matchesType(item: CalendarItem, selectedAppointmentType?: string) {
  if (!selectedAppointmentType) return true;

  if (item.kind === "appointment") {
    return item.appointment_type === selectedAppointmentType;
  }

  return item.event_type === selectedAppointmentType;
}

function matchesSource(item: CalendarItem, selectedSource: "all" | "appointments" | "events") {
  if (selectedSource === "all") return true;
  if (selectedSource === "appointments") return item.kind === "appointment";
  return item.kind === "event";
}

function matchesInstructor(item: CalendarItem, selectedInstructorId?: string) {
  if (!selectedInstructorId) return true;

  const instructor = Array.isArray(item.instructors) ? item.instructors[0] : item.instructors;
  const anyItem = item as any;

  if (anyItem.instructor_id && anyItem.instructor_id === selectedInstructorId) return true;
  if (Array.isArray(anyItem.instructors) && anyItem.instructors[0]?.id === selectedInstructorId) {
    return true;
  }
  if ((instructor as any)?.id === selectedInstructorId) return true;

  return false;
}

function matchesRoom(item: CalendarItem, selectedRoomId?: string) {
  if (!selectedRoomId) return true;

  const room = Array.isArray(item.rooms) ? item.rooms[0] : item.rooms;
  const anyItem = item as any;

  if (anyItem.room_id && anyItem.room_id === selectedRoomId) return true;
  if (Array.isArray(anyItem.rooms) && anyItem.rooms[0]?.id === selectedRoomId) return true;
  if ((room as any)?.id === selectedRoomId) return true;

  return false;
}

function matchesStatus(item: CalendarItem, selectedStatus?: string) {
  if (!selectedStatus) return true;
  return item.status === selectedStatus;
}

export default async function ScheduleCalendarPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const { studioId } = await getCurrentStudioContext();
  const supabase = await createClient();

  const today = new Date();
  const fallbackDate = toYmd(today);

  const view: "day" | "week" | "agenda" =
    resolvedSearchParams.view === "week" || resolvedSearchParams.view === "agenda"
      ? resolvedSearchParams.view
      : "day";

  const selectedSource: "all" | "appointments" | "events" =
    resolvedSearchParams.source === "appointments" || resolvedSearchParams.source === "events"
      ? resolvedSearchParams.source
      : "all";

  const groupBy: "none" | "instructor" =
    resolvedSearchParams.groupBy === "instructor" ? "instructor" : "none";

  const baseDate =
    typeof resolvedSearchParams.date === "string" && isValidYmd(resolvedSearchParams.date)
      ? resolvedSearchParams.date
      : fallbackDate;

  const selectedInstructorId =
    typeof resolvedSearchParams.instructorId === "string"
      ? resolvedSearchParams.instructorId
      : undefined;

  const selectedRoomId =
    typeof resolvedSearchParams.roomId === "string" ? resolvedSearchParams.roomId : undefined;

  const selectedAppointmentType =
    typeof resolvedSearchParams.appointmentType === "string"
      ? resolvedSearchParams.appointmentType
      : undefined;

  const selectedStatus =
    typeof resolvedSearchParams.status === "string" ? resolvedSearchParams.status : undefined;

  const days = getDaysForView(baseDate, view);
  const rangeStart = startOfDay(new Date(`${days[0]}T00:00:00`));
  const rangeEnd = endOfDay(new Date(`${days[days.length - 1]}T00:00:00`));

  const [
    { data: instructorsData, error: instructorsError },
    { data: roomsData, error: roomsError },
    { data: appointmentsData, error: appointmentsError },
    { data: eventsData, error: eventsError },
  ] = await Promise.all([
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

    supabase
      .from("appointments")
      .select(`
        id,
        title,
        starts_at,
        ends_at,
        status,
        appointment_type,
        is_recurring,
        instructor_id,
        room_id,
        clients:clients!client_id(first_name, last_name),
        partner_client:clients!partner_client_id(first_name, last_name),
        instructors:instructors!instructor_id(first_name, last_name),
        rooms:rooms!room_id(name)
      `)
      .eq("studio_id", studioId)
      .gte("starts_at", rangeStart.toISOString())
      .lte("starts_at", rangeEnd.toISOString())
      .order("starts_at", { ascending: true }),

    supabase
      .from("events")
      .select(`
        id,
        title,
        starts_at,
        ends_at,
        status,
        event_type,
        is_all_day,
        city,
        state,
        venue_name,
        organizer_id,
        organizers:organizers!organizer_id(name)
      `)
      .eq("studio_id", studioId)
      .gte("starts_at", rangeStart.toISOString())
      .lte("starts_at", rangeEnd.toISOString())
      .order("starts_at", { ascending: true }),
  ]);

  if (instructorsError) {
    throw new Error(`Failed to load instructors: ${instructorsError.message}`);
  }

  if (roomsError) {
    throw new Error(`Failed to load rooms: ${roomsError.message}`);
  }

  if (appointmentsError) {
    throw new Error(`Failed to load appointments: ${appointmentsError.message}`);
  }

  if (eventsError) {
    throw new Error(`Failed to load events: ${eventsError.message}`);
  }

  const instructors = ((instructorsData ?? []) as InstructorOption[]).map((item) => ({
    id: item.id,
    first_name: item.first_name,
    last_name: item.last_name,
  }));

  const rooms = ((roomsData ?? []) as RoomOption[]).map((item) => ({
    id: item.id,
    name: item.name,
  }));

  const appointmentItems: CalendarItem[] = ((appointmentsData ?? []) as any[]).map((item) => ({
    kind: "appointment",
    id: item.id,
    title: item.title ?? null,
    starts_at: item.starts_at,
    ends_at: item.ends_at,
    status: item.status ?? "scheduled",
    appointment_type: item.appointment_type ?? "private_lesson",
    is_recurring: item.is_recurring ?? false,
    clients: normalizePersonRelation(item.clients),
    partner_client: normalizePersonRelation(item.partner_client),
    instructors: normalizePersonRelation(item.instructors),
    rooms: normalizeRoomRelation(item.rooms),
    display_date: item.starts_at?.slice(0, 10),
    instructor_id: item.instructor_id,
    room_id: item.room_id,
  })) as CalendarItem[];

  const eventItems: CalendarItem[] = ((eventsData ?? []) as any[]).map((item) => ({
    kind: "event",
    id: item.id,
    title: item.title ?? null,
    starts_at: item.starts_at,
    ends_at: item.ends_at,
    status: item.status ?? "published",
    event_type: item.event_type ?? "other",
    is_all_day: item.is_all_day ?? false,
    clients: null,
    instructors: null,
    rooms: null,
    organizers: normalizeOrganizerRelation(item.organizers),
    city: item.city ?? null,
    state: item.state ?? null,
    venue_name: item.venue_name ?? null,
    display_date: item.starts_at?.slice(0, 10),
  })) as CalendarItem[];

  const filteredItems = [...appointmentItems, ...eventItems].filter((item) => {
    if (!matchesSource(item, selectedSource)) return false;
    if (!matchesInstructor(item, selectedInstructorId)) return false;
    if (!matchesRoom(item, selectedRoomId)) return false;
    if (!matchesType(item, selectedAppointmentType)) return false;
    if (!matchesStatus(item, selectedStatus)) return false;
    return true;
  });

  const groupedAppointments: Record<string, CalendarItem[]> = Object.fromEntries(
    days.map((day) => [day, [] as CalendarItem[]])
  );

  for (const item of filteredItems) {
    const key = getItemDateKey(item);
    if (!groupedAppointments[key]) {
      groupedAppointments[key] = [];
    }
    groupedAppointments[key].push(item);
  }

  if (view === "agenda") {
    return (
      <ScheduleAgendaView
        baseDate={baseDate}
        days={days}
        groupedAppointments={groupedAppointments}
        instructors={instructors}
        rooms={rooms}
        selectedInstructorId={selectedInstructorId}
        selectedRoomId={selectedRoomId}
        selectedAppointmentType={selectedAppointmentType}
        selectedStatus={selectedStatus}
        selectedSource={selectedSource}
        groupBy={groupBy}
      />
    );
  }

  return (
    <ScheduleCalendarView
      view={view}
      baseDate={baseDate}
      days={days}
      groupedAppointments={groupedAppointments}
      instructors={instructors}
      rooms={rooms}
      selectedInstructorId={selectedInstructorId}
      selectedRoomId={selectedRoomId}
      selectedAppointmentType={selectedAppointmentType}
      selectedStatus={selectedStatus}
      selectedSource={selectedSource}
    />
  );
}