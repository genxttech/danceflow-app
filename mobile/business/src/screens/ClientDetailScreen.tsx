import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { ScheduleSkeleton } from "@/components/Skeleton";
import { StaffErrorState } from "@/components/StaffErrorState";
import { appointmentTypeLabel, clientStatusLabel, formatTime, personName } from "@/lib/format";
import { useStaffApi, useStaffSession } from "@/lib/staff";
import type { ClientDetail } from "@/lib/staffApi";
import { colors, radius, space, tabularNums } from "@/theme";

type LoadState = { status: "loading" } | { status: "error"; error: unknown } | { status: "ready"; client: ClientDetail };

/** In the studio's zone when the server sends one (promised for client detail); otherwise the device's. */
export function formatDateTime(iso: string, timeZone: string | null) {
  const zone = timeZone ?? undefined;
  let day: string;
  try {
    day = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: zone }).format(new Date(iso));
  } catch {
    day = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
  }
  return `${day}, ${formatTime(iso, zone)}`;
}

function remainingLabel(remaining: number | null) {
  if (remaining === null) return "Unlimited or not tracked";
  return remaining === 1 ? "1 remaining" : `${remaining} remaining`;
}

/** A front-desk summary: name, status and what is next. No money and no contact details (the staff API never returns them). */
export function ClientDetailScreen({ clientId, studioId }: { clientId: string; studioId: string }) {
  const api = useStaffApi();
  const { reload: reloadWorkspaces, signOut } = useStaffSession();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", client: await api.client(studioId, clientId) });
    } catch (error) {
      setState({ status: "error", error });
    }
  }, [api, studioId, clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === "loading") {
    return (
      <Screen edges={[]}>
        <ScheduleSkeleton rows={2} label="Loading the client" />
      </Screen>
    );
  }

  if (state.status === "error") {
    return (
      <Screen edges={[]}>
        <StaffErrorState
          error={state.error}
          onRetry={() => void load()}
          onSignInAgain={() => void signOut()}
          onRefreshWorkspaces={() => void reloadWorkspaces()}
        />
      </Screen>
    );
  }

  const { client } = state;
  const name = personName({ id: client.id, firstName: client.firstName, lastName: client.lastName }) ?? "Client";
  const status = clientStatusLabel(client.status);
  const next = client.nextAppointment;

  return (
    <Screen edges={[]}>
      <View style={styles.header}>
        <AppText variant="heading" accessibilityRole="header">
          {name}
        </AppText>
        {status ? <AppText tone="muted">{status}</AppText> : null}
      </View>

      <View style={styles.section}>
        <AppText variant="label" tone="muted" accessibilityRole="header">
          Next booking
        </AppText>
        {next && next.id ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${next.appointmentType ? appointmentTypeLabel(next.appointmentType) : "Appointment"}, ${formatDateTime(next.startsAt, client.timeZone)}`}
            accessibilityHint="Opens the appointment"
            onPress={() =>
              router.push({
                pathname: "/appointments/[id]",
                params: { id: next.id as string, studioId, ...(client.timeZone ? { tz: client.timeZone } : {}) },
              })
            }
            style={({ pressed }) => [styles.next, pressed && styles.pressed]}
          >
            <AppText variant="lead">{next.appointmentType ? appointmentTypeLabel(next.appointmentType) : "Appointment"}</AppText>
            <AppText tone="muted" style={tabularNums}>
              {formatDateTime(next.startsAt, client.timeZone)}
            </AppText>
          </Pressable>
        ) : next ? (
          <AppText style={tabularNums}>{formatDateTime(next.startsAt, client.timeZone)}</AppText>
        ) : (
          <AppText tone="muted">Nothing booked.</AppText>
        )}
      </View>

      <View style={styles.section} testID="client-packages">
        <AppText variant="label" tone="muted" accessibilityRole="header">
          Active packages
        </AppText>
        {client.activePackages.length === 0 ? <AppText tone="muted">No active packages.</AppText> : null}
        {client.activePackages.map((pkg, index) => (
          <View key={`${pkg.name}-${index}`} style={styles.pkg} accessible accessibilityLabel={`${pkg.name}, ${remainingLabel(pkg.remaining)}`}>
            <AppText style={styles.pkgName}>{pkg.name}</AppText>
            <AppText tone="muted" style={tabularNums}>
              {remainingLabel(pkg.remaining)}
            </AppText>
          </View>
        ))}
      </View>

      <AppText variant="caption" tone="muted">
        Contact details, prices and payments stay on DanceFlow for the web.
      </AppText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.xs },
  section: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
  next: { gap: 2, minHeight: 44, justifyContent: "center", paddingVertical: space.xs, borderRadius: radius.control },
  pressed: { backgroundColor: colors.tint },
  pkg: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: space.sm,
    paddingVertical: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  pkgName: { flexShrink: 1 },
});
