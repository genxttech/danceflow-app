import { NextResponse } from "next/server";
import { getStudentApiUser } from "@/lib/auth/studentApiAuth";
import {
  createStudentBookingActionRequest,
  type SupabaseLike,
} from "@/lib/booking/selfServiceActionRequests";
import {
  executeApprovedStudentBookingAction,
  type SelfServiceExecutionClient,
  type StudentBookingActionRequestRow,
} from "@/lib/booking/selfServiceExecution";
import {
  loadStudentSelfServiceSlots,
  type SupabaseQueryClient,
} from "@/lib/booking/selfServiceQueries";
import { canUseSelfServiceBooking } from "@/lib/booking/selfServicePolicy";
import { sendMobilePushToUser } from "@/lib/notifications/expoPush";
import { createAdminClient } from "@/lib/supabase/admin";

type BookingActionPayload = {
  studioSlug?: string;
  actionType?: "book" | "reschedule" | "cancel";
  appointmentId?: string;
  lessonType?: string;
  startsAt?: string;
  endsAt?: string;
  instructorId?: string | null;
  roomId?: string | null;
  reason?: string | null;
};

type StudioRow = { id: string; slug: string };
type ClientRow = { id: string };
type SettingsRow = {
  portal_self_scheduling_enabled: boolean | null;
  portal_self_scheduling_mode: string | null;
  portal_self_scheduling_reschedule_mode: string | null;
  portal_self_scheduling_cancellation_mode: string | null;
  portal_self_scheduling_window_days: number | null;
  portal_self_scheduling_min_notice_hours: number | null;
  portal_self_scheduling_cancellation_cutoff_hours: number | null;
  portal_self_scheduling_require_active_credit: boolean | null;
  portal_self_scheduling_requires_payment_method: boolean | null;
  portal_bookable_lesson_types: string[] | null;
  portal_bookable_instructor_ids: string[] | null;
};
type AppointmentRow = {
  id: string;
  studio_id: string;
  client_id: string | null;
  instructor_id: string | null;
  room_id: string | null;
  appointment_type: string;
  status: string;
  starts_at: string;
  ends_at: string;
};

function sameNullableId(left: string | null, right: string | null) {
  return (left || null) === (right || null);
}

function formatActionLabel(actionType: BookingActionPayload["actionType"]) {
  if (actionType === "reschedule") return "reschedule";
  if (actionType === "cancel") return "cancellation";
  return "booking";
}

function formatPushDateTime(value: string | null | undefined) {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function getResultAppointmentId(value: unknown) {
  if (!value || typeof value !== "object" || !("id" in value)) return null;

  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id : null;
}

async function sendSelfServiceSchedulePush(params: {
  userId: string;
  actionType: BookingActionPayload["actionType"];
  status: "submitted" | "executed";
  studioSlug: string;
  actionRequestId: string;
  appointmentId?: string | null;
  startsAt?: string | null;
}) {
  const actionLabel = formatActionLabel(params.actionType);
  const timeLabel = formatPushDateTime(params.startsAt);
  const executed = params.status === "executed";

  try {
    await sendMobilePushToUser({
      userId: params.userId,
      category: "schedule",
      title: executed
        ? `Schedule ${actionLabel} confirmed`
        : `Schedule ${actionLabel} request sent`,
      body: executed
        ? timeLabel
          ? `Your ${actionLabel} is confirmed for ${timeLabel}.`
          : `Your schedule ${actionLabel} is confirmed.`
        : timeLabel
          ? `Your ${actionLabel} request for ${timeLabel} was sent to the studio.`
          : `Your schedule ${actionLabel} request was sent to the studio.`,
      data: {
        source: `student_self_service_${params.actionType}_${params.status}`,
        studioSlug: params.studioSlug,
        actionRequestId: params.actionRequestId,
        appointmentId: params.appointmentId ?? null,
      },
    });
  } catch (pushError) {
    console.error(
      "Failed to send self-service schedule mobile push",
      pushError instanceof Error ? pushError.message : pushError
    );
  }
}

async function loadRequestContext(params: {
  client: SelfServiceExecutionClient;
  studioSlug: string;
  portalUserId: string;
}) {
  const { data: studio, error: studioError } = await params.client
    .from("studios")
    .select("id, slug")
    .eq("slug", params.studioSlug)
    .maybeSingle<StudioRow>();

  if (studioError || !studio) {
    throw new Error(studioError?.message ?? "Studio not found.");
  }

  const { data: client, error: clientError } = await params.client
    .from("clients")
    .select("id")
    .eq("studio_id", studio.id)
    .eq("portal_user_id", params.portalUserId)
    .maybeSingle<ClientRow>();

  if (clientError || !client) {
    throw new Error(clientError?.message ?? "Linked student profile not found.");
  }

  const { data: settings, error: settingsError } = await params.client
    .from("studio_settings")
    .select(`
      portal_self_scheduling_enabled,
      portal_self_scheduling_mode,
      portal_self_scheduling_reschedule_mode,
      portal_self_scheduling_cancellation_mode,
      portal_self_scheduling_window_days,
      portal_self_scheduling_min_notice_hours,
      portal_self_scheduling_cancellation_cutoff_hours,
      portal_self_scheduling_require_active_credit,
      portal_self_scheduling_requires_payment_method,
      portal_bookable_lesson_types,
      portal_bookable_instructor_ids
    `)
    .eq("studio_id", studio.id)
    .maybeSingle<SettingsRow>();

  if (settingsError || !settings) {
    throw new Error(settingsError?.message ?? "Self-service settings not found.");
  }

  return { studio, client, settings };
}

async function loadOwnedAppointment(params: {
  client: SelfServiceExecutionClient;
  studioId: string;
  clientId: string;
  appointmentId: string;
}) {
  const { data: appointment, error } = await params.client
    .from("appointments")
    .select(`
      id,
      studio_id,
      client_id,
      instructor_id,
      room_id,
      appointment_type,
      status,
      starts_at,
      ends_at
    `)
    .eq("id", params.appointmentId)
    .eq("studio_id", params.studioId)
    .eq("client_id", params.clientId)
    .maybeSingle<AppointmentRow>();

  if (error || !appointment) {
    throw new Error(error?.message ?? "Appointment not found.");
  }

  return appointment;
}

function validateUpcomingAppointment(
  appointment: AppointmentRow,
  settings: { portal_self_scheduling_cancellation_cutoff_hours: number | null }
) {
  if (!["scheduled", "rescheduled"].includes(appointment.status)) {
    throw new Error("Only upcoming scheduled appointments can be changed.");
  }

  const cutoffHours = Math.max(
    settings.portal_self_scheduling_cancellation_cutoff_hours ?? 24,
    0
  );
  const cutoff = new Date(Date.now() + cutoffHours * 60 * 60 * 1000);

  if (new Date(appointment.starts_at) < cutoff) {
    throw new Error(`Changes require at least ${cutoffHours} hours notice.`);
  }
}

async function executeInstantRequest(params: {
  client: SelfServiceExecutionClient;
  actionRequestId: string;
  studioId: string;
  actorUserId: string;
}) {
  const { data: executableRequest, error: executableRequestError } = await params.client
    .from("student_booking_action_requests")
    .select(`
      id,
      studio_id,
      client_id,
      action_type,
      mode,
      status,
      appointment_id,
      requested_starts_at,
      requested_ends_at,
      previous_starts_at,
      previous_ends_at,
      instructor_id,
      room_id,
      lesson_type,
      reason
    `)
    .eq("id", params.actionRequestId)
    .eq("studio_id", params.studioId)
    .single<StudentBookingActionRequestRow>();

  if (executableRequestError || !executableRequest) {
    throw new Error(
      executableRequestError?.message ?? "Could not load instant action request."
    );
  }

  return executeApprovedStudentBookingAction({
    supabase: params.client,
    actionRequest: executableRequest,
    actorUserId: params.actorUserId,
  });
}

export async function POST(request: Request) {
  const user = await getStudentApiUser(request);

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  let payload: BookingActionPayload;

  try {
    payload = (await request.json()) as BookingActionPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  if (!payload.studioSlug?.trim()) {
    return NextResponse.json({ error: "studioSlug is required." }, { status: 400 });
  }

  const actionType = payload.actionType ?? "book";

  if (!["book", "reschedule", "cancel"].includes(actionType)) {
    return NextResponse.json(
      { error: "Unsupported self-service action." },
      { status: 400 }
    );
  }

  if (actionType !== "cancel" && (!payload.startsAt || !payload.endsAt)) {
    return NextResponse.json(
      { error: "startsAt and endsAt are required." },
      { status: 400 }
    );
  }

  if (actionType !== "cancel" && !payload.instructorId?.trim()) {
    return NextResponse.json(
      { error: "Choose an instructor before requesting a lesson time." },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();
  const queryClient = supabase as unknown as SupabaseQueryClient;
  const actionClient = supabase as unknown as SupabaseLike;
  const executionClient = supabase as unknown as SelfServiceExecutionClient;
  const lessonType = payload.lessonType || "private_lesson";
  const requestedInstructorId = payload.instructorId || null;
  const requestedRoomId = payload.roomId || null;

  try {
    if (actionType === "cancel") {
      if (!payload.appointmentId) {
        return NextResponse.json({ error: "appointmentId is required." }, { status: 400 });
      }

      const context = await loadRequestContext({
        client: executionClient,
        studioSlug: payload.studioSlug,
        portalUserId: user.id,
      });
      const appointment = await loadOwnedAppointment({
        client: executionClient,
        studioId: context.studio.id,
        clientId: context.client.id,
        appointmentId: payload.appointmentId,
      });
      validateUpcomingAppointment(appointment, context.settings);

      const decision = canUseSelfServiceBooking({
        action: "cancel",
        eligibility: {
          hasLinkedClient: true,
          hasActiveCredit: true,
          hasPaymentMethod: true,
        },
        lessonType: appointment.appointment_type,
        settings: context.settings,
      });

      if (!decision.allowed || !decision.mode) {
        return NextResponse.json(
          { error: decision.reason ?? "Cancellation is not available." },
          { status: 400 }
        );
      }

      const actionRequest = await createStudentBookingActionRequest({
        supabase: actionClient,
        input: {
          studioId: context.studio.id,
          clientId: context.client.id,
          actionType: "cancel",
          mode: decision.mode,
          appointmentId: appointment.id,
          previousStartsAt: appointment.starts_at,
          previousEndsAt: appointment.ends_at,
          lessonType: appointment.appointment_type,
          reason: payload.reason ?? null,
          requestedByUserId: user.id,
          details: {
            source: "student_self_service_api",
            studioSlug: context.studio.slug,
          },
        },
      });

      if (actionRequest.shouldExecuteImmediately) {
        try {
          const appointmentResult = await executeInstantRequest({
            client: executionClient,
            actionRequestId: actionRequest.id,
            studioId: context.studio.id,
            actorUserId: user.id,
          });

          await sendSelfServiceSchedulePush({
            userId: user.id,
            actionType: "cancel",
            status: "executed",
            studioSlug: context.studio.slug,
            actionRequestId: actionRequest.id,
            appointmentId: appointment.id,
            startsAt: appointment.starts_at,
          });

          return NextResponse.json({
            actionRequest: { ...actionRequest, status: "executed" },
            appointment: appointmentResult,
            bookingDecision: decision,
          });
        } catch (instantError) {
          const failureReason =
            instantError instanceof Error
              ? instantError.message
              : "Cancellation could not be completed.";
          await executionClient
            .from("student_booking_action_requests")
            .update({
              status: "failed",
              failure_reason: failureReason,
              updated_at: new Date().toISOString(),
            })
            .eq("id", actionRequest.id)
            .eq("studio_id", context.studio.id);
          throw new Error(failureReason);
        }
      }

      await sendSelfServiceSchedulePush({
        userId: user.id,
        actionType: "cancel",
        status: "submitted",
        studioSlug: context.studio.slug,
        actionRequestId: actionRequest.id,
        appointmentId: appointment.id,
        startsAt: appointment.starts_at,
      });

      return NextResponse.json({ actionRequest, bookingDecision: decision });
    }

    const slotResult = await loadStudentSelfServiceSlots({
      supabase: queryClient,
      studioSlug: payload.studioSlug,
      portalUserId: user.id,
      lessonType,
      instructorId: requestedInstructorId,
      roomId: requestedRoomId,
      action: actionType,
    });

    if (!slotResult.bookingDecision.allowed || !slotResult.bookingDecision.mode) {
      return NextResponse.json(
        {
          error:
            slotResult.bookingDecision.reason ??
            "Self-service booking is not available.",
        },
        { status: 400 }
      );
    }

    const matchingSlot = slotResult.slots.find(
      (slot) =>
        slot.startsAt === payload.startsAt &&
        slot.endsAt === payload.endsAt &&
        sameNullableId(slot.instructorId, requestedInstructorId) &&
        sameNullableId(slot.roomId, requestedRoomId)
    );

    if (!matchingSlot) {
      return NextResponse.json(
        { error: "That slot is no longer available." },
        { status: 409 }
      );
    }

    let appointment: AppointmentRow | null = null;

    if (actionType === "reschedule") {
      if (!payload.appointmentId) {
        return NextResponse.json({ error: "appointmentId is required." }, { status: 400 });
      }

      appointment = await loadOwnedAppointment({
        client: executionClient,
        studioId: slotResult.studio.id,
        clientId: slotResult.client.id,
        appointmentId: payload.appointmentId,
      });
      validateUpcomingAppointment(appointment, slotResult.settings);
    }

    const actionRequest = await createStudentBookingActionRequest({
      supabase: actionClient,
      input: {
        studioId: slotResult.studio.id,
        clientId: slotResult.client.id,
        actionType,
        mode: slotResult.bookingDecision.mode,
        appointmentId: appointment?.id ?? null,
        requestedStartsAt: matchingSlot.startsAt,
        requestedEndsAt: matchingSlot.endsAt,
        requestedInstructorId: matchingSlot.instructorId,
        requestedRoomId: matchingSlot.roomId,
        previousStartsAt: appointment?.starts_at ?? null,
        previousEndsAt: appointment?.ends_at ?? null,
        lessonType,
        reason: payload.reason ?? null,
        requestedByUserId: user.id,
        details: {
          source: "student_self_service_api",
          studioSlug: slotResult.studio.slug,
        },
      },
    });

    if (actionRequest.shouldExecuteImmediately) {
      try {
        const appointmentResult = await executeInstantRequest({
          client: executionClient,
          actionRequestId: actionRequest.id,
          studioId: slotResult.studio.id,
          actorUserId: user.id,
        });

        await sendSelfServiceSchedulePush({
          userId: user.id,
          actionType,
          status: "executed",
          studioSlug: slotResult.studio.slug,
          actionRequestId: actionRequest.id,
          appointmentId: getResultAppointmentId(appointmentResult) ?? appointment?.id ?? null,
          startsAt: matchingSlot.startsAt,
        });

        return NextResponse.json({
          actionRequest: {
            ...actionRequest,
            status: "executed",
          },
          appointment: appointmentResult,
          bookingDecision: slotResult.bookingDecision,
        });
      } catch (instantError) {
        const failureReason =
          instantError instanceof Error
            ? instantError.message
            : "Instant booking could not be completed.";

        await executionClient
          .from("student_booking_action_requests")
          .update({
            status: "failed",
            failure_reason: failureReason,
            updated_at: new Date().toISOString(),
          })
          .eq("id", actionRequest.id)
          .eq("studio_id", slotResult.studio.id);

        throw new Error(failureReason);
      }
    }

    await sendSelfServiceSchedulePush({
      userId: user.id,
      actionType,
      status: "submitted",
      studioSlug: slotResult.studio.slug,
      actionRequestId: actionRequest.id,
      appointmentId: appointment?.id ?? null,
      startsAt: matchingSlot.startsAt,
    });

    return NextResponse.json({
      actionRequest,
      bookingDecision: slotResult.bookingDecision,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not submit self-service booking action.",
      },
      { status: 400 }
    );
  }
}
