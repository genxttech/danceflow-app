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

function valueFromParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default function AuthCallbackScreen() {
  const [error, setError] = useState<string | null>(null);
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
        const code = params?.get("code") || valueFromParam(routeParams.code);
        const accessToken =
          params?.get("access_token") || valueFromParam(routeParams.access_token);
        const refreshToken =
          params?.get("refresh_token") || valueFromParam(routeParams.refresh_token);
        const tokenHash =
          params?.get("token_hash") || valueFromParam(routeParams.token_hash);
        const otpType = params?.get("type") || valueFromParam(routeParams.type);
        const callbackError =
          params?.get("error_description") ||
          params?.get("error") ||
          valueFromParam(routeParams.error_description) ||
          valueFromParam(routeParams.error);

        if (callbackError) {
          throw new Error(callbackError);
        }

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
          const { data, error: sessionLookupError } = await supabase.auth.getSession();
          if (sessionLookupError) throw sessionLookupError;
          if (!data.session) {
            throw new Error("Missing sign-in session. Open the latest magic link again.");
          }
        }

        if (mounted) {
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
