"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolvePortalRelationship } from "@/lib/student-identity/portal-context";
import { detectAppointmentConflicts } from "@/lib/schedule/conflicts";

type ActionState = {
  error: string;
  success: string;
};

type RentalSlot = {
  date: string;
  startTime: string;
  endTime: string;
  priceAmount: string;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}


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
    timeZone: getStudioTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  const hourValue = Number(lookup.get("hour") ?? "0");

  return {
    year: lookup.get("year") ?? "0000",
    month: lookup.get("month") ?? "01",
    day: lookup.get("day") ?? "01",
    hour: String(hourValue === 24 ? 0 : hourValue).padStart(2, "0"),
    minute: lookup.get("minute") ?? "00",
    second: lookup.get("second") ?? "00",
  };
}

function getZonedOffsetMs(date: Date, timeZone: string) {
  const parts = getZonedDateTimeParts(date, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  return asUtc - date.getTime();
}

function zonedDateTimeToUtcDate(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour = 0, minute = 0, second = 0] = time.split(":").map(Number);

  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);

  for (let i = 0; i < 2; i += 1) {
    const offsetMs = getZonedOffsetMs(new Date(utcMs), timeZone);
    utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0) - offsetMs;
  }

  return new Date(utcMs);
}

function zonedDateTimeToUtcIso(date: string, time: string, timeZone: string) {
  return zonedDateTimeToUtcDate(date, time, timeZone).toISOString();
}

function getZonedDateKey(value: Date | string, timeZone: string) {
  const parts = getZonedDateTimeParts(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDaysToDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));
  return date.toISOString().slice(0, 10);
}

function formatStudioDate(value: string | null | undefined, timeZone: string, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: getStudioTimeZone(timeZone),
    month: "short",
    day: "numeric",
    year: "numeric",
    ...options,
  }).format(new Date(value));
}

function formatStudioDateTime(value: string | null | undefined, timeZone: string, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "—";

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
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: getStudioTimeZone(timeZone),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function toIsoDateTime(date: string, time: string, timeZone: string) {
  return zonedDateTimeToUtcIso(date, time, timeZone);
}

function parseSlotsJson(raw: string): RentalSlot[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item) => ({
        date: typeof item?.date === "string" ? item.date.trim() : "",
        startTime:
          typeof item?.startTime === "string" ? item.startTime.trim() : "",
        endTime: typeof item?.endTime === "string" ? item.endTime.trim() : "",
        priceAmount:
          typeof item?.priceAmount === "string"
            ? item.priceAmount.trim()
            : typeof item?.priceAmount === "number"
              ? String(item.priceAmount)
              : "",
      }))
      .filter(
        (item) =>
          item.date && item.startTime && item.endTime && item.priceAmount
      );
  } catch {
    return [];
  }
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

async function requireIndependentInstructorPortalAccess(studioSlug: string, requestedClientId?: string | null) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, slug, name, timezone")
    .eq("slug", studioSlug)
    .single();

  if (studioError || !studio) {
    throw new Error("Studio not found.");
  }

  const relationship = await resolvePortalRelationship({
    userId: user.id,
    studioId: studio.id,
    requestedClientId,
    permission: "can_manage_bookings",
  });

  if (!relationship) {
    throw new Error("No authorized portal relationship was found for this studio.");
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, studio_id, first_name, last_name, is_independent_instructor, linked_instructor_id")
    .eq("studio_id", studio.id)
    .eq("id", relationship.clientId)
    .single();

  if (clientError || !client) {
    throw new Error("No portal-linked instructor profile was found for this studio.");
  }

  if (!client.is_independent_instructor) {
    throw new Error(
      "This account is not enabled for floor space rental booking."
    );
  }

  return { supabase, user, studio, client };
}

const FLOOR_SPACE_CONFLICT_MESSAGE =
  "That room is unavailable for the selected time. Choose another room or time.";

/**
 * FC-1B3 Room Resource Model Foundation: floor-space rooms may be shared.
 * Overlapping room_id + time is NOT itself a conflict -- detectAppointmentConflicts'
 * room branch (src/lib/schedule/conflicts.ts) rejects only when the room is
 * unavailable, an exclusive booking is involved, or configured
 * simultaneous-booking capacity would be exceeded. Floor rentals always
 * request non-exclusive use in this foundation slice (no independent-
 * instructor exclusivity control exists yet -- see FC-1B3 audit); the
 * requesting client's own overlapping appointments are still rejected via
 * the same call's clientId branch (personal scheduling conflict, unrelated
 * to room sharing).
 *
 * instructorId is deliberately never passed here: a floor rental's
 * instructor_id is the independent instructor's own linked identity
 * record (for reporting), not a real staff teaching assignment, so an
 * instructor-schedule-block conflict check is a staff-specific concept
 * that does not apply to floor-space room booking.
 *
 * One narrow case detectAppointmentConflicts cannot express on its own is
 * preserved here explicitly: a studio-wide closure (a room_unavailable row
 * with room_id IS NULL) blocks every room, including when no specific room
 * was requested -- detectAppointmentConflicts only matches an exact roomId,
 * not "null OR this room".
 */
async function checkFloorSpaceBookingConflict(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  roomId: string | null;
  clientId: string;
  startsAt: string;
  endsAt: string;
  excludeAppointmentId?: string;
}): Promise<{ hasConflict: boolean }> {
  const { supabase, studioId, roomId, clientId, startsAt, endsAt, excludeAppointmentId } = params;

  const { count: studioWideClosureCount, error: studioWideClosureError } = await supabase
    .from("appointments")
    .select("id", { count: "exact", head: true })
    .eq("studio_id", studioId)
    .eq("appointment_type", "room_unavailable")
    .is("room_id", null)
    .neq("status", "cancelled")
    .lt("starts_at", endsAt)
    .gt("ends_at", startsAt);

  if (studioWideClosureError) {
    throw new Error(
      `Failed to check floor space availability: ${studioWideClosureError.message}`,
    );
  }

  if ((studioWideClosureCount ?? 0) > 0) {
    return { hasConflict: true };
  }

  const conflict = await detectAppointmentConflicts({
    studioId,
    startsAt,
    endsAt,
    roomId,
    clientId,
    excludeAppointmentId,
    requestExclusiveRoomUse: false,
  });

  return { hasConflict: conflict.hasConflict };
}

export async function createFloorSpaceRentalAction(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const studioSlug = getString(formData, "studioSlug");
  const notes = getString(formData, "notes");
  const roomIdRaw = getString(formData, "roomId");
  const slotsJson = getString(formData, "slotsJson");
  const roomId = roomIdRaw || null;
  const clientId = getString(formData, "clientId") || null;

  if (!studioSlug) {
    return { error: "Missing studio slug.", success: "" };
  }

  try {
    const { supabase, studio, client, user } =
      await requireIndependentInstructorPortalAccess(studioSlug, clientId);

    if (roomId) {
      const { data: room, error: roomError } = await supabase
        .from("rooms")
        .select("id, studio_id, active")
        .eq("id", roomId)
        .eq("studio_id", studio.id)
        .single();

      if (roomError || !room || room.active !== true) {
        return {
          error: "Selected room is invalid.",
          success: "",
        };
      }
    }

    const slots = parseSlotsJson(slotsJson);

    if (slots.length === 0) {
      return { error: "Add at least one time slot.", success: "" };
    }

    const now = new Date();
    const studioTimeZone = getStudioTimeZone(studio.timezone);
    const seen = new Set<string>();
    const rows = [];
    // FC-1B3A: sibling-slot overlap guard. All slots in one submission share
    // the single top-level roomId above, so two overlapping slots would
    // otherwise book the same room against itself before either reaches the
    // real-occupancy check below (which only compares against ALREADY
    // COMMITTED rows -- it cannot see a sibling slot still in this same,
    // not-yet-inserted batch). Checked in-memory, before any database call.
    const acceptedSlotRanges: { startMs: number; endMs: number }[] = [];

    for (const slot of slots) {
      const startsAt = toIsoDateTime(slot.date, slot.startTime, studioTimeZone);
      const endsAt = toIsoDateTime(slot.date, slot.endTime, studioTimeZone);

      const startDate = new Date(startsAt);
      const endDate = new Date(endsAt);

      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        return {
          error: `Invalid date or time for ${slot.date}.`,
          success: "",
        };
      }

      if (endDate <= startDate) {
        return {
          error: `End time must be later than start time for ${slot.date}.`,
          success: "",
        };
      }

      if (startDate < now) {
        return {
          error: `Past time slots are not allowed (${slot.date} ${slot.startTime}).`,
          success: "",
        };
      }

      const dedupeKey = `${slot.date}|${slot.startTime}|${slot.endTime}`;
      if (seen.has(dedupeKey)) {
        return {
          error: `Duplicate time slot detected for ${slot.date} ${slot.startTime}-${slot.endTime}.`,
          success: "",
        };
      }

      seen.add(dedupeKey);

      const startMs = startDate.getTime();
      const endMs = endDate.getTime();
      const overlapsSibling = acceptedSlotRanges.some(
        (range) => startMs < range.endMs && endMs > range.startMs,
      );

      if (overlapsSibling) {
        return {
          error: "Two of the selected time slots overlap. Adjust the times and try again.",
          success: "",
        };
      }

      acceptedSlotRanges.push({ startMs, endMs });

      const bookingConflict = await checkFloorSpaceBookingConflict({
        supabase,
        studioId: studio.id,
        roomId,
        clientId: client.id,
        startsAt,
        endsAt,
      });

      if (bookingConflict.hasConflict) {
        return {
          error: FLOOR_SPACE_CONFLICT_MESSAGE,
          success: "",
        };
      }

      const priceAmount = Number(slot.priceAmount);

      if (!Number.isFinite(priceAmount) || priceAmount <= 0) {
        return {
          error: `Enter a rental fee greater than $0 for ${slot.date} ${slot.startTime}-${slot.endTime}.`,
          success: "",
        };
      }

      rows.push({
        studio_id: studio.id,
        client_id: client.id,
        instructor_id: client.linked_instructor_id ?? null,
        room_id: roomId,
        client_package_id: null,
        appointment_type: "floor_space_rental",
        title: "Floor Space Rental",
        notes: notes || null,
        starts_at: startsAt,
        ends_at: endsAt,
        status: "scheduled",
        payment_status: "unpaid",
        price_amount: priceAmount,
        is_recurring: false,
        created_by: user.id,
      });
    }

    const { error: insertError } = await supabase
      .from("appointments")
      .insert(rows);

    if (insertError) {
      return {
        error: `Floor space rental booking failed: ${insertError.message}`,
        success: "",
      };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
      success: "",
    };
  }

  redirect(
    `/portal/${encodeURIComponent(
      studioSlug
    )}/floor-space?success=floor_rentals_booked`
  );
}

export async function cancelFloorSpaceRentalAction(formData: FormData) {
  const studioSlug = getString(formData, "studioSlug");
  const appointmentId = getString(formData, "appointmentId");
  const clientId = getString(formData, "clientId") || null;
  const returnTo =
    getString(formData, "returnTo") ||
    `/portal/${encodeURIComponent(studioSlug)}/floor-space/my-rentals`;

  if (!studioSlug) {
    redirect("/login");
  }

  if (!appointmentId) {
    redirect(appendQueryParam(returnTo, "error", "missing_appointment"));
  }

  try {
    const { supabase, studio, client } =
      await requireIndependentInstructorPortalAccess(studioSlug, clientId);

    const { data: appointment, error: appointmentError } = await supabase
      .from("appointments")
      .select("id, studio_id, client_id, appointment_type, status, starts_at")
      .eq("id", appointmentId)
      .eq("studio_id", studio.id)
      .single();

    if (appointmentError || !appointment) {
      redirect(appendQueryParam(returnTo, "error", "not_found"));
    }

    if (appointment.client_id !== client.id) {
      redirect(appendQueryParam(returnTo, "error", "unauthorized"));
    }

    if (appointment.appointment_type !== "floor_space_rental") {
      redirect(appendQueryParam(returnTo, "error", "invalid_type"));
    }

    if (appointment.status === "cancelled") {
      redirect(appendQueryParam(returnTo, "success", "already_cancelled"));
    }

    if (new Date(appointment.starts_at) < new Date()) {
      redirect(appendQueryParam(returnTo, "error", "past_rental"));
    }

    const { error: updateError } = await supabase
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", appointment.id)
      .eq("studio_id", studio.id);

    if (updateError) {
      redirect(appendQueryParam(returnTo, "error", "cancel_failed"));
    }
  } catch {
    redirect(appendQueryParam(returnTo, "error", "cancel_failed"));
  }

  redirect(appendQueryParam(returnTo, "success", "cancelled"));
}