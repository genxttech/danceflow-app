import { Pressable, ScrollView, StyleSheet, useColorScheme } from "react-native";
import { AppText } from "@/components/AppText";
import { colorsForScheme, type ThemeColors } from "@/constants/theme";
import { useMemo } from "react";

export type Category = {
  /** Reachable without an account. Everything else asks a guest to sign in first. */
  guestAllowed?: boolean;
  key: string;
  label: string;
  count: number | null;
  href: string;
};

/**
 * The Discover category chips. The row is a horizontal ScrollView, and a ScrollView defaults to
 * flexGrow: 1, so inside a column it stretched to fill the screen and every chip with it (the
 * chips are cross-axis stretched). The row must not grow: flexGrow 0, and chips align to the start.
 */
export function CategoryChips({
  categories,
  loading,
  onOpen,
}: {
  categories: Category[];
  loading: boolean;
  onOpen: (category: Category) => void;
}) {
  const colors = colorsForScheme(useColorScheme());
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <ScrollView
      contentContainerStyle={styles.chips}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroll}
      testID="discover-chips"
    >
      {categories.map((category) => (
        <Pressable
          accessibilityLabel={category.count === null || loading ? category.label : `${category.label}, ${category.count}`}
          accessibilityRole="button"
          key={category.key}
          onPress={() => onOpen(category)}
          style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
          testID={`discover-chip-${category.key}`}
        >
          <AppText style={styles.chipLabel}>{category.label}</AppText>
          {category.count !== null && !loading ? <AppText style={styles.chipCount}>{category.count}</AppText> : null}
        </Pressable>
      ))}
    </ScrollView>
  );
}

export function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    // flexGrow 0: size to the chips, never fill the column (see the component note).
    scroll: { flexGrow: 0 },
    chips: { alignItems: "flex-start", gap: 8, paddingRight: 8 },
    chip: {
      alignItems: "center",
      borderColor: colors.borderStrong,
      borderRadius: 22,
      borderWidth: 1,
      flexDirection: "row",
      gap: 6,
      minHeight: 44,
      paddingHorizontal: 16,
    },
    chipLabel: { color: colors.text, fontSize: 14, fontWeight: "600" },
    chipCount: { color: colors.muted, fontSize: 13, fontWeight: "600" },
    pressed: { opacity: 0.88 },
  });
}
