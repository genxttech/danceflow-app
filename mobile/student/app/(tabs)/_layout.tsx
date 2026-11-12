import { Ionicons } from "@expo/vector-icons";
import { Redirect, Tabs } from "expo-router";
import { ActivityIndicator, StyleSheet, useColorScheme, useWindowDimensions, View, type ColorValue } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colorsForScheme } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { TAB_ICON_SIZE, TAB_LABEL_FONT_SIZE, tabBarMetrics } from "@/lib/tabBar";

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
