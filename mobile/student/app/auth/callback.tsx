import { router, useLocalSearchParams, type Href } from "expo-router";
import { useEffect, useMemo, useState, useRef } from "react";
import { ActivityIndicator, StyleSheet, useColorScheme, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { colorsForScheme, type ThemeColors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { takePostSignInRoute } from "@/lib/postSignInRoute";

function cleanParam(value: string | string[] | null | undefined) {
  const nextValue = Array.isArray(value) ? value[0] : value;
  return nextValue?.trim() || null;
}

export default function AuthCallbackScreen() {
  const colors = colorsForScheme(useColorScheme());
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { session, loading, identityCheckPending, emailBindingRequired } = useAuth();
  const routeParams = useLocalSearchParams<{
    error?: string | string[];
    error_code?: string | string[];
    error_description?: string | string[];
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
        void takePostSignInRoute().then((route) => router.replace((route ?? "/(tabs)/home") as Href));
      }
    }
  }, [emailBindingRequired, identityCheckPending, session?.access_token]);

  useEffect(() => {
    const routeError =
      cleanParam(routeParams.error_description) ||
      cleanParam(routeParams.error);

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
