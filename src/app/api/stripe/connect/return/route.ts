import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";

function getBaseUrl() {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

export async function GET() {
  const supabase = await createClient();
  const stripe = getStripe();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.redirect(new URL("/login", getBaseUrl()));
  }

  const context = await getCurrentStudioContext();
  if (!context?.studioId) {
    return NextResponse.redirect(
      new URL("/app/settings/billing?error=no_studio_context", getBaseUrl())
    );
  }

  const studioId = context.studioId;

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, stripe_connected_account_id")
    .eq("id", studioId)
    .single();

  if (studioError || !studio?.stripe_connected_account_id) {
    return NextResponse.redirect(
      new URL("/app/settings/billing?error=missing_connected_account", getBaseUrl())
    );
  }

  const account = await stripe.accounts.retrieve(studio.stripe_connected_account_id);

  const detailsSubmitted = account.details_submitted ?? false;
  const chargesEnabled = account.charges_enabled ?? false;
  const payoutsEnabled = account.payouts_enabled ?? false;
  const onboardingComplete = detailsSubmitted && payoutsEnabled;

  const { error: updateError } = await supabase
    .from("studios")
    .update({
      stripe_connect_details_submitted: detailsSubmitted,
      stripe_connect_charges_enabled: chargesEnabled,
      stripe_connect_payouts_enabled: payoutsEnabled,
      stripe_connect_onboarding_complete: onboardingComplete,
      stripe_connect_last_synced_at: new Date().toISOString(),
    })
    .eq("id", studioId);

  if (updateError) {
    return NextResponse.redirect(
      new URL("/app/settings/billing?error=sync_connected_account_failed", getBaseUrl())
    );
  }

  return NextResponse.redirect(
    new URL("/app/settings/billing?success=stripe_connect_updated", getBaseUrl())
  );
}