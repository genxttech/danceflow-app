import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * PAY-DC-4A: proves that a DanceFlow SaaS subscription belongs to the studio before any add-on
 * Stripe mutation or entitlement write.
 *
 * `studios.stripe_subscription_id` alone is not proof (it was tenant-writable before the PAY-DC-4A
 * lock). The subscription retrieved from Stripe must belong to the studio's server-written billing
 * customer, and any studio id in its metadata must be this studio. Read-only: the only Stripe call is
 * `subscriptions.retrieve`.
 */

export const SAAS_SUBSCRIPTION_UNVERIFIED = "saas_subscription_unverified" as const;

export type SaasSubscriptionOwnershipResult =
  | { ok: true; subscription: Stripe.Subscription }
  | { ok: false; code: typeof SAAS_SUBSCRIPTION_UNVERIFIED };

function customerIdOf(value: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id ?? null;
}

function trimmed(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The studio's billing customer, from server-written sources only (service-role reads). */
export async function loadTrustedStudioBillingCustomer(
  supabaseAdmin: SupabaseClient,
  studioId: string,
) {
  const { data: mapping, error: mappingError } = await supabaseAdmin
    .from("studio_billing_customers")
    .select("stripe_customer_id")
    .eq("studio_id", studioId)
    .maybeSingle<{ stripe_customer_id: string | null }>();

  if (mappingError) throw new Error(mappingError.message);

  const mapped = trimmed(mapping?.stripe_customer_id);
  if (mapped) return mapped;

  const { data: studio, error: studioError } = await supabaseAdmin
    .from("studios")
    .select("stripe_customer_id")
    .eq("id", studioId)
    .maybeSingle<{ stripe_customer_id: string | null }>();

  if (studioError) throw new Error(studioError.message);

  return trimmed(studio?.stripe_customer_id);
}

export async function verifyStudioSaasSubscription(params: {
  stripe: Stripe;
  supabaseAdmin: SupabaseClient;
  studioId: string;
  subscriptionId: string | null | undefined;
}): Promise<SaasSubscriptionOwnershipResult> {
  const subscriptionId = trimmed(params.subscriptionId);
  if (!subscriptionId) return { ok: false, code: SAAS_SUBSCRIPTION_UNVERIFIED };

  const trustedCustomerId = await loadTrustedStudioBillingCustomer(
    params.supabaseAdmin,
    params.studioId,
  );
  if (!trustedCustomerId) return { ok: false, code: SAAS_SUBSCRIPTION_UNVERIFIED };

  const subscription = await params.stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price"],
  });

  if (customerIdOf(subscription.customer) !== trustedCustomerId) {
    return { ok: false, code: SAAS_SUBSCRIPTION_UNVERIFIED };
  }

  const metadata = subscription.metadata ?? {};
  for (const key of ["studioId", "workspaceId"] as const) {
    const metadataStudioId = trimmed(metadata[key]);
    if (metadataStudioId && metadataStudioId !== params.studioId) {
      return { ok: false, code: SAAS_SUBSCRIPTION_UNVERIFIED };
    }
  }

  return { ok: true, subscription };
}
