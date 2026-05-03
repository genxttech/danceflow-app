import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type CalendarFeedRow = {
  id: string;
  studio_id: string;
  instructor_id: string;
  token: string;
  active: boolean;
};

type InstructorRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
};

type AppointmentRow = {
  id: string;
  title: string | null;
  appointment_type: string;
  status: string;
  starts_at: string;
  ends_at: string;
  notes: string | null;
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
  rooms: { name: string } | { name: string }[] | null;
};

function getAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase service role configuration.");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function firstRelationRow<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

function escapeIcsText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\r?\n/g, "\\n");
}

function formatIcsDate(value: string) {
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function foldIcsLine(line: string) {
  const maxLength = 74;
  if (line.length <= maxLength) return line;

  const chunks: string[] = [];
  let remaining = line;

  while (remaining.length > maxLength) {
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }

  chunks.push(remaining);
  return chunks.map((chunk, index) => (index === 0 ? chunk : ` ${chunk}`)).join("\r\n");
}

function appointmentTypeLabel(value: string) {
  if (value === "private_lesson") return "Private Lesson";
  if (value === "group_class") return "Group Class";
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "coaching") return "Coaching";
  if (value === "practice_party") return "Practice Party";
  if (value === "floor_space_rental") return "Floor Space Rental";
  if (value === "event") return "Event";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildAppointmentSummary(appointment: AppointmentRow, instructor: InstructorRow) {
  const client = firstRelationRow(appointment.clients);
  const baseTitle = appointment.title?.trim() || appointmentTypeLabel(appointment.appointment_type);

  if (client?.first_name || client?.last_name) {
    return `${baseTitle}: ${[client.first_name, client.last_name].filter(Boolean).join(" ")}`;
  }

  if (appointment.appointment_type === "floor_space_rental") {
    return `Floor Rental: ${instructor.first_name} ${instructor.last_name}`;
  }

  return baseTitle;
}

function buildAppointmentDescription(appointment: AppointmentRow) {
  const lines = [
    `Type: ${appointmentTypeLabel(appointment.appointment_type)}`,
    `Status: ${appointment.status.replaceAll("_", " ")}`,
  ];

  if (appointment.notes) {
    lines.push("", appointment.notes);
  }

  return lines.join("\n");
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token: rawToken } = await params;
  const token = rawToken.replace(/\.ics$/i, "").trim();

  if (!token) {
    return new NextResponse("Missing calendar token.", { status: 400 });
  }

  const supabase = getAdminClient();

  const { data: feed, error: feedError } = await supabase
    .from("instructor_calendar_feeds")
    .select("id, studio_id, instructor_id, token, active")
    .eq("token", token)
    .eq("active", true)
    .single();

  if (feedError || !feed) {
    return new NextResponse("Calendar feed not found.", { status: 404 });
  }

  const typedFeed = feed as CalendarFeedRow;

  await supabase
    .from("instructor_calendar_feeds")
    .update({ last_accessed_at: new Date().toISOString() })
    .eq("id", typedFeed.id);

  const { data: instructor, error: instructorError } = await supabase
    .from("instructors")
    .select("id, first_name, last_name, email")
    .eq("id", typedFeed.instructor_id)
    .eq("studio_id", typedFeed.studio_id)
    .single();

  if (instructorError || !instructor) {
    return new NextResponse("Instructor not found.", { status: 404 });
  }

  const typedInstructor = instructor as InstructorRow;
  const rangeStart = new Date();
  rangeStart.setDate(rangeStart.getDate() - 30);
  const rangeEnd = new Date();
  rangeEnd.setMonth(rangeEnd.getMonth() + 6);

  const { data: appointments, error: appointmentsError } = await supabase
    .from("appointments")
    .select(
      `
      id,
      title,
      appointment_type,
      status,
      starts_at,
      ends_at,
      notes,
      clients(first_name, last_name),
      rooms(name)
    `
    )
    .eq("studio_id", typedFeed.studio_id)
    .eq("instructor_id", typedFeed.instructor_id)
    .gte("starts_at", rangeStart.toISOString())
    .lte("starts_at", rangeEnd.toISOString())
    .not("status", "eq", "cancelled")
    .order("starts_at", { ascending: true });

  if (appointmentsError) {
    return new NextResponse(`Could not load calendar appointments: ${appointmentsError.message}`, {
      status: 500,
    });
  }

  const calendarName = `DanceFlow - ${typedInstructor.first_name} ${typedInstructor.last_name}`;
  const now = formatIcsDate(new Date().toISOString());

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//DanceFlow//Instructor Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    "X-WR-TIMEZONE:UTC",
  ];

  ((appointments ?? []) as AppointmentRow[]).forEach((appointment) => {
    const room = firstRelationRow(appointment.rooms);
    const summary = buildAppointmentSummary(appointment, typedInstructor);
    const description = buildAppointmentDescription(appointment);

    lines.push(
      "BEGIN:VEVENT",
      `UID:${appointment.id}@danceflow`,
      `DTSTAMP:${now}`,
      `DTSTART:${formatIcsDate(appointment.starts_at)}`,
      `DTEND:${formatIcsDate(appointment.ends_at)}`,
      `SUMMARY:${escapeIcsText(summary)}`,
      `DESCRIPTION:${escapeIcsText(description)}`
    );

    if (room?.name) {
      lines.push(`LOCATION:${escapeIcsText(room.name)}`);
    }

    lines.push("END:VEVENT");
  });

  lines.push("END:VCALENDAR");

  const body = lines.map(foldIcsLine).join("\r\n") + "\r\n";

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
