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

function formatDateTime(iso: string) {
  // The API gives no studio time zone outside Today (see the PR's API notes), so this falls back to the device's.
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
  return `${day}, ${formatTime(iso, undefined)}`;
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
        {next ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${appointmentTypeLabel(next.appointmentType)}, ${formatDateTime(next.startsAt)}`}
            accessibilityHint="Opens the appointment"
            onPress={() => router.push({ pathname: "/appointments/[id]", params: { id: next.id, studioId } })}
            style={({ pressed }) => [styles.next, pressed && styles.pressed]}
          >
            <AppText variant="lead">{appointmentTypeLabel(next.appointmentType)}</AppText>
            <AppText tone="muted" style={tabularNums}>
              {formatDateTime(next.startsAt)}
            </AppText>
          </Pressable>
        ) : (
          <AppText tone="muted">Nothing booked.</AppText>
        )}
      </View>

      <AppText variant="caption" tone="muted">
        Contact details, packages and payments stay on DanceFlow for the web.
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
  next: { gap: 2, paddingVertical: space.xs, borderRadius: radius.control },
  pressed: { backgroundColor: colors.tint },
});
