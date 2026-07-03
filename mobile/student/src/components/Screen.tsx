import type React from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { ScrollView, StyleSheet, useColorScheme, View, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { colorsForScheme } from "@/constants/theme";

type ScreenProps = {
  children: React.ReactNode;
  scroll?: boolean;
  style?: ViewStyle;
};

export function Screen({ children, scroll = true, style }: ScreenProps) {
  const colors = colorsForScheme(useColorScheme());

  if (!scroll) {
    return (
      <LinearGradient colors={colors.appBackgroundGradient} style={styles.gradient}>
        <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
          <View style={[styles.content, style]}>{children}</View>
        </SafeAreaView>
      </LinearGradient>
    );
  }

  return (
    <LinearGradient colors={colors.appBackgroundGradient} style={styles.gradient}>
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
        <ScrollView
          contentContainerStyle={[styles.content, style]}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  gradient: {
    flex: 1
  },
  safe: {
    flex: 1
  },
  content: {
    flexGrow: 1,
    padding: 20,
    gap: 16
  }
});
