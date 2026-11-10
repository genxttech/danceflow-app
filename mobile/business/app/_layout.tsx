import type React from "react";
import { useMemo } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "@/lib/auth";
import { StaffApiProvider, StaffSessionProvider } from "@/lib/staff";
import { createStaffApi } from "@/lib/staffApi";
import { colors } from "@/theme";

const webUrl = process.env.EXPO_PUBLIC_DANCEFLOW_WEB_URL;

if (!webUrl) {
  throw new Error("Missing EXPO_PUBLIC_DANCEFLOW_WEB_URL");
}

function StaffProviders({ children }: { children: React.ReactNode }) {
  const { getAccessToken, refreshAccessToken, signOut, session } = useAuth();
  const api = useMemo(
    () => createStaffApi({ baseUrl: webUrl!, getAccessToken, refreshAccessToken }),
    [getAccessToken, refreshAccessToken],
  );

  return (
    <StaffApiProvider api={api}>
      {/* Keyed by user, so a different sign-in never sees the previous person's workspaces. */}
      <StaffSessionProvider key={session?.user.id ?? "signed-out"} signOut={signOut}>
        {children}
      </StaffSessionProvider>
    </StaffApiProvider>
  );
}

function RootNavigator() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <View style={styles.boot} accessible accessibilityRole="progressbar" accessibilityLabel="Starting DanceFlow Business">
        <ActivityIndicator color={colors.plum} />
      </View>
    );
  }

  const signedIn = !!session;

  const stack = (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.surface },
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.plum,
        headerTitleStyle: { color: colors.text, fontWeight: "700" },
        headerShadowVisible: false,
      }}
    >
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="index" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="appointments/[id]" options={{ headerShown: true, title: "Appointment", headerBackTitle: "Back" }} />
        <Stack.Screen name="clients/[id]" options={{ headerShown: true, title: "Client", headerBackTitle: "Clients" }} />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
    </Stack>
  );

  return signedIn ? <StaffProviders>{stack}</StaffProviders> : stack;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
});
