import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { AppText } from "@/components/AppText";
import { attendanceLabel } from "@/lib/format";
import { newIdempotencyKey } from "@/lib/features";
import { useStaffApi } from "@/lib/staff";
import { staffErrorKind, type AppointmentDetail, type AttendanceMark } from "@/lib/staffApi";
import { colors, radius, space } from "@/theme";

type Attendee = NonNullable<AppointmentDetail["roster"]>["attendees"][number];

type RowState = { status: string | null; saving: boolean; error: string | null };

const MARKS: { value: AttendanceMark; label: string }[] = [
  { value: "attended", label: "Present" },
  { value: "absent", label: "Absent" },
];

function saveErrorText(error: unknown) {
  switch (staffErrorKind(error)) {
    case "sign_in_again":
      return "Not saved. Sign in again, then retry.";
    case "not_permitted":
      return "Not saved. Your role cannot mark attendance.";
    case "no_access":
    case "paused":
      return "Not saved. You no longer have access to this studio.";
    case "not_found":
      return "Not saved. This dancer is no longer on the roster.";
    default:
      return "Not saved. Check your connection and try again.";
  }
}

/**
 * The class roster. With `canMark`, each dancer gets Present / Absent: the choice shows at once, the server confirms it, and a
 * failure puts the previous value back and says why on that row. Each tap is one action with its own idempotency key.
 */
export function RosterAttendance({
  studioId,
  appointmentId,
  attendees,
  canMark,
}: {
  studioId: string;
  appointmentId: string;
  attendees: Attendee[];
  canMark: boolean;
}) {
  const api = useStaffApi();
  const [rows, setRows] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(attendees.map((a) => [a.clientId, { status: a.attendanceStatus, saving: false, error: null }])),
  );

  async function mark(clientId: string, value: AttendanceMark) {
    const before = rows[clientId];
    if (!before || before.saving || before.status === value) return;
    setRows((current) => ({ ...current, [clientId]: { status: value, saving: true, error: null } }));
    try {
      const result = await api.setAttendance(studioId, appointmentId, clientId, value, newIdempotencyKey());
      setRows((current) => ({ ...current, [clientId]: { status: result.attendanceStatus ?? value, saving: false, error: null } }));
    } catch (error) {
      setRows((current) => ({ ...current, [clientId]: { status: before.status, saving: false, error: saveErrorText(error) } }));
    }
  }

  const recorded = Object.values(rows).filter((r) => r.status === "attended").length;

  return (
    <View style={styles.list}>
      {canMark ? (
        <AppText tone="muted" accessibilityLiveRegion="polite" testID="attendance-summary">
          {recorded} of {attendees.length} marked present
        </AppText>
      ) : null}
      {attendees.length === 0 ? <AppText tone="muted">No one is enrolled yet.</AppText> : null}
      {attendees.map((attendee) => {
        const row = rows[attendee.clientId] ?? { status: attendee.attendanceStatus, saving: false, error: null };
        const name = attendee.name ?? "Dancer";
        return (
          <View key={attendee.clientId} style={styles.attendee} testID={`attendee-${attendee.clientId}`}>
            <View style={styles.attendeeHead}>
              <AppText style={styles.attendeeName}>{name}</AppText>
              {!canMark ? (
                <AppText variant="caption" tone="muted">
                  {attendanceLabel(row.status)}
                </AppText>
              ) : null}
            </View>
            {canMark ? (
              <View accessibilityRole="radiogroup" accessibilityLabel={`Attendance for ${name}`} style={styles.marks}>
                {MARKS.map((option) => {
                  const selected = row.status === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      accessibilityRole="radio"
                      accessibilityLabel={`${option.label}, ${name}`}
                      accessibilityState={{ checked: selected, selected, disabled: row.saving, busy: row.saving }}
                      disabled={row.saving}
                      onPress={() => void mark(attendee.clientId, option.value)}
                      style={({ pressed }) => [styles.mark, selected && styles.markSelected, pressed && styles.markPressed, row.saving && styles.markSaving]}
                      testID={`mark-${option.value}-${attendee.clientId}`}
                    >
                      <AppText variant="label" style={{ color: selected ? colors.onPlum : colors.plum }}>
                        {selected ? `✓ ${option.label}` : option.label}
                      </AppText>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
            {row.saving ? (
              <AppText variant="caption" tone="muted" accessibilityLiveRegion="polite">
                Saving…
              </AppText>
            ) : null}
            {row.error ? (
              <AppText variant="caption" tone="error" accessibilityRole="alert" testID={`attendance-error-${attendee.clientId}`}>
                {row.error}
              </AppText>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.xs },
  attendee: { gap: space.sm, paddingVertical: space.md, borderTopWidth: 1, borderTopColor: colors.border },
  attendeeHead: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: space.sm },
  attendeeName: { flexShrink: 1 },
  marks: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  mark: {
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
  markSelected: { backgroundColor: colors.plum },
  markPressed: { opacity: 0.85 },
  markSaving: { opacity: 0.6 },
});
