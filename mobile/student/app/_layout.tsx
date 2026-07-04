import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider, useAuth } from "@/lib/auth";
import { usePushNotificationBootstrap } from "@/lib/pushNotifications";
import { hydrateAppearanceMode } from "@/constants/theme";

function AppStack() {
  const { session } = useAuth();

  usePushNotificationBootstrap(session?.user.id);

  useEffect(() => {
    hydrateAppearanceMode();
  }, []);

  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="lumi"
          options={{
            presentation: "modal",
            headerShown: true,
            title: "LUMI"
          }}
        />
        <Stack.Screen
          name="partners"
          options={{
            headerShown: true,
            title: "Partner Search"
          }}
        />
        <Stack.Screen
          name="partners/[threadId]"
          options={{
            headerShown: true,
            title: "Partner Messages"
          }}
        />
        <Stack.Screen
          name="jobs"
          options={{
            headerShown: true,
            title: "Now Hiring"
          }}
        />
        <Stack.Screen
          name="schedule/request"
          options={{
            headerShown: true,
            title: "Request Lesson"
          }}
        />
        <Stack.Screen
          name="discover/studios"
          options={{
            headerShown: true,
            title: "Studios"
          }}
        />
        <Stack.Screen
          name="discover/events"
          options={{
            headerShown: true,
            title: "Events"
          }}
        />
        <Stack.Screen
          name="events/[id]"
          options={{
            headerShown: true,
            title: "Event"
          }}
        />
        <Stack.Screen
          name="events/[id]/register"
          options={{
            headerShown: true,
            title: "Register"
          }}
        />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <AppStack />
    </AuthProvider>
  );
}
