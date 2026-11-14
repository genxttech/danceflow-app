import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { ScheduleSkeleton } from "@/components/Skeleton";
import { StaffErrorState } from "@/components/StaffErrorState";
import { StateMessage } from "@/components/StateMessage";
import { StatusBadge } from "@/components/StatusBadge";
import {
  appointmentTypeLabel,
  durationMinutes,
  formatDayHeading,
  formatTime,
  personName,
  shiftDate,
  statusLabel,
} from "@/lib/format";
import { useStaffApi, useStaffSession } from "@/lib/staff";
import type { StaffToday, TodayAppointment } from "@/lib/staffApi";
import { colors, radius, space, tabularNums } from "@/theme";

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; today: StaffToday };

/** Who the row is with. A null client is the teaching-relationship rule at work, not an error (contract). */
export function appointmentHeadline(appointment: TodayAppointment) {
  const client = personName(appointment.client);
  const partner = personName(appointment.partner);

  if (appointment.appointmentType === "group_class") {
    return appointment.title || "Group class";
  }
  if (client && partner) return `${client} & ${partner}`;
  if (client) return client;
  return appointment.title || "Client";
}

function placeLabel(appointment: TodayAppointment) {
  return appointment.room?.name ?? appointment.locationName ?? null;
}

function AppointmentRow({
  appointment,
  timeZone,
  onPress,
}: {
  appointment: TodayAppointment;
  timeZone: string;
  onPress: () => void;
}) {
  const headline = appointmentHeadline(appointment);
  const start = formatTime(appointment.startsAt, timeZone);
  const minutes = durationMinutes(appointment.startsAt, appointment.endsAt);
  const detail = [appointmentTypeLabel(appointment.appointmentType), placeLabel(appointment)].filter(Boolean).join(" · ");
  const cancelled = appointment.status === "cancelled";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${start}, ${minutes} minutes. ${headline}. ${detail}. ${statusLabel(appointment.status)}.`}
      accessibilityHint="Opens the appointment"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      testID={`appointment-${appointment.id}`}
    >
      <View style={styles.timeColumn}>
        <AppText variant="lead" style={[tabularNums, cancelled && styles.struck]}>
          {start}
        </AppText>
        <AppText variant="caption" tone="muted" style={tabularNums}>
          {minutes} min
        </AppText>
      </View>
      <View style={styles.rowBody}>
        <AppText variant="lead" tone={cancelled ? "muted" : "default"}>
          {headline}
        </AppText>
        {detail ? <AppText tone="muted">{detail}</AppText> : null}
        <StatusBadge status={appointment.status} />
      </View>
    </Pressable>
  );
}

export function TodayScreen() {
  const api = useStaffApi();
  const { workspace, reload: reloadWorkspaces, signOut } = useStaffSession();
  const studioId = workspace?.studioId ?? null;

  // null asks the server for today in the studio's own zone.
  const [date, setDate] = useState<string | null>(null);
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
        const today = await api.today(studioId, date ?? undefined);
        if (id === requestId.current) setState({ status: "ready", today });
      } catch (error) {
        if (id === requestId.current) setState({ status: "error", error });
      } finally {
        if (id === requestId.current) setRefreshing(false);
      }
    },
    [api, studioId, date],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  const shownDate = state.status === "ready" ? state.today.date : date;

  function goToDay(offset: number) {
    if (!shownDate) return;
    setDate(shiftDate(shownDate, offset));
  }

  function openAppointment(appointment: TodayAppointment, timeZone: string) {
    if (!studioId) return;
    router.push({
      pathname: "/appointments/[id]",
      params: { id: appointment.id, studioId, tz: timeZone },
    });
  }

  return (
    <Screen
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void load("refresh")} tintColor={colors.plum} />
      }
    >
      <View style={styles.header}>
        <AppText variant="label" tone="muted">
          {workspace?.publicName || workspace?.name || "Your studio"}
        </AppText>
        <AppText variant="heading" accessibilityRole="header">
          {date === null ? "Today" : shownDate ? formatDayHeading(shownDate) : "Schedule"}
        </AppText>
        {date === null && shownDate ? (
          <AppText tone="muted">{formatDayHeading(shownDate)}</AppText>
        ) : null}
      </View>

      <View style={styles.dayNav}>
        <AppButton label="Previous day" variant="secondary" onPress={() => goToDay(-1)} disabled={!shownDate} />
        {date !== null ? <AppButton label="Today" variant="quiet" onPress={() => setDate(null)} /> : null}
        <AppButton label="Next day" variant="secondary" onPress={() => goToDay(1)} disabled={!shownDate} />
      </View>

      {state.status === "loading" ? <ScheduleSkeleton label="Loading your schedule" /> : null}

      {state.status === "error" ? (
        <StaffErrorState
          error={state.error}
          onRetry={() => void load("initial")}
          onSignInAgain={() => void signOut()}
          onRefreshWorkspaces={() => void reloadWorkspaces()}
        />
      ) : null}

      {state.status === "ready" && state.today.instructorId === null ? (
        <StateMessage
          testID="today-not-linked"
          title="Not linked to an instructor profile"
          body="Your account is not connected to an instructor at this studio, so there are no lessons to show. Ask the studio owner to link your instructor profile."
          actions={[{ label: "Try again", onPress: () => void load("initial"), variant: "secondary" }]}
        />
      ) : null}

      {state.status === "ready" && state.today.instructorId !== null && state.today.appointments.length === 0 ? (
        <StateMessage
          testID="today-empty"
          title={date === null ? "Nothing on your schedule today" : "Nothing on your schedule"}
          body="Lessons and classes you teach at this studio appear here."
        />
      ) : null}

      {state.status === "ready" && state.today.appointments.length > 0 ? (
        <View style={styles.list} testID="today-list">
          <AppText variant="label" tone="muted">
            {state.today.appointments.length === 1 ? "1 appointment" : `${state.today.appointments.length} appointments`}
          </AppText>
          {[...state.today.appointments]
            .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
            .map((appointment) => (
              <AppointmentRow
                key={appointment.id}
                appointment={appointment}
                timeZone={state.today.timeZone}
                onPress={() => openAppointment(appointment, state.today.timeZone)}
              />
            ))}
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.xs },
  dayNav: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  list: { gap: space.sm },
  row: {
    minHeight: 44,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.lg,
    padding: space.lg,
    borderRadius: radius.row,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
  rowPressed: { backgroundColor: colors.tint },
  timeColumn: { minWidth: 72, gap: 2 },
  rowBody: { flex: 1, minWidth: 160, gap: space.xs },
  struck: { textDecorationLine: "line-through", color: colors.muted },
});
