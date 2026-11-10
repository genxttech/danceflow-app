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
