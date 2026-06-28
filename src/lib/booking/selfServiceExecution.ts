import { appendStudentBookingActionAuditEvent } from "@/lib/booking/selfServiceActionRequests";
import { detectAppointmentConflicts } from "@/lib/schedule/conflicts";

type SupabaseError = { message: string };

type QueryResult<T> = PromiseLike<{
  data: T | null;
  error: SupabaseError | null;
}>;

type SupabaseBuilder = {
  eq(column: string, value: unknown): SupabaseBuilder;
  select(columns?: string): SupabaseBuilder;
  single<T>(): QueryResult<T>;
  maybeSingle<T>(): QueryResult<T>;
  update(values: Record<string, unknown>): SupabaseBuilder;
  insert(values: Record<string, unknown>): SupabaseBuilder;
};

export type SelfServiceExecutionClient = {
  from(table: string): SupabaseBuilder;
};

export type StudentBookingActionRequestRow = {
  id: string;
  studio_id: string;
  client_id: string | null;
  action_type: "book" | "reschedule" | "cancel";
  mode: "request_only" | "approval_required" | "instant";
  status: string;
  appointment_id: string | null;
  requested_starts_at: string | null;
  requested_ends_at: string | null;
  previous_starts_at: string | null;
  previous_ends_at: string | null;
  instructor_id: string | null;
  room_id: string | null;
  lesson_type: string | null;
  reason: string | null;
};

function getConflictErrorMessage(conflict: unknown) {
  if (!conflict) return "Scheduling conflict detected.";
  if (typeof conflict === "string") return conflict;

  if (typeof conflict === "object") {
    const value = conflict as {
      message?: string;
      error?: string;
      instructorConflict?: boolean;
      roomConflict?: boolean;
      clientConflict?: boolean;
    };

    if (value.message) return value.message;
    if (value.error) return value.error;
    if (value.instructorConflict) {
      return "The selected instructor already has an appointment during that time.";
    }
    if (value.roomConflict) return "There is a room conflict for the selected time.";
    if (value.clientConflict) return "The client already has an appointment during that time.";
  }

  return "Scheduling conflict detected.";
}

export async function executeApprovedStudentBookingAction(params: {
  supabase: SelfServiceExecutionClient;
  actionRequest: StudentBookingActionRequestRow;
  actorUserId: string;
}) {
  const request = params.actionRequest;

  if (request.status !== "pending" && request.status !== "approved") {
    throw new Error("This self-service action has already been reviewed.");
  }

  if (!request.client_id) throw new Error("Missing client.");

  if (request.action_type === "cancel") {
    if (!request.appointment_id) throw new Error("Missing appointment.");

    const { error: cancelError } = await params.supabase
      .from("appointments")
      .update({
        status: "cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", request.appointment_id)
      .eq("studio_id", request.studio_id)
      .eq("client_id", request.client_id)
      .select("id")
      .single<{ id: string }>();

    if (cancelError) throw new Error(cancelError.message);

    const { error: requestUpdateError } = await params.supabase
      .from("student_booking_action_requests")
      .update({
        status: "executed",
        decision_by: params.actorUserId,
        decision_at: new Date().toISOString(),
        executed_by: params.actorUserId,
        executed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", request.id)
      .eq("studio_id", request.studio_id)
      .select("id")
      .single<{ id: string }>();

    if (requestUpdateError) throw new Error(requestUpdateError.message);

    await appendStudentBookingActionAuditEvent({
      supabase: params.supabase,
      studioId: request.studio_id,
      actionRequestId: request.id,
      appointmentId: request.appointment_id,
      eventType: "executed",
      actorUserId: params.actorUserId,
      details: { appointmentId: request.appointment_id, actionType: "cancel" },
    });

    return { id: request.appointment_id };
  }

  if (!request.requested_starts_at || !request.requested_ends_at) {
    throw new Error("Missing requested appointment time.");
  }

  const conflict = await detectAppointmentConflicts({
    studioId: request.studio_id,
    startsAt: request.requested_starts_at,
    endsAt: request.requested_ends_at,
    instructorId: request.instructor_id,
    roomId: request.room_id,
    clientId: request.client_id,
  });

  if ((conflict as { hasConflict?: boolean } | null)?.hasConflict) {
    throw new Error(getConflictErrorMessage(conflict));
  }

  const appointmentMutation =
    request.action_type === "reschedule" && request.appointment_id
      ? params.supabase
          .from("appointments")
          .update({
            instructor_id: request.instructor_id,
            room_id: request.room_id,
            starts_at: request.requested_starts_at,
            ends_at: request.requested_ends_at,
            status: "scheduled",
            updated_at: new Date().toISOString(),
          })
          .eq("id", request.appointment_id)
          .eq("studio_id", request.studio_id)
          .eq("client_id", request.client_id)
      : params.supabase.from("appointments").insert({
          studio_id: request.studio_id,
          client_id: request.client_id,
          instructor_id: request.instructor_id,
          room_id: request.room_id,
          appointment_type: request.lesson_type ?? "private_lesson",
          title: "Self-Service Booking",
          notes: request.reason ? `Student note: ${request.reason}` : null,
          starts_at: request.requested_starts_at,
          ends_at: request.requested_ends_at,
          status: "scheduled",
          is_recurring: false,
          created_by: params.actorUserId,
        });

  const { data: appointment, error: appointmentError } = await appointmentMutation
    .select("id")
    .single<{ id: string }>();

  if (appointmentError || !appointment) {
    throw new Error(appointmentError?.message ?? "Could not create appointment.");
  }

  const { error: updateError } = await params.supabase
    .from("student_booking_action_requests")
    .update({
      status: "executed",
      appointment_id: appointment.id,
      decision_by: params.actorUserId,
      decision_at: new Date().toISOString(),
      executed_by: params.actorUserId,
      executed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", request.id)
    .eq("studio_id", request.studio_id)
    .select("id")
    .single<{ id: string }>();

  if (updateError) {
    throw new Error(
      `Appointment was created, but the self-service request update failed: ${updateError.message}`
    );
  }

  await appendStudentBookingActionAuditEvent({
    supabase: params.supabase,
    studioId: request.studio_id,
    actionRequestId: request.id,
    eventType: "executed",
    actorUserId: params.actorUserId,
    details: { appointmentId: appointment.id },
  });

  return appointment;
}

export async function declineStudentBookingAction(params: {
  supabase: SelfServiceExecutionClient;
  actionRequest: StudentBookingActionRequestRow;
  actorUserId: string;
  reason?: string | null;
}) {
  if (params.actionRequest.status !== "pending") {
    throw new Error("This self-service action has already been reviewed.");
  }

  const { error } = await params.supabase
    .from("student_booking_action_requests")
    .update({
      status: "declined",
      decision_by: params.actorUserId,
      decision_at: new Date().toISOString(),
      staff_note: params.reason ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.actionRequest.id)
    .eq("studio_id", params.actionRequest.studio_id)
    .select("id")
    .single<{ id: string }>();

  if (error) throw new Error(error.message);

  await appendStudentBookingActionAuditEvent({
    supabase: params.supabase,
    studioId: params.actionRequest.studio_id,
    actionRequestId: params.actionRequest.id,
    eventType: "declined",
    actorUserId: params.actorUserId,
    details: { reason: params.reason ?? null },
  });
}
