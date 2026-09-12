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
  /**
   * Membership Usage-Period Alignment, Phase 2: which real authorization
   * context is executing this action.
   * - "student": a genuine student/guardian self-service action, reached
   *   only when the studio's self-service mode is already `instant` (the
   *   caller decided to execute immediately rather than queue for
   *   approval, before this function was ever called). The membership-
   *   funded branch below routes through the `_self_service` RPCs, whose
   *   own auth.uid()-based checks require `entitlementClient`.
   * - "staff_on_behalf": staff approving a request (own-instructor or
   *   broad role, already authorized by the caller before this function
   *   runs). The membership-funded branch routes through the plain staff
   *   RPCs, which have no self-service-mode gate -- correct, since these
   *   approvals are not required to be in `instant` mode.
   */
  callerContext: "student" | "staff_on_behalf";
  /**
   * Required when callerContext === "student": a request-scoped client
   * built via createStudentApiUserScopedClient(request), used ONLY for
   * the entitlement-mutating RPC call so auth.uid() resolves to the real
   * student inside it. Every other read/write on this action continues to
   * use `supabase` (the admin client) unchanged.
   */
  entitlementClient?: SelfServiceExecutionClient;
}) {
  const request = params.actionRequest;

  if (request.status !== "pending" && request.status !== "approved") {
    throw new Error("This self-service action has already been reviewed.");
  }

  if (!request.client_id) throw new Error("Missing client.");

  if (request.action_type === "cancel") {
    if (!request.appointment_id) throw new Error("Missing appointment.");

    // Product decision (Membership Usage-Period Alignment, terminal
    // attendance lifecycle): attended/no_show are terminal, delivered/
    // completed outcomes for private_lesson/intro_lesson/coaching.
    // Ordinary self-service cancellation must not be usable to silently
    // reverse a recorded attendance outcome. Correcting one belongs in a
    // future, explicit Attendance Correction / Reversal workflow.
    // Backstopped at the DB level by
    // enforce_private_lesson_attendance_lifecycle (P6e).
    const { data: targetAppointment, error: targetLookupError } =
      await params.supabase
        .from("appointments")
        .select("appointment_type, status")
        .eq("id", request.appointment_id)
        .eq("studio_id", request.studio_id)
        .eq("client_id", request.client_id)
        .single<{ appointment_type: string; status: string }>();

    if (targetLookupError || !targetAppointment) {
      throw new Error("Appointment not found.");
    }
    if (
      ["private_lesson", "intro_lesson", "coaching"].includes(
        targetAppointment.appointment_type,
      ) &&
      (targetAppointment.status === "attended" ||
        targetAppointment.status === "no_show")
    ) {
      throw new Error(
        "Attended lessons cannot be cancelled. Attendance corrections require a separate correction workflow.",
      );
    }

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

  let appointment: { id: string };

  if (entitlement.billingType === "membership") {
    // Membership Usage-Period Alignment, Phase 2: membership-funded
    // lesson writes are atomic (scheduling-resource lock, membership
    // lock, capacity recheck, insert/update, all inside one RPC) instead
    // of the generic non-atomic insert/update below. Package/PAYG/free
    // outcomes are completely untouched -- see the `else` branch.
    if (params.callerContext === "student") {
      if (!params.entitlementClient) {
        throw new Error(
          "Missing entitlement-scoped client for a student membership-funded booking.",
        );
      }

      if (isReschedule) {
        const { error } = await params.entitlementClient.rpc(
          "update_private_lesson_membership_appointment_self_service",
          {
            p_appointment_id: request.appointment_id as string,
            p_new_starts_at: request.requested_starts_at,
            p_new_ends_at: request.requested_ends_at,
            p_new_client_membership_id: entitlement.clientMembershipId,
            p_new_instructor_id: request.instructor_id,
            p_new_room_id: request.room_id,
          },
        );
        if (error) throw new Error(error.message);
        appointment = { id: request.appointment_id as string };
      } else {
        const { data, error } = await params.entitlementClient.rpc(
          "create_private_lesson_membership_appointment_self_service",
          {
            p_studio_id: request.studio_id,
            p_client_id: request.client_id as string,
            p_client_membership_id: entitlement.clientMembershipId,
            p_instructor_id: request.instructor_id,
            p_room_id: request.room_id,
            p_appointment_type: appointmentType,
            p_starts_at: request.requested_starts_at,
            p_ends_at: request.requested_ends_at,
          },
        );
        if (error || !data) throw new Error(error?.message ?? "Could not create appointment.");
        appointment = { id: data as string };

        // Parity fix: the narrow student RPC deliberately has no
        // p_notes/p_created_by parameter (it must not be widened to
        // accept arbitrary caller-supplied text) but the pre-cutover raw
        // insert always persisted the derived "Student note: <reason>"
        // and created_by. Both are non-financial, non-scheduling
        // metadata -- patched here, AFTER the atomic RPC has already
        // committed the reservation, via the trusted admin/staff client.
        // A failure here can never corrupt membership/scheduling
        // atomicity, only leave this metadata blank -- logged, not
        // rethrown, so the already-successful booking is still reported
        // as a success.
        const { error: metadataError } = await params.supabase
          .from("appointments")
          .update({
            notes: request.reason ? `Student note: ${request.reason}` : null,
            created_by: params.actorUserId,
          })
          .eq("id", appointment.id);
        if (metadataError) {
          console.error(
            "Could not persist self-service booking metadata (notes/created_by):",
            metadataError.message,
          );
        }
      }
    } else {
      // staff_on_behalf: the plain staff RPCs, no self-service-mode gate.
      if (isReschedule) {
        const { error } = await params.supabase.rpc(
          "update_private_lesson_membership_appointment",
          {
            p_appointment_id: request.appointment_id as string,
            p_new_client_id: request.client_id,
            p_new_appointment_type: appointmentType,
            p_new_starts_at: request.requested_starts_at,
            p_new_ends_at: request.requested_ends_at,
            p_new_billing_type: entitlement.billingType,
            p_new_client_membership_id: entitlement.clientMembershipId,
            p_new_instructor_id: request.instructor_id,
            p_new_room_id: request.room_id,
            p_new_status: "scheduled",
          },
        );
        if (error) throw new Error(error.message);
        appointment = { id: request.appointment_id as string };
      } else {
        const { data, error } = await params.supabase.rpc(
          "create_private_lesson_membership_appointment",
          {
            p_studio_id: request.studio_id,
            p_client_id: request.client_id as string,
            p_client_membership_id: entitlement.clientMembershipId,
            p_instructor_id: request.instructor_id,
            p_room_id: request.room_id,
            p_appointment_type: appointmentType,
            p_title: "Self-Service Booking",
            p_starts_at: request.requested_starts_at,
            p_ends_at: request.requested_ends_at,
            p_notes: request.reason ? `Student note: ${request.reason}` : null,
          },
        );
        if (error || !data) throw new Error(error?.message ?? "Could not create appointment.");
        appointment = { id: data as string };

        // Parity fix: the staff RPC's shared core does not set
        // created_by (it has no such parameter) but the pre-cutover raw
        // insert always did. Non-financial, non-scheduling metadata --
        // patched after the atomic RPC has already committed, logged
        // rather than rethrown on failure.
        const { error: metadataError } = await params.supabase
          .from("appointments")
          .update({ created_by: params.actorUserId })
          .eq("id", appointment.id);
        if (metadataError) {
          console.error(
            "Could not persist self-service booking metadata (created_by):",
            metadataError.message,
          );
        }
      }
    }
  } else {
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

    const { data: mutatedAppointment, error: appointmentError } = await appointmentMutation
      .select("id")
      .single<{ id: string }>();

    if (appointmentError || !mutatedAppointment) {
      throw new Error(appointmentError?.message ?? "Could not create appointment.");
    }

    appointment = mutatedAppointment;
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
