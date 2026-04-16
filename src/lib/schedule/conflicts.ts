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
  } = params;

  const activeStatuses = ["scheduled", "rescheduled", "attended"];

  if (instructorId) {
    let query = supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .eq("instructor_id", instructorId)
      .in("status", activeStatuses)
      .lt("starts_at", endsAt)
      .gt("ends_at", startsAt);

    if (excludeAppointmentId) {
      query = query.neq("id", excludeAppointmentId);
    }

    const { count, error } = await query;

    if (error) {
      throw new Error(`Instructor conflict check failed: ${error.message}`);
    }

    if ((count ?? 0) > 0) {
      return {
        hasConflict: true,
        message: "That instructor is already booked during this time.",
      } satisfies ConflictResult;
    }
  }

  if (roomId) {
    let query = supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .eq("room_id", roomId)
      .in("status", activeStatuses)
      .lt("starts_at", endsAt)
      .gt("ends_at", startsAt);

    if (excludeAppointmentId) {
      query = query.neq("id", excludeAppointmentId);
    }

    const { count, error } = await query;

    if (error) {
      throw new Error(`Room conflict check failed: ${error.message}`);
    }

    if ((count ?? 0) > 0) {
      return {
        hasConflict: true,
        message: "That room is already booked during this time.",
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