import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/payments/stripe";

function buildAppUrl(request: NextRequest) {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    request.nextUrl.origin
  );
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClientFromRequest(request);
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.redirect(new URL("/login", request.url));
    }

    const { data: roleRow, error: roleError } = await supabase
      .from("user_studio_roles")
      .select("studio_id")
      .eq("user_id", user.id)
      .eq("active", true)
      .limit(1)
      .single();

    if (roleError || !roleRow) {
      return NextResponse.redirect(new URL("/login", request.url));
    }

    const studioId = roleRow.studio_id as string;

    const { data: billingCustomer, error: billingCustomerError } = await supabase
      .from("studio_billing_customers")
      .select("stripe_customer_id")
      .eq("studio_id", studioId)
      .maybeSingle();

    if (billingCustomerError) {
      throw new Error(billingCustomerError.message);
    }

    if (!billingCustomer?.stripe_customer_id) {
      return NextResponse.redirect(
        new URL("/app/settings/billing?error=billing_customer_missing", request.url)
      );
    }

    const stripe = getStripe();
    const appUrl = buildAppUrl(request);

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: billingCustomer.stripe_customer_id,
      return_url: `${appUrl}/app/settings/billing?success=billing_portal_opened`,
    });

    return NextResponse.redirect(portalSession.url);
  } catch {
    return NextResponse.redirect(
      new URL("/app/settings/billing?error=billing_portal_failed", request.url)
    );
  }
}

async function createClientFromRequest(request: NextRequest) {
  const { createClient } = await import("@/lib/supabase/server");
  return createClient();
}