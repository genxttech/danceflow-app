import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/payments/stripe";
import { resolveClientCheckoutSession } from "@/lib/payments/client-checkout-session";
import {
  checkRateLimit,
  getIpFromRequest,
  rateLimitKey,
  rateLimitedJson,
} from "@/lib/security/rate-limit";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getString(value: unknown, maxLength = 400) {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .trim()
        .slice(0, maxLength)
    : null;
}

function safeLocalPath(value: string | null, fallback: string) {
  const target = value || fallback;
  if (
    !target.startsWith("/") ||
    target.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(target)
  ) {
    return fallback;
  }
  return target;
}

function absoluteUrl(
  request: NextRequest,
  value: string | null,
  fallback: string,
) {
  return new URL(
    safeLocalPath(value, fallback),
    request.nextUrl.origin,
  ).toString();
}

function safeCurrency(value: unknown) {
  const currency = String(value || "usd")
    .trim()
    .toLowerCase();
  return /^[a-z]{3}$/.test(currency) ? currency : "usd";
}

function paymentLabel(paymentType: string | null, fallback: string | null) {
  if (fallback) return fallback;
  if (paymentType === "package_sale") return "Dance package purchase";
  if (paymentType === "membership") return "Dance membership payment";
  if (paymentType === "floor_rental") return "Floor rental payment";
  return "DanceFlow client payment";
}

export async function GET(request: NextRequest) {
  const rateLimit = checkRateLimit(
    rateLimitKey("stripe:client-checkout", getIpFromRequest(request)),
    { limit: 12, windowMs: 10 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return rateLimitedJson(rateLimit);
  }

  const supabase = await createClient();
  const stripe = getStripe();

  const paymentId = getString(
    request.nextUrl.searchParams.get("paymentId"),
    36,
  );
  const returnTo = getString(request.nextUrl.searchParams.get("returnTo"), 400);
  const cancelTo = getString(request.nextUrl.searchParams.get("cancelTo"), 400);

  if (!paymentId || !UUID_PATTERN.test(paymentId)) {
    return NextResponse.json(
      { error: "Missing or invalid paymentId." },
      { status: 400 },
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(
      new URL(
        `/login?next=${encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)}`,
        request.nextUrl.origin,
      ),
    );
  }

  const { data: payment, error: paymentError } = await supabase
    .from("payments")
    .select(
      `
      id,
      studio_id,
      client_id,
      client_package_id,
      client_membership_id,
      amount,
      currency,
      status,
      source,
      payment_type,
      stripe_checkout_session_id,
      checkout_session_attempt_count,
      notes,
      clients:client_id (
        id,
        first_name,
        last_name,
        email
      ),
      client_packages:client_package_id (
        id,
        name_snapshot
      ),
      client_memberships:client_membership_id (
        id,
        name_snapshot
      ),
      studios:studio_id (
        stripe_connected_account_id,
        stripe_connect_charges_enabled,
        stripe_connect_payouts_enabled,
        stripe_connect_onboarding_complete
      )
    `,
    )
    .eq("id", paymentId)
    .maybeSingle();

  if (paymentError) {
    console.error("client-checkout: payment lookup failed", paymentError.message);
    return NextResponse.json(
      { error: "Payment request could not be loaded." },
      { status: 500 },
    );
  }

  if (!payment) {
    return NextResponse.json(
      { error: "Payment request not found." },
      { status: 404 },
    );
  }

  if (payment.status !== "pending") {
    const destination = absoluteUrl(
      request,
      returnTo,
      "/app/payments?success=already_processed",
    );
    return NextResponse.redirect(destination);
  }

  const { data: role, error: roleError } = await supabase
    .from("user_studio_roles")
    .select("id")
    .eq("studio_id", payment.studio_id)
    .eq("user_id", user.id)
    .eq("active", true)
    .maybeSingle();

  if (roleError) {
    console.error("client-checkout: role lookup failed", roleError.message);
    return NextResponse.json(
      { error: "Your access could not be verified." },
      { status: 500 },
    );
  }

  const clientRow = Array.isArray(payment.clients)
    ? payment.clients[0]
    : payment.clients;

  const { data: billingRelationship, error: billingRelationshipError } =
    await supabase
      .from("client_account_links")
      .select("id")
      .eq("user_id", user.id)
      .eq("studio_id", payment.studio_id)
      .eq("client_id", payment.client_id)
      .eq("status", "linked")
      .eq("can_view_billing", true)
      .maybeSingle();

  if (billingRelationshipError) {
    console.error(
      "client-checkout: billing relationship lookup failed",
      billingRelationshipError.message,
    );
    return NextResponse.json(
      { error: "Your access could not be verified." },
      { status: 500 },
    );
  }

  if (!role && !billingRelationship) {
    return NextResponse.json(
      { error: "You do not have access to this payment request." },
      { status: 403 },
    );
  }

  const amount = Number(payment.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json(
      { error: "Payment amount must be greater than zero." },
      { status: 400 },
    );
  }

  const currency = safeCurrency(payment.currency);
  const amountInCents = Math.round(amount * 100);
  const packageRow = Array.isArray(payment.client_packages)
    ? payment.client_packages[0]
    : payment.client_packages;
  const membershipRow = Array.isArray(payment.client_memberships)
    ? payment.client_memberships[0]
    : payment.client_memberships;
  const lineItemName = paymentLabel(
    payment.payment_type,
    packageRow?.name_snapshot || membershipRow?.name_snapshot || null,
  );

  const studioRow = Array.isArray(payment.studios)
    ? payment.studios[0]
    : payment.studios;
  const connectedAccountId = studioRow?.stripe_connected_account_id ?? null;

  if (
    !connectedAccountId ||
    !studioRow?.stripe_connect_onboarding_complete ||
    !studioRow?.stripe_connect_charges_enabled ||
    !studioRow?.stripe_connect_payouts_enabled
  ) {
    return NextResponse.json(
      { error: "This studio is not ready to accept online payments." },
      { status: 409 },
    );
  }

  const successUrl = absoluteUrl(
    request,
    returnTo,
    "/app/payments?success=payment_logged",
  );
  const cancelUrl = absoluteUrl(
    request,
    cancelTo,
    returnTo || "/app/payments?error=payment_cancelled",
  );

  const createSessionParams = {
    mode: "payment" as const,
    customer_email: clientRow?.email || user.email || undefined,
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency,
          unit_amount: amountInCents,
          product_data: {
            name: lineItemName,
            description: payment.notes || undefined,
          },
        },
      },
    ],
    payment_intent_data: {
      metadata: {
        source: "client_payment_request",
        paymentId: payment.id,
        studioId: payment.studio_id,
        clientId: payment.client_id,
        clientPackageId: payment.client_package_id || "",
        clientMembershipId: payment.client_membership_id || "",
        paymentType: payment.payment_type || "general",
        connectedAccountId,
        chargeModel: "direct",
      },
    },
    metadata: {
      source: "client_payment_request",
      paymentId: payment.id,
      studioId: payment.studio_id,
      clientId: payment.client_id,
      clientPackageId: payment.client_package_id || "",
      clientMembershipId: payment.client_membership_id || "",
      paymentType: payment.payment_type || "general",
      connectedAccountId,
      chargeModel: "direct",
    },
  };

  // Every authorization/eligibility check above (signed in, role or
  // client_account_links billing relationship, studio Stripe readiness)
  // has already passed by this point -- only now is it safe to reach for
  // the service-role client. It is used exclusively for the idempotency
  // helper's own narrowly-scoped writes (see the doc comment on
  // resolveClientCheckoutSession for why a plain user-scoped client can't
  // perform them for every authorized caller), never for anything that
  // itself decides who is allowed to pay this payment.
  const adminSupabase = createAdminClient();

  const result = await resolveClientCheckoutSession({
    adminSupabase,
    stripe,
    paymentId: payment.id,
    currentAttemptCount: payment.checkout_session_attempt_count ?? 0,
    existingSessionId: payment.stripe_checkout_session_id ?? null,
    connectedAccountId,
    createSessionParams,
  });

  switch (result.kind) {
    case "reuse":
    case "created":
      return NextResponse.redirect(result.url);
    case "already_processed":
      return NextResponse.redirect(
        absoluteUrl(request, returnTo, "/app/payments?success=already_processed"),
      );
    case "retry_needed":
      return NextResponse.json(
        {
          error:
            "Checkout is already being started for this payment. Please try again in a moment.",
        },
        { status: 409 },
      );
    case "error":
      return NextResponse.json({ error: result.message }, { status: 500 });
  }
}
