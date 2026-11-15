import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { ScheduleSkeleton } from "@/components/Skeleton";
import { StaffErrorState } from "@/components/StaffErrorState";
import { StateMessage } from "@/components/StateMessage";
import { StatusBadge } from "@/components/StatusBadge";
import { appointmentTypeLabel, formatDayHeading, formatTimeRange } from "@/lib/format";
import { useStaffApi, useStaffSession } from "@/lib/staff";
import type { StaffPulse } from "@/lib/staffApi";
import { colors, radius, space, tabularNums } from "@/theme";

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; pulse: StaffPulse };

function Stat({ label, value, testID }: { label: string; value: number; testID: string }) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label}: ${value}`} testID={testID}>
      <AppText variant="heading" style={tabularNums}>
        {String(value)}
      </AppText>
      <AppText tone="muted">{label}</AppText>
    </View>
  );
}

function NextUp({ pulse, onOpen }: { pulse: StaffPulse; onOpen: () => void }) {
  const next = pulse.next;
  if (!next) {
    return (
      <AppText tone="muted" testID="pulse-next-none">
        Nothing else is scheduled.
      </AppText>
    );
  }
  const title = next.title || appointmentTypeLabel(next.appointmentType);
  const when = formatTimeRange(next.startsAt, next.endsAt, pulse.timeZone);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Next up: ${title}, ${when}`}
      accessibilityHint="Opens the appointment"
      onPress={onOpen}
      style={({ pressed }) => [styles.next, pressed && styles.nextPressed]}
      testID="pulse-next"
    >
      <AppText variant="lead">{title}</AppText>
      <AppText tone="muted" style={tabularNums}>
        {when}
      </AppText>
      <StatusBadge status={next.status} />
    </Pressable>
  );
}

export function PulseScreen() {
  const api = useStaffApi();
  const { workspace, reload: reloadWorkspaces, signOut } = useStaffSession();
  const studioId = workspace?.studioId ?? null;
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      if (!studioId) return;
      const id = ++requestId.current;
      if (mode === "initial") setState({ status: "loading" });
      else setRefreshing(true);
      try {
        const pulse = await api.pulse(studioId);
        if (id === requestId.current) setState({ status: "ready", pulse });
      } catch (error) {
        if (id === requestId.current) setState({ status: "error", error });
      } finally {
        if (id === requestId.current) setRefreshing(false);
      }
    },
    [api, studioId],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  const pulse = state.status === "ready" ? state.pulse : null;
  const notLinked = pulse !== null && pulse.scope === "own" && pulse.instructorId === null;

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load("refresh")} tintColor={colors.plum} />}>
      <View style={styles.header}>
        <AppText variant="label" tone="muted">
          {workspace?.publicName || workspace?.name || "Your studio"}
        </AppText>
        <AppText variant="heading" accessibilityRole="header">
          Pulse
        </AppText>
        {pulse ? (
          <AppText tone="muted">
            {pulse.scope === "studio" ? "Studio today" : "Your day"} · {formatDayHeading(pulse.date)}
          </AppText>
        ) : null}
      </View>

      {state.status === "loading" ? <ScheduleSkeleton rows={3} label="Loading the studio pulse" /> : null}

      {state.status === "error" ? (
        <StaffErrorState
          error={state.error}
          onRetry={() => void load("initial")}
          onSignInAgain={() => void signOut()}
          onRefreshWorkspaces={() => void reloadWorkspaces().then(() => load("initial"))}
        />
      ) : null}

      {notLinked ? (
        <StateMessage
          testID="pulse-not-linked"
          title="Not linked to an instructor profile"
          body="Your account is not connected to an instructor at this studio, so there is no day to summarise. Ask the studio owner to link your instructor profile."
          actions={[{ label: "Try again", onPress: () => void load("initial"), variant: "secondary" }]}
        />
      ) : null}

      {pulse && !notLinked ? (
        <>
          <View style={styles.card} testID="pulse-today">
            <AppText variant="label" tone="muted" accessibilityRole="header">
              Today
            </AppText>
            {pulse.today.total === 0 && pulse.today.cancelled === 0 ? (
              <AppText testID="pulse-today-empty">Nothing on the schedule today.</AppText>
            ) : (
              <View style={styles.stats}>
                <Stat label={pulse.today.total === 1 ? "appointment" : "appointments"} value={pulse.today.total} testID="pulse-total" />
                <Stat label="still to come" value={pulse.today.upcoming} testID="pulse-upcoming" />
                {pulse.today.cancelled > 0 ? <Stat label="cancelled" value={pulse.today.cancelled} testID="pulse-cancelled" /> : null}
              </View>
            )}
            {pulse.today.truncated ? (
              <AppText variant="caption" tone="muted" testID="pulse-truncated">
                Counts cover the first 500 appointments of the day.
              </AppText>
            ) : null}
          </View>

          <View style={styles.card}>
            <AppText variant="label" tone="muted" accessibilityRole="header">
              Next up
            </AppText>
            <NextUp
              pulse={pulse}
              onOpen={() => {
                if (pulse.next && studioId) {
                  router.push({ pathname: "/appointments/[id]", params: { id: pulse.next.id, studioId, tz: pulse.timeZone } });
                }
              }}
            />
          </View>

          {pulse.newClientsLast7Days !== null ? (
            <View style={styles.card}>
              <AppText variant="label" tone="muted" accessibilityRole="header">
                Clients
              </AppText>
              <Stat label="new in the last 7 days" value={pulse.newClientsLast7Days} testID="pulse-new-clients" />
            </View>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.xs },
  card: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: space.xl },
  stat: { gap: 2, minWidth: 96 },
  next: {
    minHeight: 44,
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.row,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  nextPressed: { backgroundColor: colors.tint },
});
