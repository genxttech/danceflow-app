"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAppointmentCreateAccess } from "@/lib/auth/serverRoleGuard";
import { detectAppointmentConflicts } from "@/lib/schedule/conflicts";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getConflictErrorMessage(conflict: unknown) {
  if (!conflict) return "Scheduling conflict detected.";

  if (typeof conflict === "string") return conflict;

  if (typeof conflict === "object") {
    const value = conflict as {
      message?: string;
      error?: string;
      hasConflict?: boolean;
      roomConflict?: boolean;
      instructorConflict?: boolean;
      clientConflict?: boolean;
    };

    if (value.message) return value.message;
    if (value.error) return value.error;
    if (value.instructorConflict) {
      return "The selected instructor already has an appointment during that time.";
    }
    if (value.roomConflict) {
      return "There is a room conflict for the selected time.";
    }
    if (value.clientConflict) {
      return "The client already has an appointment during that time.";
    }
  }

  return "Scheduling conflict detected.";
}

type BookingRequestRow = {
  id: string;
  studio_id: string;
  client_id: string | null;
  instructor_id: string | null;
  room_id: string | null;
  appointment_type: string;
  title: string | null;
  requested_starts_at: string;
  requested_ends_at: string;
  notes: string | null;
  status: string;
};

export async function approveBookingRequestAction(formData: FormData) {
  const requestId = getString(formData, "requestId");
  const staffNote = getString(formData, "staffNote");

  if (!requestId) {
    redirect("/app/schedule/requests?error=missing_request");
  }

  const { supabase, studioId, user } = await requireAppointmentCreateAccess();

  const { data: request, error: requestError } = await supabase
    .from("booking_requests")
    .select(`
      id,
      studio_id,
      client_id,
      instructor_id,
      room_id,
      appointment_type,
      title,
      requested_starts_at,
      requested_ends_at,
      notes,
      status
    `)
    .eq("id", requestId)
    .eq("studio_id", studioId)
    .maybeSingle();

  if (requestError || !request) {
    redirect("/app/schedule/requests?error=request_not_found");
  }

  const typedRequest = request as BookingRequestRow;

  if (typedRequest.status !== "pending") {
    redirect("/app/schedule/requests?error=request_already_reviewed");
  }

  if (!typedRequest.client_id) {
    redirect("/app/schedule/requests?error=missing_client");
  }

  const conflict = await detectAppointmentConflicts({
    studioId,
    startsAt: typedRequest.requested_starts_at,
    endsAt: typedRequest.requested_ends_at,
    instructorId: typedRequest.instructor_id,
    roomId: typedRequest.room_id,
    clientId: typedRequest.client_id,
  });

  if ((conflict as { hasConflict?: boolean } | null)?.hasConflict) {
    redirect(
      `/app/schedule/requests?error=${encodeURIComponent(getConflictErrorMessage(conflict))}`,
    );
  }

  const appointmentNotes = [
    "Created from booking request.",
    typedRequest.notes,
    staffNote ? `Staff note: ${staffNote}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const { data: appointment, error: appointmentError } = await supabase
    .from("appointments")
    .insert({
      studio_id: studioId,
      client_id: typedRequest.client_id,
      instructor_id: typedRequest.instructor_id,
      room_id: typedRequest.room_id,
      appointment_type: typedRequest.appointment_type,
      title: typedRequest.title?.replace(" Request", "") || "Intro Lesson",
      notes: appointmentNotes || null,
      starts_at: typedRequest.requested_starts_at,
      ends_at: typedRequest.requested_ends_at,
      status: "scheduled",
      is_recurring: false,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (appointmentError || !appointment) {
    redirect(
      `/app/schedule/requests?error=${encodeURIComponent(
        appointmentError?.message ?? "Could not create appointment.",
      )}`,
    );
  }

  const { error: updateError } = await supabase
    .from("booking_requests")
    .update({
      status: "approved",
      appointment_id: appointment.id,
      staff_note: staffNote || null,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", typedRequest.id)
    .eq("studio_id", studioId)
    .eq("status", "pending");

  if (updateError) {
    redirect(
      `/app/schedule/requests?error=${encodeURIComponent(
        `Appointment was created, but request update failed: ${updateError.message}`,
      )}`,
    );
  }

  await supabase.from("notifications").insert({
    studio_id: studioId,
    type: "booking_request_approved",
    title: "Booking request approved",
    body: "A booking request was approved and converted to an appointment.",
    client_id: typedRequest.client_id,
    appointment_id: appointment.id,
  });

  revalidatePath("/app/schedule/requests");
  revalidatePath("/app/schedule");
  revalidatePath("/app");

  redirect("/app/schedule/requests?success=approved");
}

export async function declineBookingRequestAction(formData: FormData) {
  const requestId = getString(formData, "requestId");
  const staffNote = getString(formData, "staffNote");

  if (!requestId) {
    redirect("/app/schedule/requests?error=missing_request");
  }

  const { supabase, studioId, user } = await requireAppointmentCreateAccess();

  const { data: request, error: requestError } = await supabase
    .from("booking_requests")
    .select("id, studio_id, status")
    .eq("id", requestId)
    .eq("studio_id", studioId)
    .maybeSingle();

  if (requestError || !request) {
    redirect("/app/schedule/requests?error=request_not_found");
  }

  if ((request as { status: string }).status !== "pending") {
    redirect("/app/schedule/requests?error=request_already_reviewed");
  }

  const { error: updateError } = await supabase
    .from("booking_requests")
    .update({
      status: "declined",
      staff_note: staffNote || null,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", requestId)
    .eq("studio_id", studioId)
    .eq("status", "pending");

  if (updateError) {
    redirect(
      `/app/schedule/requests?error=${encodeURIComponent(updateError.message)}`,
    );
  }

  revalidatePath("/app/schedule/requests");
  revalidatePath("/app/schedule");
  revalidatePath("/app");

  redirect("/app/schedule/requests?success=declined");
}
