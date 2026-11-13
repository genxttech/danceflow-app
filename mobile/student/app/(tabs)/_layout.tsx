import { Ionicons } from "@expo/vector-icons";
import { Redirect, Tabs, useSegments } from "expo-router";
import { ActivityIndicator, StyleSheet, useColorScheme, useWindowDimensions, View, type ColorValue } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colorsForScheme } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { guestMayView } from "@/lib/guestAccess";
import { TAB_BAR_BORDER_TOP, TAB_ICON_SIZE, TAB_LABEL_FONT_SIZE, tabBarMetrics } from "@/lib/tabBar";

type TabIconName = "today-outline" | "compass-outline" | "school-outline" | "wallet-outline";

function tabIcon(name: TabIconName) {
  return function Icon({ color }: { color: ColorValue }) {
    return <Ionicons color={color} name={name} size={TAB_ICON_SIZE} />;
  };
}

export default function TabsLayout() {
  const { loading, session } = useAuth();
  const colors = colorsForScheme(useColorScheme());
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const segments = useSegments();
  const tabBar = tabBarMetrics(fontScale, insets.bottom);

  if (loading) {
    return (
      <View
        accessibilityLabel="Loading DanceFlow"
        accessibilityRole="progressbar"
        style={[styles.loading, { backgroundColor: colors.background }]}
      >
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  // Signed out: only Discover is open (guest discovery). Today, Learn and Wallet need an account.
  const guest = !session;
  if (guest && !guestMayView(segments)) {
    return <Redirect href="/(auth)/sign-in" />;
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarHideOnKeyboard: true,
        tabBarLabelStyle: styles.tabLabel,
        tabBarItemStyle: styles.tabItem,
        tabBarAllowFontScaling: true,
        tabBarStyle: [
          styles.tabBar,
          // A guest has one tab, so there is nothing to switch between: no bar.
          guest && styles.tabBarHidden,
          {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
            shadowColor: colors.black,
            height: tabBar.height,
            paddingBottom: tabBar.paddingBottom,
            paddingTop: tabBar.paddingTop,
          },
        ]
      }}
    >
      {/*
        Approved navigation (docs/mobile/Mobile_Design_Direction.md): Today, Discover, Learn, Wallet.
        Schedule lives inside Today (its "Full schedule" link) and More behind Today's profile
        button. Both stay routes so links and deep links keep working; they just leave the tab bar.
      */}
      <Tabs.Screen
        name="home"
        options={{ ...(guest ? { href: null } : {}), title: "Today", tabBarIcon: tabIcon("today-outline"), tabBarAccessibilityLabel: "Today" }}
      />
      <Tabs.Screen
        name="discover"
        options={{ title: "Discover", tabBarIcon: tabIcon("compass-outline"), tabBarAccessibilityLabel: "Discover" }}
      />
      <Tabs.Screen
        name="learn"
        options={{ ...(guest ? { href: null } : {}), title: "Learn", tabBarIcon: tabIcon("school-outline"), tabBarAccessibilityLabel: "Learn" }}
      />
      <Tabs.Screen
        name="wallet"
        options={{ ...(guest ? { href: null } : {}), title: "Wallet", tabBarIcon: tabIcon("wallet-outline"), tabBarAccessibilityLabel: "Wallet" }}
      />
      <Tabs.Screen name="schedule" options={{ href: null, title: "Schedule" }} />
      <Tabs.Screen name="more" options={{ href: null, title: "More" }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  loading: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center"
  },
  tabBarHidden: { display: "none" },
  tabBar: {
    borderTopWidth: TAB_BAR_BORDER_TOP,
    elevation: 14,
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.08,
    shadowRadius: 18,
  },
  tabItem: {
    justifyContent: "flex-start",
  },
  tabLabel: {
    fontSize: TAB_LABEL_FONT_SIZE,
    fontWeight: "800",
  },
});
