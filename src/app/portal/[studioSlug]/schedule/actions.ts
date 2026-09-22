"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolvePortalRelationship } from "@/lib/student-identity/portal-context";
import { INSTRUCTOR_NOT_ASSIGNABLE_MESSAGE } from "@/lib/instructors/assignability";
import {
  buildPortalBookingClientEmail,
  buildPortalBookingStaffEmail,
} from "@/lib/notifications/scheduling-emails";
import { sendMobilePushToUser } from "@/lib/notifications/expoPush";

const DEFAULT_TIME_ZONE = "America/New_York";
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;
const APPOINTMENT_TYPES = new Set([
  "private_lesson",
  "group_class",
  "intro_lesson",
  "coaching",
  "practice_party",
  "floor_rental",
]);

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
  public_name: string | null;
  public_logo_url: string | null;
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

function cleanText(value: string, maxLength: number) {
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeSlug(value: string) {
  const slug = cleanText(value, 80);
  return SLUG_PATTERN.test(slug) ? slug : "";
}

function normalizeAppointmentType(value: string) {
  const type = cleanText(value, 80) || "private_lesson";
  return APPOINTMENT_TYPES.has(type) ? type : "private_lesson";
}

function normalizeOptionalUuid(value: string) {
  const id = cleanText(value, 36);
  return id && UUID_PATTERN.test(id) ? id : "";
}

function normalizeDateKey(value: string) {
  const date = cleanText(value, 10);
  return DATE_PATTERN.test(date) ? date : "";
}

function normalizeTimeKey(value: string) {
  const time = cleanText(value, 5);
  if (!TIME_PATTERN.test(time)) return "";
  const [hour, minute] = time.split(":").map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? time : "";
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

async function notifyStaffOfPortalScheduleRequest(params: {
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
    `${params.client.first_name ?? ""} ${params.client.last_name ?? ""}`.trim() ||
    "Portal client";
  const requestedTime = formatRequestDateTime(
    params.requestedStartsAt,
    params.studioTimeZone,
  );
  const lessonType = typeLabel(params.appointmentType);
  const reviewPath = "/app/schedule/requests?status=pending";

  if (clientEmail) {
    const clientMessage = buildPortalBookingClientEmail({
      studio: params.studio,
      clientFirstName: params.client.first_name,
      lessonType,
      requestedTime,
    });

    const { error: clientEmailError } = await params.supabase
      .from("outbound_deliveries")
      .insert({
        studio_id: params.studio.id,
        channel: "email",
        template_key: "booking_request_received_client",
        recipient_email: clientEmail,
        subject: clientMessage.subject,
        body_text: clientMessage.bodyText,
        body_html: clientMessage.bodyHtml,
        related_table: "booking_requests",
        related_id: params.bookingRequestId,
        dedupe_key: `portal-schedule-request-client:${params.bookingRequestId}`,
        status: "queued",
        updated_at: new Date().toISOString(),
      });

    if (clientEmailError) {
      console.error(
        "Failed to queue portal schedule request client email",
        clientEmailError.message,
      );
    }
  }

  const { data: staffRows, error: staffRolesError } = await params.supabase
    .from("user_studio_roles")
    .select("user_id")
    .eq("studio_id", params.studio.id)
    .eq("active", true)
    .in("role", ["studio_owner", "studio_admin", "front_desk"])
    .limit(25);

  if (staffRolesError) {
    console.error(
      "Failed to load staff recipients for portal schedule request",
      staffRolesError.message,
    );
    return;
  }

  const staffUserIds = Array.from(
    new Set(
      (staffRows ?? [])
        .map((row: { user_id?: string | null }) => row.user_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  if (!staffUserIds.length) {
    console.error(
      "Portal schedule request created, but no eligible studio staff recipients were found",
      {
        studioId: params.studio.id,
        bookingRequestId: params.bookingRequestId,
      },
    );
    return;
  }

  const { data: staffProfiles, error: staffProfilesError } =
    await params.supabase.auth.admin.listUsers();

  if (staffProfilesError) {
    console.error(
      "Failed to load staff auth profiles for portal schedule request",
      staffProfilesError.message,
    );
  } else {
    const staffEmails = staffProfiles.users
      .filter((user) => staffUserIds.includes(user.id))
      .map((user) => user.email?.trim())
      .filter((email): email is string => Boolean(email));

    const staffMessage = buildPortalBookingStaffEmail({
      studio: params.studio,
      clientName,
      lessonType,
      requestedTime,
    });

    for (const email of Array.from(new Set(staffEmails))) {
      const { error: staffEmailError } = await params.supabase
        .from("outbound_deliveries")
        .insert({
          studio_id: params.studio.id,
          channel: "email",
          template_key: "booking_request_staff_alert",
          recipient_email: email,
          subject: staffMessage.subject,
          body_text: staffMessage.bodyText,
          body_html: staffMessage.bodyHtml,
          related_table: "booking_requests",
          related_id: params.bookingRequestId,
          dedupe_key: `portal-schedule-request-staff:${params.bookingRequestId}:${email}`,
          status: "queued",
          updated_at: new Date().toISOString(),
        });

      if (staffEmailError) {
        console.error(
          "Failed to queue portal schedule request staff email",
          {
            bookingRequestId: params.bookingRequestId,
            recipientEmail: email,
            error: staffEmailError.message,
          },
        );
      }
    }
  }

  await Promise.all(
    staffUserIds.map(async (userId) => {
      try {
        await sendMobilePushToUser({
          userId,
          category: "schedule",
          title: "New schedule request",
          body: `${clientName} requested ${lessonType} for ${requestedTime}.`,
          data: {
            source: "portal_schedule_request_staff",
            bookingRequestId: params.bookingRequestId,
            studioId: params.studio.id,
            reviewPath,
          },
        });
      } catch (pushError) {
        console.error(
          "Failed to send portal schedule request staff push",
          {
            bookingRequestId: params.bookingRequestId,
            userId,
            error:
              pushError instanceof Error ? pushError.message : pushError,
          },
        );
      }
    }),
  );
}

export async function createPortalScheduleRequestAction(formData: FormData) {
  const studioSlug = normalizeSlug(getString(formData, "studioSlug"));
  const appointmentType = normalizeAppointmentType(getString(formData, "appointmentType"));
  const instructorId = normalizeOptionalUuid(getString(formData, "instructorId"));
  const requestedDate = normalizeDateKey(getString(formData, "requestedDate"));
  const requestedTime = normalizeTimeKey(getString(formData, "requestedTime"));
  const durationMinutes = normalizeDuration(getString(formData, "durationMinutes"));
  const notes = cleanText(getString(formData, "notes"), 2000);
  const requestedClientId = getString(formData, "clientId") || null;

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
    .select("id, name, public_name, public_logo_url, slug")
    .eq("slug", studioSlug)
    .maybeSingle<StudioRow>();

  if (studioError || !studio) {
    redirect(appendQueryParam(returnTo, "error", "Studio not found."));
  }

  const relationship = await resolvePortalRelationship({
    userId: user.id,
    studioId: studio.id,
    requestedClientId,
    permission: "can_manage_bookings",
  });

  if (!relationship) {
    redirect(appendQueryParam(returnTo, "error", "Portal client profile not found."));
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email, phone")
    .eq("studio_id", studio.id)
    .eq("id", relationship.clientId)
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
    // Landmark 1A Slice 7: a DB trigger now rejects a live request naming an
    // instructor who is no longer assignable (revoked, deactivated, unlinked,
    // or cross-studio). Surface that reason instead of a generic failure.
    redirect(
      appendQueryParam(
        returnTo,
        "error",
        requestError?.message?.includes(INSTRUCTOR_NOT_ASSIGNABLE_MESSAGE)
          ? INSTRUCTOR_NOT_ASSIGNABLE_MESSAGE
          : "Could not submit your schedule request.",
      ),
    );
  }

  const clientName =
    `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim() ||
    "A portal client";
  const { error: notificationError } = await supabase
    .from("notifications")
    .insert({
      studio_id: studio.id,
      type: "portal_schedule_request",
      category: "schedule",
      priority: "high",
      title: "New portal schedule request",
      body: `${clientName} requested a ${typeLabel(appointmentType)} for ${formatRequestDateTime(requestedStart.toISOString(), studioTimeZone)}.`,
      client_id: client.id,
    });

  if (notificationError) {
    console.error(
      "Failed to create portal schedule request in-app notification",
      {
        studioId: studio.id,
        bookingRequestId: bookingRequest.id,
        error: notificationError.message,
      },
    );
  }

  await notifyStaffOfPortalScheduleRequest({
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

// ============================================================================
// GC-3.3: student/guardian self-enrollment into a publicly-discoverable,
// self-enrollment-enabled group class. Thin wrapper around the
// self_enroll_class_attendee RPC (20260913091200_gc3d_...sql) -- the RPC's
// own embedded client_account_links.can_manage_bookings=true check is the
// real, fine-grained authority; resolvePortalRelationship's
// can_manage_bookings gate here is the app-layer UX check (matches
// createPortalScheduleRequestAction's own established posture above).
// ============================================================================

// Maps self_enroll_class_attendee's specific Postgres exception messages to
// a distinct, actionable message -- this page's own established convention
// (see createPortalScheduleRequestAction above) passes plain human-readable
// text via the error query param directly, not an opaque code requiring a
// separate page-level dictionary (unlike the staff-side
// classifyEnrollClassAttendeeError pattern), so this mirrors that.
function classifySelfEnrollError(message: string): string {
  if (message.includes("already enrolled")) {
    return "You are already enrolled in this class.";
  }
  if (message.includes("not open for self-enrollment")) {
    return "Online enrollment isn't available for this class.";
  }
  if (message.includes("No eligible package or membership")) {
    return "You don't currently have an eligible package or membership for this class.";
  }
  if (message.includes("single funding source choice is required")) {
    return "Choose a funding source to join this class.";
  }
  if (message.includes("is not an eligible funding source")) {
    return "That funding source is no longer eligible for this class. Choose another.";
  }
  if (message.includes("no available seats remaining")) {
    return "This class is full.";
  }
  if (message.includes("Not authorized")) {
    return "You're not authorized to enroll this client in this class.";
  }
  if (message.includes("not found")) {
    return "This class could not be found.";
  }
  return "Could not join this class. Try again.";
}

// A single native <input type="radio" name="fundingChoice"> group can only
// ever set one form field's value -- "package:<id>" / "membership:<id>" is
// parsed back into the two separate RPC parameters here, so the portal page
// never needs client-side JS to drive a multi-source choice.
function parseFundingChoice(raw: string | null): {
  clientPackageId: string | null;
  clientMembershipId: string | null;
} {
  if (!raw) return { clientPackageId: null, clientMembershipId: null };
  const [type, id] = raw.split(":");
  if (type === "package" && id) return { clientPackageId: id, clientMembershipId: null };
  if (type === "membership" && id) return { clientPackageId: null, clientMembershipId: id };
  return { clientPackageId: null, clientMembershipId: null };
}

export async function selfEnrollGroupClassAction(formData: FormData) {
  const studioSlug = normalizeSlug(getString(formData, "studioSlug"));
  const appointmentId = getString(formData, "appointmentId");
  const { clientPackageId, clientMembershipId } = parseFundingChoice(
    getString(formData, "fundingChoice") || null,
  );
  const requestedClientId = getString(formData, "clientId") || null;

  const returnTo = `/portal/${encodeURIComponent(studioSlug)}/schedule`;

  if (!studioSlug || !appointmentId) {
    redirect(appendQueryParam(returnTo, "error", "Could not join this class. Try again."));
  }

  const authClient = await createClient();

  const {
    data: { user },
  } = await authClient.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  }

  const adminClient = createAdminClient();

  const { data: studio, error: studioError } = await adminClient
    .from("studios")
    .select("id")
    .eq("slug", studioSlug)
    .maybeSingle<{ id: string }>();

  if (studioError || !studio) {
    redirect(appendQueryParam(returnTo, "error", "This class could not be found."));
  }

  const relationship = await resolvePortalRelationship({
    userId: user.id,
    studioId: studio.id,
    requestedClientId,
    permission: "can_manage_bookings",
  });

  if (!relationship) {
    redirect(appendQueryParam(returnTo, "error", "You're not authorized to enroll this client in this class."));
  }

  // RPC call runs under the request-scoped, user-JWT-bearing session client
  // so auth.uid() resolves to the real caller inside
  // self_enroll_class_attendee -- the RPC's own authorization depends on
  // this, exactly as every other staff/portal RPC caller in this codebase
  // (enrollClassAttendeeAction, the P6 self-service RPC family) already
  // relies on. Never the admin client for this specific call.
  const { error } = await authClient.rpc("self_enroll_class_attendee", {
    p_appointment_id: appointmentId,
    p_client_id: relationship.clientId,
    p_client_package_id: clientPackageId,
    p_client_membership_id: clientMembershipId,
  });

  if (error) {
    console.error("Could not self-enroll in class:", error.message);
    redirect(appendQueryParam(returnTo, "error", classifySelfEnrollError(error.message ?? "")));
  }

  revalidatePath(returnTo);
  revalidatePath("/app/schedule");
  redirect(appendQueryParam(returnTo, "success", "class_joined"));
}
