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
  const { data, error } = await supabase.rpc("fulfill_terminal_payment", {
    p_studio_id: studioId,
    p_payment_id: paymentId,
    p_session_id: sessionId,
    p_payment_intent_id: paymentIntentId,
    p_paid_at: paidAt,
  });

  if (error) {
    throw new Error(`Terminal payment fulfillment failed: ${error.message}`);
  }

  return data === true;
}
