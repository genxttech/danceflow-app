import { Ionicons } from "@expo/vector-icons";
import { Redirect, Tabs } from "expo-router";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";

type TabIconName =
  | "home-outline"
  | "calendar-outline"
  | "school-outline"
  | "compass-outline"
  | "wallet-outline";

function tabIcon(name: TabIconName) {
  return function Icon({ color, size }: { color: string; size: number }) {
    return <Ionicons color={color} name={name} size={size} />;
  };
}

export default function TabsLayout() {
  const { loading, session } = useAuth();

  if (loading) {
    return (
      <View style={styles.loading}>
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
        tabBarStyle: styles.tabBar
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
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: "center"
  },
  tabBar: {
    borderTopColor: colors.border
  }
});
