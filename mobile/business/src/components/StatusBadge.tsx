import { StyleSheet, View } from "react-native";
import { AppText } from "@/components/AppText";
import { statusLabel, statusTone, type StatusTone } from "@/lib/format";
import { colors, radius, space } from "@/theme";

const toneColor: Record<StatusTone, string> = {
  neutral: colors.muted,
  success: colors.success,
  warning: colors.amberInk,
  error: colors.error,
};

/** Status always as words; the outline color only repeats it. */
export function StatusBadge({ status }: { status: string }) {
  const color = toneColor[statusTone(status)];
  return (
    <View style={[styles.chip, { borderColor: statusTone(status) === "neutral" ? colors.border : color }]}>
      <AppText variant="caption" style={[styles.text, { color }]}>
        {statusLabel(status)}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  text: { fontWeight: "600" },
});
