import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

function getCronSecretFromRequest(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;

  return bearer || request.headers.get("x-cron-secret");
}

function requireCronAuth(request: NextRequest) {
  const provided = getCronSecretFromRequest(request);
  const expected = process.env.CRON_SECRET;

  if (!expected || !provided || provided !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

function formatDateKey(date: Date, timeZone = "UTC") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((p) => p.type === "year")?.value ?? "0000";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";

  return `${year}-${month}-${day}`;
}

function formatTime(dateLike: string | Date, timeZone = "UTC") {
  const date = new Date(dateLike);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDateLong(dateLike: string | Date, timeZone = "UTC") {
  const date = new Date(dateLike);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

type AppointmentRow = {
  id: string;
  studio_id: string;
  starts_at: string;
  ends_at: string | null;
  title: string | null;
  appointment_type: string | null;
  status: string | null;
  client_id: string | null;
  instructor_id: string | null;
  clients:
    | {
        id: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
      }
    | null
    | Array<{
        id: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
      }>;
  instructors:
    | {
        id: string;
        profile_user_id: string | null;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
      }
    | null
    | Array<{
        id: string;
        profile_user_id: string | null;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
      }>;
};

type PreferenceRow = {
  studio_id: string;
  user_id: string;
  student_lesson_reminders_enabled: boolean;
  instructor_daily_agenda_enabled: boolean;
  owner_daily_digest_enabled: boolean;
  reminder_24h_enabled: boolean;
  reminder_2h_enabled: boolean;
  email_enabled: boolean;
  sms_enabled: boolean;
};

type StudioRow = {
  id: string;
  timezone: string | null;
};

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

function getStudioTimezone(studioMap: Map<string, string>, studioId: string) {
  return studioMap.get(studioId) || "UTC";
}

export async function POST(request: NextRequest) {
  const authFailure = requireCronAuth(request);
  if (authFailure) {
    return authFailure;
  }

  const supabase = createAdminClient();
  const now = new Date();

  const reminder24Start = addHours(now, 23);
  const reminder24End = addHours(now, 25);
  const reminder2Start = addHours(now, 1);
  const reminder2End = addHours(now, 3);
  const appointmentSearchStart = addHours(now, -1);
  const appointmentSearchEnd = addHours(now, 30);

  const [
    { data: prefsRows, error: prefsError },
    { data: studioRows, error: studiosError },
    { data: appointments, error: appointmentsError },
  ] = await Promise.all([
    supabase
      .from("user_notification_preferences")
      .select(
        `
        studio_id,
        user_id,
        student_lesson_reminders_enabled,
        instructor_daily_agenda_enabled,
        owner_daily_digest_enabled,
        reminder_24h_enabled,
        reminder_2h_enabled,
        email_enabled,
        sms_enabled
      `
      ),
    supabase.from("studios").select("id, timezone"),
    supabase
      .from("appointments")
      .select(
        `
        id,
        studio_id,
        starts_at,
        ends_at,
        title,
        appointment_type,
        status,
        client_id,
        instructor_id,
        clients (
          id,
          first_name,
          last_name,
          email
        ),
        instructors (
          id,
          profile_user_id,
          first_name,
          last_name,
          email
        )
      `
      )
      .gte("starts_at", appointmentSearchStart.toISOString())
      .lte("starts_at", appointmentSearchEnd.toISOString())
      .neq("status", "cancelled"),
  ]);

  if (prefsError || studiosError || appointmentsError) {
    return NextResponse.json(
      {
        error:
          prefsError?.message ||
          studiosError?.message ||
          appointmentsError?.message ||
          "Failed to load notification generation inputs.",
      },
      { status: 500 }
    );
  }

  const prefs = (prefsRows ?? []) as PreferenceRow[];
  const studios = (studioRows ?? []) as StudioRow[];
  const allAppointments = (appointments ?? []) as AppointmentRow[];

  const studioMap = new Map<string, string>();
  for (const studio of studios) {
    studioMap.set(studio.id, studio.timezone || "UTC");
  }

  const reminder24 = allAppointments.filter((appt) => {
    const startsAt = new Date(appt.starts_at);
    return startsAt >= reminder24Start && startsAt <= reminder24End && !!appt.client_id;
  });

  const reminder2 = allAppointments.filter((appt) => {
    const startsAt = new Date(appt.starts_at);
    return startsAt >= reminder2Start && startsAt <= reminder2End && !!appt.client_id;
  });

  const todayByStudio = new Map<string, AppointmentRow[]>();
  const tomorrowByStudioAndInstructor = new Map<string, AppointmentRow[]>();

  for (const appt of allAppointments) {
    const studioTz = getStudioTimezone(studioMap, appt.studio_id);
    const apptDateKey = formatDateKey(new Date(appt.starts_at), studioTz);
    const todayKey = formatDateKey(now, studioTz);
    const tomorrowKey = formatDateKey(addHours(now, 24), studioTz);

    if (apptDateKey === todayKey) {
      const list = todayByStudio.get(appt.studio_id) ?? [];
      list.push(appt);
      todayByStudio.set(appt.studio_id, list);
    }

    if (apptDateKey === tomorrowKey) {
      const instructor = firstRelation(appt.instructors);
      if (instructor?.profile_user_id) {
        const key = `${appt.studio_id}:${instructor.profile_user_id}`;
        const list = tomorrowByStudioAndInstructor.get(key) ?? [];
        list.push(appt);
        tomorrowByStudioAndInstructor.set(key, list);
      }
    }
  }

  const deliveries: Array<Record<string, unknown>> = [];

  for (const appt of reminder24) {
    const client = firstRelation(appt.clients);
    if (!client?.email || !appt.client_id) continue;

    const studioTz = getStudioTimezone(studioMap, appt.studio_id);

    deliveries.push({
      studio_id: appt.studio_id,
      client_id: appt.client_id,
      delivery_type: "student_lesson_reminder_24h",
      channel: "email",
      status: "pending",
      related_appointment_id: appt.id,
      related_date: formatDateKey(new Date(appt.starts_at), studioTz),
      subject: `Reminder: upcoming lesson on ${formatDateLong(appt.starts_at, studioTz)}`,
      body: `You have an upcoming lesson scheduled for ${formatDateLong(
        appt.starts_at,
        studioTz
      )} at ${formatTime(appt.starts_at, studioTz)}.`,
      metadata: {
        appointmentTitle: appt.title,
        appointmentType: appt.appointment_type,
        startsAt: appt.starts_at,
        clientName: [client.first_name, client.last_name].filter(Boolean).join(" "),
        clientEmail: client.email,
        studioTimezone: studioTz,
      },
      scheduled_for: now.toISOString(),
    });
  }

  for (const appt of reminder2) {
    const client = firstRelation(appt.clients);
    if (!client?.email || !appt.client_id) continue;

    const studioTz = getStudioTimezone(studioMap, appt.studio_id);

    deliveries.push({
      studio_id: appt.studio_id,
      client_id: appt.client_id,
      delivery_type: "student_lesson_reminder_2h",
      channel: "email",
      status: "pending",
      related_appointment_id: appt.id,
      related_date: formatDateKey(new Date(appt.starts_at), studioTz),
      subject: `Reminder: your lesson starts soon`,
      body: `You have an upcoming lesson at ${formatTime(
        appt.starts_at,
        studioTz
      )} today.`,
      metadata: {
        appointmentTitle: appt.title,
        appointmentType: appt.appointment_type,
        startsAt: appt.starts_at,
        clientName: [client.first_name, client.last_name].filter(Boolean).join(" "),
        clientEmail: client.email,
        studioTimezone: studioTz,
      },
      scheduled_for: now.toISOString(),
    });
  }

  for (const pref of prefs) {
    if (!pref.instructor_daily_agenda_enabled || !pref.email_enabled) continue;

    const studioTz = getStudioTimezone(studioMap, pref.studio_id);
    const tomorrowKey = formatDateKey(addHours(now, 24), studioTz);
    const key = `${pref.studio_id}:${pref.user_id}`;
    const instructorAppointments = tomorrowByStudioAndInstructor.get(key) ?? [];
    if (!instructorAppointments.length) continue;

    const sorted = [...instructorAppointments].sort((a, b) =>
      a.starts_at.localeCompare(b.starts_at)
    );

    const lines = sorted.map((appt) => {
      const client = firstRelation(appt.clients);
      const clientName =
        [client?.first_name, client?.last_name].filter(Boolean).join(" ") ||
        "Client";
      return `${formatTime(appt.starts_at, studioTz)} — ${clientName}${
        appt.title ? ` (${appt.title})` : ""
      }`;
    });

    deliveries.push({
      studio_id: pref.studio_id,
      user_id: pref.user_id,
      delivery_type: "instructor_daily_agenda",
      channel: "email",
      status: "pending",
      related_date: tomorrowKey,
      subject: `Tomorrow's agenda`,
      body: `You have ${sorted.length} scheduled item(s) for ${formatDateLong(
        addHours(now, 24),
        studioTz
      )}:\n\n${lines.join("\n")}`,
      metadata: {
        appointmentCount: sorted.length,
        date: tomorrowKey,
        studioTimezone: studioTz,
        appointments: sorted.map((appt) => ({
          id: appt.id,
          startsAt: appt.starts_at,
          title: appt.title,
          appointmentType: appt.appointment_type,
          client: firstRelation(appt.clients),
        })),
      },
      scheduled_for: now.toISOString(),
    });
  }

  for (const pref of prefs) {
    if (!pref.owner_daily_digest_enabled || !pref.email_enabled) continue;

    const studioTz = getStudioTimezone(studioMap, pref.studio_id);
    const todayKey = formatDateKey(now, studioTz);
    const studioAppointments = todayByStudio.get(pref.studio_id) ?? [];
    const totalAppointments = studioAppointments.length;
    const privateLessons = studioAppointments.filter(
      (appt) => appt.appointment_type === "private_lesson"
    ).length;
    const floorRentals = studioAppointments.filter(
      (appt) => appt.appointment_type === "floor_space_rental"
    ).length;
    const cancellations = studioAppointments.filter(
      (appt) => appt.status === "cancelled"
    ).length;

    deliveries.push({
      studio_id: pref.studio_id,
      user_id: pref.user_id,
      delivery_type: "owner_daily_digest",
      channel: "email",
      status: "pending",
      related_date: todayKey,
      subject: `Studio activity for ${formatDateLong(now, studioTz)}`,
      body: [
        `Here is your studio activity summary for ${formatDateLong(now, studioTz)}.`,
        "",
        `Total appointments: ${totalAppointments}`,
        `Private lessons: ${privateLessons}`,
        `Floor rentals: ${floorRentals}`,
        `Cancelled items: ${cancellations}`,
      ].join("\n"),
      metadata: {
        date: todayKey,
        studioTimezone: studioTz,
        totalAppointments,
        privateLessons,
        floorRentals,
        cancellations,
      },
      scheduled_for: now.toISOString(),
    });
  }

  if (!deliveries.length) {
    return NextResponse.json({
      ok: true,
      generated: 0,
      message: "No notification deliveries were due.",
    });
  }

  const { error: insertError } = await supabase.from("notification_deliveries").upsert(
    deliveries,
    {
      onConflict:
        "channel,delivery_type,user_id,client_id,related_appointment_id,related_date",
      ignoreDuplicates: true,
    }
  );

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    generated: deliveries.length,
  });
}
