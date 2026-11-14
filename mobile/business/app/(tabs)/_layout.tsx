import { Feather } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScheduleSkeleton } from "@/components/Skeleton";
import { Screen } from "@/components/Screen";
import { StaffErrorState } from "@/components/StaffErrorState";
import { StateMessage } from "@/components/StateMessage";
import { initialTab, tabsForWorkspace, type TabKey } from "@/lib/navigation";
import { useStaffSession } from "@/lib/staff";
import { colors } from "@/theme";
import { LayoutProbe } from "@/components/LayoutProbe";

/**
 * The tab bar's height for the system text size and the bottom inset. A fixed default clips the labels at 200%, and
 * height "auto" (fine on web) pushed the bar under Android's edge-to-edge gesture area (both found on the emulator).
 */
export function tabBarHeight(fontScale: number, bottomInset: number) {
  const icon = 24;
  const label = Math.ceil(12 * 1.35 * Math.max(1, fontScale));
  return 8 + icon + 4 + label + 8 + bottomInset;
}

const TAB_META: Record<TabKey, { title: string; icon: keyof typeof Feather.glyphMap }> = {
  pulse: { title: "Pulse", icon: "activity" },
  today: { title: "Today", icon: "calendar" },
  clients: { title: "Clients", icon: "users" },
  more: { title: "More", icon: "menu" },
};

const TAB_ORDER: TabKey[] = ["pulse", "today", "clients", "more"];

export default function TabsLayout() {
  const { me, loading, error, workspace, reload, signOut } = useStaffSession();
  const { fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  if (loading && !me) {
    return (
      <Screen>
        <ScheduleSkeleton rows={3} label="Loading your studios" />
      </Screen>
    );
  }

  if (error || !me) {
    return (
      <Screen>
        <StaffErrorState error={error} onRetry={() => void reload()} onSignInAgain={() => void signOut()} />
      </Screen>
    );
  }

  if (me.workspaces.length === 0) {
    return (
      <Screen>
        <StateMessage
          testID="no-workspaces"
          title="No studio staff access"
          body="This account is not on the staff of any studio. If you take lessons, use the DanceFlow app. If you work at a studio, ask the owner to invite this email."
          actions={[
            { label: "Check again", onPress: () => void reload(), variant: "secondary" },
            { label: "Sign out", onPress: () => void signOut() },
          ]}
        />
      </Screen>
    );
  }

  const visible = new Set(tabsForWorkspace(workspace));

  return (
    // Keyed by workspace so switching studios resets each tab's screen state.
    <LayoutProbe name="tabs">
    <Tabs
      key={workspace?.studioId ?? "none"}
      initialRouteName={initialTab(workspace)}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.plum,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          height: tabBarHeight(fontScale, insets.bottom),
          paddingTop: 8,
          paddingBottom: insets.bottom + 8,
        },
        tabBarLabelStyle: { fontWeight: "600" },
        sceneStyle: { backgroundColor: colors.surface },
      }}
    >
      {TAB_ORDER.map((key) => (
        <Tabs.Screen
          key={key}
          name={key}
          options={{
            title: TAB_META[key].title,
            tabBarAccessibilityLabel: TAB_META[key].title,
            tabBarIcon: ({ color, size }) => <Feather name={TAB_META[key].icon} color={color} size={size} />,
            // Hidden tabs are removed from the bar and from linking, not just greyed out.
            href: visible.has(key) ? undefined : null,
          }}
        />
      ))}
    </Tabs>
    </LayoutProbe>
  );
}
