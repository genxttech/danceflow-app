import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";
import { ensureConnectedStripeCustomer } from "@/lib/payments/customer";

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

function getFormValue(formData: unknown, name: string) {
  return (formData as unknown as { get(key: string): FormDataEntryValue | null }).get(name);
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

async function isStripeAccountReadyForTerminal(
  stripe: ReturnType<typeof getStripe>,
  connectedAccountId: string
) {
  const connectedAccount = await stripe.accounts.retrieve(connectedAccountId);
  return (
    connectedAccount.charges_enabled === true &&
    connectedAccount.capabilities?.card_payments === "active"
  );
}

async function getTerminalContext() {
  const userSupabase = await createClient();
  const supabase = createAdminClient();
  const stripe = getStripe();

  const {
    data: { user },
    error: authError,
  } = await userSupabase.auth.getUser();

  if (authError || !user) {
    return { response: NextResponse.redirect(new URL("/login", getBaseUrl())) } as const;
  }

  const context = await getCurrentStudioContext();
  if (!context?.studioId) {
    return { response: NextResponse.redirect(new URL("/app/payments?error=no_studio_context", getBaseUrl())) } as const;
  }

  if (!canCollectTerminal(context.studioRole, context.isPlatformAdmin)) {
    return { response: NextResponse.redirect(new URL("/app/payments?error=terminal_access_denied", getBaseUrl())) } as const;
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, name, stripe_connected_account_id")
    .eq("id", context.studioId)
    .single();

  if (studioError || !studio) {
    return { response: NextResponse.redirect(new URL("/app/payments?error=studio_not_found", getBaseUrl())) } as const;
  }

  const connectedAccountId = clean(studio.stripe_connected_account_id);
  if (!connectedAccountId) {
    return { response: NextResponse.redirect(new URL("/app/payments?error=terminal_stripe_not_connected", getBaseUrl())) } as const;
  }

  return { supabase, stripe, studio, user, connectedAccountId } as const;
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const paymentId = clean(getFormValue(formData, "paymentId"));
  const readerId = clean(getFormValue(formData, "readerId"));

  if (!paymentId) {
    return NextResponse.redirect(new URL("/app/payments?error=terminal_missing_payment", getBaseUrl()));
  }

  if (!readerId) {
    return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_reader_required" }));
  }

  try {
    const context = await getTerminalContext();
    if ("response" in context) return context.response;

    const { supabase, stripe, studio, user, connectedAccountId } = context;

    const accountReady = await isStripeAccountReadyForTerminal(stripe, connectedAccountId);
    if (!accountReady) {
      return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_stripe_not_ready" }));
    }

    const { data: payment, error: paymentError } = await supabase
      .from("payments")
      .select("id, studio_id, client_id, client_membership_id, amount, currency, status, payment_type, fulfillment_type, source, client_package_id, external_reference, notes")
      .eq("id", paymentId)
      .eq("studio_id", studio.id)
      .single();

    if (paymentError || !payment) {
      return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_payment_not_found" }));
    }

    if (!["pending", "failed"].includes((payment.status ?? "").toLowerCase())) {
      return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_payment_not_pending" }));
    }

    const amount = Number(payment.amount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_invalid_amount" }));
    }

    const { data: reader, error: readerError } = await supabase
      .from("stripe_terminal_readers")
      .select("id, terminal_location_id, stripe_reader_id, stripe_location_id, label, status, active")
      .eq("id", readerId)
      .eq("studio_id", studio.id)
      .eq("active", true)
      .single();

    if (readerError || !reader?.stripe_reader_id) {
      return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_reader_not_found" }));
    }

    if ((reader.status ?? "").toLowerCase() !== "online") {
      return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_reader_offline" }));
    }

    const { data: openSession, error: openSessionError } = await supabase
      .from("terminal_payment_sessions")
      .select("id, status")
      .eq("studio_id", studio.id)
      .eq("payment_id", payment.id)
      .in("status", ["created", "processing", "requires_payment_method", "requires_confirmation"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (openSessionError) {
      return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_session_lookup_failed" }));
    }

    if (openSession?.id) {
      return NextResponse.redirect(terminalPaymentUrl(paymentId, { success: "terminal_session_already_open" }));
    }

    const currency = clean(payment.currency || "usd").toLowerCase() || "usd";
    const amountCents = Math.round(amount * 100);
    const isMembershipEnrollment =
      payment.fulfillment_type === "activate_membership" &&
      Boolean(payment.client_membership_id) &&
      Boolean(payment.client_id);
    let connectedCustomerId: string | null = null;
    let enrollmentId: string | null = null;

    if (isMembershipEnrollment) {
      const [{ data: enrollment, error: enrollmentError }, { data: client, error: clientError }] =
        await Promise.all([
          supabase
            .from("membership_terminal_enrollments")
            .select("id, consented_at, consent_text, status")
            .eq("studio_id", studio.id)
            .eq("payment_id", payment.id)
            .eq("client_membership_id", payment.client_membership_id)
            .single(),
          supabase
            .from("clients")
            .select("id, first_name, last_name, email")
            .eq("studio_id", studio.id)
            .eq("id", payment.client_id)
            .single(),
        ]);

      if (enrollmentError || !enrollment?.consented_at || !enrollment.consent_text) {
        return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_membership_consent_missing" }));
      }
      if (clientError || !client) {
        return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_membership_client_missing" }));
      }

      enrollmentId = enrollment.id;
      connectedCustomerId = await ensureConnectedStripeCustomer({
        supabase,
        studioId: studio.id,
        clientId: client.id,
        email: client.email ?? null,
        name: `${client.first_name} ${client.last_name}`.trim() || null,
        stripeAccountId: connectedAccountId,
      });
    }

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency,
        payment_method_types: ["card_present"],
        capture_method: "automatic",
        ...(connectedCustomerId
          ? {
              customer: connectedCustomerId,
              setup_future_usage: "off_session" as const,
            }
          : {}),
        metadata: {
          source: "danceflow_terminal",
          studioId: studio.id,
          paymentId: payment.id,
          clientId: payment.client_id ?? "",
          paymentType: payment.payment_type ?? "general",
          membershipEnrollmentId: enrollmentId ?? "",
        },
      },
      { stripeAccount: connectedAccountId }
    );

    const { data: session, error: sessionError } = await supabase
      .from("terminal_payment_sessions")
      .insert({
        studio_id: studio.id,
        client_id: payment.client_id,
        payment_id: payment.id,
        terminal_reader_id: reader.id,
        terminal_location_id: reader.terminal_location_id,
        source_type: payment.payment_type ?? "payment",
        source_id: payment.external_reference ?? payment.id,
        amount_cents: amountCents,
        currency,
        stripe_account_id: connectedAccountId,
        stripe_payment_intent_id: paymentIntent.id,
        status: paymentIntent.status ?? "created",
        metadata: {
          reader_label: reader.label ?? null,
          payment_type: payment.payment_type ?? null,
        },
        created_by: user.id,
      })
      .select("id")
      .single();

    if (sessionError || !session) {
      await stripe.paymentIntents.cancel(paymentIntent.id, {}, { stripeAccount: connectedAccountId }).catch(() => null);
      return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_session_create_failed" }));
    }


    if (enrollmentId) {
      const { error: enrollmentUpdateError } = await supabase
        .from("membership_terminal_enrollments")
        .update({
          stripe_account_id: connectedAccountId,
          stripe_customer_id: connectedCustomerId,
          stripe_payment_intent_id: paymentIntent.id,
          status: "reader_processing",
          updated_at: new Date().toISOString(),
        })
        .eq("id", enrollmentId)
        .eq("studio_id", studio.id);

      if (enrollmentUpdateError) {
        await stripe.paymentIntents.cancel(paymentIntent.id, {}, { stripeAccount: connectedAccountId }).catch(() => null);
        return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_membership_enrollment_update_failed" }));
      }
    }

    await supabase
      .from("payments")
      .update({
        payment_method: "card",
        source: "stripe",
        payment_channel: "terminal",
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
        { stripeAccount: connectedAccountId }
      );
    } catch (processError) {
      const nowIso = new Date().toISOString();
      const errorMessage =
        processError instanceof Error
          ? processError.message
          : "Stripe could not send the payment to the reader.";

      await stripe.paymentIntents.cancel(paymentIntent.id, {}, { stripeAccount: connectedAccountId }).catch(() => null);

      await supabase
        .from("terminal_payment_sessions")
        .update({
          status: "failed",
          error_message: errorMessage,
          updated_at: nowIso,
          completed_at: nowIso,
        })
        .eq("id", session.id);

      await supabase
        .from("payments")
        .update({ status: "failed" })
        .eq("id", payment.id)
        .eq("studio_id", studio.id)
        .neq("status", "paid");

      return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_reader_process_failed" }));
    }

    await supabase
      .from("terminal_payment_sessions")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", session.id);

    return NextResponse.redirect(terminalPaymentUrl(paymentId, { success: "terminal_payment_sent" }));
  } catch (error) {
    console.error("Terminal payment start failed", error);
    return NextResponse.redirect(terminalPaymentUrl(paymentId, { error: "terminal_payment_start_failed" }));
  }
}
