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
      return jsonError("Please sign in before canceling a payment.", 401);
    }

    const context = await getCurrentStudioContext();
    if (!context?.studioId) {
      return jsonError("No studio workspace is selected.", 400);
    }

    if (!canCollectTerminal(context.studioRole, context.isPlatformAdmin)) {
      return jsonError("You do not have permission to cancel this payment.", 403);
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

    await stripe.paymentIntents.cancel(
      session.stripe_payment_intent_id,
      {},
      { stripeAccount: session.stripe_account_id }
    ).catch(() => null);

    const nowIso = new Date().toISOString();

    await supabase
      .from("terminal_payment_sessions")
      .update({ status: "canceled", updated_at: nowIso, completed_at: nowIso })
      .eq("id", session.id);

    await supabase
      .from("payments")
      .update({ status: "failed", updated_at: nowIso })
      .eq("id", paymentId)
      .eq("studio_id", context.studioId);

    return NextResponse.json({ ok: true, status: "canceled" });
  } catch (error) {
    console.error("Quick charge cancel failed", error);
    return jsonError(error instanceof Error ? error.message : "Quick charge could not be canceled.", 500);
  }
}
