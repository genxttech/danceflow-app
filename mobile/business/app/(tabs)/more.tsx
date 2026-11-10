import { Pressable, StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { StateMessage } from "@/components/StateMessage";
import { isServedRole, roleLabel } from "@/lib/navigation";
import { useStaffSession } from "@/lib/staff";
import { colors, radius, space } from "@/theme";

export default function MoreScreen() {
  const { me, workspace, selectWorkspace, reload, signOut } = useStaffSession();
  const workspaces = me?.workspaces ?? [];

  return (
    <Screen>
      <AppText variant="heading" accessibilityRole="header">
        More
      </AppText>

      {me ? (
        <View style={styles.card}>
          <AppText variant="lead">{me.user.fullName || me.user.email || "Signed in"}</AppText>
          {me.user.fullName && me.user.email ? <AppText tone="muted">{me.user.email}</AppText> : null}
        </View>
      ) : null}

      {workspace && !workspace.accessAllowed ? (
        <StateMessage
          tone="error"
          testID="workspace-paused"
          title="This studio is paused"
          body="The studio's subscription needs attention. The owner can resolve billing on the web."
        />
      ) : null}

      {workspace && workspace.accessAllowed && !isServedRole(workspace.role) ? (
        <StateMessage
          testID="workspace-unsupported"
          title="Not in DanceFlow Business yet"
          body={`${roleLabel(workspace.role)} accounts are not supported in the app yet. Use DanceFlow on the web.`}
        />
      ) : null}

      <View style={styles.section}>
        <AppText variant="label" tone="muted" accessibilityRole="header">
          {workspaces.length > 1 ? "Your studios" : "Your studio"}
        </AppText>
        {workspaces.map((item) => {
          const selected = item.studioId === workspace?.studioId;
          const status = item.accessAllowed ? roleLabel(item.role) : `${roleLabel(item.role)} · Paused`;
          return (
            <Pressable
              key={item.studioId}
              accessibilityRole="radio"
              accessibilityState={{ selected, checked: selected }}
              accessibilityLabel={`${item.publicName || item.name}, ${status}`}
              onPress={() => selectWorkspace(item.studioId)}
              style={[styles.row, selected && styles.rowSelected]}
            >
              <View style={styles.rowBody}>
                <AppText variant="lead">{item.publicName || item.name}</AppText>
                <AppText tone="muted">{status}</AppText>
              </View>
              {selected ? (
                <AppText variant="label" tone="plum">
                  Current
                </AppText>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      <View style={styles.section}>
        <AppButton label="Refresh studios" variant="secondary" onPress={() => void reload()} />
        <AppButton label="Sign out" variant="secondary" onPress={() => void signOut()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: space.xs,
    padding: space.lg,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
  section: { gap: space.sm },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.md,
    padding: space.lg,
    minHeight: 48,
    borderRadius: radius.row,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
  rowSelected: { borderColor: colors.plum, borderWidth: 1.5 },
  rowBody: { flex: 1, minWidth: 160, gap: 2 },
});
