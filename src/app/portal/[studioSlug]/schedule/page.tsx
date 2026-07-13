import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AppointmentSelfServiceActions from "./AppointmentSelfServiceActions";
import SelfServiceBookingPanel from "./SelfServiceBookingPanel";
import { resolvePortalRelationship, portalClientPath } from "@/lib/student-identity/portal-context";

const DEFAULT_TIME_ZONE = "America/New_York";

function getStudioTimeZone(value?: string | null) {
  const timeZone = value?.trim() || DEFAULT_TIME_ZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function getZonedDateTimeParts(value: Date | string, timeZone: string) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? "0");
  const hourPart = part("hour");

  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: hourPart === 24 ? 0 : hourPart,
    minute: part("minute"),
    second: part("second"),
  };
}

function getZonedOffsetMs(date: Date, timeZone: string) {
  const parts = getZonedDateTimeParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return asUtc - date.getTime();
}

function zonedDateTimeToUtcDate(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);

  let utcMs = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);

  for (let index = 0; index < 3; index += 1) {
    const offsetMs = getZonedOffsetMs(new Date(utcMs), timeZone);
    utcMs = Date.UTC(year, month - 1, day, hours, minutes, 0, 0) - offsetMs;
  }

  return new Date(utcMs);
}

function zonedDateTimeToUtcIso(date: string, time: string, timeZone: string) {
  return zonedDateTimeToUtcDate(date, time, timeZone).toISOString();
}

function getZonedDateKey(value: Date | string, timeZone: string) {
  const parts = getZonedDateTimeParts(value, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addDaysToDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));

  return date.toISOString().slice(0, 10);
}

function getZonedWeekday(dateKey: string, timeZone: string) {
  const date = zonedDateTimeToUtcDate(dateKey, "12:00", timeZone);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);

  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
}

function getLocalDayUtcRange(dateKey: string, timeZone: string) {
  const safeTimeZone = getStudioTimeZone(timeZone);
  const nextDateKey = addDaysToDateKey(dateKey, 1);

  return {
    startIso: zonedDateTimeToUtcIso(dateKey, "00:00", safeTimeZone),
    endIso: zonedDateTimeToUtcIso(nextDateKey, "00:00", safeTimeZone),
  };
}

function formatStudioDate(value: string | null | undefined, timeZone: string, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: getStudioTimeZone(timeZone),
    month: "short",
    day: "numeric",
    year: "numeric",
    ...options,
  }).format(new Date(value));
}

function formatStudioTime(value: string | null | undefined, timeZone: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: getStudioTimeZone(timeZone),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

type PageProps = {
  params: Promise<{
    studioSlug: string;
  }>;
  searchParams: Promise<{
    client?: string;
    success?: string;
    error?: string;
  }>;
};

type ClientRow = {
  id: string;
  first_name: string;
  last_name: string;
  studio_id: string;
  is_independent_instructor: boolean | null;
  linked_instructor_id: string | null;
};

type CalendarRow = {
  id: string;
  title: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  appointment_type: string;
  client_id: string | null;
  instructor_id: string | null;
  room_id: string | null;
  clients:
    | {
        first_name: string;
        last_name: string;
      }
    | {
        first_name: string;
        last_name: string;
      }[]
    | null;
  rooms:
    | {
        name: string;
      }
    | {
        name: string;
      }[]
    | null;
};

type LessonRecapRow = {
  id: string;
  appointment_id: string;
  summary: string | null;
  homework: string | null;
  next_focus: string | null;
  visible_to_client: boolean | null;
  updated_at: string;
};

type StudioSettingsRow = {
  timezone: string | null;
  portal_self_scheduling_enabled: boolean | null;
  portal_self_scheduling_mode: string | null;
  portal_self_scheduling_window_days: number | null;
  portal_self_scheduling_min_notice_hours: number | null;
  portal_self_scheduling_cancellation_cutoff_hours: number | null;
  booking_request_allowed_weekdays: number[] | null;
  booking_request_start_time: string | null;
  booking_request_end_time: string | null;
  portal_bookable_lesson_types: string[] | null;
  portal_bookable_instructor_ids: string[] | null;
};

type BookingRequestRow = {
  id: string;
  status: string;
  source: string;
  appointment_type: string;
  title: string | null;
  requested_starts_at: string;
  requested_ends_at: string;
  staff_note: string | null;
  created_at: string;
  reviewed_at: string | null;
  appointment_id: string | null;
  instructors:
    | {
        first_name: string | null;
        last_name: string | null;
      }
    | {
        first_name: string | null;
        last_name: string | null;
      }[]
    | null;
};

type SelfServiceActionRequestRow = {
  id: string;
  action_type: string;
  mode: string;
  status: string;
  lesson_type: string | null;
  requested_starts_at: string | null;
  requested_ends_at: string | null;
  previous_starts_at: string | null;
  previous_ends_at: string | null;
  reason: string | null;
  staff_note: string | null;
  failure_reason: string | null;
  created_at: string;
  decision_at: string | null;
  executed_at: string | null;
  instructors:
    | {
        first_name: string | null;
        last_name: string | null;
      }
    | {
        first_name: string | null;
        last_name: string | null;
      }[]
    | null;
};

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function getAllowedWeekdays(settings: StudioSettingsRow | null) {
  return settings?.booking_request_allowed_weekdays?.length
    ? settings.booking_request_allowed_weekdays
    : [1, 2, 3, 4, 5, 6];
}

function formatWeekdayList(values: number[] | null | undefined) {
  const days = values?.length ? values : [1, 2, 3, 4, 5, 6];

  return days
    .map((value) => WEEKDAY_LABELS[value] ?? "")
    .filter(Boolean)
    .join(", ");
}

function formatPortalLessonTypes(values: string[] | null | undefined) {
  const lessonTypes = values?.length ? values : ["private_lesson"];
  return lessonTypes.map((value) => typeLabel(value)).join(", ");
}

function requestStatusLabel(status: string) {
  if (status === "pending") return "Pending review";
  if (status === "approved") return "Approved";
  if (status === "declined") return "Declined";
  return formatStatusLabel(status);
}

function selfServiceActionLabel(value: string) {
  if (value === "book") return "Booking";
  if (value === "reschedule") return "Reschedule";
  if (value === "cancel") return "Cancellation";
  return formatStatusLabel(value);
}

function requestStatusBadgeClass(status: string) {
  if (status === "pending") return "border-amber-200 bg-amber-50 text-amber-800";
  if (status === "approved") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "declined") return "border-rose-200 bg-rose-50 text-rose-800";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function getSingle<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function getClientName(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null
    | undefined
) {
  const client = getSingle(value);
  if (!client) return "No client";
  return `${client.first_name} ${client.last_name}`;
}

function getRoomName(
  value: { name: string } | { name: string }[] | null | undefined
) {
  const room = getSingle(value);
  return room?.name ?? "No room listed";
}

function formatDate(value: string, timeZone: string) {
  return formatStudioDate(`${value}T12:00:00.000Z`, "UTC", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatTimeRange(start: string, end: string, timeZone: string) {
  return `${formatStudioTime(start, timeZone)} – ${formatStudioTime(end, timeZone)}`;
}

function formatDateTime(value: string, timeZone: string) {
  return formatStudioDate(value, timeZone);
}

function groupKeyForAppointment(value: string, timeZone: string) {
  return getZonedDateKey(value, timeZone);
}

function formatStatusLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusBadgeClass(status: string) {
  if (status === "scheduled") return "bg-blue-50 text-blue-700 ring-blue-100";
  if (status === "attended") return "bg-green-50 text-green-700 ring-green-100";
  if (status === "cancelled") return "bg-red-50 text-red-700 ring-red-100";
  if (status === "no_show") return "bg-amber-50 text-amber-700 ring-amber-100";
  if (status === "rescheduled") return "bg-purple-50 text-purple-700 ring-purple-100";
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function typeBadgeClass(type: string) {
  if (type === "floor_space_rental") return "bg-indigo-50 text-indigo-700 ring-indigo-100";
  if (type === "private_lesson") return "bg-slate-100 text-slate-700 ring-slate-200";
  if (type === "group_class") return "bg-green-50 text-green-700 ring-green-100";
  if (type === "intro_lesson") return "bg-cyan-50 text-cyan-700 ring-cyan-100";
  if (type === "coaching") return "bg-purple-50 text-purple-700 ring-purple-100";
  if (type === "practice_party") return "bg-amber-50 text-amber-700 ring-amber-100";
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function typeLabel(type: string) {
  if (type === "floor_space_rental") return "Floor Rental";
  if (type === "private_lesson") return "Private Lesson";
  if (type === "group_class") return "Group Class";
  if (type === "intro_lesson") return "Intro Lesson";
  if (type === "coaching") return "Coaching";
  if (type === "practice_party") return "Practice Party";
  if (type === "event") return "Event";
  return type.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function groupByDay(rows: CalendarRow[], studioTimeZone: string) {
  const grouped = new Map<string, CalendarRow[]>();

  for (const row of rows) {
    const key = groupKeyForAppointment(row.starts_at, studioTimeZone);
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }

  return Array.from(grouped.entries()).map(([date, items]) => ({
    date,
    items: items.sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
  }));
}

function ScheduleCard({
  item,
  studioSlug,
  clientId,
  isIndependentInstructor,
  recap,
  studioTimeZone,
}: {
  item: CalendarRow;
  studioSlug: string;
  clientId: string;
  isIndependentInstructor: boolean;
  recap?: LessonRecapRow;
  studioTimeZone: string;
}) {
  const isRental = item.appointment_type === "floor_space_rental";

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${statusBadgeClass(
                item.status
              )}`}
            >
              {formatStatusLabel(item.status)}
            </span>
            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${typeBadgeClass(
                item.appointment_type
              )}`}
            >
              {typeLabel(item.appointment_type)}
            </span>
          </div>

          <h3 className="mt-3 text-base font-semibold text-slate-900">
            {item.title || typeLabel(item.appointment_type)}
          </h3>

          <p className="mt-1 text-sm text-slate-600">
            {formatTimeRange(item.starts_at, item.ends_at, studioTimeZone)}
          </p>

          <div className="mt-2 space-y-1 text-sm text-slate-500">
            <p>Client: {getClientName(item.clients)}</p>
            <p>Room: {getRoomName(item.rooms)}</p>
          </div>

          {recap ? (
            <div className="mt-4 rounded-2xl border border-violet-100 bg-violet-50 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-violet-950">Lesson Recap</p>
                <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-violet-700 ring-1 ring-violet-100">
                  Updated {formatDateTime(recap.updated_at, studioTimeZone)}
                </span>
              </div>
              {recap.summary ? (
                <p className="mt-2 text-sm leading-6 text-violet-900">{recap.summary}</p>
              ) : null}
              {recap.homework ? (
                <p className="mt-2 text-sm leading-6 text-violet-900">
                  <span className="font-medium">Homework:</span> {recap.homework}
                </p>
              ) : null}
              {recap.next_focus ? (
                <p className="mt-2 text-sm leading-6 text-violet-900">
                  <span className="font-medium">Next focus:</span> {recap.next_focus}
                </p>
              ) : null}
            </div>
          ) : null}

          {!isRental ? (
            <AppointmentSelfServiceActions
              studioSlug={studioSlug}
              appointmentId={item.id}
              appointmentType={item.appointment_type}
              status={item.status}
              startsAt={item.starts_at}
              studioTimeZone={studioTimeZone}
            />
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {isRental && isIndependentInstructor ? (
            <Link
              href={portalClientPath(studioSlug, clientId, "/floor-space/my-rentals")}
              className="inline-flex items-center justify-center rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              View Rentals
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}

async function loadAppointments(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  client: ClientRow;
}) {
  const { supabase, studioId, client } = params;

  let query = supabase
    .from("appointments")
    .select(`
      id,
      title,
      starts_at,
      ends_at,
      status,
      appointment_type,
      client_id,
      instructor_id,
      room_id,
      clients:clients!client_id(first_name, last_name),
      rooms:rooms!room_id(name)
    `)
    .eq("studio_id", studioId)
    .order("starts_at", { ascending: true });

  if (client.is_independent_instructor && client.linked_instructor_id) {
    query = query.or(
      `client_id.eq.${client.id},instructor_id.eq.${client.linked_instructor_id}`
    );
  } else {
    query = query.eq("client_id", client.id);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  const dedupedMap = new Map<string, CalendarRow>();
  for (const row of (data ?? []) as CalendarRow[]) {
    dedupedMap.set(row.id, row);
  }

  return Array.from(dedupedMap.values()).sort((a, b) =>
    a.starts_at.localeCompare(b.starts_at)
  );
}

export default async function PortalSchedulePage({ params, searchParams }: PageProps) {
  const { studioSlug } = await params;
  const query = await searchParams;
  const requestedClientId = query.client ?? null;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/portal/${studioSlug}/schedule`)}`);
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, name, slug, public_name")
    .eq("slug", studioSlug)
    .maybeSingle();

  if (studioError || !studio) {
    notFound();
  }

  const relationship = await resolvePortalRelationship({
    userId: user.id,
    studioId: studio.id,
    requestedClientId,
    permission: "can_view_schedule",
  });

  if (!relationship) {
    redirect(`/portal/${studioSlug}`);
  }

  const { data: portalClient, error: portalClientError } = await supabase
    .from("clients")
    .select(`
      id,
      first_name,
      last_name,
      studio_id,
      is_independent_instructor,
      linked_instructor_id
    `)
    .eq("studio_id", studio.id)
    .eq("id", relationship.clientId)
    .maybeSingle<ClientRow>();

  if (portalClientError || !portalClient) {
    redirect(`/portal/${studioSlug}`);
  }

  const { data: settingsData } = await supabase
    .from("studio_settings")
    .select(`
      timezone,
      portal_self_scheduling_enabled,
      portal_self_scheduling_mode,
      portal_self_scheduling_window_days,
      portal_self_scheduling_min_notice_hours,
      portal_self_scheduling_cancellation_cutoff_hours,
      booking_request_allowed_weekdays,
      booking_request_start_time,
      booking_request_end_time,
      portal_bookable_lesson_types,
      portal_bookable_instructor_ids
    `)
    .eq("studio_id", studio.id)
    .maybeSingle<StudioSettingsRow>();

  const settings = settingsData ?? null;
  const studioTimeZone = getStudioTimeZone(settings?.timezone);
  const portalSchedulingEnabled =
    settings?.portal_self_scheduling_enabled === true &&
    (settings.portal_self_scheduling_mode ?? "request_only") !== "disabled";

  const allowedLessonTypes = settings?.portal_bookable_lesson_types?.length
    ? settings.portal_bookable_lesson_types
    : ["private_lesson"];

  const { data: portalRequests } = await supabase
    .from("booking_requests")
    .select(`
      id,
      status,
      source,
      appointment_type,
      title,
      requested_starts_at,
      requested_ends_at,
      staff_note,
      created_at,
      reviewed_at,
      appointment_id,
      instructors(first_name, last_name)
    `)
    .eq("studio_id", studio.id)
    .eq("client_id", portalClient.id)
    .eq("source", "portal_schedule")
    .order("created_at", { ascending: false })
    .limit(10);

  const typedPortalRequests = (portalRequests ?? []) as BookingRequestRow[];

  const { data: selfServiceRequests } = await supabase
    .from("student_booking_action_requests")
    .select(`
      id,
      action_type,
      mode,
      status,
      lesson_type,
      requested_starts_at,
      requested_ends_at,
      previous_starts_at,
      previous_ends_at,
      reason,
      staff_note,
      failure_reason,
      created_at,
      decision_at,
      executed_at,
      instructors(first_name, last_name)
    `)
    .eq("studio_id", studio.id)
    .eq("client_id", portalClient.id)
    .order("created_at", { ascending: false })
    .limit(10);

  const typedSelfServiceRequests = (selfServiceRequests ?? []) as SelfServiceActionRequestRow[];

  const isIndependentInstructor = portalClient.is_independent_instructor === true;
  const appointments = await loadAppointments({
    supabase,
    studioId: studio.id,
    client: portalClient,
  });

  const recapAppointmentIds = appointments
    .filter((item) => item.status === "attended")
    .map((item) => item.id);

  let lessonRecaps: LessonRecapRow[] = [];

  if (recapAppointmentIds.length) {
    const { data, error } = await supabase
      .from("lesson_recaps")
      .select("id, appointment_id, summary, homework, next_focus, visible_to_client, updated_at")
      .eq("studio_id", studio.id)
      .in("appointment_id", recapAppointmentIds)
      .eq("visible_to_client", true)
      .order("updated_at", { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    lessonRecaps = (data ?? []) as LessonRecapRow[];
  }

  const recapByAppointmentId = new Map(
    lessonRecaps.map((recap) => [recap.appointment_id, recap])
  );

  const now = new Date();
  const upcoming = appointments.filter((row) => new Date(row.ends_at) >= now);
  const recent = appointments
    .filter((row) => new Date(row.ends_at) < now)
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
    .slice(0, 30);

  const upcomingGroups = groupByDay(upcoming, studioTimeZone);
  const recentGroups = groupByDay(recent, studioTimeZone);

  const rentalCount = appointments.filter(
    (row) => row.appointment_type === "floor_space_rental"
  ).length;

  const studioLabel = studio.public_name?.trim() || studio.name;
  const requestWindowDays = settings?.portal_self_scheduling_window_days ?? 14;
  const minNoticeHours = settings?.portal_self_scheduling_min_notice_hours ?? 24;
  const cancellationCutoffHours =
    settings?.portal_self_scheduling_cancellation_cutoff_hours ?? 24;
  const requestStartTime = (settings?.booking_request_start_time ?? "09:00").slice(0, 5);
  const requestEndTime = (settings?.booking_request_end_time ?? "21:00").slice(0, 5);
  const allowedWeekdays = getAllowedWeekdays(settings);
  const banner =
    query.success === "schedule_request_submitted"
      ? {
          kind: "success" as const,
          message: "Your schedule request was sent to the studio for review.",
        }
      : query.error
        ? {
            kind: "error" as const,
            message: decodeURIComponent(query.error),
          }
        : null;


  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-7 text-white md:px-8">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Portal
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
                My Schedule
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85">
                Review upcoming appointments, past lessons, and shared lesson recaps for {studioLabel}.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-white/15 bg-white/10 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/65">
                  Upcoming
                </p>
                <p className="mt-1 text-2xl font-semibold text-white">{upcoming.length}</p>
              </div>

              <div className="rounded-2xl border border-white/15 bg-white/10 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/65">
                  Recent
                </p>
                <p className="mt-1 text-2xl font-semibold text-white">{recent.length}</p>
              </div>

              <div className="rounded-2xl border border-white/15 bg-white/10 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/65">
                  Recaps
                </p>
                <p className="mt-1 text-2xl font-semibold text-white">{lessonRecaps.length}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-3 border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <Link
            href={portalClientPath(studioSlug, portalClient.id)}
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Back to Portal
          </Link>

          {isIndependentInstructor ? (
            <>
              <Link
                 href={portalClientPath(studioSlug, portalClient.id, "/floor-space")}
                className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Book Floor Space
              </Link>

              <Link
                href={portalClientPath(studioSlug, portalClient.id, "/floor-space/my-rentals")}
                className="inline-flex items-center justify-center rounded-xl bg-[var(--brand-accent-dark)] px-4 py-2.5 text-sm font-medium text-white hover:opacity-95"
              >
                My Rentals
              </Link>
            </>
          ) : null}
        </div>
      </section>


      {banner ? (
        <section
          className={`rounded-3xl border p-5 shadow-sm ${
            banner.kind === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
        >
          <p className="text-sm font-semibold">
            {banner.message}
          </p>
        </section>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <main className="space-y-6">
          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-black/[0.02] md:p-6">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Upcoming Schedule</h2>
              <p className="mt-1 text-sm text-slate-500">
                Future lessons, classes, rentals, and studio appointments connected to your portal.
              </p>
            </div>

            {upcomingGroups.length === 0 ? (
              <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center">
                <p className="text-sm font-medium text-slate-600">No upcoming schedule items.</p>
              </div>
            ) : (
              <div className="mt-5 space-y-6">
                {upcomingGroups.map((group) => (
                  <div key={group.date}>
                    <div className="mb-3 flex items-center gap-3">
                      <h3 className="text-sm font-semibold text-slate-900">
                        {formatDate(group.date, studioTimeZone)}
                      </h3>
                      <div className="h-px flex-1 bg-slate-200" />
                    </div>

                    <div className="space-y-3">
                      {group.items.map((item) => (
                        <ScheduleCard
                          key={item.id}
                          item={item}
                          studioSlug={studioSlug}
                          clientId={portalClient.id}
                          isIndependentInstructor={isIndependentInstructor}
                          recap={recapByAppointmentId.get(item.id)}
                          studioTimeZone={studioTimeZone}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-black/[0.02] md:p-6">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Past Appointments & Recaps</h2>
              <p className="mt-1 text-sm text-slate-500">
                Review recent appointments and any lesson recaps your instructor has shared.
              </p>
            </div>

            {recentGroups.length === 0 ? (
              <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center">
                <p className="text-sm font-medium text-slate-600">No recent schedule history.</p>
              </div>
            ) : (
              <div className="mt-5 space-y-6">
                {recentGroups.map((group) => (
                  <div key={group.date}>
                    <div className="mb-3 flex items-center gap-3">
                      <h3 className="text-sm font-semibold text-slate-900">
                        {formatDate(group.date, studioTimeZone)}
                      </h3>
                      <div className="h-px flex-1 bg-slate-200" />
                    </div>

                    <div className="space-y-3">
                      {group.items.map((item) => (
                        <ScheduleCard
                          key={item.id}
                          item={item}
                          studioSlug={studioSlug}
                          clientId={portalClient.id}
                          isIndependentInstructor={isIndependentInstructor}
                          recap={recapByAppointmentId.get(item.id)}
                          studioTimeZone={studioTimeZone}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-black/[0.02] md:p-6">
            <h2 className="text-lg font-semibold text-slate-900">Schedule Notes</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-900">Lesson recaps</p>
                <p className="mt-1 text-sm text-slate-600">
                  Recaps appear here after your instructor shares them from an attended private lesson.
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-900">
                  {isIndependentInstructor ? "Floor rentals" : "Need a schedule change?"}
                </p>
                <p className="mt-1 text-sm text-slate-600">
                  {isIndependentInstructor
                    ? `You have ${rentalCount} floor rental item${rentalCount === 1 ? "" : "s"} connected to this portal.`
                    : "Use the lesson change controls on a scheduled private lesson, or send a request from the schedule tools."}
                </p>
              </div>
            </div>
          </section>
        </main>

        <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
          {portalSchedulingEnabled ? (
            <SelfServiceBookingPanel
              studioSlug={studioSlug}
              studioTimeZone={studioTimeZone}
            />
          ) : (
            <section className="rounded-2xl border border-slate-200 bg-white p-4">
              <h2 className="text-base font-semibold text-slate-950">Booking tools</h2>
              <p className="mt-1 text-sm text-slate-600">
                Contact the studio directly to request schedule changes.
              </p>
            </section>
          )}

          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <h2 className="text-base font-semibold text-slate-950">Booking rules</h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Available lesson times are controlled by the studio.
            </p>

            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">
              <p><span className="font-medium text-slate-900">Bookable:</span> {formatPortalLessonTypes(allowedLessonTypes)}</p>
              <p><span className="font-medium text-slate-900">Days:</span> {formatWeekdayList(allowedWeekdays)}</p>
              <p><span className="font-medium text-slate-900">Hours:</span> {requestStartTime}-{requestEndTime}</p>
              <p><span className="font-medium text-slate-900">Window:</span> {requestWindowDays} days ahead</p>
              <p><span className="font-medium text-slate-900">Changes:</span> {cancellationCutoffHours}h cutoff</p>
              <p><span className="font-medium text-slate-900">Notice:</span> {minNoticeHours}h minimum</p>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-slate-950">Recent requests</h2>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                {typedSelfServiceRequests.length + typedPortalRequests.length}
              </span>
            </div>

            {typedSelfServiceRequests.length === 0 && typedPortalRequests.length === 0 ? (
              <p className="mt-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">
                No schedule requests yet.
              </p>
            ) : (
              <div className="mt-3 space-y-3">
                {typedSelfServiceRequests.slice(0, 5).map((request) => (
                  <article key={request.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="flex flex-wrap gap-2">
                      <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${requestStatusBadgeClass(request.status)}`}>
                        {requestStatusLabel(request.status)}
                      </span>
                      <span className="rounded-full bg-sky-50 px-2.5 py-1 text-[11px] font-semibold text-sky-700">
                        {selfServiceActionLabel(request.action_type)}
                      </span>
                    </div>
                    <p className="mt-2 text-sm font-semibold text-slate-950">
                      {selfServiceActionLabel(request.action_type)} request
                    </p>
                    <p className="mt-1 text-xs leading-5 text-slate-600">
                      {request.action_type === "cancel"
                        ? request.previous_starts_at
                          ? formatTimeRange(request.previous_starts_at, request.previous_ends_at ?? request.previous_starts_at, studioTimeZone)
                          : "Cancellation requested"
                        : request.requested_starts_at && request.requested_ends_at
                          ? formatTimeRange(request.requested_starts_at, request.requested_ends_at, studioTimeZone)
                          : "Studio will review the request."}
                    </p>
                    {request.staff_note ? (
                      <p className="mt-2 rounded-lg bg-white p-2 text-xs text-slate-700">
                        Studio note: {request.staff_note}
                      </p>
                    ) : null}
                    {request.failure_reason ? (
                      <p className="mt-2 rounded-lg bg-rose-50 p-2 text-xs text-rose-700">
                        {request.failure_reason}
                      </p>
                    ) : null}
                  </article>
                ))}

                {typedPortalRequests.slice(0, 5).map((request) => (
                  <article key={request.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="flex flex-wrap gap-2">
                      <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${requestStatusBadgeClass(request.status)}`}>
                        {requestStatusLabel(request.status)}
                      </span>
                      <span className="rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-700">
                        {typeLabel(request.appointment_type)}
                      </span>
                    </div>
                    <p className="mt-2 text-sm font-semibold text-slate-950">
                      {request.title || typeLabel(request.appointment_type)}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-slate-600">
                      {formatTimeRange(request.requested_starts_at, request.requested_ends_at, studioTimeZone)}
                    </p>
                    {request.staff_note ? (
                      <p className="mt-2 rounded-lg bg-white p-2 text-xs text-slate-700">
                        Studio note: {request.staff_note}
                      </p>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}