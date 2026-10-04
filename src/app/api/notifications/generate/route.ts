import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCronAuthFailure } from "@/lib/security/cron";
import { createAppointmentConfirmationToken } from "@/lib/schedule/appointmentConfirmation";
import {
  buildGroupClassReminderDelivery,
  isCanonicalGroupClass,
  selectGroupClassRecipients,
  type ClassReminderAttendeeRow,
  type ClassReminderDelivery,
} from "@/lib/notifications/groupClassReminders";

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
  location_name: string | null;
  rooms: { name: string | null } | null | Array<{ name: string | null }>;
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

// Ids per .in() lookup: the ids travel in the request URL, which overflows the request limit well before 400 uuids.
const GROUP_CLASS_LOOKUP_CHUNK = 100;

async function insertGroupClassDeliveries(
  supabase: ReturnType<typeof createAdminClient>,
  rows: ClassReminderDelivery[],
): Promise<{ inserted: number; error?: string }> {
  if (!rows.length) return { inserted: 0 };

  const existing = new Set<string>();
  for (let i = 0; i < rows.length; i += GROUP_CLASS_LOOKUP_CHUNK) {
    const keys = rows.slice(i, i + GROUP_CLASS_LOOKUP_CHUNK).map((row) => row.dedupe_key);
    const { data, error } = await supabase.from("notification_deliveries").select("dedupe_key").in("dedupe_key", keys);
    if (error) return { inserted: 0, error: error.message };
    for (const row of data ?? []) existing.add(String((row as { dedupe_key: string }).dedupe_key));
  }

  let inserted = 0;
  for (const row of rows) {
    if (existing.has(row.dedupe_key)) continue;
    const { error } = await supabase.from("notification_deliveries").insert(row);
    if (error) {
      if (error.code === "23505") continue; // already queued by a concurrent run
      return { inserted, error: error.message };
    }
    inserted += 1;
  }

  return { inserted };
}

export async function POST(request: NextRequest) {
  const authFailure = getCronAuthFailure(request);
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
        location_name,
        rooms ( name ),
        clients:clients!appointments_client_id_fkey (
  id,
  first_name,
  last_name,
  email
),
instructors:instructors!appointments_instructor_id_fkey (
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

  // GC-R1: canonical group classes have no client_id; their enrolled attendees are reminded through appointment_attendees.
  // A class that has attendee rows is reminded ONLY that way (the roster's own rule), so the client_id path below never
  // double-reminds it; a class with no attendee rows keeps the legacy behavior untouched.
  const inWindow24 = (appt: AppointmentRow) => {
    const startsAt = new Date(appt.starts_at);
    return startsAt >= reminder24Start && startsAt <= reminder24End;
  };
  const inWindow2 = (appt: AppointmentRow) => {
    const startsAt = new Date(appt.starts_at);
    return startsAt >= reminder2Start && startsAt <= reminder2End;
  };

  const classCandidates = allAppointments.filter((appt) => isCanonicalGroupClass(appt) && (inWindow24(appt) || inWindow2(appt)));
  const attendeeRows: ClassReminderAttendeeRow[] = [];

  for (let i = 0; i < classCandidates.length; i += GROUP_CLASS_LOOKUP_CHUNK) {
    const ids = classCandidates.slice(i, i + GROUP_CLASS_LOOKUP_CHUNK).map((appt) => appt.id);
    const { data, error } = await supabase
      .from("appointment_attendees")
      .select(
        "appointment_id, studio_id, client_id, status, clients:clients!client_id ( id, studio_id, first_name, last_name, email )",
      )
      .in("appointment_id", ids);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    attendeeRows.push(...((data ?? []) as unknown as ClassReminderAttendeeRow[]));
  }

  const classRecipients = selectGroupClassRecipients(classCandidates, attendeeRows);
  const reminderViaAttendees = (appt: AppointmentRow) =>
    isCanonicalGroupClass(appt) && classRecipients.classesWithAttendeeRows.has(appt.id);

  const reminder24 = allAppointments.filter((appt) => inWindow24(appt) && !!appt.client_id && !reminderViaAttendees(appt));

  const reminder2 = allAppointments.filter((appt) => inWindow2(appt) && !!appt.client_id && !reminderViaAttendees(appt));

  const classDeliveries: ClassReminderDelivery[] = [];
  const classFormat = {
    dateKey: formatDateKey,
    dateLong: (date: string, timeZone: string) => formatDateLong(date, timeZone),
    time: (date: string, timeZone: string) => formatTime(date, timeZone),
  };

  for (const recipient of classRecipients.recipients) {
    const timeZone = getStudioTimezone(studioMap, recipient.appointment.studio_id);
    for (const [kind, due] of [
      ["24h", inWindow24(recipient.appointment as AppointmentRow)],
      ["2h", inWindow2(recipient.appointment as AppointmentRow)],
    ] as const) {
      if (!due) continue;
      classDeliveries.push(
        buildGroupClassReminderDelivery({
          kind,
          appointment: recipient.appointment,
          clientId: recipient.clientId,
          email: recipient.email,
          name: recipient.name,
          timeZone,
          now,
          format: classFormat,
        }),
      );
    }
  }

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
    const confirmation = await createAppointmentConfirmationToken({
      supabase,
      studioId: appt.studio_id,
      appointmentId: appt.id,
      clientId: appt.client_id,
      recipientEmail: client.email,
      expiresAt: addHours(new Date(appt.starts_at), 1).toISOString(),
    });

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
      )} at ${formatTime(appt.starts_at, studioTz)}.\n\nConfirm appointment: ${confirmation.confirmUrl}`,
      metadata: {
        appointmentTitle: appt.title,
        appointmentType: appt.appointment_type,
        startsAt: appt.starts_at,
        clientName: [client.first_name, client.last_name].filter(Boolean).join(" "),
        clientEmail: client.email,
        studioTimezone: studioTz,
        confirmationUrl: confirmation.confirmUrl,
        confirmationExpiresAt: confirmation.expiresAt,
      },
      scheduled_for: now.toISOString(),
    });
  }

  for (const appt of reminder2) {
    const client = firstRelation(appt.clients);
    if (!client?.email || !appt.client_id) continue;

    const studioTz = getStudioTimezone(studioMap, appt.studio_id);
    const confirmation = await createAppointmentConfirmationToken({
      supabase,
      studioId: appt.studio_id,
      appointmentId: appt.id,
      clientId: appt.client_id,
      recipientEmail: client.email,
      expiresAt: addHours(new Date(appt.starts_at), 1).toISOString(),
    });

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
      )} today.\n\nConfirm appointment: ${confirmation.confirmUrl}`,
      metadata: {
        appointmentTitle: appt.title,
        appointmentType: appt.appointment_type,
        startsAt: appt.starts_at,
        clientName: [client.first_name, client.last_name].filter(Boolean).join(" "),
        clientEmail: client.email,
        studioTimezone: studioTz,
        confirmationUrl: confirmation.confirmUrl,
        confirmationExpiresAt: confirmation.expiresAt,
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

  // GC-R1: class reminders are idempotent through dedupe_key (see groupClassReminderDedupeKey), inserted one by one so a
  // concurrent run that already queued a row cannot fail the others.
  const classInsert = await insertGroupClassDeliveries(supabase, classDeliveries);

  if (classInsert.error) {
    return NextResponse.json({ error: classInsert.error }, { status: 500 });
  }

  if (!deliveries.length) {
    return NextResponse.json({
      ok: true,
      generated: classInsert.inserted,
      message: classInsert.inserted ? undefined : "No notification deliveries were due.",
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
    generated: deliveries.length + classInsert.inserted,
  });
}

export async function GET(request: NextRequest) {
  return POST(request);
}