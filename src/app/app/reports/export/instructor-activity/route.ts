import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canViewReports } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type AppointmentRow = {
  id: string;
  status: string | null;
  starts_at: string | null;
  appointment_type: string | null;
  instructor_id: string | null;
  duration_minutes: number | null;
  price_amount: number | null;
  payment_status: string | null;
};

type InstructorRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
};

type InstructorSummary = {
  instructorId: string;
  name: string;
  totalAppointments: number;
  attended: number;
  scheduled: number;
  cancelled: number;
  noShows: number;
  privateLessons: number;
  groupClasses: number;
  minutes: number;
  revenue: number;
};


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
    timeZone: getStudioTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  const hourValue = Number(lookup.get("hour") ?? "0");

  return {
    year: lookup.get("year") ?? "0000",
    month: lookup.get("month") ?? "01",
    day: lookup.get("day") ?? "01",
    hour: String(hourValue === 24 ? 0 : hourValue).padStart(2, "0"),
    minute: lookup.get("minute") ?? "00",
    second: lookup.get("second") ?? "00",
  };
}

function getZonedOffsetMs(date: Date, timeZone: string) {
  const parts = getZonedDateTimeParts(date, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  return asUtc - date.getTime();
}

function zonedDateTimeToUtcDate(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour = 0, minute = 0, second = 0] = time.split(":").map(Number);

  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);

  for (let i = 0; i < 2; i += 1) {
    const offsetMs = getZonedOffsetMs(new Date(utcMs), timeZone);
    utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0) - offsetMs;
  }

  return new Date(utcMs);
}

function zonedDateTimeToUtcIso(date: string, time: string, timeZone: string) {
  return zonedDateTimeToUtcDate(date, time, timeZone).toISOString();
}

function getZonedDateKey(value: Date | string, timeZone: string) {
  const parts = getZonedDateTimeParts(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDaysToDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));
  return date.toISOString().slice(0, 10);
}

function getRangeStartDateKey(range: string, timeZone: string) {
  const nowParts = getZonedDateTimeParts(new Date(), timeZone);
  const year = Number(nowParts.year);
  const month = Number(nowParts.month);

  if (range === "today") {
    return `${nowParts.year}-${nowParts.month}-${nowParts.day}`;
  }

  if (range === "last_30" || range === "last30") {
    return addDaysToDateKey(`${nowParts.year}-${nowParts.month}-${nowParts.day}`, -30);
  }

  if (range === "quarter") {
    const quarterStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
    return `${year}-${String(quarterStartMonth).padStart(2, "0")}-01`;
  }

  if (range === "year") {
    return `${year}-01-01`;
  }

  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function getRangeStartIso(range: string, timeZone: string) {
  return zonedDateTimeToUtcIso(getRangeStartDateKey(range, timeZone), "00:00", timeZone);
}


function csvEscape(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function toCsv(headers: string[], rows: Array<Array<unknown>>) {
  return [headers, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
}

function csvResponse(csv: string, filename: string) {
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

function percentage(part: number, total: number) {
  if (!total) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const range = url.searchParams.get("range") ?? "month";

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!canViewReports(context.studioRole ?? "") || !context.studioId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { data: studioTimeZoneRow } = await supabase
    .from("studios")
    .select("timezone")
    .eq("id", context.studioId)
    .maybeSingle<{ timezone: string | null }>();

  const studioTimeZone = getStudioTimeZone(studioTimeZoneRow?.timezone);
  const rangeStart = getRangeStartIso(range, studioTimeZone);
  const nowIso = new Date().toISOString();

  const [appointmentsResult, instructorsResult] = await Promise.all([
    supabase
      .from("appointments")
      .select(
        "id, status, starts_at, appointment_type, instructor_id, duration_minutes, price_amount, payment_status",
      )
      .eq("studio_id", context.studioId)
      .gte("starts_at", rangeStart)
      .lte("starts_at", nowIso)
      .order("starts_at", { ascending: false })
      .limit(5000),
    supabase
      .from("instructors")
      .select("id, first_name, last_name")
      .eq("studio_id", context.studioId)
      .order("first_name", { ascending: true })
      .limit(1000),
  ]);

  if (appointmentsResult.error) {
    return new NextResponse(
      `Failed to export instructor activity: ${appointmentsResult.error.message}`,
      { status: 500 },
    );
  }

  if (instructorsResult.error) {
    return new NextResponse(
      `Failed to export instructors: ${instructorsResult.error.message}`,
      { status: 500 },
    );
  }

  const instructors = (instructorsResult.data ?? []) as InstructorRow[];
  const appointments = (appointmentsResult.data ?? []) as AppointmentRow[];
  const instructorNameById = new Map(
    instructors.map((instructor) => [
      instructor.id,
      [instructor.first_name ?? "", instructor.last_name ?? ""].join(" ").trim() ||
        "Unnamed Instructor",
    ]),
  );

  const summaries = new Map<string, InstructorSummary>();

  for (const appointment of appointments) {
    const instructorId = appointment.instructor_id ?? "unassigned";
    const existing = summaries.get(instructorId) ?? {
      instructorId,
      name:
        instructorId === "unassigned"
          ? "Unassigned"
          : instructorNameById.get(instructorId) ?? "Unnamed Instructor",
      totalAppointments: 0,
      attended: 0,
      scheduled: 0,
      cancelled: 0,
      noShows: 0,
      privateLessons: 0,
      groupClasses: 0,
      minutes: 0,
      revenue: 0,
    };

    existing.totalAppointments += 1;
    existing.minutes += Number(appointment.duration_minutes ?? 0);
    if (appointment.status === "attended") existing.attended += 1;
    if (appointment.status === "scheduled") existing.scheduled += 1;
    if (appointment.status === "cancelled") existing.cancelled += 1;
    if (appointment.status === "no_show") existing.noShows += 1;

    const appointmentType = (appointment.appointment_type ?? "").toLowerCase();
    if (appointmentType.includes("private")) existing.privateLessons += 1;
    if (appointmentType.includes("group")) existing.groupClasses += 1;
    if (appointment.payment_status === "paid") {
      existing.revenue += Number(appointment.price_amount ?? 0);
    }

    summaries.set(instructorId, existing);
  }

  const rows = Array.from(summaries.values())
    .sort((a, b) => b.totalAppointments - a.totalAppointments)
    .map((item) => [
      item.name,
      item.totalAppointments,
      item.attended,
      item.scheduled,
      item.cancelled,
      item.noShows,
      percentage(item.attended, item.attended + item.cancelled + item.noShows),
      item.privateLessons,
      item.groupClasses,
      Math.round(item.minutes / 60),
      item.revenue,
      item.instructorId === "unassigned" ? "" : item.instructorId,
    ]);

  const csv = toCsv(
    [
      "Instructor",
      "Appointments",
      "Attended",
      "Scheduled",
      "Cancelled",
      "No-Shows",
      "Attendance Rate",
      "Private Lessons",
      "Group Classes",
      "Teaching Hours",
      "Paid Lesson Revenue",
      "Instructor ID",
    ],
    rows,
  );

  return csvResponse(csv, `danceflow-instructor-activity-${range}.csv`);
}
