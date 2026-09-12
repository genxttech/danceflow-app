"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAppointmentCreateAccess } from "@/lib/auth/serverRoleGuard";
import { resolveViewerInstructorId } from "@/lib/auth/instructorIdentity";
import {
  declineStudentBookingAction,
  executeApprovedStudentBookingAction,
  type SelfServiceExecutionClient,
  type StudentBookingActionRequestRow,
} from "@/lib/booking/selfServiceExecution";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function loadActionRequest(params: {
  supabase: Awaited<ReturnType<typeof requireAppointmentCreateAccess>>["supabase"];
  studioId: string;
  actionRequestId: string;
}) {
  const { data, error } = await params.supabase
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
    .maybeSingle<StudentBookingActionRequestRow>();

  if (error || !data) {
    throw new Error(error?.message ?? "Self-service action request not found.");
  }

  return data;
}

// FC-1B5D2 D2A: direct invocation of the approve/decline actions must not
// be able to bypass the page's queue filter -- an instructor may only act
// on a request currently tied to their own assignment. owner/admin/
// front_desk (and platform_admin) retain studio-wide triage, unchanged.
async function requireOwnActionRequestOrBroadRole(params: {
  supabase: Awaited<ReturnType<typeof requireAppointmentCreateAccess>>["supabase"];
  studioId: string;
  studioRole: string | null | undefined;
  isPlatformAdmin: boolean;
  userId: string;
  actionRequest: StudentBookingActionRequestRow;
}): Promise<string | null> {
  const { supabase, studioId, studioRole, isPlatformAdmin, userId, actionRequest } =
    params;

  if (isPlatformAdmin || studioRole !== "instructor") {
    return null;
  }

  const viewerInstructorId = await resolveViewerInstructorId(
    supabase,
    studioId,
    userId,
  );

  if (viewerInstructorId && actionRequest.instructor_id === viewerInstructorId) {
    return null;
  }

  return "You can only act on requests tied to your own appointments.";
}

export async function approveStudentBookingActionRequest(formData: FormData) {
  const actionRequestId = getString(formData, "actionRequestId");

  if (!actionRequestId) {
    redirect("/app/schedule/self-service?error=missing_request");
  }

  try {
    const { supabase, studioId, user, studioRole, isPlatformAdmin } =
      await requireAppointmentCreateAccess();
    const actionRequest = await loadActionRequest({
      supabase,
      studioId,
      actionRequestId,
    });

    const relationshipError = await requireOwnActionRequestOrBroadRole({
      supabase,
      studioId,
      studioRole,
      isPlatformAdmin,
      userId: user.id,
      actionRequest,
    });

    if (relationshipError) {
      throw new Error(relationshipError);
    }

    await executeApprovedStudentBookingAction({
      supabase: supabase as unknown as SelfServiceExecutionClient,
      actionRequest,
      actorUserId: user.id,
      // Staff approving a student's request on the student's behalf --
      // `supabase` here is already the genuine staff session client
      // (requireAppointmentCreateAccess), so the membership-funded branch
      // routes through the plain staff RPCs, not the self-service ones.
      callerContext: "staff_on_behalf",
    });

    revalidatePath("/app/schedule");
    revalidatePath("/app/schedule/self-service");
  } catch (error) {
    redirect(
      `/app/schedule/self-service?error=${encodeURIComponent(
        error instanceof Error ? error.message : "Could not approve request."
      )}`
    );
  }

  redirect("/app/schedule/self-service?success=approved");
}

export async function declineStudentBookingActionRequest(formData: FormData) {
  const actionRequestId = getString(formData, "actionRequestId");
  const reviewNote = getString(formData, "reviewNote");

  if (!actionRequestId) {
    redirect("/app/schedule/self-service?error=missing_request");
  }

  try {
    const { supabase, studioId, user, studioRole, isPlatformAdmin } =
      await requireAppointmentCreateAccess();
    const actionRequest = await loadActionRequest({
      supabase,
      studioId,
      actionRequestId,
    });

    const relationshipError = await requireOwnActionRequestOrBroadRole({
      supabase,
      studioId,
      studioRole,
      isPlatformAdmin,
      userId: user.id,
      actionRequest,
    });

    if (relationshipError) {
      throw new Error(relationshipError);
    }

    await declineStudentBookingAction({
      supabase: supabase as unknown as SelfServiceExecutionClient,
      actionRequest,
      actorUserId: user.id,
      reason: reviewNote || null,
    });

    revalidatePath("/app/schedule/self-service");
  } catch (error) {
    redirect(
      `/app/schedule/self-service?error=${encodeURIComponent(
        error instanceof Error ? error.message : "Could not decline request."
      )}`
    );
  }

  redirect("/app/schedule/self-service?success=declined");
}
