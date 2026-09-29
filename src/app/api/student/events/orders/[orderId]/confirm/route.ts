import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient, SupabaseClient } from "@supabase/supabase-js";
import { getStudentApiUser, normalizeStudentApiUuid, sameStudentEmail } from "@/lib/auth/studentApiAuth";

/**
 * PAY-DC-2D (M4): read-only order confirmation status for the student app.
 *
 * The Stripe-signed payment_intent.succeeded webhook (bound to the order's
 * stored PaymentIntent and the owning studio's connected account) is the only
 * fulfiller. This route never contacts Stripe and never writes: it reports the
 * order state already persisted by the webhook to the signed-in buyer.
 */

type Params = {
  params: Promise<{ orderId: string }>;
};

type EventOrderRow = {
  id: string;
  buyer_email: string | null;
  payment_status: string | null;
  status: string | null;
};

function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Missing Supabase admin environment variables.");
  }

  return createSupabaseClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest, { params }: Params) {
  const { orderId } = await params;
  const normalizedOrderId = normalizeStudentApiUuid(orderId);

  if (!normalizedOrderId) {
    return jsonError("Event order was not found.", 404);
  }

  const user = await getStudentApiUser(request);

  if (!user?.email) {
    return jsonError("Sign in to confirm this event order.", 401);
  }

  const supabase = getSupabaseAdmin();

  const { data: order, error: orderError } = await supabase
    .from("event_orders")
    .select("id, buyer_email, payment_status, status")
    .eq("id", normalizedOrderId)
    .maybeSingle();

  if (orderError) {
    return jsonError("Event order could not be loaded.", 500);
  }

  const orderRow = order as unknown as EventOrderRow | null;
  const buyerEmail = orderRow?.buyer_email?.trim().toLowerCase();

  if (!orderRow || !sameStudentEmail(user, buyerEmail)) {
    return jsonError("Event order was not found.", 404);
  }

  const confirmed = orderRow.payment_status === "paid" && orderRow.status === "confirmed";

  let registrationIds: string[] = [];

  if (confirmed) {
    const { data: registrations, error: registrationsError } = await supabase
      .from("event_registrations")
      .select("id")
      .eq("order_id", orderRow.id);

    if (registrationsError) {
      return jsonError("Event order could not be loaded.", 500);
    }

    registrationIds = ((registrations ?? []) as Array<{ id: string }>).map((row) => row.id);
  }

  return NextResponse.json({
    confirmed,
    orderId: orderRow.id,
    registrationIds,
  });
}
