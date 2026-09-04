import { createClient } from "@/lib/supabase/server";

export type ConflictResult = {
  hasConflict: boolean;
  message?: string;
};

// FC-1B3 Room Resource Model Foundation: rooms may be legitimately shared.
// Overlapping room_id + time is NOT itself a conflict -- a room booking is
// only rejected when the room/studio is unavailable, an exclusive booking
// is involved, or a configured simultaneous-booking capacity would be
// exceeded. See computeMaxConcurrentOccupancy below for why a simple count
// of "rows that touch the requested interval" is not the same question as
// "how many bookings are concurrent at any single instant within it".
function computeMaxConcurrentOccupancy(
  intervals: { starts_at: string; ends_at: string }[],
  windowStartIso: string,
  windowEndIso: string,
): number {
  const windowStart = new Date(windowStartIso).getTime();
  const windowEnd = new Date(windowEndIso).getTime();

  const events: { time: number; delta: number }[] = [];

  for (const interval of intervals) {
    const start = Math.max(new Date(interval.starts_at).getTime(), windowStart);
    const end = Math.min(new Date(interval.ends_at).getTime(), windowEnd);
    if (start >= end) continue;
    events.push({ time: start, delta: 1 });
    events.push({ time: end, delta: -1 });
  }

  // Departures (-1) are ordered before arrivals (+1) at the same instant so
  // a half-open [start,end) interval ending exactly when another begins
  // never double-counts -- matching the same back-to-back-allowed semantics
  // used everywhere else in this codebase.
  events.sort((a, b) => a.time - b.time || a.delta - b.delta);

  let current = 0;
  let max = 0;
  for (const event of events) {
    current += event.delta;
    if (current > max) max = current;
  }
  return max;
}

export async function detectAppointmentConflicts(params: {
  studioId: string;
  startsAt: string;
  endsAt: string;
  instructorId?: string | null;
  roomId?: string | null;
  clientId?: string | null;
  excludeAppointmentId?: string | null;
  excludeScheduleBlockId?: string | null;
  // FC-1B3: does the booking being created/edited itself request exclusive
  // use of the room? Distinct from an EXISTING occupant already being
  // exclusive (checked unconditionally below).
  requestExclusiveRoomUse?: boolean;
}) {
  const supabase = await createClient();

  const {
    studioId,
    startsAt,
    endsAt,
    instructorId,
    roomId,
    clientId,
    excludeAppointmentId,
    excludeScheduleBlockId,
    requestExclusiveRoomUse = false,
  } = params;

  const activeStatuses = [
    "scheduled",
    "confirmed",
    "rescheduled",
    "attended",
  ];

  if (instructorId) {
    let appointmentQuery = supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .eq("instructor_id", instructorId)
      .in("status", activeStatuses)
      .lt("starts_at", endsAt)
      .gt("ends_at", startsAt);

    if (excludeAppointmentId) {
      appointmentQuery = appointmentQuery.neq("id", excludeAppointmentId);
    }

    const { count: appointmentCount, error: appointmentError } =
      await appointmentQuery;

    if (appointmentError) {
      throw new Error(
        `Instructor conflict check failed: ${appointmentError.message}`,
      );
    }

    if ((appointmentCount ?? 0) > 0) {
      return {
        hasConflict: true,
        message: "That instructor is already booked during this time.",
      } satisfies ConflictResult;
    }

    let blockQuery = supabase
      .from("instructor_schedule_blocks")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .eq("instructor_id", instructorId)
      .lt("starts_at", endsAt)
      .gt("ends_at", startsAt);

    if (excludeScheduleBlockId) {
      blockQuery = blockQuery.neq("id", excludeScheduleBlockId);
    }

    const { count: blockCount, error: blockError } = await blockQuery;

    if (blockError) {
      throw new Error(
        `Instructor schedule block check failed: ${blockError.message}`,
      );
    }

    if ((blockCount ?? 0) > 0) {
      return {
        hasConflict: true,
        message: "That instructor has a schedule block during this time.",
      } satisfies ConflictResult;
    }
  }

  if (roomId) {
    // 1. Availability: a room_unavailable row for this exact room is a hard
    // block, independent of usage/exclusivity/capacity -- the room simply
    // isn't open. Deliberately NOT instructor_schedule_blocks: a personal
    // instructor block (lunch/travel/personal/etc.) affects that
    // instructor's own schedule (handled by the instructorId branch above),
    // not the room's availability to everyone else -- see FC-1B3 audit
    // finding on instructor_schedule_blocks room-wide conflation.
    const { count: unavailableCount, error: unavailableError } = await supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .eq("room_id", roomId)
      .eq("appointment_type", "room_unavailable")
      .in("status", activeStatuses)
      .lt("starts_at", endsAt)
      .gt("ends_at", startsAt);

    if (unavailableError) {
      throw new Error(`Room availability check failed: ${unavailableError.message}`);
    }

    if ((unavailableCount ?? 0) > 0) {
      return {
        hasConflict: true,
        message: "That room is unavailable during this time.",
      } satisfies ConflictResult;
    }

    // 2. Fetch real occupants (excluding room_unavailable rows, which are
    // an availability signal, not a usage unit) for exclusivity + capacity.
    let occupantsQuery = supabase
      .from("appointments")
      .select("starts_at, ends_at, exclusive_room_use")
      .eq("studio_id", studioId)
      .eq("room_id", roomId)
      .neq("appointment_type", "room_unavailable")
      .in("status", activeStatuses)
      .lt("starts_at", endsAt)
      .gt("ends_at", startsAt);

    if (excludeAppointmentId) {
      occupantsQuery = occupantsQuery.neq("id", excludeAppointmentId);
    }

    const { data: occupants, error: occupantsError } = await occupantsQuery;

    if (occupantsError) {
      throw new Error(`Room usage check failed: ${occupantsError.message}`);
    }

    const occupantRows = (occupants ?? []) as {
      starts_at: string;
      ends_at: string;
      exclusive_room_use: boolean | null;
    }[];

    // 3. Exclusivity: an existing exclusive occupant blocks any new usage.
    if (occupantRows.some((row) => row.exclusive_room_use === true)) {
      return {
        hasConflict: true,
        message: "That room is already booked during this time.",
      } satisfies ConflictResult;
    }

    // 4. Exclusivity: a newly requested exclusive booking is blocked by any
    // occupant at all, exclusive or not.
    if (requestExclusiveRoomUse && occupantRows.length > 0) {
      return {
        hasConflict: true,
        message: "That room is already booked during this time.",
      } satisfies ConflictResult;
    }

    // 5. Capacity: only evaluated once availability/exclusivity are clear,
    // and only when there is at least one other occupant to weigh against
    // -- with zero occupants, adding this one booking can never exceed any
    // configured (>=1) capacity, so there is nothing to look up.
    if (occupantRows.length > 0) {
      const { data: roomRow, error: roomError } = await supabase
        .from("rooms")
        .select("max_simultaneous_bookings")
        .eq("id", roomId)
        .maybeSingle();

      if (roomError) {
        throw new Error(`Room capacity lookup failed: ${roomError.message}`);
      }

      const maxSimultaneousBookings = roomRow?.max_simultaneous_bookings ?? null;

      if (maxSimultaneousBookings !== null) {
        const peakOtherOccupancy = computeMaxConcurrentOccupancy(
          occupantRows,
          startsAt,
          endsAt,
        );

        if (peakOtherOccupancy + 1 > maxSimultaneousBookings) {
          return {
            hasConflict: true,
            message: "That room is already booked during this time.",
          } satisfies ConflictResult;
        }
      }
    }
  }

  if (clientId) {
    let query = supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .in("status", activeStatuses)
      .lt("starts_at", endsAt)
      .gt("ends_at", startsAt);

    if (excludeAppointmentId) {
      query = query.neq("id", excludeAppointmentId);
    }

    const { count, error } = await query;

    if (error) {
      throw new Error(`Client conflict check failed: ${error.message}`);
    }

    if ((count ?? 0) > 0) {
      return {
        hasConflict: true,
        message: "That client already has an overlapping appointment.",
      } satisfies ConflictResult;
    }
  }

  return { hasConflict: false } satisfies ConflictResult;
}
