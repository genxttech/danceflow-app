import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Announce } from "@/components/Announce";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { attendanceLabel } from "@/lib/format";
import { isStaffFeatureEnabled, newIdempotencyKey } from "@/lib/features";
import { useStaffApi, useStaffSession } from "@/lib/staff";
import { ATTENDANCE_MARKS, staffErrorKind, type AppointmentDetail, type AttendanceMark } from "@/lib/staffApi";
import { colors, radius, space } from "@/theme";

type Attendee = NonNullable<AppointmentDetail["roster"]>["attendees"][number];

type RowState = { status: string | null; saving: boolean; error: string | null; exit?: "Sign in again" | "Sign out" };

// Button order and words; the values themselves come from the adapter's single ATTENDANCE_MARKS list.
const MARK_LABELS: Record<AttendanceMark, string> = { attended: "Present", no_show: "No-show" };
const MARKS = ATTENDANCE_MARKS.map((value) => ({ value, label: MARK_LABELS[value] }));

/** A save that failed because the session or account is gone needs a way out on the row itself, not only words. */
function exitLabel(error: unknown): RowState["exit"] {
  switch (staffErrorKind(error)) {
    case "sign_in_again":
      return "Sign in again";
    case "account_inactive":
    case "platform_admin":
      return "Sign out";
    default:
      return undefined;
  }
}

function saveErrorText(error: unknown) {
  switch (staffErrorKind(error)) {
    case "sign_in_again":
      return "Not saved. Sign in again, then retry.";
    case "not_permitted":
      return "Not saved. Your role cannot mark attendance.";
    case "account_inactive":
      return "Not saved. This account is not active.";
    case "platform_admin":
      return "Not saved. Platform admin accounts are not supported in this app.";
    case "no_access":
    case "paused":
      return "Not saved. You no longer have access to this studio.";
    case "not_found":
      return "Not saved. This dancer is no longer on the roster.";
    case "not_markable":
      return "Not saved. This class can't be marked right now (cancelled, or outside the marking window).";
    case "rate_limited":
      return "Not saved. Too many requests. Try again in a moment.";
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
  onRemove,
}: {
  studioId: string;
  appointmentId: string;
  attendees: Attendee[];
  canMark: boolean;
  /** Phase 1A: offered per dancer with no attendance recorded yet (the server refuses a removal after attendance). */
  onRemove?: (clientId: string, name: string) => void;
}) {
  const api = useStaffApi();
  const { signOut } = useStaffSession();
  const [rows, setRows] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(attendees.map((a) => [a.clientId, { status: a.attendanceStatus, saving: false, error: null }])),
  );

  // Mark all present: the dancers with no attendance recorded yet, one write each, one after the other.
  const [bulk, setBulk] = useState<{ running: boolean; saved: number; failed: string[] } | null>(null);

  /** "ok": the server confirmed the mark (or there was nothing to do). "failed": refused. "fatal": the session or account is gone. */
  async function mark(clientId: string, value: AttendanceMark): Promise<"ok" | "failed" | "fatal"> {
    const before = rows[clientId];
    if (!before || before.saving) return "failed";
    if (before.status === value) return "ok";
    setRows((current) => ({ ...current, [clientId]: { status: value, saving: true, error: null } }));
    try {
      const result = await api.setAttendance(studioId, appointmentId, clientId, value, newIdempotencyKey());
      setRows((current) => ({ ...current, [clientId]: { status: result.attendanceStatus ?? value, saving: false, error: null } }));
      return "ok";
    } catch (error) {
      setRows((current) => ({ ...current, [clientId]: { status: before.status, saving: false, error: saveErrorText(error), exit: exitLabel(error) } }));
      return exitLabel(error) ? "fatal" : "failed";
    }
  }

  const unmarked = attendees.filter((a) => rows[a.clientId]?.status === null).map((a) => a.clientId);
  const bulkOn = canMark && isStaffFeatureEnabled("bulkAttendance");

  async function markAllPresent(ids: string[]) {
    setBulk({ running: true, saved: 0, failed: [] });
    let saved = 0;
    const failed: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const outcome = await mark(ids[i], "attended");
      if (outcome === "ok") {
        saved += 1;
        continue;
      }
      failed.push(ids[i]);
      // an ended session or a deactivated account fails every remaining write the same way: stop instead of repeating it
      if (outcome === "fatal") {
        failed.push(...ids.slice(i + 1));
        break;
      }
    }
    setBulk({ running: false, saved, failed });
  }

  const recorded = Object.values(rows).filter((r) => r.status === "attended").length;
  const absent = Object.values(rows).filter((r) => r.status === "no_show").length;

  return (
    <View style={styles.list}>
      {canMark ? (
        <AppText tone="muted" accessibilityLiveRegion="polite" testID="attendance-summary">
          {recorded} of {attendees.length} marked present
        </AppText>
      ) : null}
      {canMark && absent > 0 ? (
        <AppText tone="muted" accessibilityLiveRegion="polite" testID="attendance-absent-summary">
          {absent} marked no-show
        </AppText>
      ) : null}
      {bulkOn && (unmarked.length > 0 || bulk) ? (
        <View style={styles.bulk} testID="bulk-attendance">
          {unmarked.length > 0 && !bulk?.running ? (
            <AppButton
              label={`Mark all present (${unmarked.length})`}
              variant="secondary"
              onPress={() => void markAllPresent(unmarked)}
              accessibilityHint="Marks every dancer with no attendance recorded as present"
            />
          ) : null}
          {bulk?.running ? (
            <AppText tone="muted" accessibilityLiveRegion="polite" testID="bulk-running">
              Saving attendance…
            </AppText>
          ) : null}
          {bulk && !bulk.running && bulk.saved > 0 ? (
            <>
              <Announce message={bulk.saved === 1 ? "1 dancer marked present." : `${bulk.saved} dancers marked present.`} />
              <AppText accessibilityLiveRegion="polite" testID="bulk-saved">
                {bulk.saved === 1 ? "1 dancer marked present." : `${bulk.saved} dancers marked present.`}
              </AppText>
            </>
          ) : null}
          {bulk && !bulk.running && bulk.failed.length > 0 ? (
            <View style={styles.bulk}>
              <Announce message={`${bulk.failed.length === 1 ? "1 dancer did not save." : `${bulk.failed.length} dancers did not save.`} See the rows below.`} />
              <AppText tone="error" accessibilityRole="alert" testID="bulk-failed">
                {bulk.failed.length === 1 ? "1 dancer did not save." : `${bulk.failed.length} dancers did not save.`} See the rows below.
              </AppText>
              <AppButton label="Try the failed ones again" variant="secondary" onPress={() => void markAllPresent(bulk.failed)} />
            </View>
          ) : null}
        </View>
      ) : null}
      {attendees.length === 0 ? <AppText tone="muted">No one is enrolled yet.</AppText> : null}
      {attendees.map((attendee) => {
        const row = rows[attendee.clientId] ?? { status: attendee.attendanceStatus, saving: false, error: null };
        const name = attendee.name ?? "Dancer";
        return (
          <View key={attendee.clientId} style={styles.attendee} testID={`attendee-${attendee.clientId}`}>
            <View style={styles.attendeeHead}>
              <AppText style={styles.attendeeName}>{name}</AppText>
              {!canMark || (row.status !== null && !MARKS.some((m) => m.value === row.status)) ? (
                // A status the app cannot set (registered, checked in, cancelled) must still be visible to the person marking.
                <AppText variant="caption" tone="muted" testID={`attendance-status-${attendee.clientId}`}>
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
                      aria-checked={selected}
                      aria-disabled={row.saving}
                      aria-busy={row.saving}
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
              <>
                <Announce message={`${name}: ${row.error}`} />
                <AppText variant="caption" tone="error" accessibilityRole="alert" testID={`attendance-error-${attendee.clientId}`}>
                  {row.error}
                </AppText>
              </>
            ) : null}
            {onRemove && row.status === null && !row.saving ? (
              <AppButton label={`Remove ${name} from the class`} variant="quiet" onPress={() => onRemove(attendee.clientId, name)} />
            ) : null}
            {row.exit ? <AppButton label={row.exit} variant="secondary" onPress={() => void signOut()} /> : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.xs },
  bulk: { gap: space.sm, paddingVertical: space.sm },
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
