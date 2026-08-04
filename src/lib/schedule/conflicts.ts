import { createClient } from "@/lib/supabase/server";

export type ConflictResult = {
  hasConflict: boolean;
  message?: string;
};

export async function detectAppointmentConflicts(params: {
  studioId: string;
  startsAt: string;
  endsAt: string;
  instructorId?: string | null;
  roomId?: string | null;
  clientId?: string | null;
  excludeAppointmentId?: string | null;
  excludeScheduleBlockId?: string | null;
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
      .from("schedule_blocks")
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
    let appointmentQuery = supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .eq("room_id", roomId)
      .in("status", activeStatuses)
      .lt("starts_at", endsAt)
      .gt("ends_at", startsAt);

    if (excludeAppointmentId) {
      appointmentQuery = appointmentQuery.neq("id", excludeAppointmentId);
    }

    const { count: appointmentCount, error: appointmentError } =
      await appointmentQuery;

    if (appointmentError) {
      throw new Error(`Room conflict check failed: ${appointmentError.message}`);
    }

    if ((appointmentCount ?? 0) > 0) {
      return {
        hasConflict: true,
        message: "That room is already booked during this time.",
      } satisfies ConflictResult;
    }

    let blockQuery = supabase
      .from("schedule_blocks")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .eq("room_id", roomId)
      .lt("starts_at", endsAt)
      .gt("ends_at", startsAt);

    if (excludeScheduleBlockId) {
      blockQuery = blockQuery.neq("id", excludeScheduleBlockId);
    }

    const { count: blockCount, error: blockError } = await blockQuery;

    if (blockError) {
      throw new Error(`Room schedule block check failed: ${blockError.message}`);
    }

    if ((blockCount ?? 0) > 0) {
      return {
        hasConflict: true,
        message: "That room has a schedule block during this time.",
      } satisfies ConflictResult;
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
