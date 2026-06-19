import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";

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
      .select(`
        id,
        payment_id,
        stripe_account_id,
        stripe_payment_intent_id,
        terminal_reader_id,
        stripe_terminal_readers (
          stripe_reader_id
        )
      `)
      .eq("id", sessionId)
      .eq("payment_id", paymentId)
      .eq("studio_id", context.studioId)
      .single();

    if (sessionError || !session?.stripe_payment_intent_id) {
      return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_session_not_found" }));
    }

    const readerRelation = Array.isArray(session.stripe_terminal_readers)
      ? session.stripe_terminal_readers[0]
      : session.stripe_terminal_readers;
    const readerId = readerRelation?.stripe_reader_id ?? null;

    if (readerId) {
      await stripe.terminal.readers.cancelAction(readerId, {}, { stripeAccount: session.stripe_account_id }).catch(() => null);
    }

    await stripe.paymentIntents.cancel(
      session.stripe_payment_intent_id,
      {},
      { stripeAccount: session.stripe_account_id }
    ).catch(() => null);

    const nowIso = new Date().toISOString();

    await supabase
      .from("terminal_payment_sessions")
      .update({
        status: "canceled",
        error_message: "Canceled from DanceFlow.",
        updated_at: nowIso,
        completed_at: nowIso,
      })
      .eq("id", session.id);

    await supabase
      .from("payments")
      .update({ status: "failed", updated_at: nowIso })
      .eq("id", paymentId)
      .eq("studio_id", context.studioId);

    return NextResponse.redirect(terminalPaymentUrl(paymentId, { success: "terminal_payment_canceled" }));
  } catch (error) {
    console.error("Terminal payment cancel failed", error);
    return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_payment_cancel_failed" }));
  }
}
