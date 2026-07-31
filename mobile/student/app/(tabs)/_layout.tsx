import { Ionicons } from "@expo/vector-icons";
import { Redirect, Tabs } from "expo-router";
import { ActivityIndicator, Platform, StyleSheet, useColorScheme, View, type ColorValue } from "react-native";
import { colorsForScheme } from "@/constants/theme";
import { useAuth } from "@/lib/auth";

type TabIconName =
  | "home-outline"
  | "calendar-outline"
  | "school-outline"
  | "compass-outline"
  | "wallet-outline";

function tabIcon(name: TabIconName) {
  return function Icon({ color, size }: { color: ColorValue; size: number }) {
    return <Ionicons color={color} name={name} size={size} />;
  };
}

export default function TabsLayout() {
  const { loading, session } = useAuth();
  const colors = colorsForScheme(useColorScheme());

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
        options={{ title: "Wallet", tabBarIcon: tabIcon("wallet-outline") }}
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
    height: Platform.OS === "ios" ? 84 : 72,
    paddingBottom: Platform.OS === "ios" ? 20 : 10,
    paddingTop: 8,
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.08,
    shadowRadius: 18,
  },
  tabItem: {
    minHeight: 48,
    paddingVertical: 2,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: "800",
  },
});
