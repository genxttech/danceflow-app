import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/payments/stripe";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";
import { resolvePortalFloorRentalCheckoutSession } from "@/lib/payments/portal-floor-rental-checkout-session";

function buildAppUrl(request: NextRequest) {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    request.nextUrl.origin
  ).replace(/\/$/, "");
}

function redirectTo(request: NextRequest, path: string) {
  return NextResponse.redirect(new URL(path, request.url), { status: 303 });
}

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: NextRequest) {
  const rateLimit = checkRateLimit(
    rateLimitKey("portal:floor-rental-checkout", getIpFromRequest(request)),
    { limit: 8, windowMs: 10 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return rateLimitedJson(rateLimit);
  }

  const formData = await request.formData();
  const studioSlug = getString(formData, "studioSlug");
  const requestedClientId = getString(formData, "clientId") || null;

  if (!studioSlug) {
    return redirectTo(
      request,
      "/login"
    );
  }

  try {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return redirectTo(request, `/login?studio=${encodeURIComponent(studioSlug)}`);
    }

    const { data: studio, error: studioError } = await supabase
      .from("studios")
      .select(
        "id, slug, name, public_name, stripe_connected_account_id, stripe_connect_charges_enabled, stripe_connect_payouts_enabled, stripe_connect_onboarding_complete",
      )
      .eq("slug", studioSlug)
      .single();

    if (studioError || !studio) {
      return redirectTo(request, "/login");
    }

    let relationshipQuery = supabase
      .from("client_account_links")
      .select("client_id")
      .eq("user_id", user.id)
      .eq("studio_id", studio.id)
      .eq("status", "linked")
      .eq("can_view_billing", true);

    if (requestedClientId) {
      relationshipQuery = relationshipQuery.eq("client_id", requestedClientId);
    } else {
      relationshipQuery = relationshipQuery.eq("is_primary", true);
    }

    const { data: relationship, error: relationshipError } =
      await relationshipQuery.maybeSingle<{ client_id: string }>();

    if (relationshipError || !relationship) {
      return redirectTo(
        request,
        `/portal/${encodeURIComponent(studioSlug)}?error=unauthorized`
      );
    }

    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("id, is_independent_instructor")
      .eq("studio_id", studio.id)
      .eq("id", relationship.client_id)
      .single();

    if (clientError || !client || !client.is_independent_instructor) {
      return redirectTo(
        request,
        `/portal/${encodeURIComponent(studioSlug)}?error=unauthorized`
      );
    }

    const { data: rentals, error: rentalsError } = await supabase
      .from("appointments")
      .select(`
        id,
        title,
        starts_at,
        ends_at,
        status,
        payment_status,
        price_amount
      `)
      .eq("studio_id", studio.id)
      .eq("client_id", client.id)
      .eq("appointment_type", "floor_space_rental")
      .neq("status", "cancelled")
      .in("payment_status", ["unpaid", "partial"])
      .order("starts_at", { ascending: true });

    if (rentalsError) {
      throw rentalsError;
    }

    const payableRentals = (rentals ?? []).filter(
      (rental) => Number(rental.price_amount ?? 0) > 0
    );

    if (payableRentals.length === 0) {
      return redirectTo(
        request,
        `/portal/${encodeURIComponent(studioSlug)}/floor-space/my-rentals?client=${encodeURIComponent(client.id)}&success=no_balance_due`
      );
    }

    const totalAmount = payableRentals.reduce(
      (sum, rental) => sum + Number(rental.price_amount ?? 0),
      0
    );

    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      return redirectTo(
        request,
        `/portal/${encodeURIComponent(studioSlug)}/floor-space/my-rentals?client=${encodeURIComponent(client.id)}&error=missing_rental_amount`
      );
    }

    const appointmentIds = payableRentals.map((rental) => rental.id);
    const stripe = getStripe();
    const appUrl = buildAppUrl(request);
    const connectedAccountId = studio.stripe_connected_account_id;

    if (
      !connectedAccountId ||
      !studio.stripe_connect_onboarding_complete ||
      !studio.stripe_connect_charges_enabled ||
      !studio.stripe_connect_payouts_enabled
    ) {
      return redirectTo(
        request,
        `/portal/${encodeURIComponent(studioSlug)}/floor-space/my-rentals?client=${encodeURIComponent(client.id)}&error=studio_payments_not_ready`
      );
    }

    const myRentalsPath = `/portal/${encodeURIComponent(studioSlug)}/floor-space/my-rentals?client=${encodeURIComponent(client.id)}`;

    // Every authorization/eligibility check above (signed in,
    // client_account_links billing relationship, independent-instructor
    // validation, payable-appointment lookup, studio Stripe readiness) has
    // already passed by this point -- only now is it safe to reach for the
    // service-role client. It is used exclusively for this route's own
    // narrowly-scoped idempotency bookkeeping (see the doc comment on
    // resolvePortalFloorRentalCheckoutSession for why a plain user-scoped
    // client can't perform these writes for every authorized caller), never
    // for anything that itself decides who is allowed to pay this balance.
    const adminSupabase = createAdminClient();

    const result = await resolvePortalFloorRentalCheckoutSession({
      adminSupabase,
      stripe,
      studioId: studio.id,
      clientId: client.id,
      amount: totalAmount,
      connectedAccountId,
      buildCreateSessionParams: (paymentId) => ({
        mode: "payment",
        customer_email: user.email ?? undefined,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: Math.round(totalAmount * 100),
              product_data: {
                name: "Floor Rental Balance",
                description: `${payableRentals.length} rental${payableRentals.length === 1 ? "" : "s"} at ${
                  studio.public_name?.trim() || studio.name
                }`,
              },
            },
          },
        ],
        success_url: `${appUrl}${myRentalsPath}&success=balance_payment_submitted`,
        cancel_url: `${appUrl}${myRentalsPath}&error=checkout_cancelled`,
        metadata: {
          source: "portal_floor_rental_balance_payment",
          paymentId,
          studioId: studio.id,
          clientId: client.id,
          studioSlug: studio.slug,
          appointmentIds: appointmentIds.join(","),
          appointmentCount: String(appointmentIds.length),
          paymentType: "floor_fee",
          reportingCategory: "floor_rental",
          connectedAccountId,
          chargeModel: "direct",
        },
        payment_intent_data: {
          metadata: {
            source: "portal_floor_rental_balance_payment",
            paymentId,
            studioId: studio.id,
            clientId: client.id,
            studioSlug: studio.slug,
            appointmentIds: appointmentIds.join(","),
            appointmentCount: String(appointmentIds.length),
            paymentType: "floor_fee",
            reportingCategory: "floor_rental",
            connectedAccountId,
            chargeModel: "direct",
          },
        },
      }),
    });

    switch (result.kind) {
      case "reuse":
      case "created":
        return NextResponse.redirect(result.url, { status: 303 });
      case "already_processed":
        return redirectTo(request, `${myRentalsPath}&success=no_balance_due`);
      case "retry_needed":
      case "error":
        return redirectTo(request, `${myRentalsPath}&error=checkout_failed`);
    }
  } catch (error) {
    console.error("portal floor rental balance checkout failed", error);
    return redirectTo(
      request,
      `/portal/${encodeURIComponent(studioSlug)}/floor-space/my-rentals${requestedClientId ? `?client=${encodeURIComponent(requestedClientId)}&` : "?"}error=checkout_failed`
    );
  }
}