import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";
import { router } from "expo-router";
import * as Linking from "expo-linking";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

type AuthContextValue = {
  session: Session | null;
  loading: boolean;
  continueWithEmail: (email: string) => Promise<void>;
  handleAuthUrl: (url: string) => Promise<boolean>;
  sendPasswordReset: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function getMobileCallbackUrl() {
  return "danceflow://auth/callback";
}

function extractAuthParams(url: string) {
  const normalized = url.replace("#", "?");

  try {
    const parsed = new URL(normalized);
    return {
      code: parsed.searchParams.get("code"),
      tokenHash: parsed.searchParams.get("token_hash"),
      type: parsed.searchParams.get("type"),
      accessToken: parsed.searchParams.get("access_token"),
      refreshToken: parsed.searchParams.get("refresh_token")
    };
  } catch (_error) {
    return {
      code: null,
      tokenHash: null,
      type: null,
      accessToken: null,
      refreshToken: null
    };
  }
}


async function clearPersistedSupabaseSessions() {
  const keys = await AsyncStorage.getAllKeys();
  const authKeys = keys.filter(
    (key) =>
      key.startsWith("sb-") &&
      (key.endsWith("-auth-token") || key.includes("-auth-token-"))
  );

  if (authKeys.length) {
    await AsyncStorage.multiRemove(authKeys);
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const handleAuthUrl = useCallback(async (url: string) => {
    const { code, tokenHash, type, accessToken, refreshToken } = extractAuthParams(url);

    if (tokenHash) {
      const { error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: type === "recovery" ? "recovery" : "magiclink"
      });
      if (error) throw error;
      return true;
    }

    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) throw error;
      return true;
    }

    if (accessToken && refreshToken) {
      const { error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
      });
      if (error) throw error;
      return true;
    }

    return false;
  }, []);

  useEffect(() => {
    let mounted = true;

    const linkingSubscription = Linking.addEventListener("url", ({ url }) => {
      void handleAuthUrl(url).catch((error: unknown) => {
        console.warn(
          "DanceFlow could not process the incoming authentication link:",
          error instanceof Error ? error.message : error,
        );
      });
    });

    async function bootstrap() {
      try {
        const initialUrl = await Linking.getInitialURL();

        if (initialUrl) {
          await handleAuthUrl(initialUrl).catch((error: unknown) => {
            console.warn(
              "DanceFlow could not process the initial authentication link:",
              error instanceof Error ? error.message : error,
            );
          });
        }

        const { data } = await supabase.auth.getSession();
        if (!mounted) return;

        if (!data.session?.access_token) {
          setSession(null);
          return;
        }

        const { data: userData, error: userError } = await supabase.auth.getUser(
          data.session.access_token
        );

        if (userError || !userData.user) {
          await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
          await clearPersistedSupabaseSessions().catch(() => undefined);
          setSession(null);
          return;
        }

        setSession(data.session);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    void bootstrap();

    const authSubscription = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    }).data.subscription;

    return () => {
      mounted = false;
      linkingSubscription.remove();
      authSubscription.unsubscribe();
    };
  }, [handleAuthUrl]);

  const continueWithEmail = useCallback(async (email: string) => {
    const { error } = await supabase.auth.signInWithOtp({
      email: normalizeEmail(email),
      options: {
        emailRedirectTo: getMobileCallbackUrl(),
        shouldCreateUser: false,
      },
    });

    if (error) throw error;
  }, []);

  const sendPasswordReset = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(normalizeEmail(email));
    if (error) throw error;
  }, []);

  const signOut = useCallback(async () => {
    setLoading(true);
    setSession(null);

    try {
      const { error } = await supabase.auth.signOut({ scope: "local" });
      if (error) {
        console.warn("Supabase local sign-out returned an error:", error.message);
      }
    } finally {
      await clearPersistedSupabaseSessions().catch(() => undefined);
      setSession(null);
      setLoading(false);
      router.replace("/(auth)/sign-in");
    }
  }, []);

  const value = useMemo(
    () => ({ session, loading, continueWithEmail, handleAuthUrl, sendPasswordReset, signOut }),
    [continueWithEmail, handleAuthUrl, loading, sendPasswordReset, session, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider");
  }

  return context;
}