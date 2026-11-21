// GENERATED from mobile/shared/assistant/ by mobile/shared/sync-assistant.js. Do not edit here; edit the source and re-run.
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MAX_MESSAGE_LENGTH, useAssistant, useAssistantOptional } from "./provider";
import type { AssistantErrorKind, AssistantMessage, ResolvedLink } from "./types";

/*
  Shared assistant UI: floating launcher + conversation sheet (bottom sheet or full screen). Themed by an AssistantTheme the app maps from
  its own palette, so LUMI and ARIA keep their own look. Everything here sits behind the app's flag: the apps mount <AssistantHost/> only
  when it is on, so with the flag off none of this renders or runs.
*/

export interface AssistantTheme {
  readonly background: string;
  readonly surface: string;
  readonly text: string;
  readonly muted: string;
  readonly border: string;
  readonly primary: string;
  readonly onPrimary: string;
  readonly danger: string;
  readonly scrim: string;
}

const MIN_TOUCH = 44;
const LAUNCHER_SIZE = 56;

const ERROR_COPY: Record<AssistantErrorKind, string> = {
  timeout: "That took too long.",
  network: "Couldn't reach the assistant. Check your connection.",
  unavailable: "The assistant isn't available right now.",
  rate_limited: "You've reached the limit for now. Try again later.",
  refused: "I can't help with that.",
  unknown: "Something went wrong.",
};

export function useKeyboardVisible() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => setVisible(true));
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

/**
 * The floating button. `bottomOffset` is the height the app's bottom tab bar (or primary action bar) occupies, so it never covers them;
 * `onTabScreen`-style placement is the app's call. Hidden while the sheet is open, the keyboard is up, or a screen/sheet asked it to step aside.
 */
export function AssistantLauncher({ theme, bottomOffset = 0 }: { theme: AssistantTheme; bottomOffset?: number }) {
  const api = useAssistant();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardVisible();
  if (api.open || api.suppressed || keyboard) return null;
  return (
    <View pointerEvents="box-none" style={[styles.launcherWrap, { right: 16 + insets.right, bottom: 16 + bottomOffset + insets.bottom }]}>
      <Pressable
        accessible
        accessibilityRole="button"
        accessibilityLabel={`Open ${api.config.name} assistant`}
        accessibilityHint="Opens a chat. Your conversation stays while you move around the app."
        onPress={() => api.setMode("sheet")}
        hitSlop={8}
        style={[styles.launcher, { backgroundColor: theme.primary, borderColor: theme.border }]}
        testID="assistant-launcher"
      >
        <Text style={[styles.launcherText, { color: theme.onPrimary }]}>{api.config.avatarInitials}</Text>
      </Pressable>
    </View>
  );
}

function Bubble({ message, theme, onLink, onRetry, name }: { message: AssistantMessage; theme: AssistantTheme; onLink: (l: ResolvedLink) => void; onRetry: () => void; name: string }) {
  const mine = message.role === "user";
  if (message.status === "pending") {
    return (
      <View accessible accessibilityLabel={`${name} is typing`} accessibilityRole="progressbar" style={[styles.bubble, styles.theirs, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <ActivityIndicator color={theme.muted} />
      </View>
    );
  }
  if (message.status === "error") {
    return (
      <View style={[styles.bubble, styles.theirs, { backgroundColor: theme.surface, borderColor: theme.danger }]} accessibilityRole="alert">
        <Text style={[styles.body, { color: theme.text }]}>{ERROR_COPY[message.errorKind ?? "unknown"]}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Retry" onPress={onRetry} style={[styles.chip, { borderColor: theme.primary }]}>
          <Text style={[styles.chipText, { color: theme.primary }]}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={[styles.bubble, mine ? styles.mine : styles.theirs, mine ? { backgroundColor: theme.primary, borderColor: theme.primary } : { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <Text selectable style={[styles.body, { color: mine ? theme.onPrimary : theme.text }]}>
        {message.text}
      </Text>
      {message.links?.map((link) => (
        <Pressable key={`${link.target}-${link.href}`} accessibilityRole="link" accessibilityLabel={link.label} onPress={() => onLink(link)} style={[styles.chip, { borderColor: theme.primary }]}>
          <Text style={[styles.chipText, { color: theme.primary }]}>{link.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** The conversation. Closing or minimizing never clears it; only "Clear" does. `onNavigate` receives a whitelist-resolved href. */
export function AssistantSheet({ theme, onNavigate }: { theme: AssistantTheme; onNavigate: (href: string) => void }) {
  const api = useAssistant();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState("");
  const scroll = useRef<ScrollView>(null);
  const full = api.mode === "full";

  useEffect(() => {
    scroll.current?.scrollToEnd?.({ animated: true });
  }, [api.messages.length, api.busy]);

  if (!api.open) return null;

  const submit = (text: string) => {
    if (!text.trim() || api.busy) return;
    api.send(text);
    setDraft("");
  };
  const close = () => api.setMode("closed");
  const lastIsPending = api.busy;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={close} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.avoid}>
        {!full ? <Pressable accessibilityRole="button" accessibilityLabel="Minimize assistant" onPress={close} style={[styles.scrim, { backgroundColor: theme.scrim }]} /> : null}
        <View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            full ? styles.sheetFull : styles.sheetPartial,
            { backgroundColor: theme.background, borderColor: theme.border, paddingTop: full ? insets.top + 8 : 12, paddingBottom: Math.max(insets.bottom, 12) },
          ]}
          testID="assistant-sheet"
        >
          <View style={styles.header}>
            <View style={styles.headerTitle}>
              <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
                {api.config.name}
              </Text>
              {api.screenLabel ? <Text style={[styles.caption, { color: theme.muted }]}>{`Helping with: ${api.screenLabel}`}</Text> : null}
            </View>
            <HeaderButton theme={theme} label={full ? "Show as sheet" : "Expand to full screen"} text={full ? "Shrink" : "Expand"} onPress={() => api.setMode(full ? "sheet" : "full")} />
            {api.messages.length > 0 ? <HeaderButton theme={theme} label="Clear conversation" text="Clear" onPress={api.clear} /> : null}
            <HeaderButton theme={theme} label="Minimize assistant" text="Close" onPress={close} />
          </View>

          <ScrollView ref={scroll} style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
            {api.messages.length === 0 ? (
              <View accessible={false}>
                <Text style={[styles.body, { color: theme.text }]}>{api.config.introText}</Text>
                <Text style={[styles.caption, { color: theme.muted }]}>{api.config.disclaimer}</Text>
                {api.suggestions.map((s) => (
                  <Pressable key={s.id} accessibilityRole="button" accessibilityLabel={s.text} onPress={() => submit(s.text)} style={[styles.suggestion, { borderColor: theme.border, backgroundColor: theme.surface }]}>
                    <Text style={[styles.body, { color: theme.text }]}>{s.text}</Text>
                  </Pressable>
                ))}
              </View>
            ) : (
              api.messages.map((m) => (
                <Bubble
                  key={m.id}
                  message={m}
                  theme={theme}
                  name={api.config.name}
                  onRetry={() => api.retry(m.id)}
                  onLink={(link) => {
                    api.setMode("closed");
                    onNavigate(link.href);
                  }}
                />
              ))
            )}
          </ScrollView>

          <View style={styles.composer}>
            <TextInput
              accessibilityLabel={`Message ${api.config.name}`}
              value={draft}
              onChangeText={setDraft}
              placeholder="Type a message"
              placeholderTextColor={theme.muted}
              multiline
              maxLength={MAX_MESSAGE_LENGTH}
              editable
              style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.surface }]}
            />
            {lastIsPending ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Stop" onPress={api.cancel} style={[styles.send, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Text style={[styles.sendText, { color: theme.text }]}>Stop</Text>
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send message"
                accessibilityState={{ disabled: !draft.trim() }}
                disabled={!draft.trim()}
                onPress={() => submit(draft)}
                style={[styles.send, { backgroundColor: theme.primary, borderColor: theme.primary, opacity: draft.trim() ? 1 : 0.5 }]}
              >
                <Text style={[styles.sendText, { color: theme.onPrimary }]}>Send</Text>
              </Pressable>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function HeaderButton({ theme, label, text, onPress }: { theme: AssistantTheme; label: string; text: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.headerButton} hitSlop={4}>
      <Text style={[styles.chipText, { color: theme.primary }]}>{text}</Text>
    </Pressable>
  );
}

/** What the app mounts when its flag is on: launcher + sheet. Renders nothing without a provider. */
export function AssistantHost({ theme, onNavigate, bottomOffset }: { theme: AssistantTheme; onNavigate: (href: string) => void; bottomOffset?: number }) {
  if (!useAssistantOptional()) return null;
  return (
    <>
      <AssistantLauncher theme={theme} bottomOffset={bottomOffset} />
      <AssistantSheet theme={theme} onNavigate={onNavigate} />
    </>
  );
}

const styles = StyleSheet.create({
  launcherWrap: { position: "absolute" },
  launcher: { minWidth: LAUNCHER_SIZE, minHeight: LAUNCHER_SIZE, borderRadius: LAUNCHER_SIZE / 2, alignItems: "center", justifyContent: "center", borderWidth: 1, elevation: 4 },
  launcherText: { fontSize: 18, fontWeight: "700" },
  avoid: { flex: 1, justifyContent: "flex-end" },
  scrim: { flex: 1, minHeight: MIN_TOUCH },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, paddingHorizontal: 16 },
  sheetPartial: { maxHeight: "80%", flexShrink: 1 },
  sheetFull: { flex: 1, borderRadius: 0 },
  header: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4, paddingBottom: 8 },
  headerTitle: { flexGrow: 1, flexShrink: 1, minWidth: 120 },
  headerButton: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  title: { fontSize: 20, fontWeight: "700" },
  caption: { fontSize: 13, lineHeight: 18, marginTop: 4 },
  list: { flexGrow: 0, flexShrink: 1 },
  listContent: { paddingVertical: 8, gap: 8 },
  body: { fontSize: 15, lineHeight: 21 },
  bubble: { borderWidth: 1, borderRadius: 14, padding: 12, maxWidth: "92%", gap: 8 },
  mine: { alignSelf: "flex-end" },
  theirs: { alignSelf: "flex-start" },
  chip: { minHeight: MIN_TOUCH, borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, alignItems: "center", justifyContent: "center", alignSelf: "flex-start" },
  chipText: { fontSize: 14, fontWeight: "600" },
  suggestion: { minHeight: MIN_TOUCH, borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 8, justifyContent: "center" },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingTop: 8 },
  input: { flex: 1, minHeight: MIN_TOUCH, maxHeight: 140, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  send: { minHeight: MIN_TOUCH, minWidth: 64, borderWidth: 1, borderRadius: 12, alignItems: "center", justifyContent: "center", paddingHorizontal: 14 },
  sendText: { fontSize: 15, fontWeight: "700" },
});
