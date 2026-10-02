import type { SupabaseClient } from "@supabase/supabase-js";

/*
  LAUNCH-SEC-1C-B: read-only accessors for verified-email identity.

  - getMyVerifiedEmail(sessionClient): the CALLER's claim-eligible email
    (public.my_verified_email(): bound proof for the current auth email, live
    session created after binding). Use a client carrying the user's session.
  - getVerifiedEmailForUser(adminClient, userId): a TARGET user's bound
    current email (public.verified_email_for_user, service_role only). No
    session context; for staff/platform linking decisions.

  Both return a normalized email or null, and fail closed (null) on any error.
  Never substitute auth.users.email, email_confirmed_at or a JWT email claim.
*/

function normalized(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

export async function getMyVerifiedEmail(sessionClient: SupabaseClient): Promise<string | null> {
  try {
    const { data, error } = await sessionClient.rpc("my_verified_email");
    return error ? null : normalized(data);
  } catch {
    return null;
  }
}

export async function getVerifiedEmailForUser(
  adminClient: SupabaseClient,
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null;
  try {
    const { data, error } = await adminClient.rpc("verified_email_for_user", { p_user_id: userId });
    return error ? null : normalized(data);
  } catch {
    return null;
  }
}

/** True only when a verified email exists and equals the candidate exactly (normalized). */
export function verifiedEmailMatches(
  verifiedEmail: string | null | undefined,
  candidateEmail: string | null | undefined,
) {
  const verified = normalized(verifiedEmail);
  const candidate = normalized(candidateEmail);
  return Boolean(verified && candidate && verified === candidate);
}

/** Escapes LIKE wildcards so an ILIKE filter becomes case-insensitive exact equality. */
export function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
