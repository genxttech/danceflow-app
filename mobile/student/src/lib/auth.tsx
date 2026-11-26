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
import type { EmailOtpType, Session } from "@supabase/supabase-js";
import { clearPersistedSupabaseSessions, supabase, verifyEmailLink } from "@/lib/supabase";
import { authErrorFacts } from "@/lib/errorKind";
import { reactivateDanceFlowAccount } from "@/lib/accountControls";
import {
  friendlyAuthLinkError,
  LinkNotRequestedError,
  parseAuthLink,
  parseAuthLinkError,
  resolveEmailOtpType
} from "@/lib/authLink";
import { clearPendingSignIn, markPendingSignIn, normalizeSignInEmail, readPendingSignIn } from "@/lib/pendingSignIn";
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

/** True only when the auth server answered and refused the session (4xx other than a timeout or a rate limit). Network failures, 5xx and unknown errors keep the session. */
export function serverRefusedSession(error: unknown): boolean {
  const { status, network } = authErrorFacts(error);
  if (network || status === null) return false;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function getMobileCallbackUrl() {
  return "danceflow://auth/callback";
}

/**
 * Records the request before sending it, so a link still works if the answer is lost on the way back. When the server answered with a
 * refusal (nothing was sent: a bad address, a rate limit), the earlier request is restored so its link keeps working.
 */
async function requestEmailLink(email: string, send: () => Promise<{ error: unknown }>) {
  const previous = await readPendingSignIn();
  await markPendingSignIn(email);
  const { error } = await send();
  if (!error) return;

  const { network, status } = authErrorFacts(error);
  if (!network && status !== null && status < 500) {
    if (previous) await markPendingSignIn(previous.email, previous.requestedAt);
    else await clearPendingSignIn();
  }
  throw error;
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
  // Emailed links are checked one at a time, so one pending request can accept only one link.
  const linkQueue = useRef<Promise<unknown>>(Promise.resolve());

  async function signInFromEmailLink(tokenHash: string, otpType: EmailOtpType) {
    // Checked before the token is used: without a request from this phone the token is not even spent.
    const pending = await readPendingSignIn();
    if (!pending) throw new LinkNotRequestedError();

    setIdentityCheckPending(true);

    try {
      const { data, error } = await verifyEmailLink({ token_hash: tokenHash, type: otpType });
      if (error) throw error;

      // A link for another address is dropped here: nothing was saved, and whoever was signed in stays signed in.
      if (!data.session || normalizeSignInEmail(data.user?.email ?? "") !== pending.email) throw new LinkNotRequestedError();

      const { error: sessionError } = await supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token
      });
      if (sessionError) throw sessionError;

      await clearPendingSignIn().catch(() => undefined);
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
  }

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

      const run = linkQueue.current.then(() => signInFromEmailLink(tokenHash, otpType));
      linkQueue.current = run.catch(() => undefined);
      await run;

      return true;
    }

    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) throw error;
      await clearPendingSignIn().catch(() => undefined);
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
        setAuthLinkError(friendlyAuthLinkError(error));
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

        // Only the auth server refusing this session (an invalid or revoked token) ends it. A failed request (offline, a flaky network right after the
        // phone wakes or the app starts, a 5xx, a rate limit) says nothing about the session: signing out and wiping it here would log the dancer out
        // every time the app starts without a connection.
        if (!userData.user && !userError) {
          await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
          await clearPersistedSupabaseSessions().catch(() => undefined);
          setSession(null);
          return;
        }
        if (userError && serverRefusedSession(userError)) {
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
    await requestEmailLink(email, () =>
      supabase.auth.signInWithOtp({
        email: normalizeEmail(email),
        options: {
          emailRedirectTo: getMobileCallbackUrl(),
          // New or returning: the mailbox link is what proves the address, and the
          // first proof still requires binding (LAUNCH-SEC-1C-A), same as web sign-up.
          shouldCreateUser: true,
          data: { signup_intent: "public" },
        },
      }),
    );
  }, []);

  const sendPasswordReset = useCallback(async (email: string) => {
    await requestEmailLink(email, () => supabase.auth.resetPasswordForEmail(normalizeEmail(email)));
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
      await clearPendingSignIn().catch(() => undefined);
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