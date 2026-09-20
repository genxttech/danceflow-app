import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * Whether the current request has a signed-in user, for public chrome only.
 *
 * Mirrors the existing page convention: read `data.user` and ignore the returned
 * `error` (Supabase reports "no session" as `user === null`). Unexpected exceptions
 * are deliberately not caught so they surface through normal server error handling
 * instead of masquerading as a signed-out visitor.
 *
 * `cache()` only deduplicates callers of this helper; independent direct
 * `supabase.auth.getUser()` calls elsewhere are separate lookups.
 */
export const getPublicAuthState = cache(async (): Promise<boolean> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return Boolean(user);
});
