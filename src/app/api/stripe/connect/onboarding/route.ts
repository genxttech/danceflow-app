import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";

function getBaseUrl() {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "http://localhost:3000"
  );
}

async function handleOnboarding() {
  const supabase = await createClient();
  const stripe = getStripe();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
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

  if (studioError || !studio) {
    return NextResponse.redirect(
      new URL("/app/settings/billing?error=studio_not_found", getBaseUrl())
    );
  }

  let connectedAccountId = studio.stripe_connected_account_id as string | null;

  if (!connectedAccountId) {
    const account = await stripe.accounts.create({
      type: "express",
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: {
        studioId,
      },
    });

    connectedAccountId = account.id;

    const { error: saveError } = await supabase
      .from("studios")
      .update({
        stripe_connected_account_id: connectedAccountId,
      })
      .eq("id", studioId);

    if (saveError) {
      return NextResponse.redirect(
        new URL(
          "/app/settings/billing?error=save_connected_account_failed",
          getBaseUrl()
        )
      );
    }
  }

  await stripe.accounts.update(connectedAccountId, {
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
  });

  const accountLink = await stripe.accountLinks.create({
    account: connectedAccountId,
    refresh_url: `${getBaseUrl()}/app/settings/billing`,
    return_url: `${getBaseUrl()}/api/stripe/connect/return`,
    type: "account_onboarding",
  });

  return NextResponse.redirect(accountLink.url);
}

export async function GET() {
  return handleOnboarding();
}

export async function POST() {
  return handleOnboarding();
}