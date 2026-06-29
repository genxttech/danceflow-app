import { router, useLocalSearchParams } from "expo-router";
import * as Linking from "expo-linking";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import type { EmailOtpType } from "@supabase/supabase-js";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { supabase } from "@/lib/supabase";

function getAuthParams(url: string) {
  const parsed = new URL(url);
  const params = new URLSearchParams(parsed.search);

  if (parsed.hash) {
    const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    hashParams.forEach((value, key) => {
      params.set(key, value);
    });
  }

  return params;
}

function cleanParam(value: string | string[] | null | undefined) {
  const nextValue = Array.isArray(value) ? value[0] : value;
  return nextValue?.trim() || null;
}

async function getCurrentSessionWithRetry() {
  for (let index = 0; index < 4; index += 1) {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (data.session) return data.session;

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return null;
}

export default function AuthCallbackScreen() {
  const [error, setError] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<string | null>(null);
  const callbackUrl = Linking.useURL();
  const routeParams = useLocalSearchParams<{
    access_token?: string;
    code?: string;
    error?: string;
    error_description?: string;
    refresh_token?: string;
    token_hash?: string;
    type?: string;
  }>();

  useEffect(() => {
    let mounted = true;

    async function completeSignIn() {
      try {
        const url = callbackUrl || (await Linking.getInitialURL());
        const params = url ? getAuthParams(url) : null;
        const code = cleanParam(params?.get("code")) || cleanParam(routeParams.code);
        const accessToken =
          cleanParam(params?.get("access_token")) ||
          cleanParam(routeParams.access_token);
        const refreshToken =
          cleanParam(params?.get("refresh_token")) ||
          cleanParam(routeParams.refresh_token);
        const tokenHash =
          cleanParam(params?.get("token_hash")) ||
          cleanParam(routeParams.token_hash);
        const otpType =
          cleanParam(params?.get("type")) ||
          cleanParam(routeParams.type) ||
          "magiclink";
        const callbackError =
          cleanParam(params?.get("error_description")) ||
          cleanParam(params?.get("error")) ||
          cleanParam(routeParams.error_description) ||
          cleanParam(routeParams.error);

        setDebugInfo(
          [
            `callbackUrl: ${url ? "present" : "missing"}`,
            `callbackUrlPrefix: ${url?.slice(0, 80) ?? "none"}`,
            `code: ${code ? "present" : "missing"}`,
            `accessToken: ${accessToken ? "present" : "missing"}`,
            `refreshToken: ${refreshToken ? "present" : "missing"}`,
            `tokenHash: ${tokenHash ? `present length ${tokenHash.length}` : "missing"}`,
            `tokenHashPrefix: ${tokenHash?.slice(0, 8) ?? "none"}`,
            `otpType: ${otpType ?? "missing"}`,
            `callbackError: ${callbackError ?? "none"}`,
          ].join("\n")
        );

        const existingSession = await getCurrentSessionWithRetry();
        if (existingSession) {
          router.replace("/(tabs)/home");
          return;
        }

        if (callbackError) {
          throw new Error(callbackError);
        }

        try {
          if (code) {
            const { error: exchangeError } =
              await supabase.auth.exchangeCodeForSession(code);
            if (exchangeError) throw exchangeError;
          } else if (accessToken && refreshToken) {
            const { error: sessionError } = await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken
            });
            if (sessionError) throw sessionError;
          } else if (tokenHash && otpType) {
            const { error: verifyError } = await supabase.auth.verifyOtp({
              token_hash: tokenHash,
              type: otpType as EmailOtpType
            });
            if (verifyError) throw verifyError;
          } else {
            throw new Error("Missing sign-in session. Open the latest magic link again.");
          }
        } catch (authError) {
          const recoveredSession = await getCurrentSessionWithRetry();
          if (recoveredSession) {
            router.replace("/(tabs)/home");
            return;
          }

          throw authError;
        }

        const finalSession = await getCurrentSessionWithRetry();
        if (!finalSession) {
          throw new Error("Missing sign-in session. Open the latest magic link again.");
        }

        if (mounted) {
          setError(null);
          router.replace("/(tabs)/home");
        }
      } catch (err) {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : "Unable to finish sign in.");
      }
    }

    completeSignIn();

    return () => {
      mounted = false;
    };
  }, [callbackUrl, routeParams]);

  return (
    <Screen scroll={false}>
      <View style={styles.wrap}>
        {error ? (
          <>
            <AppText variant="title">Sign in needs another try</AppText>
            <AppText variant="caption">{error}</AppText>
            {debugInfo ? <AppText variant="caption">{debugInfo}</AppText> : null}
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
    justifyContent: "center"
  }
});
