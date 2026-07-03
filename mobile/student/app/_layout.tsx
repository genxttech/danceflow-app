import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider, useAuth } from "@/lib/auth";
import { usePushNotificationBootstrap } from "@/lib/pushNotifications";

function AppStack() {
  const { session } = useAuth();

  usePushNotificationBootstrap(session?.user.id);

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
