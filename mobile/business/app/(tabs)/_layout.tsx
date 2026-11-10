import { Feather } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { ScheduleSkeleton } from "@/components/Skeleton";
import { Screen } from "@/components/Screen";
import { StaffErrorState } from "@/components/StaffErrorState";
import { StateMessage } from "@/components/StateMessage";
import { initialTab, tabsForWorkspace, type TabKey } from "@/lib/navigation";
import { useStaffSession } from "@/lib/staff";
import { colors } from "@/theme";

const TAB_META: Record<TabKey, { title: string; icon: keyof typeof Feather.glyphMap }> = {
  pulse: { title: "Pulse", icon: "activity" },
  today: { title: "Today", icon: "calendar" },
  clients: { title: "Clients", icon: "users" },
  more: { title: "More", icon: "menu" },
};

const TAB_ORDER: TabKey[] = ["pulse", "today", "clients", "more"];

export default function TabsLayout() {
  const { me, loading, error, workspace, reload, signOut } = useStaffSession();

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
    <Tabs
      key={workspace?.studioId ?? "none"}
      initialRouteName={initialTab(workspace)}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.plum,
        tabBarInactiveTintColor: colors.muted,
        // No fixed height: the default clips labels with larger system fonts and at 200% text.
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border, height: "auto", paddingTop: 4 },
        tabBarLabelStyle: { fontWeight: "600", paddingBottom: 4 },
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
  );
}
