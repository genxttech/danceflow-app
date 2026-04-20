import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/payments/stripe";

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
  const formData = await request.formData();
  const studioSlug = getString(formData, "studioSlug");

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
      .select("id, slug, name, public_name")
      .eq("slug", studioSlug)
      .single();

    if (studioError || !studio) {
      return redirectTo(request, "/login");
    }

    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("id, is_independent_instructor")
      .eq("studio_id", studio.id)
      .eq("portal_user_id", user.id)
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
        `/portal/${encodeURIComponent(studioSlug)}/floor-space/my-rentals?success=no_balance_due`
      );
    }

    const totalAmount = payableRentals.reduce(
      (sum, rental) => sum + Number(rental.price_amount ?? 0),
      0
    );

    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      return redirectTo(
        request,
        `/portal/${encodeURIComponent(studioSlug)}/floor-space/my-rentals?error=missing_rental_amount`
      );
    }

    const appointmentIds = payableRentals.map((rental) => rental.id);
    const stripe = getStripe();
    const appUrl = buildAppUrl(request);

    const checkoutSession = await stripe.checkout.sessions.create({
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
      success_url: `${appUrl}/portal/${encodeURIComponent(
        studio.slug
      )}/floor-space/my-rentals?success=balance_payment_submitted`,
      cancel_url: `${appUrl}/portal/${encodeURIComponent(
        studio.slug
      )}/floor-space/my-rentals?error=checkout_cancelled`,
      metadata: {
        source: "portal_floor_rental_balance_payment",
        studioId: studio.id,
        clientId: client.id,
        studioSlug: studio.slug,
        appointmentIds: appointmentIds.join(","),
        appointmentCount: String(appointmentIds.length),
      },
      payment_intent_data: {
        metadata: {
          source: "portal_floor_rental_balance_payment",
          studioId: studio.id,
          clientId: client.id,
          studioSlug: studio.slug,
          appointmentIds: appointmentIds.join(","),
          appointmentCount: String(appointmentIds.length),
        },
      },
    });

    if (!checkoutSession.url) {
      return redirectTo(
        request,
        `/portal/${encodeURIComponent(studioSlug)}/floor-space/my-rentals?error=checkout_failed`
      );
    }

    return NextResponse.redirect(checkoutSession.url, { status: 303 });
  } catch (error) {
    console.error("portal floor rental balance checkout failed", error);
    return redirectTo(
      request,
      `/portal/${encodeURIComponent(studioSlug)}/floor-space/my-rentals?error=checkout_failed`
    );
  }
}