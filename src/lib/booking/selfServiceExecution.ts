import type { SupabaseClient } from "@supabase/supabase-js";

import { appendStudentBookingActionAuditEvent } from "@/lib/booking/selfServiceActionRequests";
import {
  resolveEntitlementForBooking,
  resolveEntitlementForReschedule,
  type EntitlementResolutionOutcome,
} from "@/lib/booking/entitlementResolution";
import { detectAppointmentConflicts } from "@/lib/schedule/conflicts";

/**
 * Every real caller passes a genuine `createAdminClient()` /
 * session-scoped `SupabaseClient` here (see
 * `src/app/api/student/self-service/actions/route.ts`,
 * `src/app/api/student/self-service/requests/route.ts`, and
 * `src/app/app/schedule/self-service/actions.ts`, all of which cast into
 * this type via `as unknown as SelfServiceExecutionClient`). Typed
 * against the real client (rather than a narrow hand-rolled structural
 * subset) so the shared entitlement resolver -- itself typed against
 * `SupabaseClient` to match `validateMembershipEntitlement`'s existing
 * signature -- can be called directly without further casts.
 */
export type SelfServiceExecutionClient = SupabaseClient;

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

/**
 * Safe, non-technical text for each fail-closed entitlement outcome --
 * never forwards internal outcome identifiers or any DB error text.
 */
function entitlementFailureMessage(
  outcome: Exclude<EntitlementResolutionOutcome, { outcome: "resolved" }>,
): string {
  switch (outcome.outcome) {
    case "no_eligible_entitlement":
      return "This booking requires an active package or membership with remaining credit. Please contact the studio to book this appointment.";
    case "multiple_eligible_packages":
      return "More than one package on file could cover this booking. Please contact the studio so staff can confirm which one to use.";
    case "ambiguous_entitlement_type":
      return "Both a package and a membership on file could cover this booking. Please contact the studio so staff can confirm how to bill it.";
    case "lookup_failed":
      return "We couldn't verify your booking eligibility right now. Please try again shortly.";
  }
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

  const appointmentType = request.lesson_type ?? "private_lesson";
  const isReschedule = request.action_type === "reschedule" && !!request.appointment_id;

  let entitlement: EntitlementResolutionOutcome;

  if (isReschedule) {
    const { data: existingAppointment, error: existingAppointmentError } = await params.supabase
      .from("appointments")
      .select("billing_type, client_package_id, client_membership_id")
      .eq("id", request.appointment_id as string)
      .eq("studio_id", request.studio_id)
      .eq("client_id", request.client_id)
      .maybeSingle<{
        billing_type: string | null;
        client_package_id: string | null;
        client_membership_id: string | null;
      }>();

    if (existingAppointmentError) {
      throw new Error("We couldn't verify your booking eligibility right now. Please try again shortly.");
    }

    entitlement = await resolveEntitlementForReschedule({
      supabase: params.supabase,
      studioId: request.studio_id,
      clientId: request.client_id,
      appointmentType,
      newAppointmentDateIso: request.requested_starts_at,
      existingBillingType: existingAppointment?.billing_type ?? null,
      existingClientPackageId: existingAppointment?.client_package_id ?? null,
      existingClientMembershipId: existingAppointment?.client_membership_id ?? null,
      excludeAppointmentId: request.appointment_id,
    });
  } else {
    entitlement = await resolveEntitlementForBooking({
      supabase: params.supabase,
      studioId: request.studio_id,
      clientId: request.client_id,
      appointmentType,
      appointmentDateIso: request.requested_starts_at,
    });
  }

  if (entitlement.outcome !== "resolved") {
    throw new Error(entitlementFailureMessage(entitlement));
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

  const appointmentMutation = isReschedule
    ? params.supabase
        .from("appointments")
        .update({
          instructor_id: request.instructor_id,
          room_id: request.room_id,
          starts_at: request.requested_starts_at,
          ends_at: request.requested_ends_at,
          status: "scheduled",
          billing_type: entitlement.billingType,
          client_package_id: entitlement.clientPackageId,
          client_membership_id: entitlement.clientMembershipId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", request.appointment_id as string)
        .eq("studio_id", request.studio_id)
        .eq("client_id", request.client_id)
    : params.supabase.from("appointments").insert({
        studio_id: request.studio_id,
        client_id: request.client_id,
        instructor_id: request.instructor_id,
        room_id: request.room_id,
        appointment_type: appointmentType,
        title: "Self-Service Booking",
        notes: request.reason ? `Student note: ${request.reason}` : null,
        starts_at: request.requested_starts_at,
        ends_at: request.requested_ends_at,
        status: "scheduled",
        is_recurring: false,
        billing_type: entitlement.billingType,
        client_package_id: entitlement.clientPackageId,
        client_membership_id: entitlement.clientMembershipId,
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
