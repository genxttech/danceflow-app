import type React from "react";
import { useEffect, useRef } from "react";
import { AccessibilityInfo, Modal, ScrollView, StyleSheet, View, findNodeHandle } from "react-native";
import { Announce } from "@/components/Announce";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { colors, radius, space } from "@/theme";

type Props = {
  visible: boolean;
  title: string;
  /** What will happen, in one or two sentences. Say the consequence, not "Are you sure?". */
  body?: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** The write is running: both buttons are disabled so a second tap cannot send a second request. */
  busy?: boolean;
  testID?: string;
  /** Extra choices between the text and the buttons (for example what a no-show costs). */
  children?: React.ReactNode;
};

/*
  Confirm bottom sheet for a write (one obvious next action: the confirm button is primary, cancel is quiet). Behaviours the audit checks:
  - a modal for assistive tech (accessibilityViewIsModal), announced with its title and body when it opens;
  - the system back button cancels (unless busy);
  - touch targets are 48 pt (AppButton) and text grows to 200% inside a scroll view, so nothing is clipped;
  - while busy both buttons are disabled.
*/
export function ConfirmSheet({ visible, title, body, confirmLabel, cancelLabel = "Cancel", onConfirm, onCancel, busy, testID, children }: Props) {
  const headingRef = useRef<View>(null);

  useEffect(() => {
    if (!visible) return;
    const node = headingRef.current ? findNodeHandle(headingRef.current) : null;
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={busy ? undefined : onCancel} statusBarTranslucent>
      {/* Tapping outside cancels for sighted users. It is not a control for assistive tech (hidden from it); the Cancel button and the back button are. */}
      <View
        style={styles.scrim}
        onTouchEnd={busy ? undefined : onCancel}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        testID={testID ? `${testID}-scrim` : undefined}
      />
      <View style={styles.sheet} accessibilityViewIsModal accessibilityRole="alert" testID={testID}>
        <Announce message={body ? `${title}. ${body}` : title} />
        <ScrollView contentContainerStyle={styles.content} bounces={false}>
          <View ref={headingRef} accessible accessibilityRole="header">
            <AppText variant="title">{title}</AppText>
          </View>
          {body ? <AppText tone="muted">{body}</AppText> : null}
          {children}
          <View style={styles.actions}>
            <AppButton label={confirmLabel} onPress={onConfirm} disabled={busy} loading={busy} />
            <AppButton label={cancelLabel} onPress={onCancel} variant="quiet" disabled={busy} />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(43, 27, 42, 0.45)" },
  sheet: {
    maxHeight: "85%",
    backgroundColor: colors.raised,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  content: { gap: space.md, padding: space.xl },
  actions: { gap: space.sm, marginTop: space.sm },
});
