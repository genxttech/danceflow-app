import { NextResponse } from "next/server";
import { getStudentApiUser, normalizeStudentApiUuid } from "@/lib/auth/studentApiAuth";
import { sendMobilePushToUser } from "@/lib/notifications/expoPush";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";

const EARLY_CHECKIN_MINUTES = 30;
const LATE_CHECKIN_MINUTES = 15;

type AppointmentRow = {
  id: string;
  studio_id: string;
  client_id: string | null;
  instructor_id: string | null;
  title: string | null;
  appointment_type: string | null;
  starts_at: string;
  ends_at: string | null;
  status: string | null;
  clients:
    | { id: string; first_name: string | null; last_name: string | null; portal_user_id: string | null }
    | { id: string; first_name: string | null; last_name: string | null; portal_user_id: string | null }[]
    | null;
  instructors:
    | { id: string; first_name: string | null; last_name: string | null; profile_user_id: string | null }
    | { id: string; first_name: string | null; last_name: string | null; profile_user_id: string | null }[]
    | null;
  studios:
    | { name: string | null; public_name: string | null }
    | { name: string | null; public_name: string | null }[]
    | null;
};

function firstJoin<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function checkinWindow(appointment: AppointmentRow, now = new Date()) {
  const startsAt = new Date(appointment.starts_at);
  const endsAt = appointment.ends_at ? new Date(appointment.ends_at) : startsAt;
  const opensAt = new Date(startsAt.getTime() - EARLY_CHECKIN_MINUTES * 60_000);
  const closesAt = new Date(endsAt.getTime() + LATE_CHECKIN_MINUTES * 60_000);

  return {
    canCheckIn:
      ["scheduled", "rescheduled"].includes(appointment.status ?? "") &&
      now >= opensAt &&
      now <= closesAt,
    opensAt: opensAt.toISOString(),
    closesAt: closesAt.toISOString(),
  };
}

async function loadOwnedAppointment(request: Request, appointmentId: string) {
  const user = await getStudentApiUser(request);
  if (!user) return { error: NextResponse.json({ error: "Authentication required." }, { status: 401 }) };

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("appointments")
    .select(`
      id,
      studio_id,
      client_id,
      instructor_id,
      title,
      appointment_type,
      starts_at,
      ends_at,
      status,
      clients:clients!appointments_client_id_fkey (
        id,
        first_name,
        last_name,
        portal_user_id
      ),
      instructors:instructors!appointments_instructor_id_fkey (
        id,
        first_name,
        last_name,
        profile_user_id
      ),
      studios (
        name,
        public_name
      )
    `)
    .eq("id", appointmentId)
    .maybeSingle();

  if (error || !data) {
    return { error: NextResponse.json({ error: error?.message ?? "Appointment not found." }, { status: 404 }) };
  }

  const appointment = data as unknown as AppointmentRow;
  const client = firstJoin(appointment.clients);

  if (!client || client.portal_user_id !== user.id || appointment.client_id !== client.id) {
    return { error: NextResponse.json({ error: "Appointment not found." }, { status: 404 }) };
  }

  return { supabase, user, appointment, client };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const appointmentId = normalizeStudentApiUuid((await params).appointmentId);
  if (!appointmentId) {
    return NextResponse.json({ error: "Invalid appointment." }, { status: 400 });
  }

  const context = await loadOwnedAppointment(request, appointmentId);
  if ("error" in context) return context.error;

  const { data: existing } = await context.supabase
    .from("student_lesson_checkins")
    .select("id, checked_in_at")
    .eq("appointment_id", appointmentId)
    .eq("client_id", context.client.id)
    .maybeSingle();

  return NextResponse.json({
    appointmentId,
    checkedIn: Boolean(existing),
    checkedInAt: existing?.checked_in_at ?? null,
    ...checkinWindow(context.appointment),
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const rateLimit = checkRateLimit(
    rateLimitKey("student:lesson-checkin", getIpFromRequest(request)),
    { limit: 6, windowMs: 10 * 60 * 1000 },
  );
  if (!rateLimit.allowed) return rateLimitedJson(rateLimit);

  const appointmentId = normalizeStudentApiUuid((await params).appointmentId);
  if (!appointmentId) {
    return NextResponse.json({ error: "Invalid appointment." }, { status: 400 });
  }

  const context = await loadOwnedAppointment(request, appointmentId);
  if ("error" in context) return context.error;

  const window = checkinWindow(context.appointment);
  if (!window.canCheckIn) {
    return NextResponse.json(
      {
        error: `Check-in opens ${EARLY_CHECKIN_MINUTES} minutes before the lesson and closes ${LATE_CHECKIN_MINUTES} minutes after it ends.`,
        ...window,
      },
      { status: 409 },
    );
  }

  const checkedInAt = new Date().toISOString();
  const { data: checkin, error } = await context.supabase
    .from("student_lesson_checkins")
    .upsert(
      {
        studio_id: context.appointment.studio_id,
        appointment_id: context.appointment.id,
        client_id: context.client.id,
        instructor_id: context.appointment.instructor_id,
        checked_in_by_user_id: context.user.id,
        checked_in_at: checkedInAt,
        source: "student_mobile",
        metadata: {
          userAgent: request.headers.get("user-agent"),
        },
      },
      { onConflict: "appointment_id,client_id", ignoreDuplicates: true },
    )
    .select("id, checked_in_at")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const { data: existing } = checkin
    ? { data: checkin }
    : await context.supabase
        .from("student_lesson_checkins")
        .select("id, checked_in_at")
        .eq("appointment_id", appointmentId)
        .eq("client_id", context.client.id)
        .maybeSingle();

  const instructor = firstJoin(context.appointment.instructors);
  const studio = firstJoin(context.appointment.studios);
  const studentName =
    [context.client.first_name, context.client.last_name].filter(Boolean).join(" ").trim() ||
    "A student";

  if (instructor?.profile_user_id) {
    try {
      await sendMobilePushToUser({
        userId: instructor.profile_user_id,
        category: "schedule",
        title: "Student checked in",
        body: `${studentName} checked in for ${context.appointment.title || "their lesson"} at ${studio?.public_name || studio?.name || "the studio"}.`,
        data: {
          screen: "appointment",
          appointmentId,
          studioId: context.appointment.studio_id,
          source: "student_lesson_checkin",
        },
      });
    } catch (pushError) {
      console.error("Instructor check-in push failed:", pushError);
    }
  }

  return NextResponse.json({
    appointmentId,
    checkedIn: true,
    checkedInAt: existing?.checked_in_at ?? checkedInAt,
    instructorNotified: Boolean(instructor?.profile_user_id),
  });
}
