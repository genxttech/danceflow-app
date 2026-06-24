import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";
import { fulfillTerminalPayment } from "@/lib/payments/terminal-fulfillment";
import { finalizeTerminalMembership } from "@/lib/payments/terminal-membership-finalization";

function getBaseUrl() {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function terminalPaymentUrl(paymentId: string, params: Record<string, string>) {
  const url = new URL(`/app/payments/terminal/${paymentId}`, getBaseUrl());
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url;
}

function canCollectTerminal(role: string | null | undefined, isPlatformAdmin: boolean) {
  if (isPlatformAdmin) return true;
  return ["studio_owner", "studio_admin", "front_desk"].includes(role ?? "");
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const paymentId = clean(formData.get("paymentId"));
  const sessionId = clean(formData.get("sessionId"));

  if (!paymentId) {
    return NextResponse.redirect(new URL("/app/payments?error=terminal_missing_payment", getBaseUrl()));
  }

  if (!sessionId) {
    return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_session_required" }));
  }

  try {
    const userSupabase = await createClient();
    const supabase = createAdminClient();
    const stripe = getStripe();

    const {
      data: { user },
      error: authError,
    } = await userSupabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.redirect(new URL("/login", getBaseUrl()));
    }

    const context = await getCurrentStudioContext();
    if (!context?.studioId) {
      return NextResponse.redirect(new URL("/app/payments?error=no_studio_context", getBaseUrl()));
    }

    if (!canCollectTerminal(context.studioRole, context.isPlatformAdmin)) {
      return NextResponse.redirect(new URL("/app/payments?error=terminal_access_denied", getBaseUrl()));
    }

    const { data: session, error: sessionError } = await supabase
      .from("terminal_payment_sessions")
      .select("id, studio_id, payment_id, stripe_account_id, stripe_payment_intent_id, status")
      .eq("id", sessionId)
      .eq("payment_id", paymentId)
      .eq("studio_id", context.studioId)
      .single();

    if (sessionError || !session?.stripe_payment_intent_id) {
      return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_session_not_found" }));
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
      await fulfillTerminalPayment({
        supabase,
        studioId: context.studioId,
        paymentId,
        sessionId: session.id,
        paymentIntentId: paymentIntent.id,
      });

      await finalizeTerminalMembership({
        supabase,
        paymentIntentId: paymentIntent.id,
      });

      return NextResponse.redirect(terminalPaymentUrl(paymentId, { success: "terminal_payment_succeeded" }));
    }

    if (["canceled", "requires_payment_method"].includes(status)) {
      await supabase
        .from("payments")
        .update({ status: "failed", updated_at: nowIso })
        .eq("id", paymentId)
        .eq("studio_id", context.studioId);

      return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_payment_failed" }));
    }

    return NextResponse.redirect(terminalPaymentUrl(paymentId, { success: "terminal_payment_refreshed" }));
  } catch (error) {
    console.error("Terminal payment refresh failed", error);
    return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_payment_refresh_failed" }));
  }
}
