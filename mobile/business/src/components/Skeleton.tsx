import { StyleSheet, View } from "react-native";
import { colors, radius, space } from "@/theme";

/** A static placeholder shaped like a schedule row. No shimmer, so nothing moves for Reduce Motion users. */
function SkeletonRow() {
  return (
    <View style={styles.row}>
      <View style={[styles.bar, { width: 64 }]} />
      <View style={styles.body}>
        <View style={[styles.bar, { width: "70%" }]} />
        <View style={[styles.bar, styles.thin, { width: "45%" }]} />
      </View>
    </View>
  );
}

export function ScheduleSkeleton({ rows = 4, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label} testID="schedule-skeleton" style={styles.list}>
      {Array.from({ length: rows }, (_, index) => (
        <SkeletonRow key={index} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.sm },
  row: {
    flexDirection: "row",
    gap: space.lg,
    padding: space.lg,
    borderRadius: radius.row,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
  body: { flex: 1, gap: space.sm },
  bar: { height: 14, borderRadius: radius.control, backgroundColor: colors.skeleton },
  thin: { height: 10 },
});
