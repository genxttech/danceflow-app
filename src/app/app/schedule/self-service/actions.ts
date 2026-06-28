"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAppointmentCreateAccess } from "@/lib/auth/serverRoleGuard";
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

export async function approveStudentBookingActionRequest(formData: FormData) {
  const actionRequestId = getString(formData, "actionRequestId");

  if (!actionRequestId) {
    redirect("/app/schedule/self-service?error=missing_request");
  }

  try {
    const { supabase, studioId, user } = await requireAppointmentCreateAccess();
    const actionRequest = await loadActionRequest({
      supabase,
      studioId,
      actionRequestId,
    });

    await executeApprovedStudentBookingAction({
      supabase: supabase as unknown as SelfServiceExecutionClient,
      actionRequest,
      actorUserId: user.id,
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
    const { supabase, studioId, user } = await requireAppointmentCreateAccess();
    const actionRequest = await loadActionRequest({
      supabase,
      studioId,
      actionRequestId,
    });

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
