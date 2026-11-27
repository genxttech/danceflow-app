import type React from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as Linking from "expo-linking";
import type { EmailOtpType, Session } from "@supabase/supabase-js";
import { clearPersistedSupabaseSessions, supabase, verifyEmailLink } from "@/lib/supabase";
import { LinkNotRequestedError, parseAuthLink, resolveEmailOtpType } from "@/lib/authLink";
import { clearPendingSignIn, markPendingSignIn, normalizeSignInEmail, readPendingSignIn } from "@/lib/pendingSignIn";

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

/**
 * Records the request before sending it, so a link still works if the answer is lost on the way back. When the server answered with a refusal (nothing was sent:
 * an unknown address, a rate limit), the earlier request is restored so its link keeps working.
 */
async function requestEmailLink(email: string, send: () => Promise<{ error: unknown }>) {
  const previous = await readPendingSignIn();
  await markPendingSignIn(email);
  const { error } = await send();
  if (!error) return;

  const { name, status } = error as { name?: string; status?: unknown };
  if (name !== "AuthRetryableFetchError" && typeof status === "number" && status > 0 && status < 500) {
    if (previous) await markPendingSignIn(previous.email, previous.requestedAt);
    else await clearPendingSignIn();
  }
  throw error;
}

/** How long sign-out waits for the clean-up that needs the session (push unbind) before going on without it. */
export const BEFORE_SIGN_OUT_TIMEOUT_MS = 5_000;

/** Runs the clean-up while the session is still valid. Sign-out never fails or hangs because of it (offline, push not set up). */
async function runBeforeSignOut(work?: () => Promise<void>) {
  if (!work) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, BEFORE_SIGN_OUT_TIMEOUT_MS);
  });
  await Promise.race([Promise.resolve().then(work), timeout]).catch(() => undefined);
  clearTimeout(timer);
}

export function AuthProvider({
  children,
  beforeSignOut,
  onSignOutRefused,
}: {
  children: React.ReactNode;
  beforeSignOut?: () => Promise<void>;
  /** Undoes the clean-up when "sign out of all devices" is refused and this device stays signed in. */
  onSignOutRefused?: () => Promise<void>;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [linkStatus, setLinkStatus] = useState<LinkStatus>("idle");

  // A link can reach the app twice (the initial URL and the url event on a cold start); a token is single use, so the second check would fail a sign-in that worked.
  const handledUrls = useRef(new Map<string, Promise<boolean>>());
  // Emailed links are checked one at a time, so one pending request can accept only one link.
  const linkQueue = useRef<Promise<unknown>>(Promise.resolve());

  const signInFromEmailLink = useCallback(async (tokenHash: string, otpType: EmailOtpType) => {
    // Checked before the token is used: without a request from this phone the token is not even spent.
    const pending = await readPendingSignIn();
    if (!pending) throw new LinkNotRequestedError();

    const { data, error } = await verifyEmailLink({ token_hash: tokenHash, type: otpType });
    if (error) throw error;

    // A link for another address is dropped here: nothing was saved, and whoever was signed in stays signed in.
    if (!data.session || normalizeSignInEmail(data.user?.email ?? "") !== pending.email) throw new LinkNotRequestedError();

    const { error: sessionError } = await supabase.auth.setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
    if (sessionError) throw sessionError;

    await clearPendingSignIn().catch(() => undefined);
  }, []);

  const exchangeAuthUrl = useCallback(
    async (url: string) => {
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
        return true;
      }

      return false;
    },
    [signInFromEmailLink],
  );

  const handleAuthUrl = useCallback(
    (url: string) => {
      const known = handledUrls.current.get(url);
      if (known) return known;
      const attempt = exchangeAuthUrl(url);
      handledUrls.current.set(url, attempt);
      // a failed attempt may be tried again (offline, or the request had not been made yet)
      attempt.catch(() => handledUrls.current.delete(url));
      return attempt;
    },
    [exchangeAuthUrl],
  );

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
    await requestEmailLink(email, () =>
      supabase.auth.signInWithOtp({
        email: normalizeEmail(email),
        options: { emailRedirectTo: CALLBACK_URL, shouldCreateUser: false },
      }),
    );
  }, []);

  const signOut = useCallback(async () => {
    await runBeforeSignOut(beforeSignOut);
    handledUrls.current.clear();
    setSession(null);
    await clearLocalSession();
    await clearPendingSignIn().catch(() => undefined);
  }, [beforeSignOut]);

  const signOutEverywhere = useCallback(async () => {
    await runBeforeSignOut(beforeSignOut);
    // supabase-js keeps the local session when the global revoke fails, so a failure leaves this device signed in and says so.
    const { error } = await supabase.auth.signOut({ scope: "global" });
    if (error) {
      void onSignOutRefused?.().catch(() => undefined);
      return false;
    }
    handledUrls.current.clear();
    setSession(null);
    await clearPersistedSupabaseSessions().catch(() => undefined);
    await clearPendingSignIn().catch(() => undefined);
    return true;
  }, [beforeSignOut, onSignOutRefused]);

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
