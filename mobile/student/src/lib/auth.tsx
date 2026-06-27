import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";
import * as Linking from "expo-linking";
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

function extractAuthParams(url: string) {
  const normalized = url.replace("#", "?");

  try {
    const parsed = new URL(normalized);
    return {
      code: parsed.searchParams.get("code"),
      accessToken: parsed.searchParams.get("access_token"),
      refreshToken: parsed.searchParams.get("refresh_token")
    };
  } catch (_error) {
    return {
      code: null,
      accessToken: null,
      refreshToken: null
    };
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const handleAuthUrl = useCallback(async (url: string) => {
    const { code, accessToken, refreshToken } = extractAuthParams(url);

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

    async function bootstrap() {
      try {
        const initialUrl = await Linking.getInitialURL();
        if (initialUrl) {
          await handleAuthUrl(initialUrl);
        }

        const { data } = await supabase.auth.getSession();
        if (!mounted) return;
        setSession(data.session);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    bootstrap();

    const authSubscription = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    }).data.subscription;

    const urlSubscription = Linking.addEventListener("url", async ({ url }) => {
      try {
        await handleAuthUrl(url);
      } catch (_error) {
        // The sign-in screen will let the dancer request a fresh link.
      }
    });

    return () => {
      mounted = false;
      authSubscription.unsubscribe();
      urlSubscription.remove();
    };
  }, [handleAuthUrl]);

  const continueWithEmail = useCallback(async (email: string) => {
  const { error } = await supabase.auth.signInWithOtp({
    email: normalizeEmail(email),
    options: {
      emailRedirectTo: "danceflow://auth/callback",
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
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
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
