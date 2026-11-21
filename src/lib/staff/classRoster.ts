import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyGroupClassEnrolled, notifyGroupClassRemovedByAttendee } from "@/lib/notifications/groupClassNotices";
import { classifyRosterEnrollError } from "@/lib/schedule/groupClassRosterPanel";

/**
 * Group-class roster drop-in enroll and removal for staff. Extracted from enrollClassAttendeeAction / cancelClassAttendeeAction in src/app/app/schedule/actions.ts so the
 * web actions and the staff API (POST/DELETE .../appointments/{id}/roster) run the same code.
 *
 * The write itself is the existing database RPCs enroll_class_attendee / cancel_class_attendee, called on the CALLER'S client (cookie client on the web, bearer client in
 * the API). The RPCs are SECURITY DEFINER and authorize inside the database (_gc1_4_class_enrollment_authority: broad studio staff, or the class's own instructor),
 * and own capacity, duplicate, cancelled-class and funding (package, membership, pay-as-you-go, comped) rules, with row locks. Nothing here uses the service role,
 * except the dancer notices, which the web action already sent through the notifications module (it reads with the service role by design); they never throw.
 */

export type EnrollClassAttendeeResult =
  | { ok: true; attendeeId: string | null; alreadyEnrolled: boolean }
  | { ok: false; reason: string };

export type CancelClassAttendeeResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: "attendee_attendance_recorded" | "attendee_not_authorized" | "attendee_cancel_failed" | "not_found" };

export async function enrollClassAttendee(params: {
  supabase: SupabaseClient;
  studioId: string;
  appointmentId: string;
  clientId: string;
  billingType?: string | null;
  clientPackageId?: string | null;
  clientMembershipId?: string | null;
  /** The API treats "already enrolled" as a replay of a request that succeeded; the web action keeps showing the refusal. */
  treatAlreadyEnrolledAsSuccess?: boolean;
}): Promise<EnrollClassAttendeeResult> {
  const { supabase, studioId, appointmentId, clientId } = params;
  const billingType = params.billingType ?? null;
  const clientPackageId = params.clientPackageId ?? null;
  const clientMembershipId = params.clientMembershipId ?? null;

  // billingType='membership' with no clientMembershipId is an unfunded state: reject before the RPC rather than let an incomplete selection reach the database.
  if (billingType === "membership" && !clientMembershipId) {
    return { ok: false, reason: "membership_requires_selection" };
  }

  // A replay of a request that already succeeded must not reach the RPC: its capacity / cancelled-class / funding checks count the dancer's own booked row or re-evaluate
  // entitlements, so a retry could answer class_full, class_cancelled or a funding refusal instead of the success. The read is the caller's (RLS), so it only ever
  // finds a row the caller may see. A replay carrying different funding fields returns the existing attendee unchanged (documented in the contract).
  if (params.treatAlreadyEnrolledAsSuccess) {
    const { data: existing } = await supabase
      .from("appointment_attendees")
      .select("id")
      .eq("studio_id", studioId)
      .eq("appointment_id", appointmentId)
      .eq("client_id", clientId)
      .eq("status", "booked")
      .maybeSingle<{ id: string }>();
    if (existing) return { ok: true, attendeeId: existing.id, alreadyEnrolled: true };
  }

  const { data: enrolledAttendeeId, error } = await supabase.rpc("enroll_class_attendee", {
    p_appointment_id: appointmentId,
    p_client_id: clientId,
    p_billing_type: billingType,
    p_client_package_id: clientPackageId,
    p_client_membership_id: clientMembershipId,
  });

  if (error) {
    const message = error.message ?? "";
    console.error("Could not enroll class attendee:", message);
    // Beyond the shared classifier: a missing class or a client of another studio is not_found; the integrity trigger's "Invalid roster enrollment." means the package or
    // membership given is not this dancer's (or not active), which the web page shows as the generic failure.
    const reason =
      message.includes("Group class not found") || message.includes("Client not found")
        ? "not_found"
        : message.includes("Invalid roster enrollment")
          ? "invalid_funding"
          : classifyRosterEnrollError(message);

    if (reason === "already_enrolled" && params.treatAlreadyEnrolledAsSuccess) {
      const { data: existing } = await supabase
        .from("appointment_attendees")
        .select("id")
        .eq("studio_id", studioId)
        .eq("appointment_id", appointmentId)
        .eq("client_id", clientId)
        .eq("status", "booked")
        .maybeSingle<{ id: string }>();
      if (existing) return { ok: true, attendeeId: existing.id, alreadyEnrolled: true };
    }
    return { ok: false, reason };
  }

  // After the enrollment has committed, confirm it to the dancer (email + push, no SMS). The attendee row id is the event identity, so a retried notice cannot send twice.
  // Never throws; the enrollment stands regardless.
  if (typeof enrolledAttendeeId === "string" && enrolledAttendeeId) {
    await notifyGroupClassEnrolled({
      studioId,
      clientId,
      appointmentIds: [appointmentId],
      eventId: enrolledAttendeeId,
      series: false,
    });
  }

  return { ok: true, attendeeId: typeof enrolledAttendeeId === "string" ? enrolledAttendeeId : null, alreadyEnrolled: false };
}

export async function cancelClassAttendee(params: {
  supabase: SupabaseClient;
  studioId: string;
  attendeeId: string;
}): Promise<CancelClassAttendeeResult> {
  const { supabase, studioId, attendeeId } = params;

  // Only a removal that actually changes a booked dancer notifies. cancel_class_attendee treats an already cancelled row as a successful no-op, so a stale or repeated
  // request must not produce a second "removed" notice. The status is read before the RPC, studio-scoped; unreadable = no notice.
  const { data: priorRow } = await supabase
    .from("appointment_attendees")
    .select("status")
    .eq("id", attendeeId)
    .eq("studio_id", studioId)
    .maybeSingle<{ status: string | null }>();
  const wasBooked = priorRow?.status === "booked";

  const { error } = await supabase.rpc("cancel_class_attendee", { p_attendee_id: attendeeId });

  if (error) {
    const message = String(error.message ?? "");
    console.error("Could not cancel class attendee:", message);
    // Removal of a dancer with recorded terminal attendance is refused by the database (GCSD1_ATTENDEE_ATTENDANCE_RECORDED).
    return {
      ok: false,
      reason: message.includes("GCSD1_ATTENDEE_ATTENDANCE_RECORDED")
        ? "attendee_attendance_recorded"
        : message.includes("Not authorized")
          ? "attendee_not_authorized"
          : message.includes("Enrollment not found")
            ? "not_found"
            : "attendee_cancel_failed",
    };
  }

  if (wasBooked) await notifyGroupClassRemovedByAttendee({ studioId, attendeeId });
  return { ok: true, changed: wasBooked };
}

/** Staff API form of removal: the roster the app shows lists dancers by client id, so the booked row is resolved here. Removing a dancer who is not enrolled is not_found. */
export async function cancelClassAttendeeForClient(params: {
  supabase: SupabaseClient;
  studioId: string;
  appointmentId: string;
  clientId: string;
}): Promise<CancelClassAttendeeResult | { ok: false; reason: "class_not_found" }> {
  const { supabase, studioId, appointmentId, clientId } = params;

  const { data: klass, error: classError } = await supabase
    .from("appointments")
    .select("id")
    .eq("id", appointmentId)
    .eq("studio_id", studioId)
    .eq("appointment_type", "group_class")
    .maybeSingle<{ id: string }>();
  if (classError) throw new Error(`Class lookup failed: ${classError.message}`);
  if (!klass) return { ok: false, reason: "class_not_found" };

  const { data: rows, error } = await supabase
    .from("appointment_attendees")
    .select("id, status")
    .eq("studio_id", studioId)
    .eq("appointment_id", appointmentId)
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Roster lookup failed: ${error.message}`);

  const booked = (rows ?? []).find((row: { status: string }) => row.status === "booked") as { id: string } | undefined;
  if (booked) return cancelClassAttendee({ supabase, studioId, attendeeId: booked.id });
  // Already removed: the same end state, nothing to do (a replay of a request that succeeded).
  if ((rows ?? []).length > 0) return { ok: true, changed: false };
  return { ok: false, reason: "not_found" };
}
