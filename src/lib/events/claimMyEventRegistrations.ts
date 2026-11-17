import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Claims the signed-in user's own unclaimed event registrations (those bought as a guest or by a studio) through the
 * database function public.claim_my_event_registrations() (migration 20270221090000).
 *
 * The function takes NO arguments: the account is auth.uid() and the email comes only from the verified, bound email proof,
 * so nothing here can name another user or email. It fails closed: a missing function (app deployed before the SQL), a
 * permission error, an unverified email or any other failure all mean "nothing claimed" and never throw or block the page.
 */
export async function claimMyEventRegistrations(client: Pick<SupabaseClient, "rpc">): Promise<number> {
  try {
    const { data, error } = await client.rpc("claim_my_event_registrations");
    if (error) return 0;
    return typeof data === "number" && Number.isFinite(data) && data > 0 ? Math.floor(data) : 0;
  } catch {
    return 0;
  }
}
