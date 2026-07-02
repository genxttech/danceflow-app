import type { SupabaseClient } from "@supabase/supabase-js";

type FulfillTerminalPaymentParams = {
  supabase: SupabaseClient;
  studioId: string;
  paymentId: string;
  sessionId: string;
  paymentIntentId: string;
  paidAt?: string;
};

export async function fulfillTerminalPayment({
  supabase,
  studioId,
  paymentId,
  sessionId,
  paymentIntentId,
  paidAt = new Date().toISOString(),
}: FulfillTerminalPaymentParams) {
  const { data: payment, error: paymentLookupError } = await supabase
    .from("payments")
    .select("id, studio_id, client_package_id, payment_type, external_reference")
    .eq("id", paymentId)
    .eq("studio_id", studioId)
    .single();

  if (paymentLookupError || !payment) {
    throw new Error(
      `Terminal payment fulfillment failed: ${paymentLookupError?.message ?? "payment not found"}`,
    );
  }

  const { error } = await supabase
    .from("payments")
    .update({
      status: "paid",
      paid_at: paidAt,
      payment_method: "card",
      source: "stripe",
      payment_channel: "terminal",
      terminal_payment_session_id: sessionId,
      stripe_payment_intent_id: paymentIntentId,
    })
    .eq("id", paymentId)
    .eq("studio_id", studioId)
    .neq("status", "paid");

  if (error) {
    throw new Error(`Terminal payment fulfillment failed: ${error.message}`);
  }

  if (payment.client_package_id) {
    const { error: packageError } = await supabase
      .from("client_packages")
      .update({ active: true })
      .eq("id", payment.client_package_id)
      .eq("studio_id", studioId);

    if (packageError) {
      throw new Error(
        `Terminal payment package fulfillment failed: ${packageError.message}`,
      );
    }
  }

  if (
    payment.external_reference &&
    payment.payment_type === "pay_as_you_go_lesson"
  ) {
    const { error: appointmentError } = await supabase
      .from("appointments")
      .update({ payment_status: "paid" })
      .eq("id", payment.external_reference)
      .eq("studio_id", studioId);

    if (appointmentError) {
      throw new Error(
        `Terminal payment lesson fulfillment failed: ${appointmentError.message}`,
      );
    }
  }

  return true;
}
