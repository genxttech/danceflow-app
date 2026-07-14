import type React from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  ScrollView,
  StyleSheet,
  useColorScheme,
  View,
  type ViewStyle,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { colorsForScheme } from "@/constants/theme";

type ScreenProps = {
  children: React.ReactNode;
  scroll?: boolean;
  style?: ViewStyle;
};

export function Screen({ children, scroll = true, style }: ScreenProps) {
  const colors = colorsForScheme(useColorScheme());

  const content = <View style={[styles.content, style]}>{children}</View>;

  return (
    <LinearGradient colors={colors.appBackgroundGradient} style={styles.gradient}>
      <SafeAreaView style={styles.safe}>
        {scroll ? (
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            contentInsetAdjustmentBehavior="automatic"
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {content}
          </ScrollView>
        ) : (
          content
        )}
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  gradient: {
    flex: 1,
  },
  safe: {
    backgroundColor: "transparent",
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  content: {
    flexGrow: 1,
    gap: 16,
    paddingBottom: 28,
    paddingHorizontal: 18,
    paddingTop: 16,
  },
});
