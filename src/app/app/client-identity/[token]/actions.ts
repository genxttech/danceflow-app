"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { normalizeOptionalUuid } from "@/lib/validation/forms";
import { normalizePublicToken } from "@/lib/security/tokens";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function safeClientIdentityReturnPath(value: string, token: string | null) {
  const fallback = token ? `/app/client-identity/${encodeURIComponent(token)}` : "/app";
  const path = value.trim() || fallback;

  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    return fallback;
  }

  return path;
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

type AttendanceStatus = "registered" | "checked_in" | "attended" | "no_show" | "cancelled";

async function upsertAttendanceRecord(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  appointmentId: string;
  clientId: string;
  userId: string | null;
  status: AttendanceStatus;
}) {
  const { supabase, studioId, appointmentId, clientId, userId, status } = params;
  const now = new Date().toISOString();

  const { data: existingAttendance, error: existingAttendanceError } = await supabase
    .from("attendance_records")
    .select("id, status, checked_in_at, marked_attended_at")
    .eq("appointment_id", appointmentId)
    .eq("client_id", clientId)
    .maybeSingle();

  if (existingAttendanceError) {
    throw new Error(existingAttendanceError.message);
  }

  if (
    existingAttendance?.status === "checked_in" ||
    existingAttendance?.status === "attended"
  ) {
    return "already_checked_in";
  }

  if (existingAttendance) {
    const { error: updateError } = await supabase
      .from("attendance_records")
      .update({
        status,
        checked_in_at: now,
        marked_attended_at: status === "attended" ? now : null,
      })
      .eq("id", existingAttendance.id);

    if (updateError) {
      throw new Error(updateError.message);
    }

    return "checked_in";
  }

  const { error: insertError } = await supabase.from("attendance_records").insert({
    studio_id: studioId,
    appointment_id: appointmentId,
    client_id: clientId,
    status,
    checked_in_at: now,
    marked_attended_at: status === "attended" ? now : null,
    created_by: userId,
  });

  if (insertError) {
    throw new Error(insertError.message);
  }

  return "checked_in";
}

export async function checkInClientIdentityAppointmentAction(formData: FormData) {
  const appointmentIdResult = normalizeOptionalUuid(getString(formData, "appointmentId"), "Appointment");
  const clientIdResult = normalizeOptionalUuid(getString(formData, "clientId"), "Client");
  const token = normalizePublicToken(getString(formData, "token"), {
    minLength: 16,
    maxLength: 128,
  });
  const returnTo = safeClientIdentityReturnPath(getString(formData, "returnTo"), token);

  if (!appointmentIdResult.ok || !appointmentIdResult.value || !clientIdResult.ok || !clientIdResult.value || !token) {
    redirect(appendQueryParam(returnTo, "error", "missing_checkin_context"));
  }

  const appointmentId = appointmentIdResult.value;
  const clientId = clientIdResult.value;

  try {
    const supabase = await createClient();
    const { studioId, userId } = await getCurrentStudioContext();

    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("id, studio_id, client_qr_token")
      .eq("id", clientId)
      .eq("studio_id", studioId)
      .eq("client_qr_token", token)
      .maybeSingle();

    if (clientError || !client) {
      throw new Error("Client QR identity could not be verified.");
    }

    const { data: appointment, error: appointmentError } = await supabase
      .from("appointments")
      .select("id, studio_id, client_id, appointment_type, status")
      .eq("id", appointmentId)
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .maybeSingle();

    if (appointmentError || !appointment) {
      throw new Error("Appointment not found for this client.");
    }

    if (appointment.status === "cancelled") {
      redirect(appendQueryParam(returnTo, "error", "appointment_cancelled"));
    }

    const result = await upsertAttendanceRecord({
      supabase,
      studioId,
      appointmentId,
      clientId,
      userId,
      status: "checked_in",
    });

    redirect(appendQueryParam(returnTo, "success", result));
  } catch (error) {
    console.error("Client QR check-in failed", error);
    redirect(appendQueryParam(returnTo, "error", "checkin_failed"));
  }
}
