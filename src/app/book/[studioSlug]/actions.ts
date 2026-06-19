"use server";

import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";

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

function formatStudioDateTime(value: string | null | undefined, timeZone: string, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "Not requested";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: getStudioTimeZone(timeZone),
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
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

type StudioRow = {
  id: string;
  name: string;
  slug: string;
};

type StudioSettingsRow = {
  timezone: string | null;
  booking_lead_time_hours: number | null;
  public_intro_booking_enabled: boolean | null;
  intro_lesson_duration_minutes: number | null;
  intro_booking_window_days: number | null;
  intro_default_instructor_id: string | null;
  intro_default_room_id: string | null;
  booking_request_allowed_weekdays: number[] | null;
  booking_request_start_time: string | null;
  booking_request_end_time: string | null;
  public_intro_bookable_instructor_ids: string[] | null;
};

type AppointmentRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
};

type SlotRow = {
  start: string;
  end: string;
};

const INTRO_SLOT_TEMPLATES: Record<number, string[]> = {
  0: [],
  1: ["13:00", "15:00", "18:00"],
  2: ["13:00", "15:00", "18:00"],
  3: ["13:00", "15:00", "18:00"],
  4: ["13:00", "15:00", "18:00"],
  5: ["13:00", "15:00", "18:00"],
  6: ["11:00", "13:00"],
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getAllowedWeekdays(settings: StudioSettingsRow) {
  return settings.booking_request_allowed_weekdays?.length
    ? settings.booking_request_allowed_weekdays
    : [1, 2, 3, 4, 5, 6];
}

function timeWithinRequestWindow(time: string, settings: StudioSettingsRow) {
  const start = (settings.booking_request_start_time ?? "09:00").slice(0, 5);
  const end = (settings.booking_request_end_time ?? "21:00").slice(0, 5);

  return time >= start && time < end;
}

function getPublicIntroInstructorId(settings: StudioSettingsRow) {
  const allowedIds = settings.public_intro_bookable_instructor_ids ?? [];

  if (!allowedIds.length) {
    return settings.intro_default_instructor_id;
  }

  if (
    settings.intro_default_instructor_id &&
    allowedIds.includes(settings.intro_default_instructor_id)
  ) {
    return settings.intro_default_instructor_id;
  }

  return allowedIds[0] ?? null;
}

function buildStudioDateTime(dateKey: string, time: string, timeZone: string) {
  return zonedDateTimeToUtcDate(dateKey, time, timeZone);
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart < bEnd && aEnd > bStart;
}

async function getStudioAndSettings(studioSlug: string) {
  const supabase = createAdminClient();

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, name, slug")
    .eq("slug", studioSlug)
    .single();

  if (studioError || !studio) {
    throw new Error("Studio not found.");
  }

  const { data: settings, error: settingsError } = await supabase
    .from("studio_settings")
    .select(`
      timezone,
      booking_lead_time_hours,
      public_intro_booking_enabled,
      intro_lesson_duration_minutes,
      intro_booking_window_days,
      intro_default_instructor_id,
      intro_default_room_id,
      booking_request_allowed_weekdays,
      booking_request_start_time,
      booking_request_end_time,
      public_intro_bookable_instructor_ids
    `)
    .eq("studio_id", studio.id)
    .single();

  if (settingsError || !settings) {
    throw new Error("Studio settings not found.");
  }

  return {
    supabase,
    studio: studio as StudioRow,
    settings: settings as StudioSettingsRow,
  };
}

async function getAvailableSlots(studioSlug: string): Promise<SlotRow[]> {
  const { supabase, studio, settings } = await getStudioAndSettings(studioSlug);

  if (!settings.public_intro_booking_enabled) {
    return [];
  }

  const studioTimeZone = getStudioTimeZone(settings.timezone);
  const bookingWindowDays = settings.intro_booking_window_days ?? 7;
  const lessonDurationMinutes = settings.intro_lesson_duration_minutes ?? 30;
  const bookingLeadTimeHours = settings.booking_lead_time_hours ?? 0;

  const todayKey = getZonedDateKey(new Date(), studioTimeZone);
  const rangeStart = getLocalDayUtcRange(todayKey, studioTimeZone).startIso;
  const rangeEnd = getLocalDayUtcRange(addDaysToDateKey(todayKey, bookingWindowDays + 1), studioTimeZone).startIso;

  let appointmentsQuery = supabase
    .from("appointments")
    .select("id, starts_at, ends_at, status")
    .eq("studio_id", studio.id)
    .gte("starts_at", rangeStart)
    .lt("starts_at", rangeEnd)
    .neq("status", "cancelled");

  const introInstructorId = getPublicIntroInstructorId(settings);

  if (introInstructorId) {
    appointmentsQuery = appointmentsQuery.eq("instructor_id", introInstructorId);
  }

  if (settings.intro_default_room_id) {
    appointmentsQuery = appointmentsQuery.eq("room_id", settings.intro_default_room_id);
  }

  const { data: appointments, error: appointmentsError } = await appointmentsQuery;

  if (appointmentsError) {
    throw new Error(`Failed to load public intro availability: ${appointmentsError.message}`);
  }

  const typedAppointments = (appointments ?? []) as AppointmentRow[];
  const leadTimeCutoff = new Date(Date.now() + bookingLeadTimeHours * 60 * 60 * 1000);

  const generatedSlots: SlotRow[] = [];

  for (let dayOffset = 0; dayOffset < bookingWindowDays; dayOffset++) {
    const dayDateKey = addDaysToDateKey(todayKey, dayOffset);
    const dayOfWeek = getZonedWeekday(dayDateKey, studioTimeZone);

    if (!getAllowedWeekdays(settings).includes(dayOfWeek)) {
      continue;
    }

    const times = (INTRO_SLOT_TEMPLATES[dayOfWeek] ?? []).filter((time) =>
      timeWithinRequestWindow(time, settings)
    );

    for (const time of times) {
      const start = buildStudioDateTime(dayDateKey, time, studioTimeZone);
      const end = addMinutes(start, lessonDurationMinutes);

      if (start < leadTimeCutoff) {
        continue;
      }

      const hasConflict = typedAppointments.some((appointment) => {
        const apptStart = new Date(appointment.starts_at);
        const apptEnd = new Date(appointment.ends_at);

        return overlaps(start, end, apptStart, apptEnd);
      });

      if (!hasConflict) {
        generatedSlots.push({
          start: start.toISOString(),
          end: end.toISOString(),
        });
      }
    }
  }

  return generatedSlots;
}

async function findStudioOwnerOrAdminUserId(studioId: string) {
  const supabase = createAdminClient();

  const { data } = await supabase
    .from("user_studio_roles")
    .select("user_id")
    .eq("studio_id", studioId)
    .eq("active", true)
    .in("role", ["studio_owner", "studio_admin", "platform_admin"])
    .limit(1)
    .maybeSingle();

  return data?.user_id ?? null;
}


async function getStudioNotificationEmail(studioId: string) {
  const supabase = createAdminClient();

  const { data: roleRows } = await supabase
    .from("user_studio_roles")
    .select("user_id")
    .eq("studio_id", studioId)
    .eq("active", true)
    .in("role", ["studio_owner", "studio_admin"])
    .limit(5);

  for (const row of roleRows ?? []) {
    const userId = (row as { user_id?: string | null }).user_id;
    if (!userId) continue;

    const { data, error } = await supabase.auth.admin.getUserById(userId);

    if (!error && data?.user?.email) {
      return data.user.email;
    }
  }

  return null;
}

function formatBookingRequestDateTime(value: string, timeZone: string) {
  return formatStudioDateTime(value, timeZone, { weekday: "short" });
}

async function queueBookingRequestEmails(params: {
  studioId: string;
  studioName: string;
  bookingRequestId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  requestedStartsAt: string;
  studioTimeZone: string;
  danceInterests: string | null;
  notes: string | null;
}) {
  const supabase = createAdminClient();
  const requestedTime = formatBookingRequestDateTime(params.requestedStartsAt, params.studioTimeZone);
  const firstName = params.customerName.split(" ")[0] || "there";
  const requestsUrl = `${(process.env.NEXT_PUBLIC_SITE_URL || "https://www.idanceflow.com").replace(/\/$/, "")}/app/schedule/requests`;

  const clientBodyText = [
    `Hi ${firstName},`,
    "",
    `${params.studioName} received your intro lesson request for ${requestedTime}.`,
    "",
    "The studio will review the request and follow up with next steps. Your appointment is not confirmed until the studio approves it.",
    "",
    "Thanks,",
    params.studioName,
  ].join("\n");

  const staffBodyText = [
    `New intro lesson request for ${params.studioName}`,
    "",
    `Client: ${params.customerName}`,
    `Email: ${params.customerEmail}`,
    params.customerPhone ? `Phone: ${params.customerPhone}` : null,
    `Requested time: ${requestedTime}`,
    params.danceInterests ? `Dance interests: ${params.danceInterests}` : null,
    params.notes ? `Notes: ${params.notes}` : null,
    "",
    `Review request: ${requestsUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  const clientInsert = await supabase.from("outbound_deliveries").insert({
    studio_id: params.studioId,
    channel: "email",
    template_key: "booking_request_received_client",
    recipient_email: params.customerEmail,
    subject: `${params.studioName} received your lesson request`,
    body_text: clientBodyText,
    body_html: null,
    related_table: "booking_requests",
    related_id: params.bookingRequestId,
    dedupe_key: `booking-request-received-client:${params.bookingRequestId}`,
    status: "queued",
    updated_at: new Date().toISOString(),
  });

  if (clientInsert.error && clientInsert.error.code !== "23505") {
    console.error("Failed to queue booking request client email", clientInsert.error.message);
  }

  const staffEmail = await getStudioNotificationEmail(params.studioId);

  if (!staffEmail) {
    return;
  }

  const staffInsert = await supabase.from("outbound_deliveries").insert({
    studio_id: params.studioId,
    channel: "email",
    template_key: "booking_request_staff_alert",
    recipient_email: staffEmail,
    subject: `New intro lesson request: ${params.customerName}`,
    body_text: staffBodyText,
    body_html: null,
    related_table: "booking_requests",
    related_id: params.bookingRequestId,
    dedupe_key: `booking-request-staff-alert:${params.bookingRequestId}`,
    status: "queued",
    updated_at: new Date().toISOString(),
  });

  if (staffInsert.error && staffInsert.error.code !== "23505") {
    console.error("Failed to queue booking request staff email", staffInsert.error.message);
  }
}

export async function createPublicIntroBookingAction(
  prevState: { error: string },
  formData: FormData
) {
  try {
    const studioSlug = getString(formData, "studioSlug");
    const slotStart = getString(formData, "slotStart");
    const firstName = getString(formData, "firstName");
    const lastName = getString(formData, "lastName");
    const email = getString(formData, "email").toLowerCase();
    const phone = getString(formData, "phone");
    const danceInterests = getString(formData, "danceInterests");
    const notes = getString(formData, "notes");

    if (!studioSlug) {
      return { error: "Missing studio slug." };
    }

    if (!slotStart) {
      return { error: "Please choose an intro lesson time." };
    }

    if (!firstName || !lastName || !email) {
      return { error: "First name, last name, and email are required." };
    }

    const { supabase, studio, settings } = await getStudioAndSettings(studioSlug);
    const studioTimeZone = getStudioTimeZone(settings.timezone);

    if (!settings.public_intro_booking_enabled) {
      return { error: "Intro lesson requests are not enabled for this studio." };
    }

    const availableSlots = await getAvailableSlots(studioSlug);
    const chosenSlot = availableSlots.find((slot) => slot.start === slotStart);

    if (!chosenSlot) {
      return {
        error: "That intro lesson request time is no longer available. Please choose another time.",
      };
    }

    let clientId: string | null = null;

    const { data: existingClientByEmail } = await supabase
      .from("clients")
      .select("id")
      .eq("studio_id", studio.id)
      .eq("email", email)
      .limit(1)
      .maybeSingle();

    if (existingClientByEmail?.id) {
      clientId = existingClientByEmail.id;
    } else {
      const { data: insertedClient, error: clientInsertError } = await supabase
        .from("clients")
        .insert({
          studio_id: studio.id,
          first_name: firstName,
          last_name: lastName,
          email,
          phone: phone || null,
          status: "lead",
          dance_interests: danceInterests || null,
          notes: notes || null,
          referral_source: "public_intro_booking",
        })
        .select("id")
        .single();

      if (clientInsertError || !insertedClient) {
        return {
          error: `Could not create lead: ${
            clientInsertError?.message ?? "Unknown error."
          }`,
        };
      }

      clientId = insertedClient.id;
    }

    const { data: duplicateRequest } = await supabase
      .from("booking_requests")
      .select("id")
      .eq("studio_id", studio.id)
      .eq("client_id", clientId)
      .eq("appointment_type", "intro_lesson")
      .eq("requested_starts_at", chosenSlot.start)
      .in("status", ["pending", "approved"])
      .limit(1)
      .maybeSingle();

    if (duplicateRequest?.id) {
      redirect(`/book/${studioSlug}?success=intro_requested`);
    }

    const { data: duplicateAppointment } = await supabase
      .from("appointments")
      .select("id")
      .eq("studio_id", studio.id)
      .eq("client_id", clientId)
      .eq("appointment_type", "intro_lesson")
      .eq("starts_at", chosenSlot.start)
      .neq("status", "cancelled")
      .limit(1)
      .maybeSingle();

    if (duplicateAppointment?.id) {
      redirect(`/book/${studioSlug}?success=intro_requested`);
    }

    const { data: bookingRequest, error: bookingRequestError } = await supabase
      .from("booking_requests")
      .insert({
        studio_id: studio.id,
        client_id: clientId,
        instructor_id: getPublicIntroInstructorId(settings) || null,
        room_id: settings.intro_default_room_id || null,
        source: "public_intro",
        status: "pending",
        appointment_type: "intro_lesson",
        title: "Intro Lesson Request",
        requested_starts_at: chosenSlot.start,
        requested_ends_at: chosenSlot.end,
        customer_first_name: firstName,
        customer_last_name: lastName,
        customer_email: email,
        customer_phone: phone || null,
        dance_interests: danceInterests || null,
        notes: notes || null,
      })
      .select("id")
      .single();

    if (bookingRequestError || !bookingRequest) {
      return {
        error: `Could not create intro lesson request: ${
          bookingRequestError?.message ?? "Unknown error."
        }`,
      };
    }

    const activityOwnerUserId = await findStudioOwnerOrAdminUserId(studio.id);

    const leadActivityNote = [
      "Public intro lesson requested.",
      `Requested slot: ${formatBookingRequestDateTime(chosenSlot.start, studioTimeZone)}`,
      danceInterests ? `Dance interests: ${danceInterests}` : null,
      notes ? `Notes: ${notes}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const { error: leadActivityError } = await supabase.from("lead_activities").insert({
      studio_id: studio.id,
      client_id: clientId,
      activity_type: "follow_up",
      note: leadActivityNote,
      follow_up_due_at: chosenSlot.start,
      created_by: activityOwnerUserId,
    });

    if (leadActivityError) {
      return {
        error: `Request was created, but lead activity logging failed: ${leadActivityError.message}`,
      };
    }

    const customerName = [firstName, lastName].filter(Boolean).join(" ");

    const notificationBodyParts = [
      `${customerName} requested an intro lesson.`,
      `Requested for ${formatBookingRequestDateTime(chosenSlot.start, studioTimeZone)}.`,
      danceInterests ? `Interests: ${danceInterests}.` : null,
    ].filter(Boolean);

    const { error: notificationError } = await supabase.from("notifications").insert({
      studio_id: studio.id,
      type: "public_intro_booking",
      title: "New public intro request",
      body: notificationBodyParts.join(" "),
      client_id: clientId,
    });

    if (notificationError) {
      console.error("Failed to create booking request notification", notificationError.message);
    }

    await queueBookingRequestEmails({
      studioId: studio.id,
      studioName: studio.name,
      bookingRequestId: bookingRequest.id,
      customerName,
      customerEmail: email,
      customerPhone: phone || null,
      requestedStartsAt: chosenSlot.start,
      studioTimeZone,
      danceInterests: danceInterests || null,
      notes: notes || null,
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect(`/book/${getString(formData, "studioSlug")}?success=intro_requested`);
}
