import { router, useLocalSearchParams, useRootNavigationState, type Href } from "expo-router";
import { useEffect, useMemo, useState, useRef } from "react";
import { ActivityIndicator, StyleSheet, useColorScheme, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { colorsForScheme, type ThemeColors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { continueAfterSignIn } from "@/lib/afterSignIn";

function cleanParam(value: string | string[] | null | undefined) {
  const nextValue = Array.isArray(value) ? value[0] : value;
  return nextValue?.trim() || null;
}

export default function AuthCallbackScreen() {
  const colors = colorsForScheme(useColorScheme());
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { session, loading, identityCheckPending, emailBindingRequired, authLinkError } = useAuth();
  const routeParams = useLocalSearchParams<{
    error?: string | string[];
    error_code?: string | string[];
    error_description?: string | string[];
    token_hash?: string | string[];
    code?: string | string[];
    type?: string | string[];
  }>();
  const [error, setError] = useState<string | null>(null);
  // Navigate once: a second run would find the return route already taken and fall back to Today.
  const navigated = useRef(false);

  useEffect(() => {
    if (session?.access_token && !identityCheckPending && !navigated.current) {
      navigated.current = true;
      if (emailBindingRequired) {
        router.replace("/auth/secure-account" as Href);
      } else {
        void continueAfterSignIn(router);
      }
    }
  }, [emailBindingRequired, identityCheckPending, session?.access_token]);

  // The one-time token or code is consumed by the auth provider; do not leave it in the route's
  // params (navigation state, crash reports) for the screen's lifetime.
  const hasRawCredential = Boolean(
    cleanParam(routeParams.token_hash) || cleanParam(routeParams.code) || cleanParam(routeParams.type),
  );
  // A cold start opens this screen before the root navigator has mounted; navigating then throws
  // ("Attempted to navigate before mounting the Root Layout") and crashes the app on a magic link.
  const navigationReady = Boolean(useRootNavigationState()?.key);
  useEffect(() => {
    if (!hasRawCredential || !navigationReady) return;
    try {
      router.setParams({ token_hash: undefined, code: undefined, type: undefined } as never);
    } catch {
      // Tidying the route is optional; never let it take the screen down.
    }
  }, [hasRawCredential, navigationReady]);

  useEffect(() => {
    // The provider's reason first: it is already plain language. A raw provider description is
    // never shown; the route only carries one when opened with an error query.
    const routeError =
      authLinkError ||
      (cleanParam(routeParams.error_code) || cleanParam(routeParams.error_description) || cleanParam(routeParams.error)
        ? "That sign-in link could not be used. Request a new link to continue."
        : null);

    if (routeError) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- route params arrive once per navigation
      setError(routeError);
      return;
    }

    if (session?.access_token || loading) return;

    const timeout = setTimeout(() => {
      setError(
        "DanceFlow received the link, but Supabase did not create a session. Request a fresh link and try again.",
      );
    }, 10_000);

    return () => clearTimeout(timeout);
  }, [
    authLinkError,
    loading,
    routeParams.error,
    routeParams.error_code,
    routeParams.error_description,
    session?.access_token,
  ]);

  return (
    <Screen scroll={false}>
      <View style={styles.wrap}>
        {error ? (
          <>
            <AppText variant="title">Sign in needs another try</AppText>
            <AppText variant="caption">{error}</AppText>
            <AppButton
              label="Request a new link"
              onPress={() => router.replace("/(auth)/sign-in")}
            />
          </>
        ) : (
          <>
            <ActivityIndicator color={colors.primary} size="large" />
            <AppText variant="title">Signing you in</AppText>
            <AppText variant="caption">
              DanceFlow is finishing your secure sign-in.
            </AppText>
          </>
        )}
      </View>
    </Screen>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: {
      alignItems: "center",
      flex: 1,
      gap: 12,
      justifyContent: "center",
    },
  });
}
