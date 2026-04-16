"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function getStudioContext() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: roleRow, error: roleError } = await supabase
    .from("user_studio_roles")
    .select("studio_id")
    .eq("user_id", user.id)
    .eq("active", true)
    .limit(1)
    .single();

  if (roleError || !roleRow) {
    redirect("/login");
  }

  return {
    supabase,
    studioId: roleRow.studio_id as string,
    userId: user.id,
  };
}

async function validateAppointmentAccess(appointmentId: string, studioId: string) {
  const supabase = await createClient();

  const { data: appointment, error } = await supabase
    .from("appointments")
    .select("id, studio_id, title, appointment_type")
    .eq("id", appointmentId)
    .eq("studio_id", studioId)
    .single();

  if (error || !appointment) {
    throw new Error("Appointment not found.");
  }

  return appointment;
}

function buildReturnUrl(appointmentId: string, suffix?: string) {
  const base = `/app/schedule/${appointmentId}/attendance`;
  return suffix ? `${base}?${suffix}` : base;
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

function getActionReturnTo(formData: FormData, appointmentId: string) {
  return getString(formData, "returnTo") || buildReturnUrl(appointmentId);
}

type AttendanceStatus = "registered" | "checked_in" | "attended" | "no_show" | "cancelled";

async function upsertAttendanceRecord(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  appointmentId: string;
  clientId: string;
  createdBy: string | null;
  status: AttendanceStatus;
  checkedInAt?: string | null;
  markedAttendedAt?: string | null;
  notes?: string | null;
}) {
  const {
    supabase,
    studioId,
    appointmentId,
    clientId,
    createdBy,
    status,
    checkedInAt = null,
    markedAttendedAt = null,
    notes = null,
  } = params;

  const { data: existingAttendance, error: existingAttendanceError } = await supabase
    .from("attendance_records")
    .select("id")
    .eq("appointment_id", appointmentId)
    .eq("client_id", clientId)
    .maybeSingle();

  if (existingAttendanceError) {
    throw new Error(existingAttendanceError.message);
  }

  if (existingAttendance) {
    const { error: updateError } = await supabase
      .from("attendance_records")
      .update({
        status,
        checked_in_at: checkedInAt,
        marked_attended_at: markedAttendedAt,
        notes,
      })
      .eq("id", existingAttendance.id);

    if (updateError) {
      throw new Error(updateError.message);
    }

    return;
  }

  const { error: insertError } = await supabase.from("attendance_records").insert({
    studio_id: studioId,
    appointment_id: appointmentId,
    client_id: clientId,
    status,
    checked_in_at: checkedInAt,
    marked_attended_at: markedAttendedAt,
    notes,
    created_by: createdBy,
  });

  if (insertError) {
    throw new Error(insertError.message);
  }
}

export async function checkInClassAttendeeAction(formData: FormData) {
  const appointmentId = getString(formData, "appointmentId");
  const clientId = getString(formData, "clientId");
  const returnTo = getActionReturnTo(formData, appointmentId);

  if (!appointmentId || !clientId) {
    redirect("/app/schedule");
  }

  try {
    const { supabase, studioId, userId } = await getStudioContext();
    await validateAppointmentAccess(appointmentId, studioId);

    await upsertAttendanceRecord({
      supabase,
      studioId,
      appointmentId,
      clientId,
      createdBy: userId,
      status: "checked_in",
      checkedInAt: new Date().toISOString(),
      markedAttendedAt: null,
    });
  } catch {
    redirect(appendQueryParam(returnTo, "error", "checkin_failed"));
  }

  redirect(appendQueryParam(returnTo, "success", "checked_in"));
}

export async function markClassAttendedAction(formData: FormData) {
  const appointmentId = getString(formData, "appointmentId");
  const clientId = getString(formData, "clientId");
  const returnTo = getActionReturnTo(formData, appointmentId);

  if (!appointmentId || !clientId) {
    redirect("/app/schedule");
  }

  try {
    const { supabase, studioId, userId } = await getStudioContext();
    await validateAppointmentAccess(appointmentId, studioId);

    const now = new Date().toISOString();

    await upsertAttendanceRecord({
      supabase,
      studioId,
      appointmentId,
      clientId,
      createdBy: userId,
      status: "attended",
      checkedInAt: now,
      markedAttendedAt: now,
    });
  } catch {
    redirect(appendQueryParam(returnTo, "error", "attended_failed"));
  }

  redirect(appendQueryParam(returnTo, "success", "attended"));
}

export async function markClassNoShowAction(formData: FormData) {
  const appointmentId = getString(formData, "appointmentId");
  const clientId = getString(formData, "clientId");
  const returnTo = getActionReturnTo(formData, appointmentId);

  if (!appointmentId || !clientId) {
    redirect("/app/schedule");
  }

  try {
    const { supabase, studioId, userId } = await getStudioContext();
    await validateAppointmentAccess(appointmentId, studioId);

    await upsertAttendanceRecord({
      supabase,
      studioId,
      appointmentId,
      clientId,
      createdBy: userId,
      status: "no_show",
      checkedInAt: null,
      markedAttendedAt: null,
    });
  } catch {
    redirect(appendQueryParam(returnTo, "error", "no_show_failed"));
  }

  redirect(appendQueryParam(returnTo, "success", "no_show"));
}

export async function resetClassAttendanceAction(formData: FormData) {
  const appointmentId = getString(formData, "appointmentId");
  const clientId = getString(formData, "clientId");
  const returnTo = getActionReturnTo(formData, appointmentId);

  if (!appointmentId || !clientId) {
    redirect("/app/schedule");
  }

  try {
    const { supabase, studioId, userId } = await getStudioContext();
    await validateAppointmentAccess(appointmentId, studioId);

    await upsertAttendanceRecord({
      supabase,
      studioId,
      appointmentId,
      clientId,
      createdBy: userId,
      status: "registered",
      checkedInAt: null,
      markedAttendedAt: null,
    });
  } catch {
    redirect(appendQueryParam(returnTo, "error", "reset_failed"));
  }

  redirect(appendQueryParam(returnTo, "success", "reset"));
}