import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { router } from "expo-router";
import * as Linking from "expo-linking";
import type { Session } from "@supabase/supabase-js";
import { clearPersistedSupabaseSessions, supabase } from "@/lib/supabase";
import { reactivateDanceFlowAccount } from "@/lib/accountControls";
import {
  friendlyAuthLinkError,
  parseAuthLink,
  parseAuthLinkError,
  resolveEmailOtpType
} from "@/lib/authLink";
import { recordMobileEmailProof } from "@/lib/emailVerification";
import { unbindPushTokenForSignOut } from "@/lib/pushNotifications";

type AuthContextValue = {
  session: Session | null;
  loading: boolean;
  identityCheckPending: boolean;
  emailBindingRequired: boolean;
  /** Plain-language reason the last emailed link could not sign the dancer in (expired, used, refused). */
  authLinkError: string | null;
  clearAuthLinkError: () => void;
  clearEmailBindingRequired: () => void;
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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [identityCheckPending, setIdentityCheckPending] = useState(false);
  const [emailBindingRequired, setEmailBindingRequired] = useState(false);
  const [authLinkError, setAuthLinkError] = useState<string | null>(null);
  // A link can reach the app twice (the initial URL and the url event on a cold start); a token is
  // single use, so the second verification would fail and show an error for a sign-in that worked.
  const handledUrls = useRef(new Map<string, Promise<boolean>>());

  async function processAuthUrl(url: string) {
    const linkError = parseAuthLinkError(url);
    if (linkError) {
      setAuthLinkError(linkError.message);
      return true;
    }

    const { code, tokenHash, type } = parseAuthLink(url);

    if (tokenHash) {
      const otpType = resolveEmailOtpType(type);
      if (!otpType) throw new Error("This sign-in link type is not supported.");

      setIdentityCheckPending(true);

      try {
        const { error } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: otpType
        });
        if (error) throw error;
        setAuthLinkError(null);

        // LAUNCH-SEC-1C-A: only this app-performed email-link verification may
        // record proof; the database decides. A first proof requires binding.
        if ((await recordMobileEmailProof()) === "binding_required") {
          await supabase.auth.signOut({ scope: "others" }).catch(() => undefined);
          setEmailBindingRequired(true);
        }
      } finally {
        setIdentityCheckPending(false);
      }

      return true;
    }

    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) throw error;
      setAuthLinkError(null);
      return true;
    }

    return false;
  }

  const handleAuthUrl = useCallback((url: string) => {
    const existing = handledUrls.current.get(url);
    if (existing) return existing;

    const run = processAuthUrl(url);
    handledUrls.current.set(url, run);
    return run;
  }, []);

  /** Runs a link and records why it failed, for the callback screen. Never throws. */
  const handleAuthUrlReportingErrors = useCallback(
    async (url: string) => {
      try {
        await handleAuthUrl(url);
      } catch (error: unknown) {
        const code = (error as { code?: string } | null)?.code;
        setAuthLinkError(friendlyAuthLinkError(code, error instanceof Error ? error.message : null));
        console.warn(
          "DanceFlow could not process the incoming authentication link:",
          error instanceof Error ? error.message : error,
        );
      }
    },
    [handleAuthUrl],
  );

  useEffect(() => {
    let mounted = true;

    const linkingSubscription = Linking.addEventListener("url", ({ url }) => {
      void handleAuthUrlReportingErrors(url);
    });

    async function bootstrap() {
      try {
        const initialUrl = await Linking.getInitialURL();

        if (initialUrl) {
          await handleAuthUrlReportingErrors(initialUrl);
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

        try {
          await reactivateDanceFlowAccount();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Reactivation failed.";

          if (message === "Account deletion is in progress.") {
            await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
            await clearPersistedSupabaseSessions().catch(() => undefined);
            setSession(null);
            return;
          }

          console.warn("DanceFlow account reactivation check failed:", message);
        }

        setSession(data.session);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    void bootstrap();

    const authSubscription = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (nextSession?.access_token) {
        void reactivateDanceFlowAccount()
          .then(() => {
            setSession(nextSession);
            setLoading(false);
          })
          .catch(async (error: unknown) => {
            const message =
              error instanceof Error ? error.message : "Reactivation failed.";

            if (message === "Account deletion is in progress.") {
              await supabase.auth
                .signOut({ scope: "local" })
                .catch(() => undefined);
              await clearPersistedSupabaseSessions().catch(() => undefined);
              setSession(null);
              setLoading(false);
              return;
            }

            console.warn("DanceFlow account reactivation check failed:", message);
            setSession(nextSession);
            setLoading(false);
          });
        return;
      }

      setSession(nextSession);
      setLoading(false);
    }).data.subscription;

    return () => {
      mounted = false;
      linkingSubscription.remove();
      authSubscription.unsubscribe();
    };
  }, [handleAuthUrlReportingErrors]);

  const continueWithEmail = useCallback(async (email: string) => {
    const { error } = await supabase.auth.signInWithOtp({
      email: normalizeEmail(email),
      options: {
        emailRedirectTo: getMobileCallbackUrl(),
        // New or returning: the mailbox link is what proves the address, and the
        // first proof still requires binding (LAUNCH-SEC-1C-A), same as web sign-up.
        shouldCreateUser: true,
        data: { signup_intent: "public" },
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
    // While this session can still prove ownership of the device row (RLS).
    await unbindPushTokenForSignOut();
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

  const clearAuthLinkError = useCallback(() => setAuthLinkError(null), []);
  const clearEmailBindingRequired = useCallback(() => setEmailBindingRequired(false), []);

  const value = useMemo(
    () => ({
      session,
      loading,
      identityCheckPending,
      emailBindingRequired,
      authLinkError,
      clearAuthLinkError,
      clearEmailBindingRequired,
      continueWithEmail,
      handleAuthUrl,
      sendPasswordReset,
      signOut
    }),
    [
      authLinkError,
      clearAuthLinkError,
      clearEmailBindingRequired,
      continueWithEmail,
      emailBindingRequired,
      handleAuthUrl,
      identityCheckPending,
      loading,
      sendPasswordReset,
      session,
      signOut
    ]
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