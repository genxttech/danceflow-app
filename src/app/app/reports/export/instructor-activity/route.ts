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

function startOfTodayLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfMonthLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function startOfLast30DaysLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
}

function startOfQuarterLocal() {
  const now = new Date();
  const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
  return new Date(now.getFullYear(), quarterStartMonth, 1);
}

function startOfYearLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), 0, 1);
}

function getRangeStart(range: string) {
  if (range === "today") return startOfTodayLocal();
  if (range === "last30") return startOfLast30DaysLocal();
  if (range === "quarter") return startOfQuarterLocal();
  if (range === "year") return startOfYearLocal();
  return startOfMonthLocal();
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
  const rangeStart = getRangeStart(range).toISOString();
  const nowIso = new Date().toISOString();

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!canViewReports(context.studioRole ?? "") || !context.studioId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

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
