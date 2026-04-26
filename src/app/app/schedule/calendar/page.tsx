import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import ScheduleCalendarView from "./ScheduleCalendarView";
import ScheduleAgendaView from "./ScheduleAgendaView";

type SearchParams = Promise<{
  view?: string;
  date?: string;
  instructor?: string;
  instructorId?: string;
  room?: string;
  roomId?: string;
  appointmentType?: string;
  type?: string;
  status?: string;
  source?: string;
  groupBy?: string;
}>;

type ClientRelation =
  | { first_name: string; last_name: string }
  | { first_name: string; last_name: string }[]
  | null;

type InstructorRelation =
  | { first_name: string; last_name: string }
  | { first_name: string; last_name: string }[]
  | null;

type RoomRelation = { name: string } | { name: string }[] | null;

type OrganizerRelation = { name: string } | { name: string }[] | null;

type AppointmentRow = {
  kind?: "appointment";
  id: string;
  studio_id: string | null;
  client_id: string | null;
  instructor_id: string | null;
  room_id: string | null;
  appointment_type: string | null;
  title: string | null;
  status: string;
  starts_at: string;
  ends_at: string;
  is_recurring: boolean | null;
  notes: string | null;
  price_amount: number | null;
  payment_status: string | null;
  clients: ClientRelation;
  partner_client?: ClientRelation;
  instructors: InstructorRelation;
  rooms: RoomRelation;
};

type EventRow = {
  id: string;
  name: string | null;
  slug: string | null;
  event_type: string | null;
  status: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  venue_name: string | null;
  city: string | null;
  state: string | null;
  organizers: OrganizerRelation;
};

type CalendarItem = {
  kind: "appointment" | "event";
  id: string;
  studio_id?: string | null;
  client_id?: string | null;
  instructor_id?: string | null;
  room_id?: string | null;
  appointment_type?: string | null;
  event_type?: string | null;
  title?: string | null;
  status: string;
  starts_at: string;
  ends_at: string;
  display_date?: string;
  is_all_day?: boolean;
  is_recurring?: boolean | null;
  notes?: string | null;
  price_amount?: number | null;
  payment_status?: string | null;
  clients?: ClientRelation;
  partner_client?: ClientRelation;
  instructors?: InstructorRelation;
  rooms?: RoomRelation;
  organizers?: OrganizerRelation;
  name?: string | null;
  slug?: string | null;
  venue_name?: string | null;
  city?: string | null;
  state?: string | null;
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

function addDays(date: Date, amount: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function getBaseDate(raw?: string) {
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return new Date().toISOString().slice(0, 10);
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function startOfLocalDate(date: string) {
  return new Date(`${date}T00:00:00`);
}

function buildDays(baseDate: string, view: "day" | "week" | "agenda") {
  const start = startOfLocalDate(baseDate);
  const dayCount = view === "day" ? 1 : 7;

  return Array.from({ length: dayCount }, (_, index) =>
    isoDate(addDays(start, index)),
  );
}

function normalizeView(value?: string): "day" | "week" | "agenda" {
  if (value === "day") return "day";
  if (value === "agenda") return "agenda";
  return "week";
}

function normalizeSource(value?: string): "all" | "appointments" | "events" {
  if (value === "appointments" || value === "events") return value;
  return "all";
}

function normalizeGroupBy(value?: string): "none" | "instructor" {
  return value === "instructor" ? "instructor" : "none";
}

function safeFilter(value?: string) {
  if (!value || value === "all") return undefined;
  return value;
}

function getDateInTimeZone(value: string, timeZone: string) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function getEventDateTime(
  date: string,
  time: string | null,
  fallbackTime: string,
) {
  return `${date}T${time || fallbackTime}`;
}

async function getStudioTimezone(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
}) {
  const { supabase, studioId } = params;

  const { data, error } = await supabase
    .from("studio_settings")
    .select("timezone")
    .eq("studio_id", studioId)
    .maybeSingle<{ timezone: string | null }>();

  if (error) {
    console.error(
      "Could not load studio timezone for calendar:",
      error.message,
    );
  }

  return data?.timezone || "America/New_York";
}

function eventOverlapsDays(event: EventRow, days: string[]) {
  const firstDay = days[0];
  const lastDay = days[days.length - 1];

  return event.start_date <= lastDay && event.end_date >= firstDay;
}

function expandEventForDays(event: EventRow, days: string[]): CalendarItem[] {
  return days
    .filter((day) => event.start_date <= day && event.end_date >= day)
    .map((day) => ({
      kind: "event" as const,
      id: event.id,
      event_type: event.event_type,
      title: event.name,
      status: event.status,
      starts_at: getEventDateTime(day, event.start_time, "00:00:00"),
      ends_at: getEventDateTime(day, event.end_time, "23:59:59"),
      display_date: day,
      is_all_day: !event.start_time && !event.end_time,
      name: event.name,
      slug: event.slug,
      venue_name: event.venue_name,
      city: event.city,
      state: event.state,
      organizers: event.organizers,
    }));
}

function toCalendarAppointment(
  row: AppointmentRow,
  displayDate: string,
): CalendarItem {
  return {
    kind: "appointment",
    id: row.id,
    studio_id: row.studio_id,
    client_id: row.client_id,
    instructor_id: row.instructor_id,
    room_id: row.room_id,
    appointment_type: row.appointment_type,
    title: row.title,
    status: row.status,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    display_date: displayDate,
    is_recurring: row.is_recurring,
    notes: row.notes,
    price_amount: row.price_amount,
    payment_status: row.payment_status,
    clients: row.clients,
    partner_client: row.partner_client,
    instructors: row.instructors,
    rooms: row.rooms,
  };
}

function sortCalendarItems(items: CalendarItem[]) {
  return [...items].sort((a, b) => {
    const aKey = a.starts_at || `${a.display_date ?? ""}T00:00:00`;
    const bKey = b.starts_at || `${b.display_date ?? ""}T00:00:00`;
    return aKey.localeCompare(bKey);
  });
}

function CompactScheduleHeader() {
  const labels = ["Private lessons", "Floor rentals", "Room unavailable", "Agenda-ready"];

  return (
    <section className="overflow-hidden rounded-[28px] border border-[var(--brand-border)] bg-white shadow-sm">
      <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-5 py-5 text-white md:px-6">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
          DanceFlow Schedule
        </p>
        <div className="mt-2 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Calendar &amp; Agenda
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-white/80">
              Plan lessons, floor rentals, unavailable room blocks, and studio
              activity from one clean view.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {labels.map((label) => (
              <span
                key={label}
                className="rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-medium text-white"
              >
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
export default async function ScheduleCalendarPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const studioTimezone = await getStudioTimezone({ supabase, studioId });

  const view = normalizeView(params.view);
  const baseDate = getBaseDate(params.date);
  const days = buildDays(baseDate, view);
  const selectedInstructorId = safeFilter(
    params.instructorId ?? params.instructor,
  );
  const selectedRoomId = safeFilter(params.roomId ?? params.room);
  const selectedAppointmentType = safeFilter(
    params.appointmentType ?? params.type,
  );
  const selectedStatus = safeFilter(params.status);
  const selectedSource = normalizeSource(params.source);
  const groupBy = normalizeGroupBy(params.groupBy);

  const rangeStart = addDays(startOfLocalDate(days[0]), -1).toISOString();
  const rangeEnd = addDays(
    startOfLocalDate(days[days.length - 1]),
    2,
  ).toISOString();

  let appointmentsQuery = supabase
    .from("appointments")
    .select(
      `
      id,
      studio_id,
      client_id,
      instructor_id,
      room_id,
      appointment_type,
      title,
      status,
      starts_at,
      ends_at,
      is_recurring,
      notes,
      price_amount,
      payment_status,
      clients:clients!appointments_client_id_fkey ( first_name, last_name ),
      partner_client:clients!appointments_partner_client_id_fkey ( first_name, last_name ),
      instructors ( first_name, last_name ),
      rooms ( name )
    `,
    )
    .eq("studio_id", studioId)
    .gte("starts_at", rangeStart)
    .lt("starts_at", rangeEnd)
    .order("starts_at", { ascending: true });

  if (selectedInstructorId) {
    appointmentsQuery = appointmentsQuery.eq(
      "instructor_id",
      selectedInstructorId,
    );
  }

  if (selectedRoomId) {
    appointmentsQuery = appointmentsQuery.eq("room_id", selectedRoomId);
  }

  if (selectedAppointmentType) {
    appointmentsQuery = appointmentsQuery.eq(
      "appointment_type",
      selectedAppointmentType,
    );
  }

  if (selectedStatus) {
    appointmentsQuery = appointmentsQuery.eq("status", selectedStatus);
  }

  let eventsQuery = supabase
    .from("events")
    .select(
      `
      id,
      name,
      slug,
      event_type,
      status,
      start_date,
      end_date,
      start_time,
      end_time,
      venue_name,
      city,
      state,
      organizers ( name )
    `,
    )
    .eq("studio_id", studioId)
    .in("status", ["draft", "published"])
    .lte("start_date", days[days.length - 1])
    .gte("end_date", days[0])
    .order("start_date", { ascending: true });

  if (selectedStatus) {
    if (
      ["scheduled", "attended", "cancelled", "no_show", "rescheduled"].includes(
        selectedStatus,
      )
    ) {
      eventsQuery = eventsQuery.eq("id", "__no_event_match__");
    } else {
      eventsQuery = eventsQuery.eq("status", selectedStatus);
    }
  }

  const [
    { data: appointments, error: appointmentsError },
    { data: events, error: eventsError },
    { data: instructors, error: instructorsError },
    { data: rooms, error: roomsError },
  ] = await Promise.all([
    selectedSource === "events"
      ? Promise.resolve({ data: [], error: null })
      : appointmentsQuery,
    selectedSource === "appointments" ||
    selectedInstructorId ||
    selectedRoomId ||
    selectedAppointmentType
      ? Promise.resolve({ data: [], error: null })
      : eventsQuery,
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
    throw new Error(
      `Failed to load calendar appointments: ${appointmentsError.message}`,
    );
  }

  if (eventsError) {
    throw new Error(`Failed to load calendar events: ${eventsError.message}`);
  }

  if (instructorsError) {
    throw new Error(`Failed to load instructors: ${instructorsError.message}`);
  }

  if (roomsError) {
    throw new Error(`Failed to load rooms: ${roomsError.message}`);
  }

  const groupedAppointments: Record<string, CalendarItem[]> =
    Object.fromEntries(days.map((day) => [day, []]));

  ((appointments ?? []) as AppointmentRow[]).forEach((appointment) => {
    const displayDate = getDateInTimeZone(
      appointment.starts_at,
      studioTimezone,
    );

    if (!groupedAppointments[displayDate]) return;

    groupedAppointments[displayDate].push(
      toCalendarAppointment(appointment, displayDate),
    );
  });

  ((events ?? []) as EventRow[])
    .filter((event) => eventOverlapsDays(event, days))
    .flatMap((event) => expandEventForDays(event, days))
    .forEach((eventItem) => {
      const displayDate = eventItem.display_date;
      if (!displayDate || !groupedAppointments[displayDate]) return;
      groupedAppointments[displayDate].push(eventItem);
    });

  Object.keys(groupedAppointments).forEach((day) => {
    groupedAppointments[day] = sortCalendarItems(groupedAppointments[day]);
  });

  if (view === "agenda") {
    return (
      <div className="space-y-6">
        <CompactScheduleHeader />
        <ScheduleAgendaView
          baseDate={baseDate}
          days={days}
          groupedAppointments={groupedAppointments}
          instructors={(instructors ?? []) as InstructorOption[]}
          rooms={(rooms ?? []) as RoomOption[]}
          selectedInstructorId={selectedInstructorId}
          selectedRoomId={selectedRoomId}
          selectedAppointmentType={selectedAppointmentType}
          selectedStatus={selectedStatus}
          selectedSource={selectedSource}
          groupBy={groupBy}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <CompactScheduleHeader />
      <ScheduleCalendarView
        view={view}
        baseDate={baseDate}
        days={days}
        groupedAppointments={groupedAppointments}
        instructors={(instructors ?? []) as InstructorOption[]}
        rooms={(rooms ?? []) as RoomOption[]}
        selectedInstructorId={selectedInstructorId}
        selectedRoomId={selectedRoomId}
        selectedAppointmentType={selectedAppointmentType}
        selectedStatus={selectedStatus}
        selectedSource={selectedSource}
      />
    </div>
  );
}

