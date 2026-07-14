import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CATEGORY_LABELS: Record<string, string> = {
  group_class: "Group Class",
  social_party: "Social Party",
  practice_party: "Practice Party",
  floor_fee: "Floor Fee",
  private_lesson_ad_hoc: "Private Lesson",
  merchandise: "Merchandise",
  other: "Other",
};

function clean(value: unknown, maxLength = 500) {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .trim()
        .slice(0, maxLength)
    : "";
}

function isUuid(value: string) {
  return UUID_PATTERN.test(value);
}

function canCollectTerminal(
  role: string | null | undefined,
  isPlatformAdmin: boolean,
) {
  if (isPlatformAdmin) return true;
  return ["studio_owner", "studio_admin", "front_desk"].includes(role ?? "");
}

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function parseAmount(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100000) return null;
  return Math.round(parsed * 100) / 100;
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
      return jsonError("Please sign in before collecting a payment.", 401);
    }

    const context = await getCurrentStudioContext();
    if (!context?.studioId) {
      return jsonError("No studio workspace is selected.", 400);
    }

    if (!canCollectTerminal(context.studioRole, context.isPlatformAdmin)) {
      return jsonError(
        "You do not have permission to collect in-person payments.",
        403,
      );
    }

    const body = await getRequestJson(request);
    const category = clean(body.category, 80) || "other";
    const categoryLabel = CATEGORY_LABELS[category] ?? CATEGORY_LABELS.other;
    const amount = parseAmount(body.amount);
    const guestName = clean(body.guestName, 120) || null;
    const notes = clean(body.notes, 500) || null;
    const requestedReaderId = clean(body.readerId, 36);

    if (requestedReaderId && !isUuid(requestedReaderId)) {
      return jsonError("Select a valid Stripe reader.");
    }

    if (!Object.keys(CATEGORY_LABELS).includes(category)) {
      return jsonError("Choose a valid quick charge category.");
    }

    if (amount == null || amount <= 0) {
      return jsonError("Enter a valid payment amount.");
    }

    const { data: studio, error: studioError } = await supabase
      .from("studios")
      .select("id, name, stripe_connected_account_id")
      .eq("id", context.studioId)
      .single();

    if (studioError || !studio) {
      return jsonError("Studio workspace could not be loaded.", 404);
    }

    const connectedAccountId = clean(studio.stripe_connected_account_id);
    if (!connectedAccountId) {
      return jsonError("Stripe is not connected for this studio.");
    }

    const connectedAccount = await stripe.accounts.retrieve(connectedAccountId);
    if (
      !connectedAccount.charges_enabled ||
      connectedAccount.capabilities?.card_payments !== "active"
    ) {
      return jsonError(
        "Stripe is not ready for in-person card payments yet. Finish Stripe onboarding before using Quick Charge.",
        409,
      );
    }

    let readerQuery = supabase
      .from("stripe_terminal_readers")
      .select(
        "id, terminal_location_id, stripe_reader_id, stripe_location_id, label, status, active",
      )
      .eq("studio_id", studio.id)
      .eq("active", true);

    if (requestedReaderId) {
      readerQuery = readerQuery.eq("id", requestedReaderId);
    }

    const { data: readers, error: readerError } = await readerQuery
      .order("updated_at", { ascending: false })
      .limit(5);

    if (readerError) {
      return jsonError(`Reader lookup failed: ${readerError.message}`);
    }

    const reader =
      (readers ?? []).find((row) => row.status === "online") ?? null;

    if (!reader?.stripe_reader_id) {
      return jsonError(
        "No online Stripe reader is available. Refresh or reconnect the reader before starting Quick Charge.",
        409,
      );
    }

    const amountCents = Math.round(amount * 100);
    const noteParts = [
      `Quick Charge: ${categoryLabel}`,
      guestName ? `Guest: ${guestName}` : null,
      notes,
    ].filter(Boolean);

    const { data: payment, error: paymentInsertError } = await supabase
      .from("payments")
      .insert({
        studio_id: studio.id,
        client_id: null,
        amount,
        payment_method: "card",
        status: "pending",
        notes: noteParts.join(" | ") || null,
        paid_at: null,
        created_by: user.id,
        payment_type: "other",
        source: "stripe",
        payment_channel: "terminal",
        currency: "usd",
        quick_charge_category: category,
        guest_name: guestName,
      })
      .select("id")
      .single();

    if (paymentInsertError || !payment) {
      return jsonError(
        `Payment record could not be created: ${paymentInsertError?.message ?? "Unknown error"}`,
      );
    }

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: "usd",
        payment_method_types: ["card_present"],
        capture_method: "automatic",
        metadata: {
          source: "danceflow_terminal_quick_charge",
          studioId: studio.id,
          paymentId: payment.id,
          quickChargeCategory: category,
          guestName: guestName ?? "",
        },
      },
      { stripeAccount: connectedAccountId },
    );

    const { data: session, error: sessionError } = await supabase
      .from("terminal_payment_sessions")
      .insert({
        studio_id: studio.id,
        client_id: null,
        payment_id: payment.id,
        terminal_reader_id: reader.id,
        terminal_location_id: reader.terminal_location_id,
        source_type: "quick_charge",
        source_id: payment.id,
        amount_cents: amountCents,
        currency: "usd",
        stripe_account_id: connectedAccountId,
        stripe_payment_intent_id: paymentIntent.id,
        status: paymentIntent.status ?? "created",
        metadata: {
          reader_label: reader.label ?? null,
          quick_charge_category: category,
          guest_name: guestName,
        },
        created_by: user.id,
      })
      .select("id")
      .single();

    if (sessionError || !session) {
      await stripe.paymentIntents
        .cancel(paymentIntent.id, {}, { stripeAccount: connectedAccountId })
        .catch(() => null);
      await supabase
        .from("payments")
        .update({ status: "failed" })
        .eq("id", payment.id)
        .eq("studio_id", studio.id);
      return jsonError(
        `Terminal session could not be created: ${sessionError?.message ?? "Unknown error"}`,
      );
    }

    await supabase
      .from("payments")
      .update({
        terminal_payment_session_id: session.id,
        stripe_terminal_reader_id: reader.stripe_reader_id,
        stripe_terminal_location_id: reader.stripe_location_id,
        stripe_payment_intent_id: paymentIntent.id,
      })
      .eq("id", payment.id)
      .eq("studio_id", studio.id);

    try {
      await stripe.terminal.readers.processPaymentIntent(
        reader.stripe_reader_id,
        { payment_intent: paymentIntent.id },
        { stripeAccount: connectedAccountId },
      );
    } catch (processError) {
      const message =
        processError instanceof Error
          ? processError.message
          : "Stripe could not send the payment to the selected reader.";
      const nowIso = new Date().toISOString();

      await stripe.paymentIntents
        .cancel(paymentIntent.id, {}, { stripeAccount: connectedAccountId })
        .catch(() => null);

      await Promise.all([
        supabase
          .from("terminal_payment_sessions")
          .update({
            status: "failed",
            error_message: message,
            completed_at: nowIso,
            updated_at: nowIso,
          })
          .eq("id", session.id),
        supabase
          .from("payments")
          .update({ status: "failed" })
          .eq("id", payment.id)
          .eq("studio_id", studio.id),
      ]);

      console.error("Quick charge reader processing failed", processError);
      return jsonError(message, 409);
    }

    const nowIso = new Date().toISOString();
    await supabase
      .from("terminal_payment_sessions")
      .update({ status: "processing", updated_at: nowIso })
      .eq("id", session.id);

    return NextResponse.json({
      ok: true,
      paymentId: payment.id,
      sessionId: session.id,
      status: "processing",
      amount,
      category,
      categoryLabel,
      readerLabel: reader.label ?? "Stripe reader",
    });
  } catch (error) {
    console.error("Quick charge start failed", error);
    return jsonError(
      error instanceof Error
        ? error.message
        : "Quick charge could not be started.",
      500,
    );
  }
}
