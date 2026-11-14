import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { ScheduleSkeleton } from "@/components/Skeleton";
import { StaffErrorState } from "@/components/StaffErrorState";
import { StatusBadge } from "@/components/StatusBadge";
import { RosterAttendance } from "@/components/RosterAttendance";
import { isStaffFeatureEnabled } from "@/lib/features";
import { appointmentTypeLabel, formatDayHeading, formatTimeRange, personName } from "@/lib/format";
import { useStaffApi, useStaffSession } from "@/lib/staff";
import type { AppointmentDetail } from "@/lib/staffApi";
import { appointmentHeadline } from "@/screens/TodayScreen";
import { colors, radius, space, tabularNums } from "@/theme";

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; appointment: AppointmentDetail };

function localDate(iso: string, timeZone: string | undefined) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/** "6 of 10 booked", "10 of 10 booked · Full" at or over capacity, "6 booked" with no limit. The API has no waitlist yet (proposed). */
export function rosterCapacityLabel(booked: number, capacity: number | null) {
  if (capacity === null) return `${booked} booked`;
  return booked >= capacity ? `${booked} of ${capacity} booked · Full` : `${booked} of ${capacity} booked`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <AppText variant="label" tone="muted" accessibilityRole="header">
        {title}
      </AppText>
      {children}
    </View>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <View style={styles.field} accessible accessibilityLabel={`${label}: ${value}`}>
      <AppText variant="caption" tone="muted">
        {label}
      </AppText>
      <AppText>{value}</AppText>
    </View>
  );
}

export function AppointmentScreen({ appointmentId, studioId, timeZone }: { appointmentId: string; studioId: string; timeZone?: string }) {
  const api = useStaffApi();
  const { me, reload: reloadWorkspaces, signOut } = useStaffSession();
  // The capability of the studio this appointment belongs to, not of whichever studio is selected.
  const studio = me?.workspaces.find((w) => w.studioId === studioId);
  const canMarkAttendance =
    isStaffFeatureEnabled("attendance") && studio?.accessAllowed === true && studio.capabilities?.markAttendance === true;
  const [state, setState] = useState<LoadState>({ status: "loading" });

  // Retry: show the loading state, then fetch again.
  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", appointment: await api.appointment(studioId, appointmentId) });
    } catch (error) {
      setState({ status: "error", error });
    }
  }, [api, studioId, appointmentId]);

  // First load: the initial state is already "loading", so the effect only fetches and sets state in the
  // promise callbacks (no synchronous setState in the effect), ignoring a result that arrives after unmount
  // or after the ids change.
  useEffect(() => {
    let active = true;
    api.appointment(studioId, appointmentId).then(
      (appointment) => {
        if (active) setState({ status: "ready", appointment });
      },
      (error: unknown) => {
        if (active) setState({ status: "error", error });
      },
    );
    return () => {
      active = false;
    };
  }, [api, studioId, appointmentId]);

  if (state.status === "loading") {
    return (
      <Screen edges={[]}>
        <ScheduleSkeleton rows={3} label="Loading the appointment" />
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

  const appointment = state.appointment;
  // Slice 2 puts the studio zone on the detail itself; the route param (from Today) and /me cover a server without it.
  const zone = appointment.timeZone ?? timeZone ?? studio?.timeZone ?? undefined;
  const instructor = personName(appointment.instructor);
  const client = personName(appointment.client);
  const partner = personName(appointment.partner);
  const roster = appointment.roster;
  const recap = appointment.recap;

  return (
    <Screen edges={[]}>
      <View style={styles.header}>
        <AppText variant="label" tone="muted">
          {appointmentTypeLabel(appointment.appointmentType)}
        </AppText>
        <AppText variant="heading" accessibilityRole="header">
          {appointmentHeadline(appointment)}
        </AppText>
        <AppText variant="lead" style={tabularNums}>
          {formatTimeRange(appointment.startsAt, appointment.endsAt, zone)}
        </AppText>
        <AppText tone="muted">{formatDayHeading(localDate(appointment.startsAt, zone))}</AppText>
        <StatusBadge status={appointment.status} />
      </View>

      <Section title="Details">
        <Field label="Room" value={appointment.room?.name ?? appointment.locationName} />
        {appointment.appointmentType !== "group_class" ? (
          <>
            <Field label="Client" value={client ?? (appointment.client ? "Client" : null)} />
            <Field label="Partner" value={partner ?? (appointment.partner ? "Partner" : null)} />
          </>
        ) : null}
        <Field label="Instructor" value={instructor} />
        {appointment.title && appointment.appointmentType !== "group_class" ? <Field label="Title" value={appointment.title} /> : null}
      </Section>

      {appointment.notes ? (
        <Section title="Teaching notes">
          <AppText>{appointment.notes}</AppText>
        </Section>
      ) : null}

      {roster ? (
        <Section title={canMarkAttendance ? "Roster and attendance" : "Roster"}>
          <AppText tone="muted" style={tabularNums} testID="roster-capacity">
            {rosterCapacityLabel(roster.bookedCount, roster.capacity)}
          </AppText>
          <RosterAttendance
            studioId={studioId}
            appointmentId={appointment.id}
            attendees={roster.attendees}
            canMark={canMarkAttendance && appointment.status !== "cancelled"}
          />
        </Section>
      ) : null}

      {appointment.appointmentType === "private_lesson" ? (
        <Section title="Lesson recap">
          {recap ? (
            <>
              <Field label="Summary" value={recap.summary} />
              <Field label="Homework" value={recap.homework} />
              <Field label="Next focus" value={recap.nextFocus} />
              <AppText variant="caption" tone="muted">
                {recap.visibleToClient ? "Visible to the client" : "Not visible to the client"}
              </AppText>
            </>
          ) : (
            <AppText tone="muted">No recap written yet. Recaps are written on the web for now.</AppText>
          )}
        </Section>
      ) : null}
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
  field: { gap: 2 },
});
