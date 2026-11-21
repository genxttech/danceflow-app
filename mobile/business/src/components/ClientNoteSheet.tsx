import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View, KeyboardAvoidingView, Platform } from "react-native";
import { Announce } from "@/components/Announce";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { MutationNotice } from "@/components/MutationNotice";
import { isStaffFeatureEnabled } from "@/lib/features";
import { useStaffMutation } from "@/lib/mutation";
import { useStaffApi, useStaffSession } from "@/lib/staff";
import { CLIENT_NOTE_TYPES, type ClientNote, type ClientNoteType } from "@/lib/staffApi";
import { newEntityId } from "@/lib/uuid";
import { colors, radius, space, type } from "@/theme";

const TYPE_LABELS: Record<ClientNoteType, string> = {
  general: "General",
  follow_up: "Follow-up",
  sales: "Sales",
  lesson: "Lesson",
  billing: "Billing",
  concern: "Concern",
};

/** The same ceiling the server applies to a note from the app. */
export const MAX_NOTE_LENGTH = 5000;

type Props = {
  studioId: string;
  clientId: string;
  clientName: string;
  visible: boolean;
  onClose: () => void;
  onSaved: (note: ClientNote) => void;
};

/**
 * Add a note to a client (Phase 1A). One obvious action: Save. The note id is made once when the sheet opens and reused by every retry of the same
 * note, so a lost answer can never create a second note; a new note (after Save, or after Discard) gets a new id.
 */
export function ClientNoteSheet({ studioId, clientId, clientName, visible, onClose, onSaved }: Props) {
  const api = useStaffApi();
  const { signOut } = useStaffSession();
  const [body, setBody] = useState("");
  const [noteType, setNoteType] = useState<ClientNoteType>("general");
  const noteId = useRef(newEntityId());

  const mutation = useStaffMutation<{ noteId: string; body: string; noteType: ClientNoteType }, ClientNote>({
    run: async (input, key) => (await api.addClientNote(studioId, clientId, input, key)).note,
    enabled: isStaffFeatureEnabled("clientNotes"),
    onSuccess: (note) => {
      setBody("");
      setNoteType("general");
      noteId.current = newEntityId();
      onSaved(note);
    },
  });

  // A fresh sheet starts clean (a previous refusal is not carried into the next note).
  const { reset } = mutation;
  useEffect(() => {
    if (visible) reset();
  }, [visible, reset]);

  const trimmed = body.trim();
  const tooLong = trimmed.length > MAX_NOTE_LENGTH;
  const canSave = trimmed.length > 0 && !tooLong && !mutation.pending && mutation.state.status !== "failed";
  const failed = mutation.state.status === "failed";

  function save() {
    if (!canSave) return;
    mutation.submit({ noteId: noteId.current, body: trimmed, noteType });
  }

  function discard() {
    mutation.discard();
    noteId.current = newEntityId(); // the abandoned note may exist on the server under the old id; a new note must not collide with it
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={mutation.pending ? undefined : onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.avoid}>
      <View style={styles.scrim} importantForAccessibility="no-hide-descendants" accessible={false} onTouchEnd={mutation.pending ? undefined : onClose} />
      <View style={styles.sheet} accessibilityViewIsModal testID="client-note-sheet">
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <AppText variant="title" accessibilityRole="header">
            Add a note
          </AppText>
          <AppText tone="muted">For {clientName}. Only staff can see notes.</AppText>

          <View accessibilityRole="radiogroup" accessibilityLabel="Note type" style={styles.types}>
            {CLIENT_NOTE_TYPES.map((value) => {
              const selected = noteType === value;
              return (
                <Pressable
                  key={value}
                  accessibilityRole="radio"
                  accessibilityLabel={TYPE_LABELS[value]}
                  accessibilityState={{ checked: selected, selected, disabled: mutation.pending }}
                  aria-checked={selected}
                  disabled={mutation.pending}
                  onPress={() => setNoteType(value)}
                  style={[styles.chip, selected && styles.chipSelected]}
                  testID={`note-type-${value}`}
                >
                  <AppText variant="label" style={{ color: selected ? colors.onPlum : colors.plum }}>
                    {selected ? `✓ ${TYPE_LABELS[value]}` : TYPE_LABELS[value]}
                  </AppText>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.field}>
            <AppText variant="label" nativeID="note-body-label">
              Note
            </AppText>
            <TextInput
              accessibilityLabel="Note"
              accessibilityLabelledBy="note-body-label"
              editable={!mutation.pending && !failed}
              multiline
              onChangeText={setBody}
              placeholder="What should the next person know?"
              placeholderTextColor={colors.muted}
              style={styles.input}
              testID="note-body"
              textAlignVertical="top"
              value={body}
            />
            {tooLong ? (
              <AppText variant="caption" tone="error" accessibilityRole="alert" testID="note-too-long">
                Notes can be up to {MAX_NOTE_LENGTH} characters. This one is {trimmed.length}.
              </AppText>
            ) : null}
          </View>

          <MutationNotice
            state={mutation.state}
            onRetry={() => mutation.retry()}
            onDiscard={discard}
            onDismiss={() => mutation.reset()}
            onSignInAgain={() => void signOut()}
            testID="note-notice"
          />
          {mutation.state.status === "failed" && mutation.state.kind === "conflict" ? <Announce message="This note could not be saved." /> : null}

          <View style={styles.actions}>
            <AppButton label="Save note" onPress={save} disabled={!canSave} loading={mutation.pending} />
            <AppButton label="Cancel" variant="quiet" onPress={onClose} disabled={mutation.pending} />
          </View>
        </ScrollView>
      </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  avoid: { flex: 1 },
  scrim: { flex: 1, backgroundColor: "rgba(43, 27, 42, 0.45)" },
  sheet: { maxHeight: "92%", backgroundColor: colors.raised, borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card, borderWidth: 1, borderColor: colors.border },
  content: { gap: space.md, padding: space.xl },
  types: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: { minHeight: 44, minWidth: 80, justifyContent: "center", alignItems: "center", paddingHorizontal: space.md, borderRadius: radius.control, borderWidth: 1.5, borderColor: colors.plum, backgroundColor: colors.raised },
  chipSelected: { backgroundColor: colors.plum },
  field: { gap: space.xs },
  input: { minHeight: 120, borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.control, padding: space.md, backgroundColor: colors.surface, color: colors.text, ...type.body },
  actions: { gap: space.sm, marginTop: space.sm },
});
