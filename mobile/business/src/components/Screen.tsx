import type React from "react";
import { ScrollView, StyleSheet, View, type ScrollViewProps } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";
import { colors, gutter, space } from "@/theme";

type Props = {
  children: React.ReactNode;
  scroll?: boolean;
  refreshControl?: ScrollViewProps["refreshControl"];
  edges?: Edge[];
};

export function Screen({ children, scroll = true, refreshControl, edges = ["top"] }: Props) {
  return (
    <SafeAreaView edges={edges} style={styles.safe}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.content} refreshControl={refreshControl} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.content, styles.fill]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  content: { paddingHorizontal: gutter, paddingTop: space.lg, paddingBottom: space.xxxl, gap: space.lg },
  fill: { flex: 1 },
});
