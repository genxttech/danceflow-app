import { useEffect } from "react";
import { useColorScheme } from "react-native";
import { Stack, usePathname, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StripeProvider } from "@stripe/stripe-react-native";
import { AuthProvider, useAuth } from "@/lib/auth";
import { guestMayView } from "@/lib/guestAccess";
import { rememberPostSignInRoute } from "@/lib/postSignInRoute";
import { usePushNotificationBootstrap } from "@/lib/pushNotifications";
import { colorsForScheme, hydrateAppearanceMode } from "@/constants/theme";

const stripePublishableKey = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY || "";

function AppStack() {
  const { loading, session } = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const pathname = usePathname();
  const scheme = useColorScheme();
  const colors = colorsForScheme(scheme);

  usePushNotificationBootstrap(session?.user.id);

  useEffect(() => {
    hydrateAppearanceMode();
  }, []);

  // Guest discovery: a signed-out visitor may open public screens only (see guestAccess). Anything
  // else, including a deep link to Wallet or a ticket, goes to sign-in.
  const blockedForGuest = !loading && !session && !guestMayView(segments);
  useEffect(() => {
    if (!blockedForGuest) return;
    // A deep link to a gated screen (a registration, an order) returns there after sign-in; routes
    // outside postSignInRoute's allow-list are dropped there and fall back to Today.
    void rememberPostSignInRoute(pathname).then(() => router.replace("/(auth)/sign-in"));
  }, [blockedForGuest, pathname, router]);

  return (
    <>
      <StatusBar style={scheme === "light" ? "dark" : "light"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: "slide_from_right",
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
          headerTitleStyle: { color: colors.text, fontWeight: "800" },
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen name="index" />
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
          name="partners/index"
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
          name="jobs/index"
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
          name="discover/events/index"
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
          name="studios/[id]/index"
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
            // The redesigned hero is full-bleed with its own back button.
            headerShown: false,
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
