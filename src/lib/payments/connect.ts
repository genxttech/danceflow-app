import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

export type StudioConnectStatus = {
  studioId: string;
  connectedAccountId: string | null;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  onboardingComplete: boolean;
};

export async function getStudioConnectStatus(): Promise<StudioConnectStatus> {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    throw new Error("No studio context found.");
  }

  const { data: studio, error } = await supabase
    .from("studios")
    .select(
      `
      id,
      stripe_connected_account_id,
      stripe_connect_details_submitted,
      stripe_connect_charges_enabled,
      stripe_connect_payouts_enabled,
      stripe_connect_onboarding_complete
    `
    )
    .eq("id", context.studioId)
    .single();

  if (error || !studio) {
    throw new Error("Studio billing profile not found.");
  }

  return {
    studioId: studio.id,
    connectedAccountId: studio.stripe_connected_account_id ?? null,
    detailsSubmitted: studio.stripe_connect_details_submitted ?? false,
    chargesEnabled: studio.stripe_connect_charges_enabled ?? false,
    payoutsEnabled: studio.stripe_connect_payouts_enabled ?? false,
    onboardingComplete: studio.stripe_connect_onboarding_complete ?? false,
  };
}

export async function requireStudioConnectReady() {
  const status = await getStudioConnectStatus();

  if (!status.connectedAccountId) {
    throw new Error("Stripe is not connected for this studio.");
  }

  if (!status.onboardingComplete) {
    throw new Error(
      "Stripe onboarding is incomplete. Finish payout setup in Billing before accepting payments."
    );
  }

  if (!status.payoutsEnabled) {
    throw new Error(
      "Stripe payouts are not enabled yet. Finish payout setup in Billing before accepting payments."
    );
  }

  return status;
}