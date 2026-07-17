import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";

function cleanParam(value: string | string[] | null | undefined) {
  const nextValue = Array.isArray(value) ? value[0] : value;
  return nextValue?.trim() || null;
}

export default function AuthCallbackScreen() {
  const { session, loading } = useAuth();
  const routeParams = useLocalSearchParams<{
    error?: string | string[];
    error_code?: string | string[];
    error_description?: string | string[];
  }>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (session?.access_token) {
      router.replace("/(tabs)/home");
    }
  }, [session?.access_token]);

  useEffect(() => {
    const routeError =
      cleanParam(routeParams.error_description) ||
      cleanParam(routeParams.error);

    if (routeError) {
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

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    flex: 1,
    gap: 12,
    justifyContent: "center",
  },
});
