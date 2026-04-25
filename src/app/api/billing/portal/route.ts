import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/payments/stripe";
import { getCurrentStudioContext } from "@/lib/auth/studio";

function buildAppUrl(request: NextRequest) {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    request.nextUrl.origin
  );
}

function canManageBilling(role: string | null | undefined, isPlatformAdminRole: boolean) {
  if (isPlatformAdminRole) return true;
  return role === "studio_owner" || role === "organizer_owner";
}

async function createClientFromRequest() {
  const { createClient } = await import("@/lib/supabase/server");
  return createClient();
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClientFromRequest();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.redirect(new URL("/login", request.url));
    }

    const context = await getCurrentStudioContext();

    if (!context?.studioId) {
      return NextResponse.redirect(new URL("/app", request.url));
    }

    if (!canManageBilling(context.studioRole, context.isPlatformAdmin)) {
      return NextResponse.redirect(new URL("/app", request.url));
    }

    const studioId = context.studioId;

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