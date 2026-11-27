import "react-native-url-polyfill/auto";

import { createClient, type VerifyTokenHashParams } from "@supabase/supabase-js";
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

/**
 * Checks an emailed link's token on a client that saves nothing and tells nobody: the session it returns reaches the app (storage, auth events) only if the
 * caller accepts it with `supabase.auth.setSession`. A session for the wrong address is simply dropped.
 */
export function verifyEmailLink(params: VerifyTokenHashParams) {
  const verifier = createClient(supabaseUrl as string, supabaseAnonKey as string, {
    auth: {
      storageKey: `${storageKey}-link-check`,
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
      flowType: "pkce",
    },
  });

  return verifier.auth.verifyOtp(params);
}

export function clearPersistedSupabaseSessions() {
  return clearPersistedSessions([storageKey, `${storageKey}-code-verifier`]);
}
