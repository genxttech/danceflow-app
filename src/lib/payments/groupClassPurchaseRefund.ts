import type { SupabaseClient } from "@supabase/supabase-js";

/*
  GC-3.5-3 (locked refund behavior): what a LATER refund of a Group Class
  direct-payment purchase does to the enrollment it paid for.

  FULL refund    -> appointment_attendees.status 'cancelled' (cancelled_at set),
                    payment_status 'refunded'. The seat is released by the
                    existing capacity model (only 'booked' rows count). Rows
                    are kept; nothing is deleted.
  PARTIAL refund -> payment_status 'partial' (the canonical partial-refund
                    value, as event registrations use); status stays 'booked'
                    and the seat stays occupied. Never cancels.

  The enrollment is found only through the database's own binding: the
  CONVERTED purchase hold whose payment_id is this payment (its attendee_id).
  A checkout conflict payment has no attendee, so there is nothing to cancel.
  Payment-row status itself is reconciled by the caller ('refunded' when full,
  'paid' with refund_amount > 0 when partial -- DanceFlow's canonical statuses).

  One database rule is not overridden: a dancer whose attendance was already
  recorded (attended/no_show) cannot be removed from the class
  (GCSD1_ATTENDEE_ATTENDANCE_RECORDED). A full refund then marks the
  attendee's payment 'refunded' and keeps the enrollment and its attendance
  history; staff decide anything further.

  Idempotent and order-safe: re-applying the same outcome changes nothing; a
  late "partial" never downgrades an attendee already marked refunded or
  cancelled.
*/

/** payments.payment_type written by finalize_public_class_purchase (GC-3.5-2). */
export const GROUP_CLASS_PURCHASE_PAYMENT_TYPE = "group_class_direct_payment";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export type GroupClassRefundEffect =
  | "not_group_class_purchase"
  | "cancelled"
  | "partial"
  | "refunded_attendance_recorded"
  | "already_applied";

export async function applyGroupClassPurchaseRefundEffects(
  admin: Db,
  params: { paymentId: string; fullyRefunded: boolean },
): Promise<GroupClassRefundEffect> {
  const { data: hold, error: holdError } = await admin
    .from("group_class_enrollment_holds")
    .select("id, studio_id, attendee_id, status")
    .eq("payment_id", params.paymentId)
    .eq("status", "converted")
    .maybeSingle();
  if (holdError) throw new Error("gc35_refund_hold_lookup_failed");
  const binding = hold as { studio_id: string; attendee_id: string | null } | null;
  if (!binding?.attendee_id) return "not_group_class_purchase";

  const { data: attendeeRow, error: attendeeError } = await admin
    .from("appointment_attendees")
    .select("id, status, payment_status")
    .eq("id", binding.attendee_id)
    .eq("studio_id", binding.studio_id)
    .maybeSingle();
  if (attendeeError) throw new Error("gc35_refund_attendee_lookup_failed");
  const attendee = attendeeRow as { id: string; status: string; payment_status: string | null } | null;
  if (!attendee) return "not_group_class_purchase";

  if (!params.fullyRefunded) {
    // Partial: never cancels, never downgrades a refunded/cancelled enrollment.
    if (attendee.status !== "booked" || attendee.payment_status === "refunded" || attendee.payment_status === "partial") {
      return "already_applied";
    }
    const { error } = await admin
      .from("appointment_attendees")
      .update({ payment_status: "partial", updated_at: new Date().toISOString() })
      .eq("id", attendee.id)
      .eq("studio_id", binding.studio_id)
      .eq("status", "booked");
    if (error) throw new Error("gc35_refund_partial_update_failed");
    return "partial";
  }

  if (attendee.status === "cancelled") {
    if (attendee.payment_status === "refunded") return "already_applied";
    const { error } = await admin
      .from("appointment_attendees")
      .update({ payment_status: "refunded", updated_at: new Date().toISOString() })
      .eq("id", attendee.id)
      .eq("studio_id", binding.studio_id);
    if (error) throw new Error("gc35_refund_status_update_failed");
    return "cancelled";
  }

  const now = new Date().toISOString();
  const { error: cancelError } = await admin
    .from("appointment_attendees")
    .update({ status: "cancelled", cancelled_at: now, payment_status: "refunded", updated_at: now })
    .eq("id", attendee.id)
    .eq("studio_id", binding.studio_id)
    .eq("status", "booked");

  if (!cancelError) return "cancelled";

  if (/GCSD1_ATTENDEE_ATTENDANCE_RECORDED/.test(cancelError.message ?? "")) {
    // Attendance already recorded: keep the enrollment (database rule), record the refund on it.
    if (attendee.payment_status === "refunded") return "refunded_attendance_recorded";
    const { error } = await admin
      .from("appointment_attendees")
      .update({ payment_status: "refunded", updated_at: now })
      .eq("id", attendee.id)
      .eq("studio_id", binding.studio_id);
    if (error) throw new Error("gc35_refund_status_update_failed");
    return "refunded_attendance_recorded";
  }

  throw new Error("gc35_refund_cancel_failed");
}
