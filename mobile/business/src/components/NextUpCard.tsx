import { StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { nextUpLabel, type NextUpKind } from "@/lib/nextUp";
import { colors, radius, space, tabularNums } from "@/theme";

type Props = {
  kind: NextUpKind;
  /** "9:30 AM". */
  start: string;
  /** Who it is with, or the class name. */
  headline: string;
  /** Lessons or classes that ended and still have no result. */
  behind: number;
  onOpen: () => void;
};

/** The one obvious next thing on the front desk's day. The button opens the appointment, where the confirm-first controls are. */
export function NextUpCard({ kind, start, headline, behind, onOpen }: Props) {
  const label = nextUpLabel(kind, headline);
  const title = kind === "record_result" ? "Still to record" : "Next up";
  return (
    <View style={styles.card} testID="next-up">
      <AppText variant="label" tone="muted" accessibilityRole="header">
        {title}
      </AppText>
      <AppText variant="lead" style={tabularNums}>
        {start} · {headline}
      </AppText>
      <AppButton label={label} onPress={onOpen} accessibilityHint="Opens the appointment" />
      {behind > 0 ? (
        <AppText tone="muted" testID="next-up-behind">
          {behind === 1 ? "1 earlier lesson or class still has no result." : `${behind} earlier lessons or classes still have no result.`}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm, padding: space.lg, borderRadius: radius.row, borderWidth: 1.5, borderColor: colors.plum, backgroundColor: colors.raised },
});
