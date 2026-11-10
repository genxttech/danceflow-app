import { Ionicons } from "@expo/vector-icons";
import { Redirect, Tabs } from "expo-router";
import { ActivityIndicator, Platform, StyleSheet, useColorScheme, View, type ColorValue } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colorsForScheme } from "@/constants/theme";
import { useAuth } from "@/lib/auth";

type TabIconName = "today-outline" | "compass-outline" | "school-outline" | "wallet-outline";

function tabIcon(name: TabIconName) {
  return function Icon({ color, size }: { color: ColorValue; size: number }) {
    return <Ionicons color={color} name={name} size={size} />;
  };
}

export default function TabsLayout() {
  const { loading, session } = useAuth();
  const colors = colorsForScheme(useColorScheme());
  const insets = useSafeAreaInsets();
  const tabBarBottomPadding = Math.max(
    insets.bottom,
    Platform.OS === "android" ? 16 : 12,
  );

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

  if (!session) {
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
          {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
            shadowColor: colors.black,
            height: 64 + tabBarBottomPadding,
            paddingBottom: tabBarBottomPadding,
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
        options={{ title: "Today", tabBarIcon: tabIcon("today-outline"), tabBarAccessibilityLabel: "Today" }}
      />
      <Tabs.Screen
        name="discover"
        options={{ title: "Discover", tabBarIcon: tabIcon("compass-outline"), tabBarAccessibilityLabel: "Discover" }}
      />
      <Tabs.Screen
        name="learn"
        options={{ title: "Learn", tabBarIcon: tabIcon("school-outline"), tabBarAccessibilityLabel: "Learn" }}
      />
      <Tabs.Screen
        name="wallet"
        options={{ title: "Wallet", tabBarIcon: tabIcon("wallet-outline"), tabBarAccessibilityLabel: "Wallet" }}
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
  tabBar: {
    borderTopWidth: 1,
    elevation: 14,
    paddingTop: 6,
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.08,
    shadowRadius: 18,
  },
  tabItem: {
    justifyContent: "flex-start",
    minHeight: 48,
    paddingTop: 2,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: "800",
  },
});
