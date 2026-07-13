import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StripeProvider } from "@stripe/stripe-react-native";
import { AuthProvider, useAuth } from "@/lib/auth";
import { usePushNotificationBootstrap } from "@/lib/pushNotifications";
import { hydrateAppearanceMode } from "@/constants/theme";

const stripePublishableKey = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY || "";

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
          name="partners/draft"
          options={{
            headerShown: true,
            title: "Draft Listing"
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
          name="learn/syllabus/[id]"
          options={{
            headerShown: true,
            title: "Syllabus Details"
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
          name="discover/events/all"
          options={{
            headerShown: true,
            title: "All Events"
          }}
        />
        <Stack.Screen
          name="discover/events/group-classes"
          options={{
            headerShown: true,
            title: "Group Classes"
          }}
        />
        <Stack.Screen
          name="discover/events/social-dances"
          options={{
            headerShown: true,
            title: "Social Dances"
          }}
        />
        <Stack.Screen
          name="discover/events/workshops"
          options={{
            headerShown: true,
            title: "Workshops"
          }}
        />
        <Stack.Screen
          name="discover/events/competitions"
          options={{
            headerShown: true,
            title: "Competitions"
          }}
        />
        <Stack.Screen
          name="discover/events/showcases"
          options={{
            headerShown: true,
            title: "Showcases"
          }}
        />
        <Stack.Screen
          name="discover/events/other"
          options={{
            headerShown: true,
            title: "Other Events"
          }}
        />
        <Stack.Screen
          name="studios/[id]"
          options={{
            headerShown: true,
            title: "Studio"
          }}
        />
        <Stack.Screen
          name="studios/[id]/overview"
          options={{
            headerShown: true,
            title: "Overview"
          }}
        />
        <Stack.Screen
          name="studios/[id]/about"
          options={{
            headerShown: true,
            title: "About"
          }}
        />
        <Stack.Screen
          name="studios/[id]/dance-styles"
          options={{
            headerShown: true,
            title: "Dance Styles"
          }}
        />
        <Stack.Screen
          name="studios/[id]/staff"
          options={{
            headerShown: true,
            title: "Staff"
          }}
        />
        <Stack.Screen
          name="studios/[id]/offerings"
          options={{
            headerShown: true,
            title: "Offerings"
          }}
        />
        <Stack.Screen
          name="studios/[id]/events"
          options={{
            headerShown: true,
            title: "Events"
          }}
        />
        <Stack.Screen
          name="studios/[id]/contact"
          options={{
            headerShown: true,
            title: "Contact"
          }}
        />
        <Stack.Screen
          name="wallet/documents"
          options={{
            headerShown: true,
            title: "Documents"
          }}
        />
        <Stack.Screen
          name="wallet/documents/[assignmentId]"
          options={{
            headerShown: true,
            title: "Review Document"
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
    <StripeProvider publishableKey={stripePublishableKey}>
      <AuthProvider>
        <AppStack />
      </AuthProvider>
    </StripeProvider>
  );
}
