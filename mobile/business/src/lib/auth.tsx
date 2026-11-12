import type React from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import * as Linking from "expo-linking";
import type { Session } from "@supabase/supabase-js";
import { clearPersistedSupabaseSessions, supabase } from "@/lib/supabase";
import { parseAuthLink, resolveEmailOtpType } from "@/lib/authLink";

/*
  Supabase email sign-in for staff, following the Student app's pattern (#438): the session
  lives in SecureStore (Keychain / Keystore) through secureSessionStorage, and incoming links
  are accepted only as a PKCE code or an email token hash.

  Differences from the Student app, on purpose:
  - No account is ever created here (`shouldCreateUser: false`): staff accounts come from a
    studio invitation on the web.
  - Password sign-in is offered as well, because staff already sign in to the web that way.
  - No push binding, reactivation or email-proof step yet; those are Student identity flows.
*/

type AuthContextValue = {
  session: Session | null;
  loading: boolean;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  sendSignInLink: (email: string) => Promise<void>;
  handleAuthUrl: (url: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  /** Ends every session of this account (all phones and browsers). Resolves false, still signed in here, if the server could not do it. */
  signOutEverywhere: () => Promise<boolean>;
  getAccessToken: () => Promise<string | null>;
  refreshAccessToken: () => Promise<string | null>;
  /** The last sign-in link: being exchanged, failed (bad, expired or empty link), or none in flight. Drives app/auth/callback. */
  linkStatus: LinkStatus;
};

export type LinkStatus = "idle" | "processing" | "failed";

/** A link the app should treat as a sign-in callback (not, say, the dev client's own expo-development-client URL). */
export function isAuthCallbackUrl(url: string) {
  const { code, tokenHash } = parseAuthLink(url);
  return Boolean(code || tokenHash) || /^danceflow-business:\/\/auth\/callback\b/.test(url) || /\/auth\/callback\b/.test(url);
}

const AuthContext = createContext<AuthContextValue | null>(null);

const CALLBACK_URL = "danceflow-business://auth/callback";

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

async function clearLocalSession() {
  await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
  await clearPersistedSupabaseSessions().catch(() => undefined);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [linkStatus, setLinkStatus] = useState<LinkStatus>("idle");

  const handleAuthUrl = useCallback(async (url: string) => {
    const { code, tokenHash, type } = parseAuthLink(url);

    if (tokenHash) {
      const otpType = resolveEmailOtpType(type);
      if (!otpType) throw new Error("This sign-in link type is not supported.");
      const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: otpType });
      if (error) throw error;
      return true;
    }

    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) throw error;
      return true;
    }

    return false;
  }, []);

  /** Exchanges a callback link and records the outcome; other links (the dev client's own) are left alone. */
  const processLink = useCallback(
    async (url: string) => {
      if (!isAuthCallbackUrl(url)) return;
      setLinkStatus("processing");
      try {
        const handled = await handleAuthUrl(url);
        // a callback with no code or token hash (or only raw tokens, which are never read) is a failed link
        setLinkStatus(handled ? "idle" : "failed");
      } catch (error) {
        console.warn("DanceFlow Business could not process a sign-in link:", error instanceof Error ? error.message : error);
        setLinkStatus("failed");
      }
    },
    [handleAuthUrl],
  );

  useEffect(() => {
    let mounted = true;

    const linking = Linking.addEventListener("url", ({ url }) => {
      void processLink(url);
    });

    async function bootstrap() {
      try {
        const initialUrl = await Linking.getInitialURL();
        if (initialUrl) await processLink(initialUrl);

        const { data } = await supabase.auth.getSession();
        if (!mounted) return;

        if (!data.session?.access_token) {
          setSession(null);
          return;
        }

        // A stored session is only trusted after the server accepts its token.
        const { data: userData, error } = await supabase.auth.getUser(data.session.access_token);
        if (!mounted) return;

        if (error || !userData.user) {
          // A network failure keeps the session; the staff API will say if it is really invalid.
          if (error && error.name === "AuthRetryableFetchError") {
            setSession(data.session);
            return;
          }
          await clearLocalSession();
          setSession(null);
          return;
        }

        setSession(data.session);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    void bootstrap();

    const subscription = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next?.access_token ? next : null);
      setLoading(false);
    }).data.subscription;

    return () => {
      mounted = false;
      linking.remove();
      subscription.unsubscribe();
    };
  }, [processLink]);

  const signInWithPassword = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email: normalizeEmail(email), password });
    if (error) throw error;
  }, []);

  const sendSignInLink = useCallback(async (email: string) => {
    const { error } = await supabase.auth.signInWithOtp({
      email: normalizeEmail(email),
      options: { emailRedirectTo: CALLBACK_URL, shouldCreateUser: false },
    });
    if (error) throw error;
  }, []);

  const signOut = useCallback(async () => {
    setSession(null);
    await clearLocalSession();
  }, []);

  const signOutEverywhere = useCallback(async () => {
    // supabase-js keeps the local session when the global revoke fails, so a failure leaves this device signed in and says so.
    const { error } = await supabase.auth.signOut({ scope: "global" });
    if (error) return false;
    setSession(null);
    await clearPersistedSupabaseSessions().catch(() => undefined);
    return true;
  }, []);

  const getAccessToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }, []);

  const refreshAccessToken = useCallback(async () => {
    const { data, error } = await supabase.auth.refreshSession();
    if (error || !data.session) return null;
    return data.session.access_token;
  }, []);

  const value = useMemo(
    () => ({
      session,
      loading,
      signInWithPassword,
      sendSignInLink,
      handleAuthUrl,
      signOut,
      signOutEverywhere,
      getAccessToken,
      refreshAccessToken,
      linkStatus,
    }),
    [session, loading, signInWithPassword, sendSignInLink, handleAuthUrl, signOut, signOutEverywhere, getAccessToken, refreshAccessToken, linkStatus],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
