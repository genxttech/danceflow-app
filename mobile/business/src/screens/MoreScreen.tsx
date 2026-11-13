import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { StateMessage } from "@/components/StateMessage";
import { isServedRole, roleLabel } from "@/lib/navigation";
import { useStaffSession } from "@/lib/staff";
import type { StaffWorkspace } from "@/lib/staffApi";
import { colors, radius, space } from "@/theme";

function studioName(w: StaffWorkspace) {
  return w.publicName || w.name;
}

function studioStatus(w: StaffWorkspace) {
  if (!w.accessAllowed) return `${roleLabel(w.role)} · Paused`;
  if (!isServedRole(w.role)) return `${roleLabel(w.role)} · Web only`;
  return roleLabel(w.role);
}

type SignOutAllState = "idle" | "confirming" | "working" | "failed";

export function MoreScreen() {
  const { me, workspace, selectWorkspace, reload, signOut, signOutEverywhere } = useStaffSession();
  const workspaces = me?.workspaces ?? [];
  const [allState, setAllState] = useState<SignOutAllState>("idle");

  async function confirmSignOutEverywhere() {
    setAllState("working");
    const ok = await signOutEverywhere();
    // on success the root layout moves to sign-in; on failure this device is still signed in
    if (!ok) setAllState("failed");
  }

  return (
    <Screen>
      <AppText variant="heading" accessibilityRole="header">
        More
      </AppText>

      {me ? (
        <View style={styles.card} testID="profile">
          <AppText variant="label" tone="muted" accessibilityRole="header">
            Profile
          </AppText>
          <AppText variant="lead">{me.user.fullName || me.user.email || "Signed in"}</AppText>
          {me.user.fullName && me.user.email ? <AppText tone="muted">{me.user.email}</AppText> : null}
          {workspace ? (
            <AppText tone="muted">
              {roleLabel(workspace.role)} at {studioName(workspace)}
            </AppText>
          ) : null}
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

      {workspaces.length > 1 ? (
        <View style={styles.section} testID="studio-switcher">
          <AppText variant="label" tone="muted" accessibilityRole="header" nativeID="studio-switcher-label">
            Switch studio
          </AppText>
          <View accessibilityRole="radiogroup" accessibilityLabel="Switch studio" style={styles.section}>
            {workspaces.map((item) => {
              const selected = item.studioId === workspace?.studioId;
              return (
                <Pressable
                  key={item.studioId}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, checked: selected }}
                  aria-checked={selected}
                  accessibilityLabel={`${studioName(item)}, ${studioStatus(item)}`}
                  accessibilityHint={selected ? undefined : "Switches the app to this studio"}
                  onPress={() => selectWorkspace(item.studioId)}
                  style={({ pressed }) => [styles.row, selected && styles.rowSelected, pressed && styles.rowPressed]}
                  testID={`studio-${item.studioId}`}
                >
                  <View style={styles.rowBody}>
                    <AppText variant="lead">{studioName(item)}</AppText>
                    <AppText tone="muted">{studioStatus(item)}</AppText>
                  </View>
                  {selected ? (
                    <AppText variant="label" tone="plum">
                      ✓ Current
                    </AppText>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : workspace ? (
        <View style={styles.card} testID="single-studio">
          <AppText variant="label" tone="muted" accessibilityRole="header">
            Your studio
          </AppText>
          <AppText variant="lead">{studioName(workspace)}</AppText>
          <AppText tone="muted">{studioStatus(workspace)}</AppText>
        </View>
      ) : null}

      <View style={styles.section}>
        <AppButton label="Refresh studios" variant="secondary" onPress={() => void reload()} />
        <AppButton label="Sign out" variant="secondary" onPress={() => void signOut()} accessibilityHint="Signs out on this device only" />
      </View>

      <View style={styles.section} testID="sign-out-everywhere">
        {allState === "idle" ? (
          <AppButton
            label="Sign out of all devices"
            variant="quiet"
            onPress={() => setAllState("confirming")}
            accessibilityHint="Asks before ending your sessions everywhere"
          />
        ) : null}
        {allState === "confirming" || allState === "working" || allState === "failed" ? (
          <View style={styles.confirm} accessibilityRole="alert">
            <AppText variant="lead">Sign out of all devices?</AppText>
            <AppText tone="muted">This ends your DanceFlow sessions on every phone and browser, including this one.</AppText>
            {allState === "failed" ? (
              <AppText tone="error" testID="sign-out-everywhere-failed">
                Other devices could not be signed out. You are still signed in here. Check your connection and try again.
              </AppText>
            ) : null}
            <AppButton
              label="Sign out everywhere"
              onPress={() => void confirmSignOutEverywhere()}
              loading={allState === "working"}
            />
            <AppButton label="Cancel" variant="secondary" onPress={() => setAllState("idle")} disabled={allState === "working"} />
          </View>
        ) : null}
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
  rowPressed: { backgroundColor: colors.tint },
  rowBody: { flex: 1, minWidth: 160, gap: 2 },
  confirm: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
});
