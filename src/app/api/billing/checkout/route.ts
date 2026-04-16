import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseAdmin } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Missing Supabase admin environment variables.");
  }

  return createSupabaseAdmin(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

function buildAppUrl(request: NextRequest) {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    request.nextUrl.origin
  ).replace(/\/$/, "");
}

function billingRedirect(request: NextRequest, path: string) {
  return NextResponse.redirect(new URL(path, request.url), { status: 303 });
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const planCode =
    typeof formData.get("planCode") === "string"
      ? String(formData.get("planCode")).trim()
      : "";
  const billingInterval =
    typeof formData.get("billingInterval") === "string"
      ? String(formData.get("billingInterval")).trim()
      : "month";

  if (!planCode) {
    return billingRedirect(request, "/app/settings/billing?error=plan_not_found");
  }

  if (!["month", "year"].includes(billingInterval)) {
    return billingRedirect(request, "/app/settings/billing?error=checkout_failed");
  }

  try {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return billingRedirect(request, "/login");
    }

    const context = await getCurrentStudioContext();
    const studioId = context.studioId;

    const supabaseAdmin = getSupabaseAdmin();

    const [{ data: studio, error: studioError }, { data: plan, error: planError }] =
      await Promise.all([
        supabaseAdmin
          .from("studios")
          .select("id, name")
          .eq("id", studioId)
          .single(),
        supabaseAdmin
          .from("subscription_plans")
          .select(`
            id,
            code,
            name,
            stripe_price_id_monthly,
            stripe_price_id_yearly
          `)
          .eq("code", planCode)
          .eq("active", true)
          .single(),
      ]);

    if (studioError || !studio || planError || !plan) {
      return billingRedirect(request, "/app/settings/billing?error=plan_not_found");
    }

    const stripePriceId =
      billingInterval === "year"
        ? plan.stripe_price_id_yearly
        : plan.stripe_price_id_monthly;

    if (!stripePriceId) {
      return billingRedirect(request, "/app/settings/billing?error=missing_price_id");
    }

    const { data: existingCustomer, error: customerLookupError } = await supabaseAdmin
      .from("studio_billing_customers")
      .select("id, stripe_customer_id")
      .eq("studio_id", studioId)
      .maybeSingle();

    if (customerLookupError) {
      throw new Error(customerLookupError.message);
    }

    const stripe = getStripe();
    let stripeCustomerId = existingCustomer?.stripe_customer_id ?? null;

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        name: studio.name,
        metadata: {
          studioId,
          source: "studio_saas_billing",
        },
      });

      stripeCustomerId = customer.id;

      const { error: insertCustomerError } = await supabaseAdmin
        .from("studio_billing_customers")
        .insert({
          studio_id: studioId,
          stripe_customer_id: stripeCustomerId,
          billing_email: user.email ?? null,
          contact_name: studio.name,
        });

      if (insertCustomerError) {
        throw new Error(insertCustomerError.message);
      }
    }

    const appUrl = buildAppUrl(request);

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: [
        {
          price: stripePriceId,
          quantity: 1,
        },
      ],
      success_url: `${appUrl}/app/settings/billing?success=subscription_checkout_started`,
      cancel_url: `${appUrl}/app/settings/billing?error=checkout_cancelled`,
      allow_promotion_codes: true,
      metadata: {
        source: "studio_subscription",
        studioId,
        planCode: plan.code,
        billingInterval,
      },
      subscription_data: {
        metadata: {
          source: "studio_subscription",
          studioId,
          planCode: plan.code,
          billingInterval,
        },
      },
    });

    if (!checkoutSession.url) {
      return billingRedirect(request, "/app/settings/billing?error=checkout_failed");
    }

    return NextResponse.redirect(checkoutSession.url, { status: 303 });
  } catch (error) {
    console.error("billing checkout failed", error);
    return billingRedirect(request, "/app/settings/billing?error=checkout_failed");
  }
}