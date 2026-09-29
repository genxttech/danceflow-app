import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";

const CONNECT_PROVISIONING_ROLES = new Set(["studio_owner", "studio_admin"]);

function canProvisionConnectedAccount(
  studioRole: string | null | undefined,
  isPlatformAdmin: boolean | null | undefined,
) {
  return Boolean(isPlatformAdmin) || CONNECT_PROVISIONING_ROLES.has(studioRole ?? "");
}

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

  // PAY-DC-2D (N2): the connected account id is server-write only. Only a studio
  // owner/admin (or platform admin) of this studio may provision it; this check
  // runs before any Stripe account is created or the service role is used.
  if (!canProvisionConnectedAccount(context.studioRole, context.isPlatformAdmin)) {
    return NextResponse.redirect(
      new URL("/app/settings/billing?error=connect_onboarding_unauthorized", getBaseUrl())
    );
  }

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

    // Written with the service role only while the stored account is still NULL,
    // so an existing connected account is never overwritten.
    const { data: saved, error: saveError } = await createAdminClient()
      .from("studios")
      .update({
        stripe_connected_account_id: account.id,
      })
      .eq("id", studioId)
      .is("stripe_connected_account_id", null)
      .select("id, stripe_connected_account_id")
      .maybeSingle();

    if (saveError || !saved || saved.stripe_connected_account_id !== account.id) {
      return NextResponse.redirect(
        new URL(
          "/app/settings/billing?error=save_connected_account_failed",
          getBaseUrl()
        )
      );
    }

    connectedAccountId = account.id;
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