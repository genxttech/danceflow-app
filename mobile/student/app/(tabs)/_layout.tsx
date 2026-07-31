import { Ionicons } from "@expo/vector-icons";
import { Redirect, Tabs } from "expo-router";
import { ActivityIndicator, Platform, StyleSheet, useColorScheme, View, type ColorValue } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colorsForScheme } from "@/constants/theme";
import { useAuth } from "@/lib/auth";

type TabIconName =
  | "home-outline"
  | "calendar-outline"
  | "school-outline"
  | "compass-outline"
  | "wallet-outline"
  | "menu-outline";

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
      <Tabs.Screen
        name="home"
        options={{ title: "Home", tabBarIcon: tabIcon("home-outline") }}
      />
      <Tabs.Screen
        name="schedule"
        options={{ title: "Schedule", tabBarIcon: tabIcon("calendar-outline") }}
      />
      <Tabs.Screen
        name="learn"
        options={{ title: "Learn", tabBarIcon: tabIcon("school-outline") }}
      />
      <Tabs.Screen
        name="discover"
        options={{ title: "Discover", tabBarIcon: tabIcon("compass-outline") }}
      />
      <Tabs.Screen
        name="wallet"
        options={{
          href: null,
          title: "Wallet",
          tabBarIcon: tabIcon("wallet-outline"),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{ title: "More", tabBarIcon: tabIcon("menu-outline") }}
      />
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
