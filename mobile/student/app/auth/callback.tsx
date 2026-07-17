import { router, useLocalSearchParams } from "expo-router";
import * as Linking from "expo-linking";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

function cleanParam(value: string | string[] | null | undefined) {
  const nextValue = Array.isArray(value) ? value[0] : value;
  return nextValue?.trim() || null;
}

function buildCallbackUrl(
  urls: Array<string | null | undefined>,
  routeParams: {
    access_token?: string | string[];
    code?: string | string[];
    error?: string | string[];
    error_description?: string | string[];
    refresh_token?: string | string[];
    token_hash?: string | string[];
    type?: string | string[];
  },
) {
  const merged = new URL("danceflow://auth/callback");

  for (const candidate of urls) {
    if (!candidate) continue;

    try {
      const parsed = new URL(candidate);

      for (const [key, value] of parsed.searchParams.entries()) {
        if (!merged.searchParams.has(key)) {
          merged.searchParams.set(key, value);
        }
      }

      const fragmentParams = new URLSearchParams(
        parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash,
      );

      for (const [key, value] of fragmentParams.entries()) {
        if (!merged.searchParams.has(key)) {
          merged.searchParams.set(key, value);
        }
      }
    } catch {
      // Ignore malformed candidates and continue with the remaining sources.
    }
  }

  for (const [key, value] of Object.entries(routeParams)) {
    const cleaned = cleanParam(value);
    if (cleaned && !merged.searchParams.has(key)) {
      merged.searchParams.set(key, cleaned);
    }
  }

  const hasAuthData =
    merged.searchParams.has("code") ||
    merged.searchParams.has("token_hash") ||
    (merged.searchParams.has("access_token") &&
      merged.searchParams.has("refresh_token"));

  return hasAuthData ? merged.toString() : null;
}

async function waitForSession() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (data.session?.access_token) return data.session;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return null;
}

export default function AuthCallbackScreen() {
  const { handleAuthUrl, session } = useAuth();
  const callbackUrl = Linking.useURL();
  const routeParams = useLocalSearchParams<{
    access_token?: string | string[];
    code?: string | string[];
    error?: string | string[];
    error_description?: string | string[];
    refresh_token?: string | string[];
    token_hash?: string | string[];
    type?: string | string[];
  }>();
  const attemptedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [initialUrl, setInitialUrl] = useState<string | null>(null);

  useEffect(() => {
    Linking.getInitialURL()
      .then((url) => setInitialUrl(url))
      .catch(() => setInitialUrl(null));
  }, []);

  useEffect(() => {
    if (session?.access_token) {
      router.replace("/(tabs)/home");
    }
  }, [session?.access_token]);

  useEffect(() => {
    let mounted = true;

    async function completeSignIn() {
      if (attemptedRef.current) return;

      const resolvedUrl = buildCallbackUrl(
        [callbackUrl, initialUrl],
        routeParams,
      );

      if (!resolvedUrl) return;

      attemptedRef.current = true;

      try {
        const routeError = cleanParam(routeParams.error);
        if (routeError) {
          throw new Error(
            cleanParam(routeParams.error_description) ||
              "The secure sign-in link could not be completed.",
          );
        }

        const handled = await handleAuthUrl(resolvedUrl);

        if (!handled) {
          throw new Error(
            "The sign-in link was incomplete or has already been used. Request a new link and try again.",
          );
        }

        const nextSession = await waitForSession();

        if (!nextSession) {
          throw new Error(
            "DanceFlow could not finish creating your session. Request a new link and try again.",
          );
        }

        if (mounted) {
          setError(null);
          router.replace("/(tabs)/home");
        }
      } catch (nextError) {
        if (!mounted) return;

        setError(
          nextError instanceof Error
            ? nextError.message
            : "DanceFlow could not finish signing you in.",
        );
      }
    }

    void completeSignIn();

    return () => {
      mounted = false;
    };
  }, [
    callbackUrl,
    initialUrl,
    handleAuthUrl,
    routeParams.access_token,
    routeParams.code,
    routeParams.error,
    routeParams.error_description,
    routeParams.refresh_token,
    routeParams.token_hash,
    routeParams.type,
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

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    flex: 1,
    gap: 12,
    justifyContent: "center",
  },
});