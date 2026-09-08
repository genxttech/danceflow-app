"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { requireAppointmentRelationshipAccess } from "@/lib/auth/appointmentAccess";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

// FC-1B5D2c-0A: replaces the old getStudioContext()+validateAppointmentAccess()
// pair, which authorized purely on "does the caller have any active
// user_studio_roles row at this studio" -- no relationship to THIS
// appointment at all, so any active-role studio member (including an
// unassigned instructor) could mark attendance on any class. This now
// reuses the same relationship-authorization primitive D2A/D2C already
// established for `appointments` itself: platform_admin/studio_owner/
// studio_admin/front_desk remain broad (front_desk retains full
// operational attendance authority for any class, per product decision);
// an instructor is authorized only for a class currently assigned to
// them (own-instructor scope) -- there is no implicit substitute/
// covering-instructor allowance. If that workflow is ever needed it must
// be added explicitly, not inferred from studio membership.
//
// Blocking-review correction: a floor-rental relationship alone
// (own-floor-rental scope) must NOT authorize attendance actions. Product
// decision explicitly denies "independent instructor whose only
// relationship is floor rental/client portal" here -- and independently,
// there is no legitimate attendance workflow for a floor_space_rental
// appointment at all (its own attended/no_show status is tracked directly
// on appointments.status via markAppointmentAttendedAction, never via
// attendance_records). requireAppointmentRelationshipAccess is a generic
// appointment-relationship primitive and correctly has no opinion on this
// -- the exclusion belongs here, at the call site, matching the same
// pattern recap-actions.ts and page.tsx already use.
async function requireAttendanceAccess(appointmentId: string) {
  const supabase = await createClient();
  const { studioId, studioRole, isPlatformAdmin, userId } =
    await getCurrentStudioContext();

  const result = await requireAppointmentRelationshipAccess({
    supabase,
    studioId,
    studioRole,
    isPlatformAdmin,
    userId,
    appointmentId,
    select: "title, appointment_type",
  });

  if (!result.ok) {
    throw new Error(result.reason);
  }

  if (result.scope === "own-floor-rental") {
    throw new Error(
      "You can only manage your own assigned appointments or your own floor space rental bookings.",
    );
  }

  return { supabase, studioId, userId, appointment: result.appointment };
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
    const { supabase, studioId, userId } = await requireAttendanceAccess(appointmentId);

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
    const { supabase, studioId, userId } = await requireAttendanceAccess(appointmentId);

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
    const { supabase, studioId, userId } = await requireAttendanceAccess(appointmentId);

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
    const { supabase, studioId, userId } = await requireAttendanceAccess(appointmentId);

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