import { useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Announce } from "@/components/Announce";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { MutationNotice } from "@/components/MutationNotice";
import { useStaffMutation } from "@/lib/mutation";
import { useStaffApi, useStaffSession } from "@/lib/staff";
import type { AppointmentOutcome, MissedCharge, OutcomeResult } from "@/lib/staffApi";
import { colors, radius, space } from "@/theme";

/** One-to-one lesson types the server accepts for this route; anything else keeps its own controls. */
export const ONE_TO_ONE_TYPES = ["private_lesson", "intro_lesson", "coaching"] as const;
/** Statuses a lesson can still be checked in from. attended and no_show are final: there is no undo in the app. */
const OPEN_STATUSES = ["scheduled", "confirmed", "rescheduled"] as const;

export function canCheckIn(appointment: { appointmentType: string; status: string }) {
  return (ONE_TO_ONE_TYPES as readonly string[]).includes(appointment.appointmentType) && (OPEN_STATUSES as readonly string[]).includes(appointment.status);
}

type Input = { status: AppointmentOutcome; missedAppointmentCharge?: MissedCharge };

const CHARGES: { value: MissedCharge; label: string; hint: string }[] = [
  { value: "none", label: "No charge", hint: "No lesson credit is used" },
  { value: "package", label: "Use a package credit", hint: "Takes one credit from the package on this lesson" },
  { value: "membership", label: "Use a membership benefit", hint: "Records the membership benefit for this lesson" },
];

type Props = {
  studioId: string;
  appointmentId: string;
  clientName: string | null;
  status: string;
  /** The screen shows this status now. Called optimistically, then again to put the server's answer (or the previous status) back. */
  onStatusChange: (status: string) => void;
};

/*
  Check-in for one private lesson: one obvious next action (Mark attended), No-show as the second. Both are final, so each asks first and says so.
  The status on screen changes at once (optimistic); it goes back if the server refuses, and it stays (with Try again) if the answer was lost.
*/
export function PrivateLessonCheckIn({ studioId, appointmentId, clientName, status, onStatusChange }: Props) {
  const api = useStaffApi();
  const { signOut } = useStaffSession();
  const [confirm, setConfirm] = useState<"attended" | "no_show" | null>(null);
  const [charge, setCharge] = useState<MissedCharge>("none");
  const [recorded, setRecorded] = useState<string | null>(null);
  const before = useRef(status);
  const who = clientName ?? "this client";

  const mutation = useStaffMutation<Input, OutcomeResult>({
    run: (input, key) => api.setAppointmentOutcome(studioId, appointmentId, input, key),
    optimistic: {
      apply: (input) => {
        before.current = status;
        onStatusChange(input.status);
      },
      rollback: () => onStatusChange(before.current),
    },
    onSuccess: (result) => {
      onStatusChange(result.status);
      setRecorded(result.status);
      setConfirm(null);
    },
    // outcome_conflict: the server says what the lesson already is; show that, not our guess
    onConflict: (conflict) => {
      const current = (conflict.current as { status?: unknown } | null | undefined)?.status;
      if (typeof current === "string") onStatusChange(current);
    },
  });

  function send() {
    if (!confirm) return;
    mutation.submit(confirm === "no_show" ? { status: "no_show", missedAppointmentCharge: charge } : { status: "attended" });
    setConfirm(null);
  }

  const open = (OPEN_STATUSES as readonly string[]).includes(status) && mutation.state.status !== "success";
  const showControls = open && !mutation.pending && mutation.state.status !== "failed";

  return (
    <View style={styles.box} testID="lesson-check-in">
      {recorded ? (
        <>
          <Announce message={recorded === "attended" ? "Marked attended." : "Marked no-show."} />
          <AppText accessibilityLiveRegion="polite" testID="check-in-recorded">
            {recorded === "attended" ? "Marked attended." : "Marked no-show."} This can&apos;t be changed in the app.
          </AppText>
        </>
      ) : null}

      <MutationNotice
        state={mutation.state}
        onRetry={() => mutation.retry()}
        onDiscard={() => mutation.discard()}
        onDismiss={() => mutation.reset()}
        onSignInAgain={() => void signOut()}
        testID="check-in-notice"
      />

      {showControls ? (
        <View style={styles.actions}>
          <AppButton label="Mark attended" onPress={() => setConfirm("attended")} />
          <AppButton label="No-show" variant="secondary" onPress={() => setConfirm("no_show")} />
        </View>
      ) : null}

      <ConfirmSheet
        visible={confirm === "attended"}
        title={`Mark ${who} attended?`}
        body="This records the lesson as attended. If it is paid with a package or membership, that is used. It can't be changed in the app."
        confirmLabel="Yes, mark attended"
        onConfirm={send}
        onCancel={() => setConfirm(null)}
        testID="confirm-attended"
      />

      <ConfirmSheet
        visible={confirm === "no_show"}
        title={`Mark ${who} as a no-show?`}
        body="Choose what happens to the lesson credit. It can't be changed in the app."
        confirmLabel="Yes, mark no-show"
        onConfirm={send}
        onCancel={() => setConfirm(null)}
        testID="confirm-no-show"
      >
        <View accessibilityRole="radiogroup" accessibilityLabel="Lesson credit" style={styles.charges}>
          {CHARGES.map((option) => {
            const selected = charge === option.value;
            return (
              <Pressable
                key={option.value}
                accessibilityRole="radio"
                accessibilityLabel={option.label}
                accessibilityHint={option.hint}
                accessibilityState={{ checked: selected, selected }}
                aria-checked={selected}
                onPress={() => setCharge(option.value)}
                style={[styles.charge, selected && styles.chargeSelected]}
                testID={`charge-${option.value}`}
              >
                <AppText variant="label" style={{ color: selected ? colors.onPlum : colors.plum }}>
                  {selected ? `✓ ${option.label}` : option.label}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      </ConfirmSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: space.md },
  actions: { gap: space.sm },
  charges: { gap: space.sm },
  charge: { minHeight: 48, justifyContent: "center", paddingHorizontal: space.lg, borderRadius: radius.control, borderWidth: 1.5, borderColor: colors.plum, backgroundColor: colors.raised },
  chargeSelected: { backgroundColor: colors.plum },
});
