import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function canCollectTerminal(role: string | null | undefined, isPlatformAdmin: boolean) {
  if (isPlatformAdmin) return true;
  return ["studio_owner", "studio_admin", "front_desk"].includes(role ?? "");
}

async function getRequestJson(request: NextRequest) {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function POST(request: NextRequest) {
  try {
    const userSupabase = await createClient();
    const supabase = createAdminClient();
    const stripe = getStripe();

    const {
      data: { user },
      error: authError,
    } = await userSupabase.auth.getUser();

    if (authError || !user) {
      return jsonError("Please sign in before refreshing payment status.", 401);
    }

    const context = await getCurrentStudioContext();
    if (!context?.studioId) {
      return jsonError("No studio workspace is selected.", 400);
    }

    if (!canCollectTerminal(context.studioRole, context.isPlatformAdmin)) {
      return jsonError("You do not have permission to refresh this payment.", 403);
    }

    const body = await getRequestJson(request);
    const paymentId = clean(body.paymentId);
    const sessionId = clean(body.sessionId);

    if (!paymentId || !sessionId) {
      return jsonError("Payment and session are required.");
    }

    const { data: session, error: sessionError } = await supabase
      .from("terminal_payment_sessions")
      .select("id, studio_id, payment_id, stripe_account_id, stripe_payment_intent_id, status")
      .eq("id", sessionId)
      .eq("payment_id", paymentId)
      .eq("studio_id", context.studioId)
      .single();

    if (sessionError || !session?.stripe_payment_intent_id) {
      return jsonError("Terminal payment session was not found.", 404);
    }

    const { data: existingPayment, error: existingPaymentError } = await supabase
      .from("payments")
      .select("id, status, paid_at")
      .eq("id", paymentId)
      .eq("studio_id", context.studioId)
      .maybeSingle<{ id: string; status: string | null; paid_at: string | null }>();

    if (existingPaymentError) {
      return jsonError(`Payment lookup failed: ${existingPaymentError.message}`);
    }

    if (!existingPayment) {
      return jsonError("Payment record was not found.", 404);
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(
      session.stripe_payment_intent_id,
      { expand: ["latest_charge.balance_transaction"] },
      { stripeAccount: session.stripe_account_id }
    );

    const nowIso = new Date().toISOString();
    const status = paymentIntent.status ?? "unknown";
    const errorMessage = paymentIntent.last_payment_error?.message ?? null;

    await supabase
      .from("terminal_payment_sessions")
      .update({
        status,
        error_message: errorMessage,
        updated_at: nowIso,
        completed_at: status === "succeeded" ? nowIso : null,
      })
      .eq("id", session.id);

    if (status === "succeeded") {
      await supabase
        .from("payments")
        .update({
          status: "paid",
          paid_at: existingPayment?.paid_at ?? nowIso,
          payment_method: "card",
          source: "stripe",
          payment_channel: "terminal",
          terminal_payment_session_id: session.id,
          stripe_payment_intent_id: paymentIntent.id,
          updated_at: nowIso,
        })
        .eq("id", paymentId)
        .eq("studio_id", context.studioId);
    } else if (["canceled", "requires_payment_method"].includes(status)) {
      if (existingPayment?.status !== "paid") {
        await supabase
          .from("payments")
          .update({ status: "failed", updated_at: nowIso })
          .eq("id", paymentId)
          .eq("studio_id", context.studioId);
      }
    }

    return NextResponse.json({
      ok: true,
      paymentId,
      sessionId: session.id,
      status,
      errorMessage,
      done: status === "succeeded" || status === "canceled" || status === "requires_payment_method",
      paid: status === "succeeded",
    });
  } catch (error) {
    console.error("Quick charge refresh failed", error);
    return jsonError(error instanceof Error ? error.message : "Quick charge status could not be refreshed.", 500);
  }
}
