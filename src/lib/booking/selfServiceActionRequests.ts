import {
  type BookingActionDecision,
  type BookingActionType,
} from "@/lib/booking/selfServicePolicy";

export type StudentBookingActionStatus =
  | "pending"
  | "approved"
  | "declined"
  | "cancelled"
  | "executed"
  | "failed";

export type StudentBookingActionRequestInput = {
  studioId: string;
  clientId: string;
  actionType: BookingActionType;
  mode: Exclude<BookingActionDecision["mode"], null>;
  appointmentId?: string | null;
  bookingRequestId?: string | null;
  requestedStartsAt?: string | null;
  requestedEndsAt?: string | null;
  requestedInstructorId?: string | null;
  requestedRoomId?: string | null;
  previousStartsAt?: string | null;
  previousEndsAt?: string | null;
  lessonType?: string | null;
  reason?: string | null;
  requestedByUserId?: string | null;
  details?: Record<string, unknown> | null;
};

export type StudentBookingActionRequestResult = {
  id: string;
  status: StudentBookingActionStatus;
  shouldExecuteImmediately: boolean;
};

type QueryResult<T> = PromiseLike<{
  data: T | null;
  error: { message: string } | null;
}>;

type SupabaseInsertBuilder<T> = {
  select(columns?: string): {
    single(): QueryResult<T>;
  };
};

type SupabaseTable<T> = {
  insert(value: Record<string, unknown>): SupabaseInsertBuilder<T>;
};

export type SupabaseLike = {
  from<T = Record<string, unknown>>(table: string): SupabaseTable<T>;
};

function statusForMode(
  mode: Exclude<BookingActionDecision["mode"], null>
): StudentBookingActionStatus {
  return mode === "instant" ? "approved" : "pending";
}

function auditEventTypeForMode(mode: Exclude<BookingActionDecision["mode"], null>) {
  if (mode === "instant") return "instant_action_queued";
  if (mode === "approval_required") return "approval_requested";
  return "request_submitted";
}

export async function createStudentBookingActionRequest(params: {
  supabase: SupabaseLike;
  input: StudentBookingActionRequestInput;
}): Promise<StudentBookingActionRequestResult> {
  const status = statusForMode(params.input.mode);

  const { data: request, error } = await params.supabase
    .from<{ id: string; status: StudentBookingActionStatus }>(
      "student_booking_action_requests"
    )
    .insert({
      studio_id: params.input.studioId,
      client_id: params.input.clientId,
      action_type: params.input.actionType,
      mode: params.input.mode,
      status,
      appointment_id: params.input.appointmentId ?? null,
      booking_request_id: params.input.bookingRequestId ?? null,
      requested_starts_at: params.input.requestedStartsAt ?? null,
      requested_ends_at: params.input.requestedEndsAt ?? null,
      instructor_id: params.input.requestedInstructorId ?? null,
      room_id: params.input.requestedRoomId ?? null,
      previous_starts_at: params.input.previousStartsAt ?? null,
      previous_ends_at: params.input.previousEndsAt ?? null,
      lesson_type: params.input.lessonType ?? null,
      reason: params.input.reason ?? null,
      created_by: params.input.requestedByUserId ?? null,
      updated_at: new Date().toISOString(),
    })
    .select("id, status")
    .single();

  if (error || !request) {
    throw new Error(error?.message ?? "Could not create booking action request.");
  }

  const { error: auditError } = await params.supabase
    .from("student_booking_action_audit_events")
    .insert({
      studio_id: params.input.studioId,
      action_request_id: request.id,
      event_type: auditEventTypeForMode(params.input.mode),
      outcome: "started",
      actor_user_id: params.input.requestedByUserId ?? null,
      details: {
        actionType: params.input.actionType,
        mode: params.input.mode,
        status,
        ...(params.input.details ?? {}),
      },
    })
    .select("id")
    .single();

  if (auditError) {
    throw new Error(auditError.message);
  }

  return {
    id: request.id,
    status: request.status,
    shouldExecuteImmediately: params.input.mode === "instant",
  };
}

export async function appendStudentBookingActionAuditEvent(params: {
  supabase: SupabaseLike;
  studioId: string;
  actionRequestId: string;
  appointmentId?: string | null;
  eventType: string;
  actorUserId?: string | null;
  outcome?: "started" | "succeeded" | "failed" | "blocked" | "skipped";
  details?: Record<string, unknown> | null;
}) {
  const { error } = await params.supabase
    .from("student_booking_action_audit_events")
    .insert({
      studio_id: params.studioId,
      action_request_id: params.actionRequestId,
      appointment_id: params.appointmentId ?? null,
      event_type: params.eventType,
      outcome: params.outcome ?? "succeeded",
      actor_user_id: params.actorUserId ?? null,
      details: params.details ?? {},
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(error.message);
  }
}
