import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * PAY-DC-1: a studio-client membership Stripe object may only be touched in the exact
 * connected account that owns it. This check never calls Stripe and never falls back
 * to the platform account. It holds no secrets and only uses the Supabase client its
 * server-side callers (membership server actions, the payments webhook) pass in.
 *
 * A stored `stripe_account_id` of null is ambiguous (a legacy platform subscription, or
 * a connected subscription whose account was never recorded), so it is never assumed to
 * be either: it fails closed. A stored account that differs from the studio's connected
 * account also fails closed.
 */

export const MEMBERSHIP_PAYMENT_ACCOUNT_UNVERIFIED = "membership_payment_account_unverified";

export type MembershipStripeAccountResult =
  | { ok: true; stripeAccount: string }
  | { ok: false; code: typeof MEMBERSHIP_PAYMENT_ACCOUNT_UNVERIFIED };

function clean(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function resolveMembershipStripeAccount(input: {
  supabase: SupabaseClient;
  studioId: string;
  stripeAccountId: string | null | undefined;
}): Promise<MembershipStripeAccountResult> {
  const unverified = { ok: false, code: MEMBERSHIP_PAYMENT_ACCOUNT_UNVERIFIED } as const;

  const storedAccount = clean(input.stripeAccountId);
  if (!storedAccount) return unverified;

  const { data, error } = await input.supabase
    .from("studios")
    .select("stripe_connected_account_id")
    .eq("id", input.studioId)
    .maybeSingle<{ stripe_connected_account_id: string | null }>();

  if (error || !data) return unverified;

  const studioAccount = clean(data.stripe_connected_account_id);
  if (!studioAccount || studioAccount !== storedAccount) return unverified;

  return { ok: true, stripeAccount: storedAccount };
}
