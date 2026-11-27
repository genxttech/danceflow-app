import { useRef } from "react";
import type React from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  useColorScheme,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { colorsForScheme } from "@/constants/theme";

type ScreenProps = {
  children: React.ReactNode;
  scroll?: boolean;
  style?: ViewStyle;
  refreshing?: boolean;
  onRefresh?: () => void;
  /**
   * Android only, for a form that ends the screen: the scroll area shrinks to sit above the open
   * keyboard and scrolls to its end. iOS relies on automaticallyAdjustKeyboardInsets.
   */
  keepEndAboveKeyboard?: boolean;
};

export function Screen({
  children,
  scroll = true,
  style,
  refreshing = false,
  onRefresh,
  keepEndAboveKeyboard = false,
}: ScreenProps) {
  const colors = colorsForScheme(useColorScheme());
  const { width } = useWindowDimensions();
  const contentWidthStyle = width >= 900 ? styles.contentWide : null;
  const scrollRef = useRef<ScrollView>(null);
  // Android draws edge to edge, so the window does not resize for the keyboard.
  const avoidKeyboard = keepEndAboveKeyboard && Platform.OS === "android";

  const content = (
    <View style={[styles.content, contentWidthStyle, style]}>{children}</View>
  );

  const scrollView = (
    <ScrollView
      ref={scrollRef}
      onLayout={
        avoidKeyboard
          ? () => {
              if (Keyboard.isVisible()) scrollRef.current?.scrollToEnd();
            }
          : undefined
      }
      contentContainerStyle={styles.scrollContent}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      automaticallyAdjustsScrollIndicatorInsets
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        ) : undefined
      }
      showsVerticalScrollIndicator={false}
    >
      {content}
    </ScrollView>
  );

  return (
    <LinearGradient colors={colors.appBackgroundGradient} style={styles.gradient}>
      <SafeAreaView style={styles.safe}>
        {!scroll ? (
          content
        ) : avoidKeyboard ? (
          <KeyboardAvoidingView behavior="padding" style={styles.keyboardArea}>
            {scrollView}
          </KeyboardAvoidingView>
        ) : (
          scrollView
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
  keyboardArea: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  content: {
    alignSelf: "center",
    flexGrow: 1,
    gap: 16,
    maxWidth: "100%",
    paddingBottom: 32,
    paddingHorizontal: 18,
    paddingTop: 16,
    width: "100%",
  },
  contentWide: {
    maxWidth: 760,
  },
});
