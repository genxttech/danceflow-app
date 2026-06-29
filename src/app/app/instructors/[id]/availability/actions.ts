"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { canManageInstructors } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStudioTimeZone, zonedDateTimeToUtcDate } from "@/lib/booking/selfServiceAvailability";
import { createClient } from "@/lib/supabase/server";

const LESSON_TYPES = new Set([
  "private_lesson",
  "coaching",
  "practice_party",
  "group_class",
]);

const BLACKOUT_SOURCES = new Set([
  "manual",
  "instructor_unavailable",
]);

type InstructorRow = {
  id: string;
  studio_id: string;
  email: string | null;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getOptionalId(formData: FormData, key: string) {
  return getString(formData, key) || null;
}

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() || null;
}

function parseWeekday(value: string) {
  const weekday = Number.parseInt(value, 10);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new Error("Weekday is invalid.");
  }
  return weekday;
}

function parseWeekdays(formData: FormData) {
  const selectedWeekdays = formData
    .getAll("weekdays")
    .map((value) => (typeof value === "string" ? value : ""))
    .filter(Boolean);

  const weekdays = Array.from(new Set(selectedWeekdays.map(parseWeekday)));
  if (weekdays.length === 0) {
    throw new Error("Choose at least one weekday.");
  }

  return weekdays;
}

function parseOptionalWeekdays(formData: FormData, key: string) {
  return Array.from(
    new Set(
      formData
        .getAll(key)
        .map((value) => (typeof value === "string" ? value : ""))
        .filter(Boolean)
        .map(parseWeekday),
    ),
  );
}

function parseDate(value: string, label: string) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be a valid date.`);
  }
  return value;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dateToInputValue(date: Date) {
  return date.toISOString().slice(0, 10);
}

function inputValueToUtcDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function parseTime(value: string, label: string) {
  if (!/^\d{2}:\d{2}$/.test(value)) {
    throw new Error(`${label} must be a valid time.`);
  }
  return value;
}

async function loadInstructorAccess(instructorId: string) {
  const context = await getCurrentStudioContext();
  const supabase = await createClient();

  const { data: instructor, error } = await supabase
    .from("instructors")
    .select("id, studio_id, email")
    .eq("id", instructorId)
    .eq("studio_id", context.studioId)
    .maybeSingle<InstructorRow>();

  if (error || !instructor) {
    throw new Error(error?.message ?? "Instructor not found.");
  }

  const role = context.studioRole ?? "";
  const canManage =
    context.isPlatformAdmin || canManageInstructors(role);
  const isOwnInstructorProfile =
    ["instructor", "independent_instructor"].includes(role) &&
    normalizeEmail(context.email) === normalizeEmail(instructor.email);

  if (!canManage && !isOwnInstructorProfile) {
    throw new Error("You do not have permission to manage this instructor availability.");
  }

  return { context, supabase, instructor };
}

async function getStudioTimezone(
  supabase: Awaited<ReturnType<typeof createClient>>,
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

export async function createInstructorAvailabilityWindowAction(formData: FormData) {
  const instructorId = getString(formData, "instructorId");

  if (!instructorId) {
    redirect("/app/instructors?error=missing_instructor");
  }

  try {
    const { context, supabase } = await loadInstructorAccess(instructorId);
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

    const roomId = getOptionalId(formData, "roomId");
    const approvalRequired = getString(formData, "approvalRequired") === "on";
    const nowIso = new Date().toISOString();
    const rows = parseWeekdays(formData).map((weekday) => ({
      studio_id: context.studioId,
      instructor_id: instructorId,
      room_id: roomId,
      lesson_type: lessonType,
      weekday,
      start_time: startTime,
      end_time: endTime,
      effective_start_date: effectiveStartDate,
      effective_end_date: effectiveEndDate,
      approval_required: approvalRequired,
      active: true,
      created_by: context.userId,
      updated_at: nowIso,
    }));

    const { error } = await supabase
      .from("studio_booking_availability_windows")
      .insert(rows);

    if (error) throw new Error(error.message);
  } catch (error) {
    redirect(
      `/app/instructors/${instructorId}/availability?error=${encodeURIComponent(
        error instanceof Error ? error.message : "Could not create availability."
      )}`
    );
  }

  revalidatePath(`/app/instructors/${instructorId}/availability`);
  revalidatePath("/app/schedule/self-service/availability");
  redirect(`/app/instructors/${instructorId}/availability?success=availability_created`);
}

export async function deactivateInstructorAvailabilityWindowAction(formData: FormData) {
  const instructorId = getString(formData, "instructorId");
  const availabilityWindowId = getString(formData, "availabilityWindowId");

  if (!instructorId || !availabilityWindowId) {
    redirect("/app/instructors?error=missing_availability_window");
  }

  try {
    const { context, supabase } = await loadInstructorAccess(instructorId);
    const { error } = await supabase
      .from("studio_booking_availability_windows")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("id", availabilityWindowId)
      .eq("studio_id", context.studioId)
      .eq("instructor_id", instructorId);

    if (error) throw new Error(error.message);
  } catch (error) {
    redirect(
      `/app/instructors/${instructorId}/availability?error=${encodeURIComponent(
        error instanceof Error ? error.message : "Could not remove availability."
      )}`
    );
  }

  revalidatePath(`/app/instructors/${instructorId}/availability`);
  revalidatePath("/app/schedule/self-service/availability");
  redirect(`/app/instructors/${instructorId}/availability?success=availability_removed`);
}

export async function createInstructorBlackoutAction(formData: FormData) {
  const instructorId = getString(formData, "instructorId");

  if (!instructorId) {
    redirect("/app/instructors?error=missing_instructor");
  }

  try {
    const { context, supabase } = await loadInstructorAccess(instructorId);
    const timeZone = await getStudioTimezone(supabase, context.studioId);
    const startDate = parseDate(getString(formData, "startDate"), "Start date");
    const endDate = parseDate(getString(formData, "endDate"), "End date");
    const startTime = parseTime(getString(formData, "startTime"), "Start time");
    const endTime = parseTime(getString(formData, "endTime"), "End time");
    const source = getString(formData, "source") || "instructor_unavailable";
    const recurringWeekdays = parseOptionalWeekdays(formData, "blackoutWeekdays");

    if (!startDate || !endDate) {
      throw new Error("Start date and end date are required.");
    }

    if (!BLACKOUT_SOURCES.has(source)) {
      throw new Error("Blackout source is invalid.");
    }

    if (recurringWeekdays.length > 0 && startTime >= endTime) {
      throw new Error("For recurring unavailable time, start time must be earlier than end time.");
    }

    if (startDate > endDate) {
      throw new Error("End date must be on or after the start date.");
    }

    const roomId = getOptionalId(formData, "roomId");
    const reason = getString(formData, "reason") || null;
    const nowIso = new Date().toISOString();
    const baseRow = {
      studio_id: context.studioId,
      instructor_id: instructorId,
      room_id: roomId,
      reason,
      source,
      active: true,
      created_by: context.userId,
      updated_at: nowIso,
    };
    const rows = [];

    if (recurringWeekdays.length > 0) {
      const recurringWeekdaySet = new Set(recurringWeekdays);
      for (
        let cursor = inputValueToUtcDate(startDate);
        dateToInputValue(cursor) <= endDate;
        cursor = addDays(cursor, 1)
      ) {
        if (!recurringWeekdaySet.has(cursor.getUTCDay())) continue;

        const dateValue = dateToInputValue(cursor);
        rows.push({
          ...baseRow,
          starts_at: zonedDateTimeToUtcDate(dateValue, startTime, timeZone).toISOString(),
          ends_at: zonedDateTimeToUtcDate(dateValue, endTime, timeZone).toISOString(),
        });
      }

      if (rows.length === 0) {
        throw new Error("No matching weekdays were found in the selected date range.");
      }
    } else {
      const startsAt = zonedDateTimeToUtcDate(startDate, startTime, timeZone);
      const endsAt = zonedDateTimeToUtcDate(endDate, endTime, timeZone);

      if (startsAt >= endsAt) {
        throw new Error("Blackout start must be earlier than blackout end.");
      }

      rows.push({
        ...baseRow,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
      });
    }

    const { error } = await supabase.from("studio_booking_blackouts").insert(rows);

    if (error) throw new Error(error.message);
  } catch (error) {
    redirect(
      `/app/instructors/${instructorId}/availability?error=${encodeURIComponent(
        error instanceof Error ? error.message : "Could not create blackout."
      )}`
    );
  }

  revalidatePath(`/app/instructors/${instructorId}/availability`);
  revalidatePath("/app/schedule/self-service/availability");
  redirect(`/app/instructors/${instructorId}/availability?success=blackout_created`);
}

export async function deactivateInstructorBlackoutAction(formData: FormData) {
  const instructorId = getString(formData, "instructorId");
  const blackoutId = getString(formData, "blackoutId");

  if (!instructorId || !blackoutId) {
    redirect("/app/instructors?error=missing_blackout");
  }

  try {
    const { context, supabase } = await loadInstructorAccess(instructorId);
    const { error } = await supabase
      .from("studio_booking_blackouts")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("id", blackoutId)
      .eq("studio_id", context.studioId)
      .eq("instructor_id", instructorId);

    if (error) throw new Error(error.message);
  } catch (error) {
    redirect(
      `/app/instructors/${instructorId}/availability?error=${encodeURIComponent(
        error instanceof Error ? error.message : "Could not remove blackout."
      )}`
    );
  }

  revalidatePath(`/app/instructors/${instructorId}/availability`);
  revalidatePath("/app/schedule/self-service/availability");
  redirect(`/app/instructors/${instructorId}/availability?success=blackout_removed`);
}
