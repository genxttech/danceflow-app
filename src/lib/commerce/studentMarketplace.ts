import { SupabaseClient } from "@supabase/supabase-js";

export async function finalizeStudentMarketplacePayment(input: {
  supabase: SupabaseClient;
  orderId: string;
  paymentIntentId: string;
  amount: number;
  currency: string;
}) {
  const { data, error } = await input.supabase.rpc(
    "commerce_finalize_student_digital_order",
    {
      p_order_id: input.orderId,
      p_stripe_payment_intent_id: input.paymentIntentId,
      p_amount: input.amount,
      p_currency: input.currency,
    },
  );

  if (error) {
    throw new Error(error.message);
  }

  return data as string;
}
