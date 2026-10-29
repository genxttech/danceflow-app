import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/payments/stripe";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageWorkspaceSubscription } from "@/lib/billing/subscriptionAuthority";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";

function buildAppUrl(request: NextRequest) {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    request.nextUrl.origin
  );
}

// D7-1: this route answers an HTML form POST. A 307 (the NextResponse.redirect
// default) makes the browser repeat the POST to the destination, so every redirect
// here is a 303, which turns the follow-up into a GET.
function redirectTo(request: NextRequest, path: string) {
  return NextResponse.redirect(new URL(path, request.url), { status: 303 });
}

async function createClientFromRequest() {
  const { createClient } = await import("@/lib/supabase/server");
  return createClient();
}

/** Non-secret fields only: never the customer id, URLs, card data or the raw error body. */
function describeError(error: unknown) {
  const stripeError = error as {
    type?: unknown;
    code?: unknown;
    statusCode?: unknown;
    requestId?: unknown;
  } | null;

  return {
    name: error instanceof Error ? error.name : typeof error,
    stripeType: typeof stripeError?.type === "string" ? stripeError.type : undefined,
    stripeCode: typeof stripeError?.code === "string" ? stripeError.code : undefined,
    statusCode: typeof stripeError?.statusCode === "number" ? stripeError.statusCode : undefined,
    requestId: typeof stripeError?.requestId === "string" ? stripeError.requestId : undefined,
  };
}

export async function POST(request: NextRequest) {
  const rateLimit = checkRateLimit(
    rateLimitKey("billing:portal", getIpFromRequest(request)),
    { limit: 10, windowMs: 10 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return rateLimitedJson(rateLimit);
  }

  let studioId: string | undefined;

  try {
    const supabase = await createClientFromRequest();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return redirectTo(request, "/login");
    }

    const context = await getCurrentStudioContext();

    if (!context?.studioId) {
      return redirectTo(request, "/app");
    }

    studioId = context.studioId;

    if (!canManageWorkspaceSubscription(context.studioRole, context.isPlatformAdmin)) {
      return redirectTo(request, "/app/settings/billing?error=billing_owner_required");
    }

    // PAY-DC-4A: the billing customer comes from the server-written mapping (service role), never from a
    // tenant-controlled value.
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabaseAdmin = createAdminClient();

    const { data: billingCustomer, error: billingCustomerError } = await supabaseAdmin
      .from("studio_billing_customers")
      .select("stripe_customer_id")
      .eq("studio_id", studioId)
      .maybeSingle();

    if (billingCustomerError) {
      throw new Error(billingCustomerError.message);
    }

    if (!billingCustomer?.stripe_customer_id) {
      console.error("billing portal: no billing customer for studio", { studioId });
      return redirectTo(request, "/app/settings/billing?error=billing_customer_missing");
    }

    const stripe = getStripe();
    const appUrl = buildAppUrl(request);

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: billingCustomer.stripe_customer_id,
      return_url: `${appUrl}/app/settings/billing?success=billing_portal_opened`,
    });

    if (!portalSession.url) {
      console.error("billing portal: Stripe returned a session without a URL", { studioId });
      return redirectTo(request, "/app/settings/billing?error=billing_portal_failed");
    }

    return NextResponse.redirect(portalSession.url, { status: 303 });
  } catch (error) {
    console.error("billing portal failed", { studioId, ...describeError(error) });

    return redirectTo(request, "/app/settings/billing?error=billing_portal_failed");
  }
}
