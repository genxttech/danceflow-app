"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAppointmentCreateAccess } from "@/lib/auth/serverRoleGuard";
import { getStudioTimeZone, zonedDateTimeToUtcDate } from "@/lib/booking/selfServiceAvailability";

const LESSON_TYPES = new Set([
  "private_lesson",
  "coaching",
  "practice_party",
  "group_class",
]);

const BLACKOUT_SOURCES = new Set([
  "manual",
  "studio_closed",
  "instructor_unavailable",
  "room_unavailable",
  "event",
  "system",
]);

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getOptionalId(formData: FormData, key: string) {
  return getString(formData, key) || null;
}

function parseWeekday(value: string) {
  const weekday = Number.parseInt(value, 10);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new Error("Weekday is invalid.");
  }
  return weekday;
}

function parseDate(value: string, label: string) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be a valid date.`);
  }
  return value;
}

function parseTime(value: string, label: string) {
  if (!/^\d{2}:\d{2}$/.test(value)) {
    throw new Error(`${label} must be a valid time.`);
  }
  return value;
}

async function getStudioTimezone(
  supabase: Awaited<ReturnType<typeof requireAppointmentCreateAccess>>["supabase"],
  studioId: string
) {
  const { data, error } = await supabase
    .from("studio_settings")
    .select("timezone")
    .eq("studio_id", studioId)
    .maybeSingle<{ timezone: string | null }>();

  if (error) throw new Error(error.message);
  return getStudioTimeZone(data?.timezone);
}

export async function createSelfServiceAvailabilityWindowAction(formData: FormData) {
  try {
    const { supabase, studioId, user } = await requireAppointmentCreateAccess();
    const lessonType = getString(formData, "lessonType") || "private_lesson";
    const startTime = parseTime(getString(formData, "startTime"), "Start time");
    const endTime = parseTime(getString(formData, "endTime"), "End time");
    const effectiveStartDate = parseDate(
      getString(formData, "effectiveStartDate"),
      "Effective start date"
    );
    const effectiveEndDate = parseDate(
      getString(formData, "effectiveEndDate"),
      "Effective end date"
    );

    if (!LESSON_TYPES.has(lessonType)) {
      throw new Error("Lesson type is invalid.");
    }

    if (startTime >= endTime) {
      throw new Error("Start time must be earlier than end time.");
    }

    if (
      effectiveStartDate &&
      effectiveEndDate &&
      effectiveStartDate > effectiveEndDate
    ) {
      throw new Error("Effective end date must be after the start date.");
    }

    const { error } = await supabase.from("studio_booking_availability_windows").insert({
      studio_id: studioId,
      instructor_id: getOptionalId(formData, "instructorId"),
      room_id: getOptionalId(formData, "roomId"),
      lesson_type: lessonType,
      weekday: parseWeekday(getString(formData, "weekday")),
      start_time: startTime,
      end_time: endTime,
      effective_start_date: effectiveStartDate,
      effective_end_date: effectiveEndDate,
      approval_required: getString(formData, "approvalRequired") === "on",
      active: true,
      created_by: user.id,
      updated_at: new Date().toISOString(),
    });

    if (error) throw new Error(error.message);
  } catch (error) {
    redirect(
      `/app/schedule/self-service/availability?error=${encodeURIComponent(
        error instanceof Error ? error.message : "Could not create availability window."
      )}`
    );
  }

  revalidatePath("/app/schedule/self-service/availability");
  redirect("/app/schedule/self-service/availability?success=availability_created");
}

export async function deactivateSelfServiceAvailabilityWindowAction(formData: FormData) {
  const availabilityWindowId = getString(formData, "availabilityWindowId");

  if (!availabilityWindowId) {
    redirect("/app/schedule/self-service/availability?error=missing_availability_window");
  }

  try {
    const { supabase, studioId } = await requireAppointmentCreateAccess();
    const { error } = await supabase
      .from("studio_booking_availability_windows")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("id", availabilityWindowId)
      .eq("studio_id", studioId);

    if (error) throw new Error(error.message);
  } catch (error) {
    redirect(
      `/app/schedule/self-service/availability?error=${encodeURIComponent(
        error instanceof Error ? error.message : "Could not remove availability window."
      )}`
    );
  }

  revalidatePath("/app/schedule/self-service/availability");
  redirect("/app/schedule/self-service/availability?success=availability_removed");
}

export async function createSelfServiceBlackoutAction(formData: FormData) {
  try {
    const { supabase, studioId, user } = await requireAppointmentCreateAccess();
    const timeZone = await getStudioTimezone(supabase, studioId);
    const startDate = parseDate(getString(formData, "startDate"), "Start date");
    const endDate = parseDate(getString(formData, "endDate"), "End date");
    const startTime = parseTime(getString(formData, "startTime"), "Start time");
    const endTime = parseTime(getString(formData, "endTime"), "End time");
    const source = getString(formData, "source") || "manual";

    if (!startDate || !endDate) {
      throw new Error("Start date and end date are required.");
    }

    if (!BLACKOUT_SOURCES.has(source)) {
      throw new Error("Blackout source is invalid.");
    }

    const startsAt = zonedDateTimeToUtcDate(startDate, startTime, timeZone);
    const endsAt = zonedDateTimeToUtcDate(endDate, endTime, timeZone);

    if (startsAt >= endsAt) {
      throw new Error("Blackout start must be earlier than blackout end.");
    }

    const { error } = await supabase.from("studio_booking_blackouts").insert({
      studio_id: studioId,
      instructor_id: getOptionalId(formData, "instructorId"),
      room_id: getOptionalId(formData, "roomId"),
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      reason: getString(formData, "reason") || null,
      source,
      active: true,
      created_by: user.id,
      updated_at: new Date().toISOString(),
    });

    if (error) throw new Error(error.message);
  } catch (error) {
    redirect(
      `/app/schedule/self-service/availability?error=${encodeURIComponent(
        error instanceof Error ? error.message : "Could not create blackout."
      )}`
    );
  }

  revalidatePath("/app/schedule/self-service/availability");
  redirect("/app/schedule/self-service/availability?success=blackout_created");
}

export async function deactivateSelfServiceBlackoutAction(formData: FormData) {
  const blackoutId = getString(formData, "blackoutId");

  if (!blackoutId) {
    redirect("/app/schedule/self-service/availability?error=missing_blackout");
  }

  try {
    const { supabase, studioId } = await requireAppointmentCreateAccess();
    const { error } = await supabase
      .from("studio_booking_blackouts")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("id", blackoutId)
      .eq("studio_id", studioId);

    if (error) throw new Error(error.message);
  } catch (error) {
    redirect(
      `/app/schedule/self-service/availability?error=${encodeURIComponent(
        error instanceof Error ? error.message : "Could not remove blackout."
      )}`
    );
  }

  revalidatePath("/app/schedule/self-service/availability");
  redirect("/app/schedule/self-service/availability?success=blackout_removed");
}
