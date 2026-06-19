"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
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

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
};

type StudioSettingsRow = {
  timezone: string | null;
  portal_self_scheduling_enabled: boolean | null;
  portal_self_scheduling_mode: string | null;
  portal_self_scheduling_window_days: number | null;
  portal_self_scheduling_min_notice_hours: number | null;
  booking_request_allowed_weekdays: number[] | null;
  booking_request_start_time: string | null;
  booking_request_end_time: string | null;
  portal_bookable_lesson_types: string[] | null;
  portal_bookable_instructor_ids: string[] | null;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

function typeLabel(value: string) {
  if (value === "private_lesson") return "Private Lesson";
  if (value === "group_class") return "Group Class";
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "coaching") return "Coaching";
  if (value === "practice_party") return "Practice Party";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatRequestDateTime(value: string, timeZone: string) {
  return formatStudioDateTime(value, timeZone, { weekday: "short" });
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

function buildLocalDateTime(date: string, time: string, timeZone: string) {
  return zonedDateTimeToUtcDate(date, time, timeZone);
}

function addMinutes(value: Date, minutes: number) {
  return new Date(value.getTime() + minutes * 60 * 1000);
}

function normalizeDuration(value: string) {
  const duration = Number(value);

  if ([30, 45, 60, 90].includes(duration)) {
    return duration;
  }

  return 45;
}

async function queuePortalScheduleRequestEmails(params: {
  supabase: ReturnType<typeof createAdminClient>;
  studio: StudioRow;
  client: ClientRow;
  bookingRequestId: string;
  appointmentType: string;
  requestedStartsAt: string;
  studioTimeZone: string;
}) {
  const clientEmail = params.client.email?.trim();
  const clientName =
    `${params.client.first_name ?? ""} ${params.client.last_name ?? ""}`.trim() || "Portal client";
  const firstName = params.client.first_name?.trim() || "there";
  const requestedTime = formatRequestDateTime(params.requestedStartsAt, params.studioTimeZone);
  const lessonType = typeLabel(params.appointmentType);

  if (clientEmail) {
    await params.supabase.from("outbound_deliveries").insert({
      studio_id: params.studio.id,
      channel: "email",
      template_key: "booking_request_received_client",
      recipient_email: clientEmail,
      subject: `${params.studio.name} received your schedule request`,
      body_text: [
        `Hi ${firstName},`,
        "",
        `${params.studio.name} received your request for ${lessonType} on ${requestedTime}.`,
        "",
        "The studio will review your request and confirm whether the time is available.",
        "",
        "Thanks,",
        params.studio.name,
      ].join("\n"),
      body_html: null,
      related_table: "booking_requests",
      related_id: params.bookingRequestId,
      dedupe_key: `portal-schedule-request-client:${params.bookingRequestId}`,
      status: "queued",
      updated_at: new Date().toISOString(),
    });
  }

  const { data: staffRows } = await params.supabase
    .from("user_studio_roles")
    .select("user_id")
    .eq("studio_id", params.studio.id)
    .eq("active", true)
    .in("role", ["studio_owner", "studio_admin", "front_desk"])
    .limit(10);

  const staffUserIds = (staffRows ?? [])
    .map((row: { user_id?: string | null }) => row.user_id)
    .filter(Boolean) as string[];

  if (!staffUserIds.length) return;

  const { data: staffProfiles } = await params.supabase.auth.admin.listUsers();
  const staffEmails = staffProfiles.users
    .filter((user) => staffUserIds.includes(user.id))
    .map((user) => user.email)
    .filter(Boolean) as string[];

  const uniqueStaffEmails = Array.from(new Set(staffEmails));

  for (const email of uniqueStaffEmails) {
    await params.supabase.from("outbound_deliveries").insert({
      studio_id: params.studio.id,
      channel: "email",
      template_key: "booking_request_staff_alert",
      recipient_email: email,
      subject: `New portal schedule request: ${clientName}`,
      body_text: [
        `A portal client requested a lesson time.`,
        "",
        `Client: ${clientName}`,
        `Lesson type: ${lessonType}`,
        `Requested time: ${requestedTime}`,
        "",
        "Review the request in DanceFlow:",
        `/app/schedule/requests?status=pending`,
      ].join("\n"),
      body_html: null,
      related_table: "booking_requests",
      related_id: params.bookingRequestId,
      dedupe_key: `portal-schedule-request-staff:${params.bookingRequestId}:${email}`,
      status: "queued",
      updated_at: new Date().toISOString(),
    });
  }
}

export async function createPortalScheduleRequestAction(formData: FormData) {
  const studioSlug = getString(formData, "studioSlug");
  const appointmentType = getString(formData, "appointmentType") || "private_lesson";
  const instructorId = getString(formData, "instructorId");
  const requestedDate = getString(formData, "requestedDate");
  const requestedTime = getString(formData, "requestedTime");
  const durationMinutes = normalizeDuration(getString(formData, "durationMinutes"));
  const notes = getString(formData, "notes");

  const returnTo = `/portal/${encodeURIComponent(studioSlug)}/schedule`;

  if (!studioSlug) {
    redirect("/login");
  }

  if (!requestedDate || !requestedTime) {
    redirect(appendQueryParam(returnTo, "error", "Please choose a preferred date and time."));
  }

  const authClient = await createClient();

  const {
    data: { user },
  } = await authClient.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  }

  const supabase = createAdminClient();

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, name, slug")
    .eq("slug", studioSlug)
    .maybeSingle<StudioRow>();

  if (studioError || !studio) {
    redirect(appendQueryParam(returnTo, "error", "Studio not found."));
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email, phone")
    .eq("studio_id", studio.id)
    .eq("portal_user_id", user.id)
    .maybeSingle<ClientRow>();

  if (clientError || !client) {
    redirect(appendQueryParam(returnTo, "error", "Portal client profile not found."));
  }

  const { data: settings, error: settingsError } = await supabase
    .from("studio_settings")
    .select(`
      timezone,
      portal_self_scheduling_enabled,
      portal_self_scheduling_mode,
      portal_self_scheduling_window_days,
      portal_self_scheduling_min_notice_hours,
      booking_request_allowed_weekdays,
      booking_request_start_time,
      booking_request_end_time,
      portal_bookable_lesson_types,
      portal_bookable_instructor_ids
    `)
    .eq("studio_id", studio.id)
    .maybeSingle<StudioSettingsRow>();

  if (settingsError || !settings) {
    redirect(appendQueryParam(returnTo, "error", "Schedule request settings are not available."));
  }

  const studioTimeZone = getStudioTimeZone(settings.timezone);

  if (
    settings.portal_self_scheduling_enabled !== true ||
    (settings.portal_self_scheduling_mode ?? "request_only") === "disabled"
  ) {
    redirect(appendQueryParam(returnTo, "error", "Schedule requests are not enabled for this studio."));
  }

  const allowedLessonTypes = settings.portal_bookable_lesson_types?.length
    ? settings.portal_bookable_lesson_types
    : ["private_lesson"];

  if (!allowedLessonTypes.includes(appointmentType)) {
    redirect(appendQueryParam(returnTo, "error", "That lesson type is not available for portal requests."));
  }

  const allowedInstructorIds = settings.portal_bookable_instructor_ids ?? [];
  const selectedInstructorId =
    instructorId && (!allowedInstructorIds.length || allowedInstructorIds.includes(instructorId))
      ? instructorId
      : null;

  const requestedStart = buildLocalDateTime(requestedDate, requestedTime, studioTimeZone);
  const requestedEnd = addMinutes(requestedStart, durationMinutes);

  if (Number.isNaN(requestedStart.getTime())) {
    redirect(appendQueryParam(returnTo, "error", "Please choose a valid request time."));
  }

  if (!getAllowedWeekdays(settings).includes(getZonedWeekday(requestedDate, studioTimeZone))) {
    redirect(appendQueryParam(returnTo, "error", "That day is not available for schedule requests."));
  }

  if (!timeWithinRequestWindow(requestedTime, settings)) {
    redirect(appendQueryParam(returnTo, "error", "That time is outside the studio request window."));
  }

  const minNoticeHours = settings.portal_self_scheduling_min_notice_hours ?? 24;
  const minStart = new Date(Date.now() + minNoticeHours * 60 * 60 * 1000);

  if (requestedStart < minStart) {
    redirect(
      appendQueryParam(
        returnTo,
        "error",
        `Please request at least ${minNoticeHours} hours in advance.`,
      ),
    );
  }

  const windowDays = settings.portal_self_scheduling_window_days ?? 14;
  const todayKey = getZonedDateKey(new Date(), studioTimeZone);
  const maxDateKey = addDaysToDateKey(todayKey, windowDays + 1);
  const maxStart = zonedDateTimeToUtcDate(maxDateKey, "00:00", studioTimeZone);

  if (requestedStart > maxStart) {
    redirect(
      appendQueryParam(
        returnTo,
        "error",
        `Please request a time within the next ${windowDays} days.`,
      ),
    );
  }

  const { data: duplicateRequest } = await supabase
    .from("booking_requests")
    .select("id")
    .eq("studio_id", studio.id)
    .eq("client_id", client.id)
    .eq("source", "portal_schedule")
    .eq("requested_starts_at", requestedStart.toISOString())
    .in("status", ["pending", "approved"])
    .limit(1)
    .maybeSingle();

  if (duplicateRequest?.id) {
    redirect(appendQueryParam(returnTo, "error", "You already have a pending or approved request for that time."));
  }

  const { data: bookingRequest, error: requestError } = await supabase
    .from("booking_requests")
    .insert({
      studio_id: studio.id,
      client_id: client.id,
      instructor_id: selectedInstructorId,
      room_id: null,
      source: "portal_schedule",
      status: "pending",
      appointment_type: appointmentType,
      title: `${typeLabel(appointmentType)} Request`,
      requested_starts_at: requestedStart.toISOString(),
      requested_ends_at: requestedEnd.toISOString(),
      customer_first_name: client.first_name,
      customer_last_name: client.last_name,
      customer_email: client.email,
      customer_phone: client.phone,
      dance_interests: null,
      notes: notes || null,
    })
    .select("id")
    .single();

  if (requestError || !bookingRequest) {
    redirect(
      appendQueryParam(
        returnTo,
        "error",
        requestError?.message ?? "Could not submit your schedule request.",
      ),
    );
  }

  await queuePortalScheduleRequestEmails({
    supabase,
    studio,
    client,
    bookingRequestId: bookingRequest.id,
    appointmentType,
    requestedStartsAt: requestedStart.toISOString(),
    studioTimeZone,
  });

  revalidatePath(returnTo);
  revalidatePath("/app/schedule/requests");
  revalidatePath("/app");
  redirect(appendQueryParam(returnTo, "success", "schedule_request_submitted"));
}
