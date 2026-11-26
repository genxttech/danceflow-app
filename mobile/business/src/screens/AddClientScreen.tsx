import { useRef, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { router } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { MutationNotice } from "@/components/MutationNotice";
import { Screen } from "@/components/Screen";
import { StateMessage } from "@/components/StateMessage";
import { isStaffFeatureEnabled } from "@/lib/features";
import { useStaffMutation } from "@/lib/mutation";
import { useStaffApi, useStaffSession } from "@/lib/staff";
import type { ClientSummary, NewClientInput } from "@/lib/staffApi";
import { newEntityId } from "@/lib/uuid";
import { colors, radius, space, type } from "@/theme";

type Draft = { firstName: string; lastName: string; phone: string; email: string; note: string };
const EMPTY: Draft = { firstName: "", lastName: "", phone: "", email: "", note: "" };

/** Same rules the server applies (it refuses anything else with 400): names, and a phone or an email. Returns the first problem, in words. */
export function validateDraft(draft: Draft): string | null {
  if (!draft.firstName.trim()) return "Enter a first name.";
  if (!draft.lastName.trim()) return "Enter a last name.";
  if (!draft.phone.trim() && !draft.email.trim()) return "Enter a phone number or an email.";
  if (draft.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) return "That email doesn't look right.";
  return null;
}

function Field({ label, value, onChangeText, testID, ...rest }: { label: string; value: string; onChangeText: (v: string) => void; testID: string } & Partial<React.ComponentProps<typeof TextInput>>) {
  return (
    <View style={styles.field}>
      <AppText variant="label" nativeID={`${testID}-label`}>
        {label}
      </AppText>
      <TextInput
        accessibilityLabel={label}
        accessibilityLabelledBy={`${testID}-label`}
        onChangeText={onChangeText}
        placeholderTextColor={colors.muted}
        style={styles.input}
        testID={testID}
        value={value}
        {...rest}
      />
    </View>
  );
}

/**
 * Quick-add a client from the floor: name and a way to reach them, an optional note. Everything else stays on the web. The client id is made once when the
 * screen opens and reused by every retry, so a lost answer can never create the client twice.
 */
export function AddClientScreen({ studioId }: { studioId: string }) {
  const api = useStaffApi();
  const { signOut } = useStaffSession();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [problem, setProblem] = useState<string | null>(null);
  const clientId = useRef(newEntityId());
  const lastInput = useRef<NewClientInput | null>(null);

  const mutation = useStaffMutation<NewClientInput, { client: ClientSummary; replayed: boolean }>({
    run: (input, key) => api.createClient(studioId, input, key),
    enabled: isStaffFeatureEnabled("clientCreate"),
    onSuccess: ({ client }) => router.replace({ pathname: "/clients/[id]", params: { id: client.id, studioId } }),
  });

  const state = mutation.state;
  const duplicate =
    state.status === "failed" && state.kind === "conflict" && state.conflict?.serverCode === "duplicate_client"
      ? (state.error as { extra?: { details?: { existingClientId?: unknown; matchedOn?: unknown } } }).extra?.details
      : null;
  const existingClientId = typeof duplicate?.existingClientId === "string" ? duplicate.existingClientId : null;
  const matchedOn = duplicate?.matchedOn === "email" ? "email" : "phone";

  function submit(allowDuplicatePhone = false) {
    const message = validateDraft(draft);
    setProblem(message);
    if (message) return;
    const input: NewClientInput = {
      clientId: clientId.current,
      firstName: draft.firstName.trim(),
      lastName: draft.lastName.trim(),
      ...(draft.phone.trim() ? { phone: draft.phone.trim() } : {}),
      ...(draft.email.trim() ? { email: draft.email.trim() } : {}),
      ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
      ...(allowDuplicatePhone ? { allowDuplicatePhone: true } : {}),
    };
    lastInput.current = input;
    mutation.submit(input);
  }

  const set = (key: keyof Draft) => (value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setProblem(null);
  };
  const locked = mutation.pending || state.status === "failed";

  if (!isStaffFeatureEnabled("clientCreate")) {
    return (
      <Screen edges={[]}>
        <StateMessage title="Not available" body="Adding clients from the app isn't turned on yet. You can add them on DanceFlow for the web." />
      </Screen>
    );
  }

  return (
    <Screen edges={[]}>
      <AppText variant="heading" accessibilityRole="header">
        Add a client
      </AppText>
      <AppText tone="muted">Name and a phone or email. You can add the rest on the web.</AppText>

      <Field label="First name" value={draft.firstName} onChangeText={set("firstName")} testID="client-first-name" autoCapitalize="words" autoComplete="given-name" editable={!locked} returnKeyType="next" />
      <Field label="Last name" value={draft.lastName} onChangeText={set("lastName")} testID="client-last-name" autoCapitalize="words" autoComplete="family-name" editable={!locked} returnKeyType="next" />
      <Field label="Phone" value={draft.phone} onChangeText={set("phone")} testID="client-phone" keyboardType="phone-pad" autoComplete="tel" editable={!locked} returnKeyType="next" />
      <Field label="Email" value={draft.email} onChangeText={set("email")} testID="client-email" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" editable={!locked} returnKeyType="next" />
      <Field label="Note (optional)" value={draft.note} onChangeText={set("note")} testID="client-note" multiline editable={!locked} textAlignVertical="top" />

      {problem ? (
        <AppText tone="error" accessibilityRole="alert" accessibilityLiveRegion="polite" testID="add-client-problem">
          {problem}
        </AppText>
      ) : null}

      {duplicate ? (
        <StateMessage
          tone="error"
          testID="duplicate-client"
          title="This client may already exist"
          body={matchedOn === "email" ? "A client with this email is already in your studio." : "A client with this phone number is already in your studio."}
          actions={[
            ...(existingClientId ? [{ label: "Open that client", onPress: () => router.replace({ pathname: "/clients/[id]", params: { id: existingClientId, studioId } }) }] : []),
            ...(matchedOn === "phone" ? [{ label: "Add as a new client anyway", onPress: () => { mutation.reset(); submit(true); }, variant: "secondary" as const }] : []),
            { label: "Change the details", onPress: () => mutation.reset(), variant: "secondary" as const },
          ]}
        />
      ) : (
        <MutationNotice
          state={state}
          onRetry={() => mutation.retry()}
          onDiscard={() => mutation.discard()}
          onDismiss={() => mutation.reset()}
          onSignInAgain={() => void signOut()}
          testID="add-client-notice"
        />
      )}

      <AppButton label="Add client" onPress={() => submit(false)} disabled={locked} loading={mutation.pending} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  field: { gap: space.xs },
  input: { minHeight: 48, borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.control, paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: colors.raised, color: colors.text, ...type.body },
});
