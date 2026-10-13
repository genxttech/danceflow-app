"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { createClient } from "@/lib/supabase/server";

/**
 * PAY-WH-1A -- staff handling of payment exceptions. Authorization is enforced by the database functions
 * (acknowledge_/resolve_event_order_settlement_exception: event managers and platform admins only); these actions never
 * move money, issue tickets or touch the order.
 */

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function back(eventId: string, query: string) {
  return `/app/events/${encodeURIComponent(eventId)}/registrations?${query}#payment-exceptions`;
}

async function runExceptionRpc(formData: FormData, fn: "acknowledge_event_order_settlement_exception" | "resolve_event_order_settlement_exception") {
  const eventId = text(formData, "eventId");
  const exceptionId = text(formData, "exceptionId");
  const note = text(formData, "note");
  if (!eventId || !exceptionId) redirect("/app/events");
  if (fn === "resolve_event_order_settlement_exception" && !note) {
    redirect(back(eventId, "error=payment_exception_note_required"));
  }
  const success = fn === "acknowledge_event_order_settlement_exception" ? "payment_exception_acknowledged" : "payment_exception_resolved";
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc(fn, { p_exception_id: exceptionId, p_note: note || null });
    if (error) {
      redirect(back(eventId, error.code === "42501" ? "error=payment_exception_not_authorized" : "error=payment_exception_update_failed"));
    }
    if (data !== true) redirect(back(eventId, "error=payment_exception_already_handled"));
    revalidatePath(`/app/events/${eventId}/registrations`);
    redirect(back(eventId, `success=${success}`));
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirect(back(eventId, "error=payment_exception_update_failed"));
  }
}

export async function acknowledgePaymentExceptionAction(formData: FormData) {
  await runExceptionRpc(formData, "acknowledge_event_order_settlement_exception");
}

export async function resolvePaymentExceptionAction(formData: FormData) {
  await runExceptionRpc(formData, "resolve_event_order_settlement_exception");
}
