import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The single write path for one dancer's attendance on a class (attendance_records). Shared by the web attendance actions
 * (src/app/app/schedule/[id]/attendance/actions.ts) and the staff API, so both apply the same rules: the caller's own
 * user-scoped client (RLS applies), and the database guards and triggers on attendance_records (for example, the cancelled-class
 * guard GCSC2_CLASS_CANCELLED). Authorization of the caller to THIS class happens before this is called.
 * Extracted unchanged from the web actions file, which as a "use server" module can export only server actions.
 */

export type AttendanceStatus = "registered" | "checked_in" | "attended" | "no_show" | "cancelled";

export async function upsertAttendanceRecord(params: {
  supabase: SupabaseClient;
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
