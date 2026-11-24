import "react-native-url-polyfill/auto";

import { createClient } from "@supabase/supabase-js";
import { clearPersistedSessions, secureSessionStorage } from "@/lib/secureSessionStorage";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY");
}

// Stated explicitly because SecureStore keys cannot be enumerated at sign-out.
const storageKey = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: secureSessionStorage,
    storageKey,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    flowType: "pkce",
  },
});

export function clearPersistedSupabaseSessions() {
  return clearPersistedSessions([storageKey, `${storageKey}-code-verifier`]);
}

/**
 * True while this device has asked for a sign-in link (the PKCE verifier is written when the link is requested and removed when it is used or on sign-out).
 * A link that carries a token hash instead of a code is not bound to this device, so it is only honoured while a request is pending: otherwise any page or
 * app could open the callback with someone else's link and silently swap this person into another account.
 */
export async function hasPendingSignInRequest() {
  const verifier = await secureSessionStorage.getItem(`${storageKey}-code-verifier`).catch(() => null);
  return Boolean(verifier);
}
