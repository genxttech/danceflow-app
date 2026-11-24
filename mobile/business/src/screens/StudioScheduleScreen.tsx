import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { ScheduleSkeleton } from "@/components/Skeleton";
import { StaffErrorState } from "@/components/StaffErrorState";
import { StateMessage } from "@/components/StateMessage";
import { formatDayHeading, formatTime, personName, shiftDate } from "@/lib/format";
import { nextUp } from "@/lib/nextUp";
import { NextUpCard } from "@/components/NextUpCard";
import { isStaffFeatureEnabled } from "@/lib/features";
import { shouldKeepStale } from "@/lib/stale";
import { useStaffApi, useStaffSession } from "@/lib/staff";
import { StaleBanner } from "@/components/StaleBanner";
import type { StaffStudioDay, StudioAppointment } from "@/lib/staffApi";
import { appointmentHeadline, AppointmentRow } from "@/screens/TodayScreen";
import { colors, radius, space } from "@/theme";

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; day: StaffStudioDay; loadedAt: number; stale?: boolean };

export type DayMode = "mine" | "studio";

/** "My day" / "Studio": which schedule the Today tab shows. A radio group with the choice in words and state. */
export function DayModeSwitch({ mode, onChange }: { mode: DayMode; onChange: (mode: DayMode) => void }) {
  const options: { value: DayMode; label: string }[] = [
    { value: "mine", label: "My day" },
    { value: "studio", label: "Studio" },
  ];
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Schedule to show" style={styles.switch} testID="day-mode-switch">
      {options.map((option) => {
        const selected = option.value === mode;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked: selected, selected }}
            aria-checked={selected}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [styles.option, selected && styles.optionSelected, pressed && styles.optionPressed]}
            testID={`day-mode-${option.value}`}
          >
            <AppText variant="label" style={{ color: selected ? colors.onPlum : colors.plum }}>
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The whole studio's day, for owner, admin and front desk. Rows open the same appointment detail as Today (broad staff already have access there). */
export function StudioScheduleScreen({ modeSwitch }: { modeSwitch?: React.ReactNode } = {}) {
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
        const day = await api.studioSchedule(studioId, date ?? undefined);
        if (id === requestId.current) setState({ status: "ready", day, loadedAt: Date.now() });
      } catch (error) {
        if (id === requestId.current) {
          setState((prev) =>
            shouldKeepStale({ enabled: isStaffFeatureEnabled("keepStale"), mode, hadData: prev.status === "ready", error }) && prev.status === "ready"
              ? { ...prev, stale: true }
              : { status: "error", error },
          );
        }
      } finally {
        if (id === requestId.current) setRefreshing(false);
      }
    },
    [api, studioId, date],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  const shownDate = state.status === "ready" ? state.day.date : date;

  function goToDay(offset: number) {
    if (!shownDate) return;
    setDate(shiftDate(shownDate, offset));
  }

  function open(appointment: StudioAppointment, timeZone: string) {
    if (!studioId) return;
    router.push({ pathname: "/appointments/[id]", params: { id: appointment.id, studioId, tz: timeZone } });
  }

  const day = state.status === "ready" ? state.day : null;
  // The one obvious next action, for today only (a past or future day has no "next").
  const next =
    day && date === null
      ? nextUp(day.appointments, Date.now(), { oneToOne: isStaffFeatureEnabled("appointmentAttendance"), classes: isStaffFeatureEnabled("attendance") })
      : null;

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load("refresh")} tintColor={colors.plum} />}>
      <View style={styles.header}>
        <AppText variant="label" tone="muted">
          {workspace?.publicName || workspace?.name || "Your studio"}
        </AppText>
        <AppText variant="heading" accessibilityRole="header">
          {date === null ? "Studio today" : shownDate ? formatDayHeading(shownDate) : "Studio schedule"}
        </AppText>
        {date === null && shownDate ? <AppText tone="muted">{formatDayHeading(shownDate)}</AppText> : null}
      </View>

      {modeSwitch}

      <View style={styles.dayNav}>
        <AppButton label="Previous day" variant="secondary" onPress={() => goToDay(-1)} disabled={!shownDate} />
        {date !== null ? <AppButton label="Today" variant="quiet" onPress={() => setDate(null)} /> : null}
        <AppButton label="Next day" variant="secondary" onPress={() => goToDay(1)} disabled={!shownDate} />
      </View>

      {state.status === "ready" && state.stale ? <StaleBanner loadedAt={state.loadedAt} timeZone={state.day.timeZone} onRetry={() => void load("refresh")} /> : null}

      {state.status === "loading" ? <ScheduleSkeleton label="Loading the studio schedule" /> : null}

      {state.status === "error" ? (
        <StaffErrorState
          error={state.error}
          onRetry={() => void load("initial")}
          onSignInAgain={() => void signOut()}
          onRefreshWorkspaces={() => void reloadWorkspaces().then(() => load("initial"))}
        />
      ) : null}

      {day && day.appointments.length === 0 ? (
        <StateMessage
          testID="studio-empty"
          title={date === null ? "Nothing on the studio schedule today" : "Nothing on the studio schedule"}
          body="Lessons, classes and rentals at this studio appear here."
        />
      ) : null}

      {day && next ? (
        <NextUpCard
          kind={next.kind}
          start={formatTime(next.appointment.startsAt, day.timeZone)}
          headline={appointmentHeadline(next.appointment)}
          behind={next.behind}
          onOpen={() => open(next.appointment, day.timeZone)}
        />
      ) : null}

      {day && day.appointments.length > 0 ? (
        <View style={styles.list} testID="studio-list">
          <AppText variant="label" tone="muted">
            {day.appointments.length === 1 ? "1 appointment" : `${day.appointments.length} appointments`}
          </AppText>
          {day.truncated ? (
            <AppText variant="caption" tone="muted" testID="studio-truncated">
              Showing the first 500 appointments of the day.
            </AppText>
          ) : null}
          {[...day.appointments]
            .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id))
            .map((appointment) => (
              <AppointmentRow
                key={appointment.id}
                appointment={appointment}
                timeZone={day.timeZone}
                instructorName={personName(appointment.instructor)}
                onPress={() => open(appointment, day.timeZone)}
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
  switch: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  option: {
    minHeight: 44,
    minWidth: 96,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.control,
    borderWidth: 1.5,
    borderColor: colors.plum,
    backgroundColor: colors.raised,
  },
  optionSelected: { backgroundColor: colors.plum },
  optionPressed: { opacity: 0.85 },
});
