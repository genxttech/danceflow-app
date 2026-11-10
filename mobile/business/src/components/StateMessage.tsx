import type React from "react";
import { StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { colors, radius, space } from "@/theme";

type Action = { label: string; onPress: () => void; variant?: "primary" | "secondary" };

type Props = {
  title: string;
  body?: string;
  tone?: "neutral" | "error";
  actions?: Action[];
  testID?: string;
  children?: React.ReactNode;
};

/** Empty, error and explanation states. Errors are announced, and say so in words, not only with color. */
export function StateMessage({ title, body, tone = "neutral", actions = [], testID, children }: Props) {
  return (
    <View
      testID={testID}
      accessibilityRole={tone === "error" ? "alert" : "summary"}
      style={[styles.card, tone === "error" && styles.error]}
    >
      <AppText variant="title" accessibilityRole="header">
        {title}
      </AppText>
      {body ? <AppText tone="muted">{body}</AppText> : null}
      {children}
      {actions.length ? (
        <View style={styles.actions}>
          {actions.map((action) => (
            <AppButton key={action.label} label={action.label} onPress={action.onPress} variant={action.variant ?? "primary"} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: space.md,
    padding: space.xl,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
  error: { borderColor: colors.error, borderLeftWidth: 4 },
  actions: { gap: space.sm, marginTop: space.sm },
});
