import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Announce } from "@/components/Announce";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { MutationNotice } from "@/components/MutationNotice";
import { RosterAttendance } from "@/components/RosterAttendance";
import { personName } from "@/lib/format";
import { useStaffMutation } from "@/lib/mutation";
import { useStaffApi, useStaffSession } from "@/lib/staff";
import type { ClientSummary, RosterBilling, RosterEnrollResult, RosterRemoveResult } from "@/lib/staffApi";
import { colors, radius, space, type } from "@/theme";

export type RosterAttendee = { clientId: string; name: string | null; attendanceStatus: string | null };

/** Membership funding needs a specific membership to be chosen, which the app doesn't offer yet: it stays on the web. */
const FUNDING: { value: RosterBilling; label: string; hint: string }[] = [
  { value: "package_credit", label: "Package credit", hint: "A credit is used when attendance is recorded" },
  { value: "pay_as_you_go", label: "Pay as you go", hint: "Paid on the web or at the desk" },
  { value: "free_comped", label: "Free (comped)", hint: "No charge" },
];

type Props = {
  studioId: string;
  appointmentId: string;
  attendees: RosterAttendee[];
  canMark: boolean;
  /** Owner, admin and front desk, with the classRoster flag on. Instructors manage the roster on the web until the instructor SQL gate (D4). */
  canManage: boolean;
  /** For the capacity line and the screen's counts. */
  onRosterChange: (attendees: RosterAttendee[]) => void;
};

/**
 * The class roster with add and remove (Phase 1A). Adding finds a client, picks how the class is paid, and enrols them; the server decides capacity, funding and
 * duplicates under locks. Removing is only offered for a dancer with no attendance recorded, and asks first. Every write goes through the mutation framework.
 */
export function ClassRosterEditor({ studioId, appointmentId, attendees, canMark, canManage, onRosterChange }: Props) {
  const api = useStaffApi();
  const { signOut } = useStaffSession();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ clientId: string; name: string } | null>(null);
  const [lastChange, setLastChange] = useState<string | null>(null);

  const remove = useStaffMutation<{ clientId: string }, RosterRemoveResult>({
    run: (input, key) => api.removeFromClass(studioId, appointmentId, input.clientId, key),
    onSuccess: (_result, input) => {
      onRosterChange(attendees.filter((a) => a.clientId !== input.clientId));
      setLastChange("Dancer removed.");
    },
  });

  function confirmRemove() {
    if (!removing) return;
    remove.submit({ clientId: removing.clientId });
    setRemoving(null);
  }

  return (
    <View style={styles.box}>
      {lastChange ? (
        <>
          <Announce message={lastChange} />
          <AppText tone="success" accessibilityLiveRegion="polite" testID="roster-change">
            {lastChange}
          </AppText>
        </>
      ) : null}

      <MutationNotice
        state={remove.state}
        onRetry={() => remove.retry()}
        onDiscard={() => remove.discard()}
        onDismiss={() => remove.reset()}
        onSignInAgain={() => void signOut()}
        testID="remove-notice"
      />

      {canManage ? (
        <AppButton
          label="Add a dancer"
          variant="secondary"
          onPress={() => {
            setLastChange(null);
            setAdding(true);
          }}
          disabled={remove.pending}
        />
      ) : null}

      <RosterAttendance
        key={attendees.map((a) => a.clientId).join("|")}
        studioId={studioId}
        appointmentId={appointmentId}
        attendees={attendees}
        canMark={canMark}
        onRemove={canManage && !remove.pending ? (clientId, name) => setRemoving({ clientId, name }) : undefined}
      />

      <ConfirmSheet
        visible={removing !== null}
        title={`Remove ${removing?.name ?? "this dancer"} from the class?`}
        body="They are told they were removed. This only works while no attendance is recorded for them."
        confirmLabel="Yes, remove"
        onConfirm={confirmRemove}
        onCancel={() => setRemoving(null)}
        testID="confirm-remove"
      />

      {adding ? (
      <AddDancerSheet
        studioId={studioId}
        appointmentId={appointmentId}
        visible
        enrolledIds={attendees.map((a) => a.clientId)}
        onClose={() => setAdding(false)}
        onAdded={(client, result) => {
          setAdding(false);
          setLastChange(result.alreadyEnrolled ? "That dancer was already on the roster." : "Dancer added.");
          if (!result.alreadyEnrolled) onRosterChange([...attendees, { clientId: client.id, name: personName({ id: client.id, firstName: client.firstName, lastName: client.lastName }), attendanceStatus: null }]);
        }}
      />
      ) : null}
    </View>
  );
}

function AddDancerSheet({
  studioId,
  appointmentId,
  visible,
  enrolledIds,
  onClose,
  onAdded,
}: {
  studioId: string;
  appointmentId: string;
  visible: boolean;
  enrolledIds: string[];
  onClose: () => void;
  onAdded: (client: ClientSummary, result: RosterEnrollResult) => void;
}) {
  const api = useStaffApi();
  const { signOut } = useStaffSession();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClientSummary[] | null>(null);
  const [searchError, setSearchError] = useState(false);
  const [chosen, setChosen] = useState<ClientSummary | null>(null);
  const [funding, setFunding] = useState<RosterBilling>("package_credit");
  const seq = useRef(0);

  const mutation = useStaffMutation<{ client: ClientSummary; billingType: RosterBilling }, RosterEnrollResult>({
    run: (input, key) => api.enrollInClass(studioId, appointmentId, { clientId: input.client.id, billingType: input.billingType }, key),
    onSuccess: (result, input) => onAdded(input.client, result),
  });
  // The sheet is mounted only while open (see ClassRosterEditor), so every opening starts clean and needs no reset effect.
  useEffect(() => {
    if (!visible || chosen) return;
    const text = query.trim();
    if (text.length < 2) return;
    const id = ++seq.current;
    const timer = setTimeout(() => {
      api.searchClients(studioId, { q: text, limit: 10 }).then(
        (page) => {
          if (id === seq.current) {
            setResults(page.clients.filter((c) => !enrolledIds.includes(c.id)));
            setSearchError(false);
          }
        },
        () => {
          if (id === seq.current) setSearchError(true);
        },
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [query, visible, chosen, api, studioId, enrolledIds]);

  const failed = mutation.state.status === "failed";
  const busy = mutation.pending;
  const shownResults = query.trim().length >= 2 ? results : null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={busy ? undefined : onClose} statusBarTranslucent>
      <View style={styles.scrim} accessible={false} importantForAccessibility="no-hide-descendants" onTouchEnd={busy ? undefined : onClose} />
      <View style={styles.sheet} accessibilityViewIsModal testID="add-dancer-sheet">
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <AppText variant="title" accessibilityRole="header">
            Add a dancer
          </AppText>

          {chosen ? (
            <View style={styles.gap}>
              <AppText testID="chosen-dancer">{personName({ id: chosen.id, firstName: chosen.firstName, lastName: chosen.lastName }) ?? "Dancer"}</AppText>
              {!busy && !failed ? <AppButton label="Choose someone else" variant="quiet" onPress={() => setChosen(null)} /> : null}
            </View>
          ) : (
            <View style={styles.gap}>
              <AppText variant="label" nativeID="dancer-search-label">
                Find a client
              </AppText>
              <TextInput
                accessibilityLabel="Find a client"
                accessibilityLabelledBy="dancer-search-label"
                accessibilityHint="Type at least two letters of a first or last name"
                autoCapitalize="words"
                autoCorrect={false}
                onChangeText={setQuery}
                placeholder="Name"
                placeholderTextColor={colors.muted}
                style={styles.input}
                testID="dancer-search"
                value={query}
              />
              {searchError ? (
                <AppText tone="error" accessibilityRole="alert">
                  Search failed. Try again.
                </AppText>
              ) : null}
              {shownResults && shownResults.length === 0 ? <AppText tone="muted">No matching clients who aren&apos;t already on the roster.</AppText> : null}
              {shownResults?.map((client) => {
                const name = personName({ id: client.id, firstName: client.firstName, lastName: client.lastName }) ?? "Client";
                return (
                  <Pressable key={client.id} accessibilityRole="button" accessibilityLabel={name} onPress={() => setChosen(client)} style={styles.result} testID={`dancer-${client.id}`}>
                    <AppText variant="lead">{name}</AppText>
                  </Pressable>
                );
              })}
            </View>
          )}

          {chosen ? (
            <View accessibilityRole="radiogroup" accessibilityLabel="How the class is paid" style={styles.gap}>
              {FUNDING.map((option) => {
                const selected = funding === option.value;
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="radio"
                    accessibilityLabel={option.label}
                    accessibilityHint={option.hint}
                    accessibilityState={{ checked: selected, selected, disabled: busy || failed }}
                    aria-checked={selected}
                    disabled={busy || failed}
                    onPress={() => setFunding(option.value)}
                    style={[styles.option, selected && styles.optionSelected]}
                    testID={`funding-${option.value}`}
                  >
                    <AppText variant="label" style={{ color: selected ? colors.onPlum : colors.plum }}>
                      {selected ? `✓ ${option.label}` : option.label}
                    </AppText>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          <MutationNotice
            state={mutation.state}
            onRetry={() => mutation.retry()}
            onDiscard={() => mutation.discard()}
            onDismiss={() => mutation.reset()}
            onSignInAgain={() => void signOut()}
            testID="enroll-notice"
          />

          <View style={styles.gap}>
            {chosen ? (
              <AppButton label="Add to class" onPress={() => mutation.submit({ client: chosen, billingType: funding })} disabled={busy || failed} loading={busy} />
            ) : null}
            <AppButton label="Cancel" variant="quiet" onPress={onClose} disabled={busy} />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  box: { gap: space.md },
  gap: { gap: space.sm },
  scrim: { flex: 1, backgroundColor: "rgba(43, 27, 42, 0.45)" },
  sheet: { maxHeight: "92%", backgroundColor: colors.raised, borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card, borderWidth: 1, borderColor: colors.border },
  content: { gap: space.md, padding: space.xl },
  input: { minHeight: 48, borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.control, paddingHorizontal: space.md, backgroundColor: colors.surface, color: colors.text, ...type.body },
  result: { minHeight: 48, justifyContent: "center", paddingHorizontal: space.md, borderRadius: radius.row, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  option: { minHeight: 48, justifyContent: "center", paddingHorizontal: space.lg, borderRadius: radius.control, borderWidth: 1.5, borderColor: colors.plum, backgroundColor: colors.raised },
  optionSelected: { backgroundColor: colors.plum },
});
