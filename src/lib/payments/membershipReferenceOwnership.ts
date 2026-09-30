import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * PAY-DC-4A (G1): a connected-account subscription or invoice event may only reference a client and
 * membership of the studio already verified to own that Stripe account.
 *
 * Subscription metadata (`clientId`, `localMembershipId`) is authored on the studio's own Stripe
 * account, so after PAY-DC-2B proves the studio it still has to be proven that these ids belong to that
 * studio (and, when both are given, that the membership belongs to that client). Otherwise a crafted
 * subscription could book a payment or overwrite a membership period in another studio.
 */

export const SUBSCRIPTION_EVENT_MEMBERSHIP_MISMATCH = "subscription_event_membership_mismatch";

/** True only when every provided reference belongs to `studioId`. Lookup errors throw. */
export async function membershipReferencesBelongToStudio(
  supabase: SupabaseClient,
  params: {
    studioId: string;
    clientId?: string | null;
    membershipId?: string | null;
  },
) {
  const clientId = params.clientId || null;
  const membershipId = params.membershipId || null;

  if (clientId) {
    const { data: client, error } = await supabase
      .from("clients")
      .select("id")
      .eq("id", clientId)
      .eq("studio_id", params.studioId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!client) return false;
  }

  if (membershipId) {
    let query = supabase
      .from("client_memberships")
      .select("id")
      .eq("id", membershipId)
      .eq("studio_id", params.studioId);

    if (clientId) query = query.eq("client_id", clientId);

    const { data: membership, error } = await query.maybeSingle();

    if (error) throw new Error(error.message);
    if (!membership) return false;
  }

  return true;
}

/** Throws the fixed code (0 writes follow) when a connected event references another studio's rows. */
export async function assertMembershipReferencesBelongToStudio(
  supabase: SupabaseClient,
  params: {
    studioId: string;
    clientId?: string | null;
    membershipId?: string | null;
  },
) {
  if (!(await membershipReferencesBelongToStudio(supabase, params))) {
    throw new Error(SUBSCRIPTION_EVENT_MEMBERSHIP_MISMATCH);
  }
}
